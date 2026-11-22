/**
 * Edge request-body byte cap (`maxRequestBytes`, default 1 MiB). WHY it
 * exists: the token cap and the depth/complexity limits run only after Yoga
 * has buffered and `JSON.parse`d the whole body, so without this any
 * anonymous client could make the gateway hold an arbitrarily large body in
 * memory (a 64 MB POST costs about +225 MB RSS) and still be served. The cap
 * is enforced while reading, before any parse, and never costs a downstream call.
 */

/** 1 MiB: about ten times the largest legitimate body the suite or benchmark sends. */
export const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;

/** What `GatewayServer.fetch` hands on to Yoga once the body is known to fit. */
export interface AdmittedRequest {
  input: RequestInfo | URL;
  init?: RequestInit;
}

/**
 * The typed 413. WHY `connection: close`: the rest of an over-cap body is
 * deliberately left unread, so the socket cannot carry another request. WHY
 * `content-length`: the Node listener holds the end of the reply until the
 * client stops sending (lingering close), and a sized body lets the client
 * read the whole reply meanwhile.
 */
export function requestTooLarge(limitBytes: number): Response {
  const body = {
    errors: [
      {
        message: `Request body exceeds ${limitBytes} bytes`,
        extensions: { code: 'REQUEST_TOO_LARGE', limitBytes },
      },
    ],
  };
  const text = JSON.stringify(body);
  return new Response(text, {
    status: 413,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(text, 'utf8')),
      connection: 'close',
    },
  });
}

/**
 * Byte size of an in-memory body, or undefined when only reading it tells
 * (a stream, `FormData`, `URLSearchParams`). Strings are sized as UTF-8,
 * which is how `Request` encodes them.
 */
function knownSize(body: BodyInit): number | undefined {
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8');
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof Blob) return body.size;
  return undefined;
}

/** A plain decimal `content-length`, else undefined (absent, or a value only the bytes can settle). */
function declaredLength(headers: Headers): number | undefined {
  const raw = headers.get('content-length');
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/**
 * Reads at most `limitBytes + 1` bytes of the body: the bytes when it fits,
 * else null. WHY the stream is released and never cancelled: on the Node
 * path, cancelling a `Readable.toWeb(req)` stream destroys the socket, which
 * would drop the 413 before it is written.
 */
async function readWithin(body: ReadableStream<Uint8Array>, limitBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) return null;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Rebuilt request → the request its bytes were read from. WHY: undici links a
 * Request's signal to its source's signal only through a WeakRef to the
 * source's own AbortController, so once the caller drops its Request (which
 * Yoga used to hold for the whole handling) a client abort would never reach
 * the rebuilt one, and downstream calls would no longer be cancelled. The
 * entry keeps the source alive exactly as long as the rebuilt request.
 */
const sources = new WeakMap<Request, Request>();

/**
 * The one choke point behind `GatewayServer.fetch` (and so `nodeListener`):
 * resolves to what Yoga should serve, or null when the body is over
 * `limitBytes`. A bodyless request and an in-memory body that fits pass
 * through untouched; a declared `content-length` over the cap is refused
 * without reading; anything else is counted as it is read, then rebuilt
 * from exactly the bytes read.
 */
export async function admitRequestBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  limitBytes: number,
): Promise<AdmittedRequest | null> {
  const body = init?.body ?? (input instanceof Request ? input.body : null);
  if (body === null || body === undefined) return { input, init };
  const size = init?.body == null ? undefined : knownSize(init.body);
  if (size !== undefined) return size > limitBytes ? null : { input, init };

  // `duplex: 'half'` is required by Node's fetch for a streamed body but missing from the global RequestInit type.
  const request =
    input instanceof Request && init === undefined
      ? input
      : new Request(input, { ...init, duplex: 'half' } as RequestInit & { duplex: 'half' });
  const declared = declaredLength(request.headers);
  if (declared !== undefined && declared > limitBytes) return null;
  if (request.body === null) return { input: request };
  const bytes = await readWithin(request.body, limitBytes);
  if (bytes === null) return null;
  const rebuilt = new Request(request, { body: bytes });
  sources.set(rebuilt, request);
  return { input: rebuilt };
}
