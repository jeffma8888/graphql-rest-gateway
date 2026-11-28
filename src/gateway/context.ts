import { GraphQLError } from 'graphql';
import { RestClient, type DownstreamCache, type DownstreamCallHook, type InFlightCalls } from './datasources/rest-client.js';
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
  /**
   * A caller identity already established at the edge (`createGateway`'s
   * `authenticate` verifier). When set it is used as-is and `authorization`
   * is not parsed; unset = the stub {@link parseAuth} reads `authorization`.
   */
  auth?: AuthContext;
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
  /**
   * The gateway's shared TTL cache of downstream GET bodies
   * (`downstreamCacheTtlMs`); forwarded to RestClient. Ignored under
   * `loaderOptions.cache === false`, like `inFlightCalls`. Unset = no cache.
   */
  downstreamCache?: DownstreamCache;
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

/**
 * An embedder-supplied edge verifier (`createGateway({ authenticate })`).
 * WHY sync: the context factory is memoised per Request synchronously, so a
 * Promise return fails closed rather than racing the first operation.
 */
export type Authenticate = (request: Request) => AuthContext | null;

/** Signed-out caller; a fresh object each time so no request can mutate another's. */
function anonymous(): AuthContext {
  return { userId: null, scopes: [] };
}

/**
 * `userId` is a non-empty string or null; `scopes` is an array of strings only.
 * Each field is read ONCE and the validated snapshot is returned, so a getter
 * or Proxy cannot pass the check with one value and hand back another.
 */
function snapshotAuth(value: unknown): AuthContext | null {
  if (typeof value !== 'object' || value === null) return null;
  const { userId, scopes } = value as Record<string, unknown>;
  if (!(userId === null || (typeof userId === 'string' && userId !== ''))) return null;
  if (!Array.isArray(scopes)) return null;
  const copy: unknown[] = Array.from(scopes as unknown[]);
  if (!copy.every((scope) => typeof scope === 'string')) return null;
  return { userId, scopes: copy as string[] };
}

/**
 * Runs the verifier once and FAILS CLOSED: a throw, a thenable or a malformed
 * result becomes the anonymous caller, so the `UNAUTHENTICATED`/
 * `@requiresScope`/`pii` gates refuse it at 0 downstream calls. WHY the throw
 * is swallowed rather than surfaced: its message may carry key or JWKS
 * detail, which must never reach a response body. A thenable gets a no-op
 * rejection handler so an async verifier never raises `unhandledRejection`.
 * A valid result is copied (`scopes` snapshotted) so the verifier cannot mutate
 * a live request's identity afterwards.
 */
export function verifyAuth(authenticate: Authenticate, request: Request): AuthContext {
  // One try covers the shape checks too: a hostile getter or Proxy result fails closed as well.
  try {
    const result: unknown = authenticate(request);
    if (isThenable(result)) {
      Promise.resolve(result).catch(() => undefined);
      return anonymous();
    }
    return snapshotAuth(result) ?? anonymous();
  } catch {
    return anonymous();
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
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
      loaderOptions.cache ? opts.downstreamCache : undefined,
    );
  const datasources = buildDataSources(restClient);
  const loaders = buildLoaders(datasources, loaderOptions);
  const services = buildServices(datasources, loaders, loaderOptions.cache);
  const auth = opts.auth ?? parseAuth(opts.authorization);
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

/**
 * Guard for a field annotated `@requiresScope(scope: ...)` in the SDL (wired
 * generically in `schema.ts`, so no resolver names a scope by hand). WHY it
 * takes an already-authenticated caller: an anonymous request must stay
 * UNAUTHENTICATED, never FORBIDDEN, so `requireAuth` always runs first. The
 * match is exact and case-sensitive, like the `pii` check, so `WRITE` or
 * `writer` never grants `write`.
 */
export function requireScope(auth: AuthenticatedContext, scope: string): void {
  if (!auth.scopes.includes(scope)) {
    throw new GraphQLError(`Missing required scope: ${scope}`, {
      extensions: { code: 'FORBIDDEN', requiredScope: scope },
    });
  }
}
