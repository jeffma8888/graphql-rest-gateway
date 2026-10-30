import { createYoga, type YogaServerInstance, type Plugin } from 'graphql-yoga';
import { getOperationAST, type ExecutionResult } from 'graphql';
import { schema } from './schema';
import { createContext, type GatewayContext } from './context';
import { validateMaxDownstreamCalls } from './datasources/rest-client';
import type { LoaderOptions } from './loaders';
import { depthLimit, measureDepth } from './security/depth-limit';
import {
  complexityLimit,
  complexityError,
  estimateComplexity,
  variableResolver,
} from './security/complexity';
import { getValidationResult, buildFragmentMap } from './security/validation-cache';

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
}

type YogaInstance = YogaServerInstance<Record<string, never>, GatewayContext>;

export interface GatewayServer {
  yoga: YogaInstance;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

const DRAIN_TIMEOUT_MS = 5000;

function securityPlugin(maxDepth: number, maxComplexity: number): Plugin {
  return {
    onValidate({ addValidationRule }) {
      addValidationRule(depthLimit(maxDepth));
      addValidationRule(complexityLimit(maxComplexity));
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
 * Injects `extensions.downstreamCalls.total`: the measured number of REST calls
 * this request sent (incl. failed/timed-out; calls refused by `maxDownstreamCalls`
 * are not counted), next to `queryComplexity`'s estimate. WHY: it turns the
 * batching claim into proof on every live response. Safe to read per request
 * because `createContext` builds a fresh `RestClient` (and counter) each time.
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
  const maxDepth = opts.maxDepth ?? 10;
  const maxComplexity = opts.maxComplexity ?? 1000;

  let shuttingDown = false;
  let inFlight = 0;
  let drainResolve: (() => void) | null = null;

  const yoga = createYoga<Record<string, never>, GatewayContext>({
    schema,
    context: ({ request }) =>
      createContext({
        restBaseUrl: opts.restBaseUrl,
        authorization: request.headers.get('authorization'),
        loaderOptions: opts.loaderOptions,
        downstreamTimeoutMs: opts.downstreamTimeoutMs,
        maxDownstreamCalls: opts.maxDownstreamCalls,
      }),
    plugins: [
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
