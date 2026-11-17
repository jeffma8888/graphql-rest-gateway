import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway, NAIVE, type GatewayServer } from '../src/lib';

/**
 * iter-99: response compression (`compressMinBytes`, PRODUCT row 66).
 *
 * Black-box: the bundled Fastify REST backend runs in-process on port 0
 * (latencyMs 0). Gateways are driven through `gw.fetch` with hand-built
 * `Request`s (so no transparent decompression happens), and through
 * `http.createServer(gw.nodeListener)` for the real-HTTP behaviour. Every
 * served query asserts a downstream call count read from the backend's own
 * `/__stats` (reset before each probe).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

const BENCH = '{ authors(first:5){ edges{ node{ id name books{ id title reviews{ id body } } } } } }';
const SMALL = '{ authors(first:1){ edges{ node{ id } } } }';
const DEFER = '{ authors(first:2){ edges{ node{ id ... @defer { books{ id } } } } } }';
const H = 'http://localhost';

type Body = {
  data?: { authors?: { edges: unknown[] } };
  errors?: unknown[];
  extensions?: { downstreamCalls?: { total: number } };
};

let backend: FastifyInstance;
let base: string;

async function calls(): Promise<number> {
  const r = await fetch(`${base}/__stats`);
  const s = (await r.json()) as { total: number };
  return s.total;
}
async function reset(): Promise<void> {
  const r = await fetch(`${base}/__stats/reset`, { method: 'POST' });
  if (!r.ok) throw new Error('stats reset failed');
}

const gateways: GatewayServer[] = [];
function gw(extra: Record<string, unknown> = {}): GatewayServer {
  const g = createGateway({ restBaseUrl: base, ...extra } as Parameters<typeof createGateway>[0]);
  gateways.push(g);
  return g;
}

function post(query: string, ae?: string, accept = 'application/json'): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept };
  if (ae !== undefined) headers['accept-encoding'] = ae;
  return new Request(`${H}/graphql`, { method: 'POST', headers, body: JSON.stringify({ query }) });
}
function get(path: string, accept: string, ae?: string, query?: string): Request {
  const headers: Record<string, string> = { accept };
  if (ae !== undefined) headers['accept-encoding'] = ae;
  const qs = query === undefined ? '' : `?query=${encodeURIComponent(query)}`;
  return new Request(`${H}${path}${qs}`, { headers });
}

async function raw(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}
function decode(res: Response, buf: Buffer): Buffer {
  const ce = (res.headers.get('content-encoding') ?? '').toLowerCase();
  if (ce === 'gzip') return zlib.gunzipSync(buf);
  if (ce === 'deflate') return zlib.inflateSync(buf);
  return buf;
}
function varyTokens(res: Response): string[] {
  return (res.headers.get('vary') ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}
/** "Not compressed": header absent, or Yoga's own SSE `none` marker (see report). */
function expectNotCompressed(res: Response): void {
  const ce = res.headers.get('content-encoding');
  if (ce !== null) expect(ce.toLowerCase()).toBe('none');
}

/** Identity reference bodies, fetched from a default gateway with no accept-encoding. */
let identityBench: Buffer;
let identitySmall: Buffer;

beforeAll(async () => {
  backend = buildBackend({ latencyMs: 0 }).app;
  base = await backend.listen({ port: 0, host: '127.0.0.1' });
  const g = gw();
  const a = await g.fetch(post(BENCH));
  identityBench = await raw(a);
  const b = await g.fetch(post(SMALL));
  identitySmall = await raw(b);
});

afterAll(async () => {
  while (gateways.length) await gateways.pop()!.close();
  await backend.close();
});

describe('reference sizes (spec notation)', () => {
  it('BENCH identity body > 1024 bytes, SMALL < 1024 bytes, both without content-encoding', () => {
    expect(identityBench.length).toBeGreaterThan(1024);
    expect(identitySmall.length).toBeLessThan(1024);
    const body = JSON.parse(identityBench.toString('utf8')) as Body;
    expect(body.extensions?.downstreamCalls?.total).toBe(3);
  });
});

describe('EB1: gzip on request', () => {
  it('BENCH + accept-encoding: gzip → 200 gzip, vary accept-encoding, ≤50 % size, identical decoded body, 3 calls', async () => {
    const g = gw();
    await reset();
    const res = await g.fetch(post(BENCH, 'gzip'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(varyTokens(res)).toContain('accept-encoding');
    const buf = await raw(res);
    const cl = res.headers.get('content-length');
    if (cl !== null) expect(Number(cl)).toBe(buf.length);
    expect(buf.length).toBeLessThanOrEqual(identityBench.length * 0.5);
    const dec = zlib.gunzipSync(buf);
    expect(dec.equals(identityBench)).toBe(true);
    const body = JSON.parse(dec.toString('utf8')) as Body;
    expect(body.errors).toBeUndefined();
    expect(body.data?.authors?.edges).toHaveLength(5);
    expect(body.extensions?.downstreamCalls?.total).toBe(3);
    expect(await calls()).toBe(3);
  });
});

describe('EB2: deflate', () => {
  it('accept-encoding: deflate → content-encoding deflate, inflated body equals identity, 3 calls', async () => {
    const g = gw();
    await reset();
    const res = await g.fetch(post(BENCH, 'deflate'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('deflate');
    expect(varyTokens(res)).toContain('accept-encoding');
    const buf = await raw(res);
    expect(zlib.inflateSync(buf).equals(identityBench)).toBe(true);
    expect(await calls()).toBe(3);
  });
});

describe('EB3: negotiation follows q-values', () => {
  const ENCODED: Array<[string, string]> = [
    ['gzip, deflate, br', 'gzip'],
    ['br;q=1.0, gzip;q=0.5', 'gzip'],
    ['deflate;q=1, gzip;q=0.4', 'deflate'],
    [' GZIP ', 'gzip'],
    ['*', 'gzip'],
  ];
  for (const [ae, want] of ENCODED) {
    it(`${JSON.stringify(ae)} → ${want}, decoded body identical`, async () => {
      const g = gw();
      const res = await g.fetch(post(BENCH, ae));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-encoding')).toBe(want);
      const buf = await raw(res);
      expect(decode(res, buf).equals(identityBench)).toBe(true);
    });
  }
  const IDENTITY = ['gzip;q=0', 'identity', 'br', '*;q=0', ''];
  for (const ae of IDENTITY) {
    it(`${JSON.stringify(ae)} → no content-encoding, body byte-identical to no header`, async () => {
      const g = gw();
      await reset();
      const res = await g.fetch(post(BENCH, ae));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-encoding')).toBeNull();
      expect((await raw(res)).equals(identityBench)).toBe(true);
      expect(await calls()).toBe(3);
    });
  }
});

describe('EB4: streams are never compressed', () => {
  it('@defer multipart/mixed with gzip → multipart, not compressed, same parts as without header, same calls', async () => {
    const g = gw();
    await reset();
    const plain = await g.fetch(get('/graphql', 'multipart/mixed', undefined, DEFER));
    const plainText = await plain.text();
    const plainCalls = await calls();
    await reset();
    const res = await g.fetch(get('/graphql', 'multipart/mixed', 'gzip', DEFER));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/^multipart\/mixed/);
    expect(res.headers.get('content-encoding')).toBeNull();
    const text = await res.text();
    expect(text).toBe(plainText);
    expect(text).toContain('"incremental"');
    expect(text).toContain('"hasNext":true');
    expect(await calls()).toBe(plainCalls);
    expect(plainCalls).toBeGreaterThan(0);
  });

  it('@defer POST multipart/mixed with gzip → not compressed either', async () => {
    const g = gw();
    const res = await g.fetch(post(DEFER, 'gzip', 'multipart/mixed'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/^multipart\/mixed/);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toContain('"incremental"');
  });

  it('@defer with accept text/event-stream and gzip → SSE, not compressed, same text and calls', async () => {
    const g = gw();
    await reset();
    const plain = await g.fetch(get('/graphql', 'text/event-stream', undefined, DEFER));
    const plainCe = plain.headers.get('content-encoding');
    const plainText = await plain.text();
    const plainCalls = await calls();
    await reset();
    const res = await g.fetch(get('/graphql', 'text/event-stream', 'gzip', DEFER));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/^text\/event-stream/);
    expectNotCompressed(res);
    expect(res.headers.get('content-encoding')).toBe(plainCe);
    const text = await res.text();
    expect(text).toBe(plainText);
    expect(text).toContain('event: next');
    expect(await calls()).toBe(plainCalls);
  });

  it('BENCH GET text/event-stream with gzip (body > 1024) → not compressed, same text, 3 calls', async () => {
    const g = gw();
    await reset();
    const plain = await g.fetch(get('/graphql', 'text/event-stream', undefined, BENCH));
    const plainText = await plain.text();
    expect(await calls()).toBe(3);
    await reset();
    const res = await g.fetch(get('/graphql', 'text/event-stream', 'gzip', BENCH));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/^text\/event-stream/);
    expectNotCompressed(res);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(1024);
    expect(text).toBe(plainText);
    expect(text).toContain('event: next');
    expect(await calls()).toBe(3);
  });
});

describe('EB5: threshold', () => {
  it('SMALL with gzip (default 1024) → no content-encoding, body identical to no header', async () => {
    const g = gw();
    await reset();
    const res = await g.fetch(post(SMALL, 'gzip'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect((await raw(res)).equals(identitySmall)).toBe(true);
    expect(await calls()).toBe(1);
  });

  it('compressMinBytes: 0 → SMALL is gzip, decoded body equals identity', async () => {
    const g = gw({ compressMinBytes: 0 });
    await reset();
    const res = await g.fetch(post(SMALL, 'gzip'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(varyTokens(res)).toContain('accept-encoding');
    expect(zlib.gunzipSync(await raw(res)).equals(identitySmall)).toBe(true);
    expect(await calls()).toBe(1);
  });

  it('compressMinBytes: 1_000_000 → BENCH not compressed', async () => {
    const g = gw({ compressMinBytes: 1_000_000 });
    await reset();
    const res = await g.fetch(post(BENCH, 'gzip'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect((await raw(res)).equals(identityBench)).toBe(true);
    expect(await calls()).toBe(3);
  });

  it('a threshold exactly at the identity size compresses ("at least"), one byte above does not', async () => {
    const n = identityBench.length;
    const at = await gw({ compressMinBytes: n }).fetch(post(BENCH, 'gzip'));
    expect(at.headers.get('content-encoding')).toBe('gzip');
    const above = await gw({ compressMinBytes: n + 1 }).fetch(post(BENCH, 'gzip'));
    expect(above.headers.get('content-encoding')).toBeNull();
  });
});

describe('EB6: opt-out', () => {
  it('compressMinBytes: false → BENCH + gzip has same headers (minus date) and body as default without header', async () => {
    const off = gw({ compressMinBytes: false });
    await reset();
    const res = await off.fetch(post(BENCH, 'gzip'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBeNull();
    const body = await raw(res);
    expect(await calls()).toBe(3);
    const ref = await gw().fetch(post(BENCH));
    const refBody = await raw(ref);
    const hdrs = (r: Response): Array<[string, string]> =>
      [...r.headers.entries()].filter(([k]) => k.toLowerCase() !== 'date').sort(([a], [b]) => a.localeCompare(b));
    expect(hdrs(res)).toEqual(hdrs(ref));
    expect(body.equals(refBody)).toBe(true);
  });
});

describe('EB7: unchanged without accept-encoding', () => {
  it('BENCH, SMALL, errors, GraphiQL, /healthz, /readyz: no content-encoding; status/body match a compression-off gateway', async () => {
    const on = gw();
    const off = gw({ compressMinBytes: false });
    const probes: Array<() => Request> = [
      () => post(BENCH),
      () => post(SMALL),
      () => post('{ authors('),
      () => post('{ nope }'),
      () => get('/graphql', 'text/html'),
      () => get('/healthz', 'application/json'),
      () => get('/readyz', 'application/json'),
    ];
    for (const mk of probes) {
      const a = await on.fetch(mk());
      const b = await off.fetch(mk());
      expect(a.headers.get('content-encoding')).toBeNull();
      expect(a.status).toBe(b.status);
      expect((await raw(a)).equals(await raw(b))).toBe(true);
    }
  });

  it('pinned HEAD observables: /healthz {"status":"ok"}, /readyz {"status":"ready"}, GraphiQL HTML', async () => {
    const g = gw();
    const h = await g.fetch(get('/healthz', 'application/json'));
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual({ status: 'ok' });
    const r = await g.fetch(get('/readyz', 'application/json'));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ready' });
    const html = await g.fetch(get('/graphql', 'text/html'));
    expect(html.status).toBe(200);
    expect((await html.text()).toLowerCase()).toContain('graphiql');
  });
});

describe('EB8: only GraphQL JSON is compressed', () => {
  it('/healthz, /readyz, GraphiQL (> 1024 bytes) with gzip → no content-encoding, plain bodies', async () => {
    const g = gw();
    const h = await g.fetch(get('/healthz', 'application/json', 'gzip'));
    expect(h.headers.get('content-encoding')).toBeNull();
    expect(JSON.parse((await raw(h)).toString('utf8'))).toEqual({ status: 'ok' });
    const r = await g.fetch(get('/readyz', 'application/json', 'gzip'));
    expect(r.headers.get('content-encoding')).toBeNull();
    expect(JSON.parse((await raw(r)).toString('utf8'))).toEqual({ status: 'ready' });
    const html = await g.fetch(get('/graphql', 'text/html', 'gzip'));
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type') ?? '').toMatch(/^text\/html/);
    expect(html.headers.get('content-encoding')).toBeNull();
    const text = (await raw(html)).toString('utf8');
    expect(text.length).toBeGreaterThan(1024);
    expect(text.toLowerCase()).toContain('graphiql');
  });

  it('GraphiQL with compressMinBytes: 0 and gzip is still not compressed', async () => {
    const html = await gw({ compressMinBytes: 0 }).fetch(get('/graphql', 'text/html', 'gzip'));
    expect(html.headers.get('content-encoding')).toBeNull();
    expect((await html.text()).toLowerCase()).toContain('graphiql');
  });

  it('small GraphQL error responses (syntax error, depth refusal) with gzip → no content-encoding, 0 calls', async () => {
    const g = gw();
    const g2 = gw({ maxDepth: 2 });
    await reset();
    for (const [gate, q] of [
      [g, '{ authors('],
      [g2, BENCH],
    ] as Array<[GatewayServer, string]>) {
      const res = await gate.fetch(post(q, 'gzip'));
      expect(res.headers.get('content-encoding')).toBeNull();
      const buf = await raw(res);
      expect(buf.length).toBeLessThan(1024);
      const body = JSON.parse(buf.toString('utf8')) as Body;
      expect(body.errors?.length ?? 0).toBeGreaterThan(0);
      expect(body.data?.authors).toBeUndefined();
    }
    expect(await calls()).toBe(0);
  });
});

describe('EB9: batching and the N+1 oracle are unchanged', () => {
  it('batched BENCH + gzip → backend 3, decoded total 3', async () => {
    await reset();
    const res = await gw().fetch(post(BENCH, 'gzip'));
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const body = JSON.parse(zlib.gunzipSync(await raw(res)).toString('utf8')) as Body;
    expect(body.extensions?.downstreamCalls?.total).toBe(3);
    expect(await calls()).toBe(3);
  });

  it('NAIVE BENCH + gzip → backend 21, decoded total 21', async () => {
    await reset();
    const res = await gw({ loaderOptions: NAIVE }).fetch(post(BENCH, 'gzip'));
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const body = JSON.parse(zlib.gunzipSync(await raw(res)).toString('utf8')) as Body;
    expect(body.data?.authors?.edges).toHaveLength(5);
    expect(body.extensions?.downstreamCalls?.total).toBe(21);
    expect(await calls()).toBe(21);
  });

  it('test/n-plus-1.test.ts still asserts batched vs naive call counts', () => {
    const src = readFileSync(resolve(root, 'test/n-plus-1.test.ts'), 'utf8');
    expect(src.length).toBeGreaterThan(0);
    expect(src).toMatch(/NAIVE|naive/);
    expect(src).not.toMatch(/accept-encoding|compressMinBytes/);
  });
});

describe('EB10: real HTTP via nodeListener', () => {
  let server: http.Server;
  let url: string;
  beforeAll(async () => {
    const g = gw();
    server = http.createServer(g.nodeListener);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('global fetch POST BENCH → 200 content-encoding gzip, transparently decoded JSON with 5 edges, 3 calls', async () => {
    await reset();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: BENCH }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const body = (await res.json()) as Body;
    expect(body.errors).toBeUndefined();
    expect(body.data?.authors?.edges).toHaveLength(5);
    expect(await calls()).toBe(3);
  });

  it('raw http.request with accept-encoding: gzip → gunzipSync gives the same data as identity', async () => {
    await reset();
    const payload = JSON.stringify({ query: BENCH });
    const { headers, buf } = await new Promise<{ headers: http.IncomingHttpHeaders; buf: Buffer }>((ok, fail) => {
      const req = http.request(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'accept-encoding': 'gzip',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => ok({ headers: res.headers, buf: Buffer.concat(chunks) }));
          res.on('error', fail);
        },
      );
      req.on('error', fail);
      req.end(payload);
    });
    expect(headers['content-encoding']).toBe('gzip');
    const dec = JSON.parse(zlib.gunzipSync(buf).toString('utf8')) as Body;
    const ref = JSON.parse(identityBench.toString('utf8')) as Body;
    expect(dec.data).toEqual(ref.data);
    expect(await calls()).toBe(3);
  });
});

describe('EB11: bad values throw', () => {
  const BAD: unknown[] = [-1, 1.5, NaN, Infinity, '1024', true, null];
  for (const v of BAD) {
    it(`compressMinBytes: ${String(typeof v === 'string' ? JSON.stringify(v) : v)} → TypeError naming compressMinBytes, 0 calls`, async () => {
      await reset();
      let err: unknown;
      try {
        createGateway({ restBaseUrl: base, compressMinBytes: v } as unknown as Parameters<typeof createGateway>[0]);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message).toContain('compressMinBytes');
      // a value error, not the unknown-key error a gateway without the option would throw
      expect((err as Error).message).not.toMatch(/^Unknown createGateway option/);
      expect(await calls()).toBe(0);
    });
  }

  const GOOD: unknown[] = [0, 1, 1024, false, undefined];
  for (const v of GOOD) {
    it(`compressMinBytes: ${String(v)} boots and serves BENCH`, async () => {
      const g = gw({ compressMinBytes: v });
      const res = await g.fetch(post(BENCH));
      expect(res.status).toBe(200);
      expect((await raw(res)).equals(identityBench)).toBe(true);
    });
  }

  it('compressMinBytes: undefined behaves as the default 1024 (BENCH gzip, SMALL identity)', async () => {
    const g = gw({ compressMinBytes: undefined });
    expect((await g.fetch(post(BENCH, 'gzip'))).headers.get('content-encoding')).toBe('gzip');
    expect((await g.fetch(post(SMALL, 'gzip'))).headers.get('content-encoding')).toBeNull();
  });

  it('typo compressMinByte → unknown-key TypeError with the compressMinBytes hint', () => {
    expect(() =>
      createGateway({ restBaseUrl: base, compressMinByte: 1024 } as unknown as Parameters<typeof createGateway>[0]),
    ).toThrow(new TypeError('Unknown createGateway option "compressMinByte" (did you mean compressMinBytes?)'));
  });
});

describe('EB12: docs', () => {
  const rows = readme.split('\n').filter((l) => l.startsWith('| `compressMinBytes`'));
  it('README options table has exactly one compressMinBytes row: number | false, default 1024', () => {
    expect(rows).toHaveLength(1);
    const cells = (rows[0] ?? '').split(/(?<!\\)\|/).map((c) => c.trim());
    expect(cells[2]).toMatch(/number\s*\\?\|\s*false/);
    expect(cells[3]).toContain('1024');
  });
  it('the row names gzip, deflate, the stream exclusion and false = off', () => {
    const row = rows[0] ?? '';
    expect(row).toMatch(/gzip/i);
    expect(row).toMatch(/deflate/i);
    expect(row).toMatch(/@defer|multipart/i);
    expect(row).toMatch(/SSE|event-stream/i);
    expect(row).toMatch(/`false`\s*=\s*off/);
  });
});
