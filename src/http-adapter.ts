import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Node `http` ⇄ fetch bridge for `npm start`. WHY it exists: mounting
 * `gateway.yoga` directly on `createServer` bypasses `GatewayServer.fetch`,
 * the only path that refuses new work (503) and counts in-flight requests
 * during shutdown. Routing every request through a fetch handler keeps that
 * bookkeeping the single source of truth; this module only adds what a socket
 * server needs on top: `connection: close` once shutdown begins, and knowing
 * when responses have finished writing so sockets can be destroyed safely.
 */

type FetchHandler = (request: Request) => Promise<Response>;

/** Handle returned by {@link createDrainAwareListener}. */
export interface DrainAwareListener {
  /** Pass to `http.createServer`. */
  listener: RequestListener;
  /**
   * Resolves once every response started so far has finished writing, or after
   * `timeoutMs`, whichever comes first. WHY: `server.closeAllConnections()`
   * destroys sockets, which would truncate a response still being flushed.
   */
  flushed(timeoutMs: number): Promise<void>;
}

/** `new Request` rejects a body on these methods. */
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

/** Absolute-form targets (`GET http://h/x`) parse alone; origin-form ones are resolved against Host. */
function requestUrl(req: IncomingMessage): URL {
  const target = req.url ?? '/';
  return URL.canParse(target) ? new URL(target) : new URL(`http://${req.headers.host ?? 'localhost'}${target}`);
}

function toRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const headers = new Headers();
  // rawHeaders keeps repeated headers as separate entries, unlike the merged `req.headers`.
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    headers.append(req.rawHeaders[i] as string, req.rawHeaders[i + 1] as string);
  }
  const method = req.method ?? 'GET';
  const body = BODYLESS_METHODS.has(method) ? null : (Readable.toWeb(req) as ReadableStream<Uint8Array>);
  // `duplex: 'half'` is required by Node's fetch for a streamed body but missing from the global RequestInit type.
  const init: RequestInit & { duplex: 'half' } = { method, headers, body, signal, duplex: 'half' };
  return new Request(requestUrl(req), init);
}

/** `connectionClose` is decided at write time, so a response finishing after shutdown began also closes its socket. */
async function sendResponse(res: ServerResponse, response: Response, connectionClose: boolean): Promise<void> {
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') res.setHeader(name, value);
  });
  // Set-Cookie must stay one header per cookie; `forEach` would join them with commas.
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader('set-cookie', cookies);
  if (connectionClose) res.setHeader('connection', 'close');
  // `new Response(null, { status: 503 })` has statusText ''; let Node supply the standard reason phrase.
  res.writeHead(response.status, response.statusText || undefined);
  if (response.body === null) {
    res.end();
    return;
  }
  // Yoga answers with @whatwg-node ponyfill streams, which `Readable.fromWeb` rejects; both
  // kinds are async-iterable, and `pipeline` still applies backpressure and client-abort teardown.
  await pipeline(Readable.from(response.body as unknown as AsyncIterable<Uint8Array>), res);
}

/** Never rejects: a broken client socket or a malformed request must not become an unhandled rejection. */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  fetch: FetchHandler,
  isClosing: () => boolean,
): Promise<void> {
  // Mirrors Yoga's own node adapter: a client that disconnects aborts its request.
  const abort = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  let request: Request;
  try {
    request = toRequest(req, abort.signal);
  } catch {
    // Unparseable target or Host: the client's fault, and never worth a downstream call.
    res.writeHead(isClosing() ? 503 : 400, { connection: 'close' }).end();
    return;
  }
  try {
    await sendResponse(res, await fetch(request), isClosing());
  } catch {
    if (res.headersSent) res.destroy();
    else res.writeHead(isClosing() ? 503 : 500, { connection: 'close' }).end();
  }
}

async function settleWithin(pending: Promise<void>[], timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(pending),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * Builds a node request listener that serves every request through `fetch`
 * (pass `gateway.fetch`). `isClosing` reports whether shutdown has begun;
 * from then on every response carries `connection: close`.
 */
export function createDrainAwareListener(fetch: FetchHandler, isClosing: () => boolean): DrainAwareListener {
  const open = new Set<Promise<void>>();
  return {
    listener(req, res) {
      const handled: Promise<void> = handle(req, res, fetch, isClosing).finally(() => open.delete(handled));
      open.add(handled);
    },
    flushed: (timeoutMs) => settleWithin([...open], timeoutMs),
  };
}
