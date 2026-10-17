import { createYoga, type Plugin } from 'graphql-yoga';
import { schema } from './schema';
import { createContext, type GatewayContext } from './context';
import type { LoaderOptions } from './loaders';
import { depthLimit } from './security/depth-limit';
import { complexityLimit } from './security/complexity';

export interface GatewayOptions {
  restBaseUrl: string;
  maxDepth?: number;
  maxComplexity?: number;
  loaderOptions?: LoaderOptions;
  /** Downstream REST call timeout in ms. Finite default (30s) when omitted. */
  downstreamTimeoutMs?: number;
}

/**
 * Register our custom validation rules through envelop's `onValidate` hook, so
 * depth + complexity limits run during the standard GraphQL validation phase
 * (before execution) for every request.
 */
function securityPlugin(maxDepth: number, maxComplexity: number): Plugin {
  return {
    onValidate({ addValidationRule }) {
      addValidationRule(depthLimit(maxDepth));
      addValidationRule(complexityLimit(maxComplexity));
    },
  };
}

export function createGateway(opts: GatewayOptions) {
  const maxDepth = opts.maxDepth ?? 10;
  const maxComplexity = opts.maxComplexity ?? 1000;

  return createYoga<Record<string, never>, GatewayContext>({
    schema,
    context: ({ request }) =>
      createContext({
        restBaseUrl: opts.restBaseUrl,
        authorization: request.headers.get('authorization'),
        loaderOptions: opts.loaderOptions,
        downstreamTimeoutMs: opts.downstreamTimeoutMs,
      }),
    plugins: [securityPlugin(maxDepth, maxComplexity)],
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
}
