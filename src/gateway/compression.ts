import { promisify } from 'node:util';
import { gzip, deflate } from 'node:zlib';
import type { Plugin } from 'graphql-yoga';

/**
 * Response compression for non-streaming GraphQL JSON. WHY a gateway plugin
 * and not Yoga's `useContentEncoding()`: that plugin splits `accept-encoding`
 * on `,` with no trim or q-values (so `gzip;q=0` still gzips), and it
 * compresses every body, including `@defer` multipart and SSE, which a
 * compressor buffers until the last part, breaking "cheap part first".
 */

/** Codings this gateway can produce, in server preference order (ties go to the first). */
const SUPPORTED = ['gzip', 'deflate'] as const;
type Coding = (typeof SUPPORTED)[number];

/** Promisified so a large page is compressed on the libuv pool, not the event loop. */
const ENCODERS: Record<Coding, (body: Uint8Array) => Promise<Buffer>> = {
  gzip: promisify(gzip),
  deflate: promisify(deflate),
};

/**
 * Only `application/json` and `application/<x>+json` (graphql-response+json).
 * WHY not `\bjson\b`: that would also match `application/json-patch`, and the
 * streaming types (`multipart/mixed`, `text/event-stream`) must never match.
 */
export const JSON_CONTENT_TYPE = /^application\/([^;\s]+\+)?json\s*(;|$)/i;

/** An RFC 9110 qvalue: `0`..`1` with up to three decimals. */
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * Parses `accept-encoding` into coding → q. A malformed q drops only its own
 * entry, so a garbled header degrades to identity rather than a 4xx.
 */
function parseAcceptEncoding(header: string): Map<string, number> {
  const weights = new Map<string, number>();
  for (const entry of header.split(',')) {
    const [rawName, ...params] = entry.split(';');
    const name = rawName!.trim().toLowerCase();
    if (name === '') continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split('=').map((part) => part.trim());
      if (key?.toLowerCase() !== 'q') continue;
      q = value !== undefined && QVALUE.test(value) ? Number(value) : Number.NaN;
    }
    if (!Number.isNaN(q)) weights.set(name, q);
  }
  return weights;
}

/**
 * The supported coding with the highest q above 0, or undefined for identity.
 * An explicitly listed coding wins over `*`, so `gzip;q=0, *` never picks gzip.
 */
export function negotiateEncoding(header: string | null): Coding | undefined {
  if (!header) return undefined;
  const weights = parseAcceptEncoding(header);
  const wildcard = weights.get('*') ?? 0;
  let best: Coding | undefined;
  let bestQ = 0;
  for (const coding of SUPPORTED) {
    const q = weights.get(coding) ?? wildcard;
    if (q > bestQ) {
      best = coding;
      bestQ = q;
    }
  }
  return best;
}

/** Appends `accept-encoding` to `vary` unless a token already covers it. */
function addVary(headers: Headers): void {
  const tokens = (headers.get('vary') ?? '').split(',').map((token) => token.trim().toLowerCase());
  if (tokens.includes('accept-encoding') || tokens.includes('*')) return;
  headers.append('vary', 'accept-encoding');
}

/**
 * Compresses GraphQL JSON responses of at least `minBytes` identity bytes.
 * WHY GraphQL responses are marked in `onResultProcess`: that hook runs only
 * for GraphQL results, so `/healthz`, `/readyz` and GraphiQL are never
 * touched, whichever path they are served at.
 */
export function compressionPlugin(minBytes: number): Plugin {
  const graphqlRequests = new WeakSet<Request>();
  return {
    onResultProcess({ request }) {
      graphqlRequests.add(request);
    },
    async onResponse({ request, response, setResponse, fetchAPI }) {
      if (!graphqlRequests.delete(request)) return;
      if (response.body === null || response.headers.has('content-encoding')) return;
      if (!JSON_CONTENT_TYPE.test(response.headers.get('content-type') ?? '')) return;
      const coding = negotiateEncoding(request.headers.get('accept-encoding'));
      if (coding === undefined) return;
      // Yoga sets content-length on JSON results, so a small reply skips the body read.
      const declared = Number(response.headers.get('content-length') ?? Number.NaN);
      if (declared < minBytes) return;
      const identity = new Uint8Array(await response.arrayBuffer());
      const headers = new Headers(response.headers);
      const init = { status: response.status, statusText: response.statusText, headers };
      // WHY re-check: content-length was absent (e.g. a future chunked JSON reply), so the size is known only now.
      if (identity.byteLength < minBytes) {
        setResponse(new fetchAPI.Response(identity, init));
        return;
      }
      const compressed = await ENCODERS[coding](identity);
      headers.set('content-encoding', coding);
      headers.set('content-length', String(compressed.byteLength));
      addVary(headers);
      setResponse(new fetchAPI.Response(new Uint8Array(compressed), init));
    },
  };
}
