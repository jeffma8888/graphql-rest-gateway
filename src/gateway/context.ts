import { GraphQLError } from 'graphql';
import { RestClient, type DownstreamCallHook, type InFlightCalls } from './datasources/rest-client.js';
import { buildDataSources, type DataSources } from './datasources/index.js';
import { buildLoaders, BATCHED, type Loaders, type LoaderOptions } from './loaders.js';
import { buildServices, type Services } from './services.js';

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
  /** Operator hook fired once per sent downstream call; forwarded to RestClient. Unset = none. */
  onDownstreamCall?: DownstreamCallHook;
  /**
   * The edge request's abort signal; forwarded to RestClient. Once it aborts,
   * no further downstream call is sent and an in-flight one is cancelled as
   * `CLIENT_CLOSED_REQUEST`. Unset = calls run to completion as before.
   */
  signal?: AbortSignal;
  /**
   * The gateway's in-flight registry (`coalesceInFlight`); forwarded to
   * RestClient. Ignored under `loaderOptions.cache === false`, so NAIVE always
   * shows every call it makes. Unset = every call is sent by its own request.
   */
  inFlightCalls?: InFlightCalls;
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
  const loaderOptions = opts.loaderOptions ?? BATCHED;
  const restClient =
    opts.restClient ??
    new RestClient(
      opts.restBaseUrl ?? 'http://127.0.0.1:4001',
      opts.downstreamTimeoutMs,
      opts.maxDownstreamCalls,
      opts.downstreamHeaders,
      opts.onDownstreamCall,
      opts.signal,
      loaderOptions.cache ? opts.inFlightCalls : undefined,
    );
  const datasources = buildDataSources(restClient);
  const loaders = buildLoaders(datasources, loaderOptions);
  const services = buildServices(datasources, loaders, loaderOptions.cache);
  const auth = parseAuth(opts.authorization);
  return { auth, services, loaders, datasources, restClient };
}

/** An authenticated caller: `requireAuth` narrows `userId` to a string. */
export type AuthenticatedContext = AuthContext & { userId: string };

/**
 * Guard helper for resolvers that require an authenticated caller (today
 * `Mutation.addReview`). Call it FIRST, before argument checks or loads, so an
 * anonymous request learns nothing else and costs 0 downstream calls.
 */
export function requireAuth(ctx: GatewayContext): AuthenticatedContext {
  if (!ctx.auth.userId) {
    throw new GraphQLError('Unauthenticated', { extensions: { code: 'UNAUTHENTICATED' } });
  }
  return { ...ctx.auth, userId: ctx.auth.userId };
}
