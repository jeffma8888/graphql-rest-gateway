import type { RequestListener } from 'node:http';
import { createYoga, isAsyncIterable, type YogaServerInstance, type Plugin } from 'graphql-yoga';
import { getOperationAST, validate, GraphQLError, type DocumentNode, type ExecutionResult } from 'graphql';
import { schema } from './schema.js';
import { createContext, type GatewayContext } from './context.js';
import {
  RestClient,
  validateForwardHeaders,
  validateMaxDownstreamCalls,
  type DownstreamCallHook,
} from './datasources/rest-client.js';
import { AuthorDataSource } from './datasources/index.js';
import type { LoaderOptions } from './loaders.js';
import { createDrainAwareListener } from '../http-adapter.js';
import { depthLimit } from './security/depth-limit.js';
import {
  complexityLimit,
  complexityError,
  measureOperation,
  variableResolver,
} from './security/complexity.js';
import { getValidationResult, buildFragmentMap } from './security/validation-cache.js';
import { parseWithTokenLimit } from './security/token-limit.js';
import { validateGatewayOptions } from './options.js';
import { deferAcceptPlugin } from './defer.js';

export interface GatewayOptions {
  restBaseUrl: string;
  maxDepth?: number;
  maxComplexity?: number;
  loaderOptions?: LoaderOptions;
  /** Downstream REST call timeout in ms. Finite default (30s) when omitted. */
  downstreamTimeoutMs?: number;
  /**
   * Per-request ceiling on downstream REST calls actually sent. A call past it
   * is refused before it leaves the gateway (`DOWNSTREAM_BUDGET_EXCEEDED`).
   * Unlimited when omitted.
   */
  maxDownstreamCalls?: number;
  /**
   * Edge request headers (case-insensitive names) copied onto every downstream
   * REST call of the same request, e.g. `['authorization', 'x-request-id']`.
   * Opt-in allowlist: nothing is forwarded when omitted, and a header the
   * caller did not send is not sent. Invalid or hop-by-hop names throw.
   */
  forwardHeaders?: readonly string[];
  /**
   * Opt-in GraphQL-over-HTTP request batching: a POST whose JSON body is an
   * array of up to this many operations is served as one batch, and every
   * operation in it shares one request-scoped `RestClient`, loader set and
   * `maxDownstreamCalls` budget. Batching is off (400) when omitted.
   */
  maxBatchSize?: number;
  /**
   * Operator-side hook called once for every downstream REST call this gateway
   * sends, after it settles, with its route template, HTTP status, duration,
   * outcome and error code (see `DownstreamCallEvent`). WHY a hook and not a response
   * field: per-route data is backend topology, which clients must not see.
   * Never awaited; a throw or rejection is swallowed, so it cannot change a
   * response. Budget-refused calls, calls refused after the edge client
   * disconnected, and the `/readyz` probe fire nothing; a call cancelled in
   * flight by that disconnect fires `outcome: 'aborted'`. An orphaned
   * lookahead prefetch can fire after its response was sent.
   */
  onDownstreamCall?: DownstreamCallHook;
}

type YogaInstance = YogaServerInstance<Record<string, never>, GatewayContext>;

export interface GatewayServer {
  yoga: YogaInstance;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /**
   * Drain-aware listener for `http.createServer`: every request goes through
   * `fetch`, so after `close()` it answers 503, and every response then carries
   * `connection: close`. WHY not mount `yoga` directly: that bypasses `fetch`,
   * so it keeps serving after `close()` and `close()` cannot wait for it.
   * The same function on every read, so it can be passed and compared freely.
   */
  nodeListener: RequestListener;
  close(): Promise<void>;
}

const DRAIN_TIMEOUT_MS = 5000;

/** Same rule as the other numeric limits: a positive safe integer, or omitted. */
function validateMaxBatchSize(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`maxBatchSize must be a positive integer, got ${String(value)}`);
  }
}

/**
 * Edge admission control, cheapest check first. WHY this order: the token
 * cap bounds the document at parse time, then the gateway's own linear
 * depth/complexity rules run on their own, and only a document within those
 * limits reaches graphql-js's specified rules (some of which are quadratic).
 * A limit rejection is returned alone, so a hostile document never pays for,
 * or reports, spec-rule validation. Those rules also fill the shared
 * validation cache that `queryComplexityPlugin` reads, so they are not added
 * to the spec-rule pass a second time.
 */
function securityPlugin(maxDepth: number, maxComplexity: number): Plugin {
  // Per gateway (its limits are fixed) and per parsed document: Yoga's parse
  // cache hands repeat queries the same DocumentNode, so the walk runs once.
  // Keyed on the document only because the schema is fixed per gateway; a
  // future schema swap (setSchema) would need the schema in the key too.
  const limitErrors = new WeakMap<DocumentNode, readonly GraphQLError[]>();
  return {
    onParse({ setParseFn }) {
      setParseFn(parseWithTokenLimit);
    },
    onValidate({ params, setResult }) {
      let errors = limitErrors.get(params.documentAST);
      if (!errors) {
        errors = validate(params.schema, params.documentAST, [
          depthLimit(maxDepth),
          complexityLimit(maxComplexity),
        ]);
        limitErrors.set(params.documentAST, errors);
      }
      if (errors.length > 0) setResult(errors);
    },
  };
}

function healthzPlugin(): Plugin {
  return {
    onRequest({ request, endResponse, fetchAPI }) {
      if (new URL(request.url).pathname === '/healthz') {
        endResponse(
          new fetchAPI.Response(JSON.stringify({ status: 'ok' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
    },
  };
}

/** A readiness verdict: the HTTP status and JSON body every waiting probe gets. */
interface Readiness {
  status: 200 | 503;
  body: { status: 'ready' } | { status: 'unready'; code: string };
}

/**
 * Fetches the first `/authors` page through the same data source (and so the
 * same contract reader) the resolvers use. WHY a fresh client per check, with
 * no forwarded headers and no budget: the probe belongs to no caller, so it
 * must never carry one caller's credential or spend one caller's budget, and
 * nothing from an earlier check (a counter, a result) may leak into the next.
 * The code is the typed downstream error's own `extensions.code`, so the probe
 * and GraphQL clients name the same failure the same way.
 */
async function checkReadiness(restBaseUrl: string, timeoutMs: number | undefined): Promise<Readiness> {
  try {
    await new AuthorDataSource(new RestClient(restBaseUrl, timeoutMs)).listAuthors(0, 1);
    return { status: 200, body: { status: 'ready' } };
  } catch (err: unknown) {
    const code = err instanceof GraphQLError ? err.extensions.code : undefined;
    return { status: 503, body: { status: 'unready', code: typeof code === 'string' ? code : 'DOWNSTREAM_UNREACHABLE' } };
  }
}

/**
 * `/readyz`: readiness for a load balancer, next to `/healthz`'s liveness.
 * WHY concurrent probes share one in-flight check: a fleet of LB probes must
 * not multiply into downstream load. WHY it is cleared on settle and never
 * cached: a cached verdict would keep routing to a backend that just died,
 * or keep refusing one that just recovered.
 */
function readyzPlugin(restBaseUrl: string, timeoutMs: number | undefined): Plugin {
  let inFlight: Promise<Readiness> | null = null;
  const check = (): Promise<Readiness> => {
    inFlight ??= checkReadiness(restBaseUrl, timeoutMs).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  return {
    async onRequest({ request, endResponse, fetchAPI }) {
      if (new URL(request.url).pathname !== '/readyz') return;
      const { status, body } = await check();
      endResponse(
        new fetchAPI.Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
      );
    },
  };
}

/**
 * Reports `extensions.queryComplexity` and enforces `maxComplexity` for
 * variable-dependent operations. WHY here: validation rules never see
 * variable values, so `authors(first: $n)` is only knowable at execute time.
 * Rejecting via `setResultAndStopExecution` happens before any resolver (zero
 * downstream calls) and, because this plugin precedes `downstreamCallsPlugin`,
 * the rejection carries no extensions -- the same shape as a validation
 * rejection. The variable-resolved cost is per request and never cached.
 */
function queryComplexityPlugin(maxComplexity: number, defaultListSize: number): Plugin {
  return {
    onExecute({ args, setResultAndStopExecution }) {
      const doc = args.document;
      const gqlSchema = args.schema;
      const cached = getValidationResult(doc);

      let cost: number;
      let depth: number;
      if (cached && cached.cost >= 0 && cached.depth >= 0) {
        cost = cached.cost;
        depth = cached.depth;
      } else {
        const fragments = cached?.fragments ?? buildFragmentMap(doc);
        // The operation actually being executed, not merely the first in the document.
        const op = getOperationAST(doc, args.operationName);
        if (!op) return;
        ({ cost, depth } = measureOperation(
          gqlSchema,
          op,
          fragments,
          defaultListSize,
          variableResolver(op, args.variableValues),
        ));
        if (cost > maxComplexity) {
          setResultAndStopExecution({ errors: [complexityError(cost, maxComplexity, op)] });
          return;
        }
      }

      const extensions = { queryComplexity: { cost, depth } };
      return {
        onExecuteDone({ result, setResult }) {
          if (!isAsyncIterable(result)) {
            setResult(withExtensions(result, extensions));
            return;
          }
          // A streamed (@defer) reply: the estimate is known up front, so it
          // rides on the first payload, where a client reads it before any
          // deferred part arrives.
          let first = true;
          return {
            onNext({ result: payload, setResult: setPayload }) {
              if (first) setPayload(withExtensions(payload, extensions));
              first = false;
            },
          };
        },
      };
    },
  };
}

/**
 * Copies one result (or one streamed payload) with `extra` merged into its
 * `extensions`. WHY one helper for both shapes: a plain reply and a @defer
 * payload must carry the extension keys in the same order and form.
 */
function withExtensions(result: ExecutionResult, extra: Record<string, unknown>): ExecutionResult {
  return { ...result, extensions: { ...result.extensions, ...extra } };
}

/**
 * Picks the allowlisted headers off one edge request. WHY per request and
 * only present ones: values belong to that caller alone, and an absent header
 * must stay absent downstream rather than become an empty credential.
 */
function pickHeaders(headers: Headers, names: readonly string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null) picked[name] = value;
  }
  return picked;
}

/**
 * Injects `extensions.downstreamCalls.total`: the measured number of REST calls
 * this request sent (incl. failed/timed-out; calls refused by `maxDownstreamCalls`
 * are not counted), next to `queryComplexity`'s estimate. WHY: it turns the
 * batching claim into proof on every live response. Safe to read per request
 * because the context factory builds one `RestClient` (and counter) per edge
 * HTTP request. In a batch every operation shares that counter, so each
 * element reports the batch-wide total at the moment its operation finished.
 * Only `total` is exposed -- a per-path breakdown would leak backend topology
 * to edge clients. Validation-rejected queries never reach `onExecute`, so
 * they carry no extension.
 */
function downstreamCallsPlugin(): Plugin<GatewayContext> {
  return {
    onExecute({ args }) {
      const { restClient } = args.contextValue;
      const stamp = (result: ExecutionResult): ExecutionResult =>
        withExtensions(result, { downstreamCalls: { total: restClient.stats.total } });
      return {
        onExecuteDone({ result, setResult }) {
          if (!isAsyncIterable(result)) {
            setResult(stamp(result));
            return;
          }
          // A streamed (@defer) reply: the count is only final once every
          // deferred part has resolved, so it rides on the last payload
          // (`hasNext: false`) and on no earlier one.
          return {
            onNext({ result: payload, setResult: setPayload }) {
              if ((payload as { hasNext?: boolean }).hasNext === false) setPayload(stamp(payload));
            },
          };
        },
      };
    },
  };
}

/**
 * Stamps `extensions.code = "BAD_USER_INPUT"` on graphql-js's variable-coercion
 * errors (`$n: Int` sent `"x"`, a missing `$id: ID!`, `null` in `[ID!]!`). WHY:
 * every other error a client can trigger carries a code, and clients branch on
 * it, but these arrive with none. Matched on ORIGIN, never on message text: by
 * the time `onExecute` runs, Yoga has already resolved the operation, so an
 * execution result with no `data` means the executor stopped while building
 * its execution context, i.e. while coercing variables, before any resolver
 * (0 downstream calls). Errors that already carry a code or a `path` (field
 * errors) are left untouched as defence in depth. Message, locations and
 * `originalError` are preserved. The HTTP 400 comes from the executor's
 * `extensions.http.status`, which survives only through the
 * `...error.extensions` spread below; do not drop it.
 */
function badUserInputPlugin(): Plugin {
  return {
    onExecute() {
      return {
        onExecuteDone({ result, setResult }) {
          if (isAsyncIterable(result)) return;
          if (result.data !== undefined || !result.errors?.length) return;
          setResult({ ...result, errors: result.errors.map(withBadUserInputCode) });
        },
      };
    },
  };
}

/** Copies one request error with `code` added, unless it is a field error or already coded. */
function withBadUserInputCode(error: GraphQLError): GraphQLError {
  if (error.path !== undefined || error.extensions?.code !== undefined) return error;
  return new GraphQLError(error.message, {
    nodes: error.nodes,
    source: error.source,
    positions: error.positions,
    originalError: error.originalError,
    extensions: { ...error.extensions, code: 'BAD_USER_INPUT' },
  });
}

export function createGateway(opts: GatewayOptions): GatewayServer {
  validateGatewayOptions(opts);
  validateMaxDownstreamCalls(opts.maxDownstreamCalls);
  const forwardHeaders = validateForwardHeaders(opts.forwardHeaders);
  validateMaxBatchSize(opts.maxBatchSize);
  const maxDepth = opts.maxDepth ?? 10;
  const maxComplexity = opts.maxComplexity ?? 1000;

  let shuttingDown = false;
  let inFlight = 0;
  // Fires at most once, so it is never reset to null: no new work is
  // admitted after shuttingDown, so inFlight reaches 0 only once after it.
  let drainResolve: (() => void) | null = null;
  let drainPromise: Promise<void> | null = null;

  // WHY memoised per Request: Yoga calls the context factory once per
  // operation, but hands every operation of one batched POST the same
  // `Request`. Keying on it makes a batch share one RestClient/loader set/
  // budget, while a new edge HTTP request (a new Request) never reuses one.
  const contexts = new WeakMap<Request, GatewayContext>();
  const contextFor = (request: Request): GatewayContext => {
    let context = contexts.get(request);
    if (!context) {
      context = createContext({
        restBaseUrl: opts.restBaseUrl,
        authorization: request.headers.get('authorization'),
        loaderOptions: opts.loaderOptions,
        downstreamTimeoutMs: opts.downstreamTimeoutMs,
        maxDownstreamCalls: opts.maxDownstreamCalls,
        downstreamHeaders: pickHeaders(request.headers, forwardHeaders),
        onDownstreamCall: opts.onDownstreamCall,
        // `/readyz` builds its own client without one: a prober leaving must
        // not cancel the check other probers share.
        signal: request.signal,
      });
      contexts.set(request, context);
    }
    return context;
  };

  const yoga = createYoga<Record<string, never>, GatewayContext>({
    schema,
    context: ({ request }) => contextFor(request),
    batching: opts.maxBatchSize === undefined ? false : { limit: opts.maxBatchSize },
    plugins: [
      {
        // One memo entry per handling: a caller-reused Request (GET) must not
        // inherit the previous call's loaders, counter or budget.
        onRequest({ request }) {
          contexts.delete(request);
        },
      },
      healthzPlugin(),
      readyzPlugin(opts.restBaseUrl, opts.downstreamTimeoutMs),
      securityPlugin(maxDepth, maxComplexity),
      deferAcceptPlugin(),
      queryComplexityPlugin(maxComplexity, 5),
      downstreamCallsPlugin(),
      badUserInputPlugin(),
    ],
    graphiql: {
      title: 'graphql-rest-gateway',
      defaultQuery: `# Nested query -- one call from the client, batched downstream.
query Sample {
  authors(first: 5) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges {
      cursor
      node {
        id
        name
        books {
          id
          title
          reviews { id rating reviewer }
        }
      }
    }
  }
}`,
    },
  });

  // `gateway` is read lazily, on the first request, so referencing it before its declaration is safe.
  const drainListener = createDrainAwareListener((request) => gateway.fetch(request), () => shuttingDown);
  const gateway: GatewayServer = {
    yoga,
    nodeListener: drainListener.listener,
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      if (shuttingDown) {
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      inFlight++;
      const done = () => {
        inFlight--;
        if (shuttingDown && inFlight === 0 && drainResolve) drainResolve();
      };
      const result = yoga.fetch(input as any, init as any);
      if (result instanceof Promise) {
        return result.finally(done);
      }
      done();
      return Promise.resolve(result);
    },
    // WHY one shared drain: a second close() (SIGINT + SIGTERM, afterAll +
    // helper) must not overwrite the first caller's resolver and strand it
    // until the cap. WHY clearTimeout: an uncleared cap timer keeps a drained
    // process alive for the rest of the 5 s, which embedders that await
    // close() and expect Node to exit would pay as a silent tail. WHY one
    // deadline for fetches AND nodeListener writes: an embedder calls
    // closeAllConnections() right after close(), which would truncate a body
    // still being written, yet a stuck request must not cost 5 s per phase.
    close(): Promise<void> {
      shuttingDown = true;
      if (!drainPromise) {
        if (inFlight === 0 && drainListener.idle()) return Promise.resolve();
        const deadline = Date.now() + DRAIN_TIMEOUT_MS;
        const fetches =
          inFlight === 0
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                const cap = setTimeout(resolve, DRAIN_TIMEOUT_MS);
                drainResolve = () => {
                  clearTimeout(cap);
                  resolve();
                };
              });
        drainPromise = fetches.then(() => drainListener.flushed(Math.max(0, deadline - Date.now())));
      }
      return drainPromise;
    },
  };
  return gateway;
}
