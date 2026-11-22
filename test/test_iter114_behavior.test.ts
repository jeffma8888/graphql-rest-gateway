import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import http from 'node:http';
import { execFile, type ExecFileException } from 'node:child_process';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend, createGateway, NAIVE, type GatewayOptions, type DownstreamCallEvent } from '../src/lib';
import { OPTION_ENV } from '../src/cli';
import { BENCHMARK_QUERY } from '../benchmark/benchmark';

/**
 * iter-114: default-ON request-body byte cap `maxRequestBytes` (PRODUCT row 35).
 * An over-cap body gets a typed HTTP 413 `REQUEST_TOO_LARGE` with
 * `connection: close`, before it is parsed, at 0 downstream calls.
 *
 * Black-box: every case builds its OWN bundled Fastify backend on port 0 and
 * puts `createGateway` in front of it, driven through `gw.fetch`, through
 * `gw.nodeListener` on an ephemeral 127.0.0.1 port, or through the CLI's
 * `startFromEnv`. Every call count is a TWO-counter oracle: the backend
 * `GET /__stats` delta must equal the `onDownstreamCall` events in the same
 * window. No wall-clock bound is asserted anywhere (only "it settles").
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const TSX = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SPAWN_T = 30_000;

const DEFAULT_CAP = 1048576;
const MiB2 = 2 * 1024 * 1024;
const CHUNK = 64 * 1024;
const SAMPLE = BENCHMARK_QUERY;
const ONE = '{ author(id:"a1"){ name } }';
const READ_IDS = '{ book(id: "a1-b1") { reviews { id } } }';
const ADD = 'mutation { addReview(bookId: "a1-b1", rating: 5, body: "Great read") { id } }';
const WRITER = { authorization: 'Bearer user:u9:read,write' };

type Body = { data?: any; errors?: Array<{ message: string; extensions?: Record<string, any> }>; extensions?: any };
type Gw = ReturnType<typeof createGateway>;
type Stats = { total: number; byRoute: Record<string, number> };
type Reply = { status: number; headers: Record<string, string | null>; text: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** JSON body `{query, variables:{pad}}` of EXACTLY `n` bytes (ASCII). */
function padded(query: string, n: number): string {
  const base = JSON.stringify({ query, variables: { pad: '' } }).length;
  expect(n, 'requested size below the unpadded body').toBeGreaterThanOrEqual(base);
  const s = JSON.stringify({ query, variables: { pad: 'x'.repeat(n - base) } });
  expect(Buffer.byteLength(s)).toBe(n);
  return s;
}

function expected413(cap: number): unknown {
  return { errors: [{ message: `Request body exceeds ${cap} bytes`, extensions: { code: 'REQUEST_TOO_LARGE', limitBytes: cap } }] };
}

function expect413(r: Reply, cap: number): void {
  expect(r.status, `status (body: ${r.text.slice(0, 200)})`).toBe(413);
  expect(r.headers['content-type'] ?? '').toMatch(/^application\/json/);
  expect((r.headers['connection'] ?? '').toLowerCase()).toBe('close');
  expect(JSON.parse(r.text)).toStrictEqual(expected413(cap));
}

function expectOneAuthor(r: Reply): void {
  expect(r.status, `status (body: ${r.text.slice(0, 200)})`).toBe(200);
  const b = JSON.parse(r.text) as Body;
  expect(b.errors).toBeUndefined();
  expect(b.data.author.name).toEqual(expect.any(String));
  expect(b.data.author.name.length).toBeGreaterThan(0);
}

async function toReply(res: Response): Promise<Reply> {
  const headers: Record<string, string | null> = {};
  for (const k of ['content-type', 'connection', 'server-timing']) headers[k] = res.headers.get(k);
  return { status: res.status, headers, text: await res.text() };
}

type Env = {
  gw: Gw;
  url: string;
  events: DownstreamCallEvent[];
  /** Run `fn`; return the backend hit delta, checked equal to the hook events in the same window. */
  measure: <R>(fn: () => Promise<R>) => Promise<{ calls: number; value: R }>;
};

async function withEnv<T>(opts: Omit<GatewayOptions, 'restBaseUrl'>, fn: (env: Env) => Promise<T>): Promise<T> {
  const app: FastifyInstance = buildBackend({ latencyMs: 0 }).app;
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  const events: DownstreamCallEvent[] = [];
  const gw = createGateway({ restBaseUrl: url, ...opts, onDownstreamCall: (e) => void events.push(e) });
  const stats = async () => (await (await fetch(`${url}/__stats`)).json()) as Stats;
  const measure: Env['measure'] = async (f) => {
    const before = await stats();
    const ev0 = events.length;
    const value = await f();
    await sleep(25);
    const after = await stats();
    const calls = after.total - before.total;
    expect(events.length - ev0, 'onDownstreamCall events vs /__stats delta').toBe(calls);
    return { calls, value };
  };
  try {
    return await fn({ gw, url, events, measure });
  } finally {
    await gw.close();
    const closing = app.close();
    app.server.closeAllConnections();
    await closing;
  }
}

function gqlRequest(body: BodyInit, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): Request {
  return new Request('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body,
    ...extra,
  } as RequestInit);
}

async function post(gw: Gw, body: string, headers: Record<string, string> = {}): Promise<Reply> {
  return toReply(await gw.fetch(gqlRequest(body, headers)));
}

/** Serve `handler` on an ephemeral 127.0.0.1 port. */
async function listen(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = http.createServer(handler);
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = (srv.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((ok) => {
        srv.closeAllConnections();
        srv.close(() => ok());
      }),
  };
}

/**
 * Raw HTTP POST on a FRESH connection (agent:false). `chunked` omits
 * content-length (transfer-encoding: chunked). Write errors after the reply
 * arrived (the server closed early) are tolerated; the reply is what counts.
 */
function rawPost(port: number, body: Buffer | string, opts: { chunked?: boolean; path?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return new Promise<Reply>((ok, fail) => {
    let got = false;
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json', ...(opts.headers ?? {}) };
    if (!opts.chunked) headers['content-length'] = String(buf.length);
    const req = http.request({ host: '127.0.0.1', port, path: opts.path ?? '/graphql', method: 'POST', agent: false, headers }, (res) => {
      got = true;
      const parts: Buffer[] = [];
      res.on('data', (d: Buffer) => parts.push(d));
      res.on('end', () => {
        const h: Record<string, string | null> = {};
        for (const k of ['content-type', 'connection', 'server-timing']) {
          const v = res.headers[k];
          h[k] = v === undefined ? null : Array.isArray(v) ? v.join(', ') : v;
        }
        ok({ status: res.statusCode ?? 0, headers: h, text: Buffer.concat(parts).toString('utf8') });
      });
      res.on('error', (e) => (got ? undefined : fail(e)));
    });
    req.on('error', (e) => {
      if (!got) fail(e);
    });
    if (opts.chunked) {
      for (let i = 0; i < buf.length; i += CHUNK) req.write(buf.subarray(i, i + CHUNK));
    } else {
      req.write(buf);
    }
    req.end();
  });
}

async function closedPort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createNetServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => ok(p));
    });
  });
}

// ---------------------------------------------------------------- EB1 ----

describe('EB1: default cap is 1048576', () => {
  it('gw.fetch: 1048577 bytes -> 413 REPLY (limitBytes 1048576) at 0 calls; 1048576 bytes -> 200 at 1 call', async () => {
    await withEnv({}, async (env) => {
      const over = await env.measure(() => post(env.gw, padded(ONE, DEFAULT_CAP + 1)));
      expect413(over.value, DEFAULT_CAP);
      expect(over.calls).toBe(0);
      const at = await env.measure(() => post(env.gw, padded(ONE, DEFAULT_CAP)));
      expectOneAuthor(at.value);
      expect(at.calls).toBe(1);
    });
  });

  it('nodeListener with content-length: the same boundary holds on the wire', async () => {
    await withEnv({}, async (env) => {
      const srv = await listen(env.gw.nodeListener);
      try {
        const over = await env.measure(() => rawPost(srv.port, padded(ONE, DEFAULT_CAP + 1)));
        expect413(over.value, DEFAULT_CAP);
        expect(over.calls).toBe(0);
        const at = await env.measure(() => rawPost(srv.port, padded(ONE, DEFAULT_CAP)));
        expectOneAuthor(at.value);
        expect(at.calls).toBe(1);
      } finally {
        await srv.close();
      }
    });
  });
});

// ---------------------------------------------------------------- EB2 ----

describe('EB2: a declared content-length over CAP is refused without reading', () => {
  it('ReadableStream body with content-length CAP+1: 413 at 0 calls, stream pulled at most once', async () => {
    await withEnv({}, async (env) => {
      let pulls = 0;
      const chunk = new Uint8Array(CHUNK).fill(0x20);
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          pulls++;
          c.enqueue(chunk);
        },
      });
      const r = await env.measure(async () =>
        toReply(await env.gw.fetch(gqlRequest(stream, { 'content-length': String(DEFAULT_CAP + 1) }, { duplex: 'half' }))),
      );
      expect413(r.value, DEFAULT_CAP);
      expect(r.calls).toBe(0);
      await sleep(50);
      expect(pulls).toBeLessThanOrEqual(1);
    });
  });

  it('explicit cap 2048 with content-length 4096 on a stream: 413 limitBytes 2048, pulled at most once', async () => {
    await withEnv({ maxRequestBytes: 2048 }, async (env) => {
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          pulls++;
          c.enqueue(new Uint8Array(4096).fill(0x20));
        },
      });
      const r = await env.measure(async () =>
        toReply(await env.gw.fetch(gqlRequest(stream, { 'content-length': '4096' }, { duplex: 'half' }))),
      );
      expect413(r.value, 2048);
      expect(r.calls).toBe(0);
      await sleep(50);
      expect(pulls).toBeLessThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------- EB3 ----

describe('EB3: a never-ending stream with no declared length', () => {
  it('settles to the 413 REPLY at 0 calls having pulled at most CAP + 262144 bytes', async () => {
    await withEnv({}, async (env) => {
      let pulled = 0;
      const chunk = new Uint8Array(CHUNK).fill(0x20);
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled += chunk.byteLength;
          c.enqueue(chunk);
        },
      });
      const r = await env.measure(async () => toReply(await env.gw.fetch(gqlRequest(stream, {}, { duplex: 'half' }))));
      expect413(r.value, DEFAULT_CAP);
      expect(r.calls).toBe(0);
      await sleep(50);
      expect(pulled).toBeGreaterThan(DEFAULT_CAP); // it really read past the cap before refusing
      expect(pulled).toBeLessThanOrEqual(DEFAULT_CAP + 262144);
    });
  });
});

// ---------------------------------------------------------------- EB4 ----

describe('EB4: Node HTTP path (nodeListener)', () => {
  it('chunked 2 MiB POST -> 413 with connection: close on the wire at 0 calls; a fresh 1000-byte POST -> 200 at 1 call', async () => {
    await withEnv({}, async (env) => {
      const srv = await listen(env.gw.nodeListener);
      try {
        const over = await env.measure(() => rawPost(srv.port, padded(ONE, MiB2), { chunked: true }));
        expect413(over.value, DEFAULT_CAP);
        expect(over.calls).toBe(0);
        const small = await env.measure(() => rawPost(srv.port, padded(ONE, 1000)));
        expectOneAuthor(small.value);
        expect(small.calls).toBe(1);
      } finally {
        await srv.close();
      }
    });
  });
});

// ---------------------------------------------------------------- EB5 ----

describe('EB5: a host that already consumed the stream into req.body', () => {
  async function withHost<T>(env: Env, as: 'buffer' | 'string', fn: (port: number) => Promise<T>): Promise<T> {
    const srv = await listen((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (d: Buffer) => parts.push(d));
      req.on('end', () => {
        const raw = Buffer.concat(parts);
        (req as unknown as { body: unknown }).body = as === 'buffer' ? raw : raw.toString('utf8');
        void env.gw.nodeListener(req, res);
      });
    });
    try {
      return await fn(srv.port);
    } finally {
      await srv.close();
    }
  }

  for (const as of ['buffer', 'string'] as const) {
    it(`req.body as a ${as}: 2 MiB -> 413 at 0 calls; small -> 200 at 1 call`, async () => {
      await withEnv({}, async (env) => {
        await withHost(env, as, async (port) => {
          // chunked, so no declared content-length: only the bytes on req.body can trip the cap
          const over = await env.measure(() => rawPost(port, padded(ONE, MiB2), { chunked: true }));
          expect413(over.value, DEFAULT_CAP);
          expect(over.calls).toBe(0);
          const small = await env.measure(() => rawPost(port, padded(ONE, 500), { chunked: true }));
          expectOneAuthor(small.value);
          expect(small.calls).toBe(1);
        });
      });
    });
  }

  it('explicit cap 2048 on a consumed Buffer body: 2049 -> 413 limitBytes 2048, 2048 -> 200', async () => {
    await withEnv({ maxRequestBytes: 2048 }, async (env) => {
      await withHost(env, 'buffer', async (port) => {
        const over = await env.measure(() => rawPost(port, padded(ONE, 2049), { chunked: true }));
        expect413(over.value, 2048);
        expect(over.calls).toBe(0);
        const at = await env.measure(() => rawPost(port, padded(ONE, 2048), { chunked: true }));
        expectOneAuthor(at.value);
        expect(at.calls).toBe(1);
      });
    });
  });
});

// ---------------------------------------------------------------- EB6 ----

describe('EB6: explicit cap 2048', () => {
  it('2049 bytes -> 413 "Request body exceeds 2048 bytes" at 0 calls; 2048 bytes -> 200 at 1 call', async () => {
    await withEnv({ maxRequestBytes: 2048 }, async (env) => {
      const over = await env.measure(() => post(env.gw, padded(ONE, 2049)));
      expect413(over.value, 2048);
      expect(JSON.parse(over.value.text).errors[0].message).toBe('Request body exceeds 2048 bytes');
      expect(over.calls).toBe(0);
      const at = await env.measure(() => post(env.gw, padded(ONE, 2048)));
      expectOneAuthor(at.value);
      expect(at.calls).toBe(1);
    });
  });

  it('maxRequestBytes: 1 refuses any non-empty POST with limitBytes 1', async () => {
    await withEnv({ maxRequestBytes: 1 }, async (env) => {
      const r = await env.measure(() => post(env.gw, JSON.stringify({ query: ONE })));
      expect413(r.value, 1);
      expect(r.calls).toBe(0);
    });
  });
});

// ---------------------------------------------------------------- EB7 ----

describe('EB7: maxRequestBytes: false turns the cap off', () => {
  it('a 2 MiB padded one-call query is 200 at 1 call through gw.fetch and nodeListener', async () => {
    await withEnv({ maxRequestBytes: false }, async (env) => {
      const a = await env.measure(() => post(env.gw, padded(ONE, MiB2)));
      expectOneAuthor(a.value);
      expect(a.calls).toBe(1);
      const srv = await listen(env.gw.nodeListener);
      try {
        const b = await env.measure(() => rawPost(srv.port, padded(ONE, MiB2), { chunked: true }));
        expectOneAuthor(b.value);
        expect(b.calls).toBe(1);
      } finally {
        await srv.close();
      }
    });
  });
});

// ---------------------------------------------------------------- EB8 ----

describe('EB8: batches are capped per HTTP request', () => {
  function batch(total: number): string {
    const op = (pad: string) => ({ query: ONE, variables: { pad } });
    const base = JSON.stringify([op(''), op('')]).length;
    const rest = total - base;
    const a = Math.floor(rest / 2);
    const s = JSON.stringify([op('x'.repeat(a)), op('x'.repeat(rest - a))]);
    expect(s.length).toBe(total);
    return s;
  }

  it('a 5000-byte 2-op batch (each op < 4096 alone) -> 413 at 0 calls', async () => {
    await withEnv({ maxBatchSize: 5, maxRequestBytes: 4096 }, async (env) => {
      const body = batch(5000);
      for (const op of JSON.parse(body) as unknown[]) expect(JSON.stringify(op).length).toBeLessThan(4096);
      const r = await env.measure(() => post(env.gw, body));
      expect413(r.value, 4096);
      expect(r.calls).toBe(0);
    });
  });

  it('a 2-op batch under 4096 bytes is served exactly as with the cap off (same body, same calls)', async () => {
    const body = batch(3000);
    const capped = await withEnv({ maxBatchSize: 5, maxRequestBytes: 4096 }, (env) => env.measure(() => post(env.gw, body)));
    const off = await withEnv({ maxBatchSize: 5, maxRequestBytes: false }, (env) => env.measure(() => post(env.gw, body)));
    expect(capped.value.status).toBe(200);
    expect(off.value.status).toBe(200);
    const results = JSON.parse(capped.value.text) as Body[];
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.data.author.name.length).toBeGreaterThan(0);
    expect(results.map((r) => r.data)).toEqual((JSON.parse(off.value.text) as Body[]).map((r) => r.data));
    expect(capped.calls).toBe(off.calls);
    expect(capped.calls).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------- EB9 ----

describe('EB9: no body, no effect', () => {
  it('GET SAMPLE with maxRequestBytes: 1 is 200 with the same data and 3 calls as the default; /healthz and /readyz are 200', async () => {
    const getSample = (gw: Gw) =>
      gw.fetch(new Request(`http://gateway.local/graphql?query=${encodeURIComponent(SAMPLE)}`, { headers: { accept: 'application/json' } }));
    const ref = await withEnv({ maxRequestBytes: false }, (env) => env.measure(async () => toReply(await getSample(env.gw))));
    expect(ref.value.status).toBe(200);
    expect(ref.calls).toBe(3);
    for (const cap of [1, 2048, undefined] as const) {
      await withEnv(cap === undefined ? {} : { maxRequestBytes: cap }, async (env) => {
        const g = await env.measure(async () => toReply(await getSample(env.gw)));
        expect(g.value.status).toBe(200);
        expect(JSON.parse(g.value.text).data).toEqual(JSON.parse(ref.value.text).data);
        expect(JSON.parse(g.value.text).errors).toBeUndefined();
        expect(g.calls).toBe(3);
        expect((await env.gw.fetch('http://gateway.local/healthz')).status).toBe(200);
        expect((await env.gw.fetch('http://gateway.local/readyz')).status).toBe(200);
      });
    }
  });
});

// --------------------------------------------------------------- EB10 ----

describe('EB10: a refused request has no side effects', () => {
  it('serverTiming: true: the 413 carries no server-timing header and fires 0 events', async () => {
    await withEnv({ serverTiming: true, maxRequestBytes: 2048 }, async (env) => {
      const ev0 = env.events.length;
      const r = await env.measure(() => post(env.gw, padded(ONE, 4096)));
      expect413(r.value, 2048);
      expect(r.calls).toBe(0);
      expect(env.events.length - ev0).toBe(0);
      expect(r.value.headers['server-timing']).toBeNull();
      // control: a served request on the same gateway does carry the header
      const ok = await env.measure(() => post(env.gw, padded(ONE, 1000)));
      expectOneAuthor(ok.value);
      expect(ok.value.headers['server-timing']).not.toBeNull();
    });
  });

  it('an over-cap addReview creates no review; the same mutation under the cap does (control)', async () => {
    await withEnv({ maxRequestBytes: 2048 }, async (env) => {
      const ids = async () => {
        const r = await post(env.gw, JSON.stringify({ query: READ_IDS }));
        expect(r.status).toBe(200);
        return (JSON.parse(r.text).data.book.reviews as Array<{ id: string }>).map((x) => x.id);
      };
      const before = await ids();
      const refused = await env.measure(() => post(env.gw, padded(ADD, 4096), WRITER));
      expect413(refused.value, 2048);
      expect(refused.calls).toBe(0);
      expect(await ids()).toEqual(before);
      const written = await env.measure(() => post(env.gw, padded(ADD, 1000), WRITER));
      expect(written.value.status).toBe(200);
      expect(JSON.parse(written.value.text).errors).toBeUndefined();
      expect(written.calls).toBe(1);
      expect((await ids()).length).toBe(before.length + 1);
    });
  });
});

// --------------------------------------------------------------- EB11 ----

describe('EB11: shutdown still wins', () => {
  it('after gw.close() has begun, an over-cap POST gets 503, not 413', async () => {
    const app: FastifyInstance = buildBackend({ latencyMs: 0 }).app;
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const gw = createGateway({ restBaseUrl: url, maxRequestBytes: 2048 });
    try {
      // control: before close the same body is a 413
      expect((await post(gw, padded(ONE, 4096))).status).toBe(413);
      const closing = gw.close();
      const r = await post(gw, padded(ONE, 4096));
      expect(r.status).toBe(503);
      await closing;
    } finally {
      await gw.close();
      const c = app.close();
      app.server.closeAllConnections();
      await c;
    }
  });
});

// --------------------------------------------------------------- EB12 ----

describe('EB12: library validation', () => {
  const throwsOf = (extra: Record<string, unknown>, restBaseUrl = 'http://127.0.0.1:9'): unknown => {
    try {
      const gw = createGateway({ restBaseUrl, ...extra } as GatewayOptions);
      void gw.close();
      return undefined;
    } catch (e) {
      return e;
    }
  };

  it('bad values throw synchronously (RangeError/TypeError naming maxRequestBytes) at 0 downstream calls', async () => {
    const app: FastifyInstance = buildBackend({ latencyMs: 0 }).app;
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const stats = async () => ((await (await fetch(`${url}/__stats`)).json()) as Stats).total;
      const before = await stats();
      for (const v of [0, -1, 1.5, NaN, Infinity, '1024', null, true]) {
        const e = throwsOf({ maxRequestBytes: v }, url);
        expect(e, `maxRequestBytes: ${String(v)} must throw`).toBeDefined();
        expect(e instanceof RangeError || e instanceof TypeError, `error class for ${String(v)}`).toBe(true);
        expect((e as Error).message).toContain('maxRequestBytes');
      }
      await sleep(25);
      expect((await stats()) - before).toBe(0);
    } finally {
      const c = app.close();
      app.server.closeAllConnections();
      await c;
    }
  });

  it('1, 1048576 and false are accepted', () => {
    for (const v of [1, 1048576, false]) expect(throwsOf({ maxRequestBytes: v }), `maxRequestBytes: ${String(v)}`).toBeUndefined();
  });

  it('the typo key maxRequestByte is rejected by the unknown-key check', () => {
    const e = throwsOf({ maxRequestByte: 2048 });
    expect(e).toBeInstanceOf(TypeError);
    expect((e as Error).message).toContain('Unknown createGateway option "maxRequestByte"');
    expect((e as Error).message).toContain('maxRequestBytes');
  });
});

// --------------------------------------------------------------- EB13 ----

type Running = { url: string; restBaseUrl: string; close(): Promise<void> };
type StartFromEnv = (env: Record<string, string | undefined>, log?: (line: string) => void) => Promise<Running>;
async function loadStart(): Promise<StartFromEnv> {
  return ((await import('../src/cli')) as unknown as { startFromEnv: StartFromEnv }).startFromEnv;
}

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '' };
  for (const k of Object.keys(env)) {
    if (k.startsWith('VITEST') || k.startsWith('npm_')) delete env[k];
    if (['REST_BASE_URL', 'PORT', 'TEST', 'NODE_ENV', 'MAX_REQUEST_BYTES'].includes(k)) delete env[k];
  }
  env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`;
  return { ...env, ...extra };
}

describe('EB13: env MAX_REQUEST_BYTES', () => {
  it('OPTION_ENV.maxRequestBytes === "MAX_REQUEST_BYTES"', () => {
    expect((OPTION_ENV as Record<string, string | null>).maxRequestBytes).toBe('MAX_REQUEST_BYTES');
  });

  async function withCli<T>(v: string | undefined, fn: (r: Running, port: number) => Promise<T>): Promise<T> {
    const r = await (await loadStart())({ PORT: '0', MAX_REQUEST_BYTES: v }, () => {});
    try {
      return await fn(r, Number(new URL(r.url).port));
    } finally {
      await r.close();
    }
  }

  it('MAX_REQUEST_BYTES=2048 -> CAP 2048 (2049 is 413, 2048 is 200)', async () => {
    await withCli('2048', async (_r, port) => {
      expect413(await rawPost(port, padded(ONE, 2049)), 2048);
      expectOneAuthor(await rawPost(port, padded(ONE, 2048)));
    });
  });

  it('MAX_REQUEST_BYTES=off -> no cap (2 MiB is 200)', async () => {
    await withCli('off', async (_r, port) => {
      expectOneAuthor(await rawPost(port, padded(ONE, MiB2)));
    });
  });

  for (const v of [undefined, '']) {
    it(`MAX_REQUEST_BYTES=${JSON.stringify(v)} -> default 1048576`, async () => {
      await withCli(v, async (_r, port) => {
        expect413(await rawPost(port, padded(ONE, DEFAULT_CAP + 1)), DEFAULT_CAP);
        expectOneAuthor(await rawPost(port, padded(ONE, DEFAULT_CAP)));
      });
    });
  }

  for (const v of ['0', '-5', '1.5', 'abc', '1e6']) {
    it(`in-process MAX_REQUEST_BYTES=${v} rejects before listening, naming MAX_REQUEST_BYTES`, async () => {
      const logs: string[] = [];
      let err: unknown;
      try {
        const r = await (await loadStart())({ PORT: '0', MAX_REQUEST_BYTES: v }, (l) => logs.push(l));
        await r.close();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('MAX_REQUEST_BYTES');
      expect(logs.join('\n')).not.toMatch(/listening|http:\/\//i);
    });
  }

  it('spawned `tsx src/index.ts` with MAX_REQUEST_BYTES=abc: exit 1, message on stderr, never listens', { timeout: SPAWN_T }, async () => {
    const port = await closedPort();
    const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((ok) => {
      execFile(
        process.execPath,
        [TSX, 'src/index.ts'],
        { cwd: root, env: cleanEnv({ PORT: String(port), MAX_REQUEST_BYTES: 'abc' }), timeout: 25_000, maxBuffer: 8 * 1024 * 1024 },
        (err: ExecFileException | null, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
          ok({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('MAX_REQUEST_BYTES');
    expect(run.stdout).not.toContain(`:${port}`);
  });
});

// --------------------------------------------------------------- EB14 ----

describe('EB14: oracles unchanged', () => {
  it('SAMPLE still costs 3 batched / 21 naive calls with the default cap on', async () => {
    const run = (opts: Omit<GatewayOptions, 'restBaseUrl'>) =>
      withEnv(opts, (env) => env.measure(() => post(env.gw, JSON.stringify({ query: SAMPLE }))));
    const batched = await run({});
    const naive = await run({ loaderOptions: NAIVE });
    expect(batched.value.status).toBe(200);
    expect(naive.value.status).toBe(200);
    expect(batched.calls).toBe(3);
    expect(naive.calls).toBe(21);
    expect(JSON.parse(batched.value.text).data).toEqual(JSON.parse(naive.value.text).data);
  });

  it('the N+1 regression test files are still present with their 3/21 oracle', () => {
    const guard = readFileSync(resolve(root, 'test', 'n-plus-1.test.ts'), 'utf8');
    expect(guard).toMatch(/\b21\b/);
    expect(guard).toMatch(/\b3\b/);
  });
});

// --------------------------------------------------------------- EB15 ----

describe('EB15: README', () => {
  const lines = readme.split('\n');
  const section = (h: string) => {
    const i = lines.findIndex((l) => l.startsWith(h));
    expect(i, `heading ${h}`).toBeGreaterThanOrEqual(0);
    const j = lines.findIndex((l, k) => k > i && l.startsWith('## '));
    return lines.slice(i, j < 0 ? undefined : j).join('\n');
  };

  it('GatewayOptions table row for maxRequestBytes states default, false, 413 REQUEST_TOO_LARGE', () => {
    const rows = lines.filter((l) => l.startsWith('| `maxRequestBytes`'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('1048576');
    expect(rows[0]).toContain('false');
    expect(rows[0]).toContain('413');
    expect(rows[0]).toContain('REQUEST_TOO_LARGE');
  });

  it('env table row for MAX_REQUEST_BYTES states off, the default and 413', () => {
    const rows = lines.filter((l) => l.startsWith('| `MAX_REQUEST_BYTES`'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('off');
    expect(rows[0]).toContain('1048576');
    expect(rows[0]).toContain('maxRequestBytes');
    expect(rows[0]).toContain('REQUEST_TOO_LARGE');
  });

  it('one §9 design-decision bullet explains default-ON: the token cap runs after a full buffer', () => {
    const s9 = section('## 9.');
    const bullets = s9.split('\n').filter((l) => l.startsWith('- ') && l.includes('maxRequestBytes'));
    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toMatch(/default-ON|on by default/i);
    expect(bullets[0]).toMatch(/token/i);
    expect(bullets[0]).toMatch(/buffer/i);
    expect(bullets[0]).toContain('REQUEST_TOO_LARGE');
  });

  it('§8 lists this iteration\'s test file', () => {
    expect(section('## 8.')).toContain('test_iter114_behavior.test.ts');
  });
});
