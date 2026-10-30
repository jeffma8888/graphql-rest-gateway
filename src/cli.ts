import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildBackend } from './rest-backend/server';
import { createGateway, type GatewayOptions } from './gateway/server';
import { validateForwardHeaders } from './gateway/datasources/rest-client';
import { createDrainAwareListener } from './http-adapter';

/**
 * CLI composition for `npm start`, kept free of import-time side effects (no
 * listeners, no `process.on`, no `process.exit`) so tests can boot and tear it
 * down in-process. `src/index.ts` owns signals and exit codes.
 */

/** Handle to a gateway started by {@link startFromEnv}. */
export interface RunningGateway {
  /** `http://localhost:<actualPort>/graphql` — the real port, even when `PORT=0`. */
  url: string;
  /** External: `REST_BASE_URL` exactly as given. Bundled: the bundled backend's listen URL. */
  restBaseUrl: string;
  backend: 'bundled' | 'external';
  /** Stops what this call started; an external backend is never touched. */
  close(): Promise<void>;
}

type Env = Record<string, string | undefined>;

const DEFAULT_PORT = 4000;
const DEFAULT_REST_LATENCY_MS = 25;
const MAX_PORT = 65535;
/** Same bound as the gateway's in-flight drain: a slow reader cannot hold shutdown open forever. */
const FLUSH_TIMEOUT_MS = 5000;

/** Unset and `''` both mean "use the default", so `VAR= npm start` behaves like omitting it. */
function isUnset(raw: string | undefined): raw is undefined | '' {
  return raw === undefined || raw === '';
}

/**
 * Strict decimal-integer parse. `Number.parseInt` would silently accept
 * `'1.5'` or `'10abc'`, which is exactly the silent misconfiguration a
 * fail-fast CLI exists to prevent.
 */
function readInt(name: string, raw: string | undefined, min: 0 | 1): number | undefined {
  if (isUnset(raw)) return undefined;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min) {
    const kind = min === 0 ? 'a non-negative' : 'a positive';
    throw new Error(`${name} must be ${kind} decimal integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Only http(s) makes sense for a REST backend; `localhost:4001` parses as protocol `localhost:`.
 * A path prefix (`/api/v1`) is honoured downstream, but a query string or fragment would be
 * silently discarded on every call, so it is rejected. The raw `?`/`#` check catches a bare
 * `http://h/?`, whose parsed `search` is empty.
 */
function readRestBaseUrl(raw: string | undefined): string | undefined {
  if (isUnset(raw)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`REST_BASE_URL must be an absolute http(s) URL, got ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`REST_BASE_URL must use http: or https:, got ${JSON.stringify(raw)}`);
  }
  if (parsed.search !== '' || parsed.hash !== '' || /[?#]/.test(raw)) {
    throw new Error(`REST_BASE_URL must not contain a query string or fragment, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * Comma-separated header allowlist. Whitespace is trimmed and empty entries
 * (a trailing comma) dropped, so `' authorization , x-request-id ,'` is two
 * names; each is then validated like the library option, naming the variable.
 */
function readForwardHeaders(raw: string | undefined): string[] | undefined {
  if (isUnset(raw)) return undefined;
  const names = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  return names.length === 0 ? undefined : validateForwardHeaders(names, 'FORWARD_HEADERS');
}

interface CliConfig {
  port: number;
  /** Undefined → boot the bundled backend. */
  externalBaseUrl: string | undefined;
  /** Only meaningful (and only validated) in bundled mode. */
  restLatencyMs: number;
  limits: Omit<GatewayOptions, 'restBaseUrl' | 'loaderOptions'>;
}

/** Validates every variable up front so a bad value never leaves a half-started process. */
function parseEnv(env: Env): CliConfig {
  const externalBaseUrl = readRestBaseUrl(env.REST_BASE_URL);
  const port = readInt('PORT', env.PORT, 0) ?? DEFAULT_PORT;
  if (port > MAX_PORT) throw new Error(`PORT must be <= ${MAX_PORT}, got ${JSON.stringify(env.PORT)}`);
  const restLatencyMs =
    externalBaseUrl === undefined
      ? (readInt('REST_LATENCY_MS', env.REST_LATENCY_MS, 0) ?? DEFAULT_REST_LATENCY_MS)
      : DEFAULT_REST_LATENCY_MS;
  return {
    port,
    externalBaseUrl,
    restLatencyMs,
    limits: {
      maxDepth: readInt('MAX_DEPTH', env.MAX_DEPTH, 1),
      maxComplexity: readInt('MAX_COMPLEXITY', env.MAX_COMPLEXITY, 1),
      downstreamTimeoutMs: readInt('DOWNSTREAM_TIMEOUT_MS', env.DOWNSTREAM_TIMEOUT_MS, 1),
      maxDownstreamCalls: readInt('MAX_DOWNSTREAM_CALLS', env.MAX_DOWNSTREAM_CALLS, 1),
      forwardHeaders: readForwardHeaders(env.FORWARD_HEADERS),
    },
  };
}

/** Promise wrapper so listen errors (EADDRINUSE) reject instead of crashing via an unhandled 'error'. */
function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/**
 * Stops accepting connections and sweeps the sockets idle right now. Sockets
 * mid-request are left alone here; they end themselves after their
 * `connection: close` response, and `closeAllConnections()` catches stragglers.
 */
function stopListening(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeIdleConnections();
  });
}

/**
 * Boots the gateway from environment variables: in front of `REST_BASE_URL`
 * when set (the strangler-fig on-ramp), otherwise in front of the bundled
 * demo backend. Rejects before anything listens if any variable is invalid.
 */
export async function startFromEnv(
  env: Env,
  // eslint-disable-next-line no-console
  log: (line: string) => void = (line) => console.log(line),
): Promise<RunningGateway> {
  const config = parseEnv(env);

  // forceCloseConnections: the gateway's own keep-alive sockets must not stall shutdown.
  const bundled =
    config.externalBaseUrl === undefined
      ? buildBackend({ latencyMs: config.restLatencyMs, forceCloseConnections: true }).app
      : undefined;
  const restBaseUrl = bundled
    ? await bundled.listen({ port: 0, host: '127.0.0.1' })
    : (config.externalBaseUrl as string);

  const gateway = createGateway({ restBaseUrl, ...config.limits });
  let shuttingDown = false;
  // Never `createServer(gateway.yoga)`: that bypasses gateway.fetch's 503 + in-flight drain.
  const http = createDrainAwareListener((request) => gateway.fetch(request), () => shuttingDown);
  const server = createServer(http.listener);
  let port: number;
  try {
    port = await listen(server, config.port);
  } catch (err) {
    await gateway.close();
    await bundled?.close();
    throw err;
  }

  let closing: Promise<void> | undefined;
  const url = `http://localhost:${port}/graphql`;
  log(
    bundled
      ? `REST backend (bundled): ${restBaseUrl} (latency ${config.restLatencyMs}ms/request)`
      : `REST backend (external): ${restBaseUrl}`,
  );
  log(`GraphQL gateway + GraphiQL: ${url}`);

  return {
    url,
    restBaseUrl,
    backend: bundled ? 'bundled' : 'external',
    // Memoized so a double Ctrl-C (SIGINT + SIGINT/SIGTERM) shares one shutdown;
    // each step runs even if an earlier one rejects, so no listener can leak.
    // Order: refuse new work (503 + connection: close) -> drain in-flight -> let
    // their responses flush -> destroy what is left, so a keep-alive socket that
    // went idle after the first sweep cannot hold close() open for keepAliveTimeout.
    close(): Promise<void> {
      closing ??= (async () => {
        shuttingDown = true;
        // One shared deadline: a handler stuck past the drain bound must not be waited on twice.
        const deadline = Date.now() + FLUSH_TIMEOUT_MS;
        const stopped = stopListening(server);
        try {
          await gateway.close();
          await http.flushed(Math.max(0, deadline - Date.now()));
        } finally {
          server.closeAllConnections();
          try {
            await stopped;
          } finally {
            await bundled?.close();
          }
        }
      })();
      return closing;
    },
  };
}
