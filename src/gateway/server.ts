import { createYoga, type YogaServerInstance, type Plugin } from 'graphql-yoga';
import { Kind, type ExecutionResult, type DefinitionNode, type FragmentDefinitionNode } from 'graphql';
import { schema } from './schema';
import { createContext, type GatewayContext } from './context';
import type { LoaderOptions } from './loaders';
import { depthLimit, measureDepth } from './security/depth-limit';
import { complexityLimit, estimateComplexity } from './security/complexity';

export interface GatewayOptions {
  restBaseUrl: string;
  maxDepth?: number;
  maxComplexity?: number;
  loaderOptions?: LoaderOptions;
  /** Downstream REST call timeout in ms. Finite default (30s) when omitted. */
  downstreamTimeoutMs?: number;
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

function queryComplexityPlugin(defaultListSize: number): Plugin {
  return {
    onExecute({ args }) {
      const doc = args.document;
      const gqlSchema = args.schema;
      const fragments = new Map<string, FragmentDefinitionNode>();
      for (const def of doc.definitions) {
        if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
      }
      const op = doc.definitions.find((d: DefinitionNode) => d.kind === Kind.OPERATION_DEFINITION);
      if (!op || op.kind !== Kind.OPERATION_DEFINITION) return;
      const rootType =
        op.operation === 'query'
          ? gqlSchema.getQueryType()
          : op.operation === 'mutation'
            ? gqlSchema.getMutationType()
            : gqlSchema.getSubscriptionType();
      const cost = estimateComplexity(
        op.selectionSet,
        rootType,
        (name) => gqlSchema.getType(name) ?? undefined,
        fragments,
        defaultListSize,
      );
      const depth = measureDepth(op.selectionSet, fragments);
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

export function createGateway(opts: GatewayOptions): GatewayServer {
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
      }),
    plugins: [healthzPlugin(), securityPlugin(maxDepth, maxComplexity), queryComplexityPlugin(5)],
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
