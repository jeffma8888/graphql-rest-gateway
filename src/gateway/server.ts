import { createYoga, type YogaServerInstance, type Plugin } from 'graphql-yoga';
import { getOperationAST, validate, type DocumentNode, type ExecutionResult, type GraphQLError } from 'graphql';
import { schema } from './schema.js';
import { createContext, type GatewayContext } from './context.js';
import { validateForwardHeaders, validateMaxDownstreamCalls } from './datasources/rest-client.js';
import type { LoaderOptions } from './loaders.js';
import { depthLimit, measureDepth } from './security/depth-limit.js';
import {
  complexityLimit,
  complexityError,
  estimateComplexity,
  variableResolver,
} from './security/complexity.js';
import { getValidationResult, buildFragmentMap } from './security/validation-cache.js';
import { parseWithTokenLimit } from './security/token-limit.js';

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
}

type YogaInstance = YogaServerInstance<Record<string, never>, GatewayContext>;

export interface GatewayServer {
  yoga: YogaInstance;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
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
        const rootType =
          op.operation === 'query'
            ? gqlSchema.getQueryType()
            : op.operation === 'mutation'
              ? gqlSchema.getMutationType()
              : gqlSchema.getSubscriptionType();
        cost = estimateComplexity(
          op.selectionSet,
          rootType,
          (name) => gqlSchema.getType(name) ?? undefined,
          fragments,
          defaultListSize,
          variableResolver(op, args.variableValues),
        );
        depth = measureDepth(op.selectionSet, fragments);
        if (cost > maxComplexity) {
          setResultAndStopExecution({ errors: [complexityError(cost, maxComplexity, op)] });
          return;
        }
      }

      return {
        onExecuteDone({ result, setResult }) {
          if (Symbol.asyncIterator in Object(result)) return;
          const execResult = result as ExecutionResult;
          setResult({
            ...execResult,
            extensions: {
              ...execResult.extensions,
              queryComplexity: { cost, depth },
            },
          });
        },
      };
    },
  };
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
      return {
        onExecuteDone({ result, setResult }) {
          if (Symbol.asyncIterator in Object(result)) return;
          const execResult = result as ExecutionResult;
          setResult({
            ...execResult,
            extensions: {
              ...execResult.extensions,
              downstreamCalls: { total: restClient.stats.total },
            },
          });
        },
      };
    },
  };
}

export function createGateway(opts: GatewayOptions): GatewayServer {
  validateMaxDownstreamCalls(opts.maxDownstreamCalls);
  const forwardHeaders = validateForwardHeaders(opts.forwardHeaders);
  validateMaxBatchSize(opts.maxBatchSize);
  const maxDepth = opts.maxDepth ?? 10;
  const maxComplexity = opts.maxComplexity ?? 1000;

  let shuttingDown = false;
  let inFlight = 0;
  let drainResolve: (() => void) | null = null;

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
      securityPlugin(maxDepth, maxComplexity),
      queryComplexityPlugin(maxComplexity, 5),
      downstreamCallsPlugin(),
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

  return {
    yoga,
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
    async close(): Promise<void> {
      shuttingDown = true;
      if (inFlight > 0) {
        await Promise.race([
          new Promise<void>((resolve) => {
            drainResolve = resolve;
          }),
          new Promise<void>((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS)),
        ]);
      }
    },
  };
}
