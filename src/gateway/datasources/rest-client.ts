import { GraphQLError } from 'graphql';
import { ContractMismatch } from './contract.js';

/**
 * Thin HTTP client for the downstream REST service.
 *
 * It also *counts* outbound calls. That counter is the instrument behind the
 * whole repo: the benchmark and the N+1 regression test read `stats.total` to
 * prove that DataLoader collapses many logical loads into few real HTTP calls.
 */

export interface RestClientStats {
  total: number;
  byPath: Record<string, number>;
}

export type QueryParams = Record<string, string | number | ReadonlyArray<string> | undefined>;

/** Default downstream timeout when none is configured (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Joins an absolute route path onto the base URL *keeping* the base's path
 * prefix. WHY not `new URL(path, base)`: WHATWG resolution of an absolute path
 * discards the base pathname, so a legacy service mounted at `http://h/api/v1`
 * would silently receive `/authors` and 404. Trailing slashes on the base are
 * stripped so `/api/v1`, `/api/v1/` and `/api/v1//` all yield `/api/v1/authors`.
 * The base's query string and fragment are not carried over, as before.
 * The base is parsed per call (not pre-parsed in the constructor) on purpose:
 * an invalid base must keep failing at request time, not at construction.
 */
function joinBaseUrl(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, '') + path;
  url.search = '';
  url.hash = '';
  return url;
}

/**
 * Fails fast on a budget that could never be honoured as a call count. WHY a
 * throw instead of clamping: `0`, `1.5` or `NaN` silently becoming "refuse
 * everything" or "unlimited" is a misconfiguration the operator must see.
 * Lives next to `RestClient` so every entry point (`createGateway`, the public
 * `createContext`, a hand-built client) is checked the same way.
 */
export function validateMaxDownstreamCalls(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`maxDownstreamCalls must be a positive integer, got ${String(value)}`);
  }
}

/** RFC 9110 `token`: the only legal characters in a header field name. */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Connection-scoped/framing headers. WHY rejected: they describe the edge
 * hop, not the caller; copying `host` or `content-length` onto a different
 * downstream request would mis-route or corrupt it (and fetch forbids most).
 */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-connection',
  // Not hop-by-hop, but Node's undici fetch throws on it ("expect header not
  // supported"), so forwarding it would fail every downstream call.
  'expect',
]);

/**
 * Validates and normalizes a header-forwarding allowlist to lowercase names.
 * WHY a throw at configuration time: a typo'd or illegal name would otherwise
 * surface only as every downstream call silently missing its credential.
 * `label` names the setting in the message (`forwardHeaders` for the library,
 * `FORWARD_HEADERS` for the CLI) so the operator knows what to fix.
 */
export function validateForwardHeaders(
  names: readonly string[] | undefined,
  label = 'forwardHeaders',
): string[] {
  if (names === undefined) return [];
  if (!Array.isArray(names)) throw new TypeError(`${label} must be an array of header names`);
  const normalized: string[] = [];
  for (const name of names) {
    if (typeof name !== 'string' || !HTTP_TOKEN.test(name)) {
      throw new Error(`${label} entry ${JSON.stringify(name)} is not a valid HTTP header name`);
    }
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) {
      throw new Error(`${label} entry ${JSON.stringify(name)} is a hop-by-hop header and cannot be forwarded`);
    }
    if (!normalized.includes(lower)) normalized.push(lower);
  }
  return normalized;
}

/**
 * A 2xx downstream body that is not valid JSON or breaks the REST contract.
 * WHY typed: without it the parse/shape failure escaped as an untyped
 * "Unexpected error.", indistinguishable from a gateway bug. The message and
 * extensions name only the route and status, never the body (an error page or
 * row data is not the client's to see); `detail` keeps the underlying error
 * for operator tooling and is not serialized into GraphQL responses.
 */
export class DownstreamBadResponse extends GraphQLError {
  constructor(
    route: string,
    status: number,
    problem: string,
    readonly detail: Error,
  ) {
    super(`Downstream REST response for ${route} ${problem}`, {
      extensions: { code: 'DOWNSTREAM_BAD_RESPONSE', status, route },
    });
  }
}

/** Turns a 2xx body into `T` via `read`, or fails as `DownstreamBadResponse`. */
function readBody<T>(route: string, status: number, text: string, read: (body: unknown) => T): T {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err: unknown) {
    throw new DownstreamBadResponse(route, status, 'is not valid JSON', err as Error);
  }
  try {
    return read(body);
  } catch (err: unknown) {
    if (!(err instanceof ContractMismatch)) throw err;
    throw new DownstreamBadResponse(route, status, `breaks the contract: ${err.message}`, err);
  }
}

const parsedJson = (body: unknown): unknown => body;

/**
 * The downstream could not be reached at all (connection refused, DNS
 * failure, reset before headers). WHY typed: it used to escape as an untyped
 * "Unexpected error.", which a client cannot tell from a gateway bug and a
 * readiness probe cannot name. The message names only the route: the host,
 * port and errno (`ECONNREFUSED`) describe the backend's topology, which is not
 * the client's to see. `detail` keeps the original fetch error for operator
 * tooling (`npm run check-backend`) and is not serialized into responses.
 */
export class DownstreamUnreachable extends GraphQLError {
  constructor(
    route: string,
    readonly detail: Error,
  ) {
    super(`Downstream request to ${route} failed: backend unreachable`, {
      extensions: { code: 'DOWNSTREAM_UNREACHABLE' },
    });
  }
}

/**
 * Types a rejected `fetch`. WHY every non-timeout rejection is "unreachable":
 * the URL is built (and the base validated) before `fetch`, so what is left is
 * the transport failing before any response arrived.
 */
function fetchFailure(path: string, timeoutMs: number, err: unknown): GraphQLError {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new GraphQLError(`Downstream request to ${path} timed out after ${timeoutMs}ms`, {
      extensions: { code: 'DOWNSTREAM_TIMEOUT' },
    });
  }
  return new DownstreamUnreachable(path, err instanceof Error ? err : new Error(String(err)));
}

/**
 * How one sent downstream call ended. The four typed failures map 1:1 onto the
 * `extensions.code` a client sees; `other` covers anything untyped (e.g. a body
 * that stalls or resets after a 2xx status line).
 */
export type DownstreamCallOutcome = 'ok' | 'http_error' | 'bad_response' | 'unreachable' | 'timeout' | 'other';

/**
 * One settled downstream REST call, as reported to `onDownstreamCall`. WHY so
 * few fields: the event is operator-side, but it must still carry no URL, id,
 * host, header or query param, so a hook that ships it to a log or metrics
 * backend can never leak a caller's credential or row data. `route` is the
 * route template (`/books/by-author`), never the base URL's path prefix.
 */
export interface DownstreamCallEvent {
  route: string;
  /** HTTP status that arrived, or `null` when no response did (unreachable, timeout). */
  status: number | null;
  durationMs: number;
  outcome: DownstreamCallOutcome;
  /** The client-visible `extensions.code` of the failure, or `null` (`ok`, `other`). */
  errorCode: string | null;
}

/** Called once per sent downstream call, after it settles. */
export type DownstreamCallHook = (event: DownstreamCallEvent) => void;

const OUTCOME_BY_CODE: Readonly<Record<string, DownstreamCallOutcome>> = {
  DOWNSTREAM_ERROR: 'http_error',
  DOWNSTREAM_BAD_RESPONSE: 'bad_response',
  DOWNSTREAM_UNREACHABLE: 'unreachable',
  DOWNSTREAM_TIMEOUT: 'timeout',
};

type Verdict = Pick<DownstreamCallEvent, 'outcome' | 'errorCode'>;

const OK: Verdict = { outcome: 'ok', errorCode: null };

/** Classifies a failed call by the typed error the client will see. */
function classify(err: unknown): Verdict {
  const code = err instanceof GraphQLError ? err.extensions.code : undefined;
  const outcome = typeof code === 'string' ? OUTCOME_BY_CODE[code] : undefined;
  return outcome && typeof code === 'string' ? { outcome, errorCode: code } : { outcome: 'other', errorCode: null };
}

/**
 * Invokes the operator hook without letting it touch the response. WHY not
 * awaited and both throw paths swallowed: a slow, throwing or rejecting hook
 * must never change a client's data or errors, nor surface as an
 * `unhandledRejection` that could crash the process. Synchronous hook work
 * still runs inline on the request path, so keep the hook cheap.
 */
function emit(hook: DownstreamCallHook, event: DownstreamCallEvent): void {
  try {
    const result: unknown = hook(event);
    if (result instanceof Promise) result.catch(() => undefined);
  } catch {
    // Swallowed on purpose; see above.
  }
}

export class RestClient {
  readonly stats: RestClientStats = { total: 0, byPath: {} };
  /** Per-request deadline in milliseconds for every downstream call. */
  readonly timeoutMs: number;

  /**
   * @param maxCalls Hard ceiling on calls this client may *send* (undefined =
   *   unlimited). WHY on the client: it is already the per-request counter
   *   behind `extensions.downstreamCalls`, so the budget is enforced on the
   *   measured number whatever the query shape, batching mode or prefetch path.
   * @param headers Edge headers to send on every call (already allowlisted by
   *   the caller). WHY on the client: every downstream path -- batched, naive,
   *   list, prefetch -- funnels through `get`, so none can forget them, and the
   *   client is per request, so one caller's credential never reaches another's.
   * @param onCall Operator hook fired once per *sent* call after it settles
   *   (see {@link DownstreamCallEvent}). WHY here: `get` is the one place every
   *   counted call passes, so once every sent call has settled, events equal
   *   `stats.total` (a call still in flight when the response is sent -- an
   *   orphaned prefetch or an error-orphaned NAIVE sibling -- fires later).
   */
  constructor(
    private readonly baseUrl: string,
    timeoutMs?: number,
    private readonly maxCalls?: number,
    private readonly headers: Readonly<Record<string, string>> = {},
    private readonly onCall?: DownstreamCallHook,
  ) {
    validateMaxDownstreamCalls(maxCalls);
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Refuses a call once the budget is spent. Runs before `track`, so a refused
   * call is never counted: `stats.total` only ever reports calls actually sent.
   */
  private checkBudget(): void {
    if (this.maxCalls === undefined || this.stats.total < this.maxCalls) return;
    throw new GraphQLError(
      `Downstream call budget of ${this.maxCalls} exceeded; call refused`,
      { extensions: { code: 'DOWNSTREAM_BUDGET_EXCEEDED', budget: this.maxCalls } },
    );
  }

  private track(path: string): void {
    this.stats.total += 1;
    this.stats.byPath[path] = (this.stats.byPath[path] ?? 0) + 1;
  }

  /**
   * Sends one counted GET. `read` checks the parsed body against the contract
   * and returns it typed. WHY the reader is passed in rather than cast after:
   * a cast is where a contract-breaking body used to slip through unchecked.
   * Without a reader the parsed JSON is returned as `unknown`.
   */
  get(path: string, params?: QueryParams): Promise<unknown>;
  get<T>(path: string, params: QueryParams | undefined, read: (body: unknown) => T): Promise<T>;
  async get<T>(path: string, params?: QueryParams, read?: (body: unknown) => T): Promise<T | unknown> {
    this.checkBudget();
    this.track(path);
    if (!this.onCall) return this.send(path, params, read);

    const started = performance.now();
    let status: number | null = null;
    let verdict = OK;
    try {
      return await this.send(path, params, read, (arrived) => (status = arrived));
    } catch (err: unknown) {
      verdict = classify(err);
      throw err;
    } finally {
      emit(this.onCall, { route: path, status, durationMs: performance.now() - started, ...verdict });
    }
  }

  /**
   * The uncounted transport for one call: build the URL, fetch, check status,
   * read and contract-check the body. `onStatus` reports the HTTP status as
   * soon as headers arrive, so a failure while reading the body still knows it.
   */
  private async send<T>(
    path: string,
    params: QueryParams | undefined,
    read: ((body: unknown) => T) | undefined,
    onStatus?: (status: number) => void,
  ): Promise<T | unknown> {
    const url = joinBaseUrl(this.baseUrl, path);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined) continue;
        url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
      }
    }

    let res: Response;
    try {
      res = await fetch(url, { headers: this.headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err: unknown) {
      throw fetchFailure(path, this.timeoutMs, err);
    }
    onStatus?.(res.status);

    if (!res.ok) {
      throw new GraphQLError(`Downstream REST error ${res.status} ${res.statusText} for ${path}`, {
        extensions: { code: 'DOWNSTREAM_ERROR', status: res.status },
      });
    }
    return readBody(path, res.status, await res.text(), read ?? parsedJson);
  }

  resetStats(): void {
    this.stats.total = 0;
    this.stats.byPath = {};
  }
}
