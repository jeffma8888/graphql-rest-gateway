import { GraphQLError } from 'graphql';

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
   */
  constructor(
    private readonly baseUrl: string,
    timeoutMs?: number,
    private readonly maxCalls?: number,
    private readonly headers: Readonly<Record<string, string>> = {},
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

  async get<T>(path: string, params?: QueryParams): Promise<T> {
    this.checkBudget();
    this.track(path);

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
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new GraphQLError(`Downstream request to ${path} timed out after ${this.timeoutMs}ms`, {
          extensions: { code: 'DOWNSTREAM_TIMEOUT' },
        });
      }
      throw err;
    }

    if (!res.ok) {
      throw new GraphQLError(`Downstream REST error ${res.status} ${res.statusText} for ${path}`, {
        extensions: { code: 'DOWNSTREAM_ERROR', status: res.status },
      });
    }
    return (await res.json()) as T;
  }

  resetStats(): void {
    this.stats.total = 0;
    this.stats.byPath = {};
  }
}
