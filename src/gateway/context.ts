import { GraphQLError } from 'graphql';
import { RestClient } from './datasources/rest-client';
import { buildDataSources, type DataSources } from './datasources';
import { buildLoaders, BATCHED, type Loaders, type LoaderOptions } from './loaders';
import { buildServices, type Services } from './services';

/**
 * Request-scoped GraphQL context.
 *
 * Everything here is rebuilt PER REQUEST. That is deliberate: the DataLoaders
 * carry a per-request cache, so they must not outlive the request. `restClient`
 * is exposed so tests and the benchmark can read the downstream call counter.
 */

export interface AuthContext {
  userId: string | null;
  scopes: string[];
}

export interface GatewayContext {
  auth: AuthContext;
  services: Services;
  loaders: Loaders;
  datasources: DataSources;
  restClient: RestClient;
}

export interface CreateContextOptions {
  restBaseUrl?: string;
  /** Inject a pre-built client (tests/benchmark read its stats afterwards). */
  restClient?: RestClient;
  authorization?: string | null;
  loaderOptions?: LoaderOptions;
  /** Downstream REST call timeout in ms; forwarded to RestClient. */
  downstreamTimeoutMs?: number;
  /** Per-request ceiling on sent downstream calls; forwarded to RestClient. Unset = unlimited. */
  maxDownstreamCalls?: number;
  /**
   * Header name -> value sent on every downstream call of this request
   * (`createGateway` fills it from the `forwardHeaders` allowlist). Unset = none.
   */
  downstreamHeaders?: Readonly<Record<string, string>>;
}

/**
 * Stub bearer-token parsing. A real gateway verifies a signed JWT and derives
 * identity + scopes; here we accept a `user:<id>:<scope,scope>` token to
 * demonstrate the context-threading pattern without pulling in an auth vendor.
 */
export function parseAuth(authorization?: string | null): AuthContext {
  if (!authorization) return { userId: null, scopes: [] };
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match?.[1]) return { userId: null, scopes: [] };

  const parts = match[1].split(':');
  if (parts[0] === 'user' && parts[1]) {
    return { userId: parts[1], scopes: parts[2] ? parts[2].split(',').filter(Boolean) : [] };
  }
  return { userId: null, scopes: [] };
}

export function createContext(opts: CreateContextOptions): GatewayContext {
  const restClient =
    opts.restClient ??
    new RestClient(
      opts.restBaseUrl ?? 'http://127.0.0.1:4001',
      opts.downstreamTimeoutMs,
      opts.maxDownstreamCalls,
      opts.downstreamHeaders,
    );
  const datasources = buildDataSources(restClient);
  const loaderOptions = opts.loaderOptions ?? BATCHED;
  const loaders = buildLoaders(datasources, loaderOptions);
  const services = buildServices(datasources, loaders, loaderOptions.cache);
  const auth = parseAuth(opts.authorization);
  return { auth, services, loaders, datasources, restClient };
}

/** Guard helper for resolvers that require an authenticated caller. */
export function requireAuth(ctx: GatewayContext): AuthContext {
  if (!ctx.auth.userId) {
    throw new GraphQLError('Unauthenticated', { extensions: { code: 'UNAUTHENTICATED' } });
  }
  return ctx.auth;
}
