import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import http from 'node:http';
import { execFile, type ExecFileException } from 'node:child_process';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend, createGateway, type GatewayOptions, type DownstreamCallEvent } from '../src/lib';
import { OPTION_ENV } from '../src/cli';
import { BENCHMARK_QUERY } from '../benchmark/benchmark';

/**
 * iter-110: opt-in `Server-Timing` header (`serverTiming` / env
 * `SERVER_TIMING`, PRODUCT row 125).
 *
 * Black-box: every case builds its OWN bundled Fastify backend on port 0 and
 * puts `createGateway` in front of it, driven through `gw.fetch` with
 * hand-built `Request`s (no transparent decompression) or through
 * `http.createServer(gw.nodeListener)` for the real-HTTP compression leg.
 * Call counts are read from the backend's own `GET /__stats` and are
 * cross-checked as a FOUR-way equality: header N == body
 * `extensions.downstreamCalls.total` == `onDownstreamCall` events == backend
 * hits. The CLI is driven through `startFromEnv(env, log)` in-process plus ONE
 * spawned `tsx src/index.ts` (the refusal case).
 *
 * Timing: no wall-clock bound is asserted (H2). The duration oracle compares
 * the header's `dur` with the SUM of the hook's `durationMs` values (a pure
 * equality) and with the physical floor N × latencyMs − 1 (load only adds time).
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const TSX = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SPAWN_T = 30_000;

const SAMPLE = BENCHMARK_QUERY;
const ONE_BOOK = '{ book(id: "a1-b1") { title } }';
const NOT_FOUND = '{ book(id: "nope") { title } }';
const Q_DEFER = '{ authors(first:5){ edges { node { name ... @defer { books { reviews { rating } } } } } } }';
const ADD_REVIEW = 'mutation { addReview(bookId: "a1-b1", rating: 5, body: "Great read") { id } }';
const FORMAT = /^downstream;dur=\d+\.\d;desc="\d+ calls?"$/;
const ZERO = 'downstream;dur=0.0;desc="0 calls"';
const JSON_TYPES = ['application/json', 'application/graphql-response+json'] as const;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Body = { data?: any; errors?: Array<{ message: string; extensions?: Record<string, any> }>; extensions?: any };
type Gw = ReturnType<typeof createGateway>;
type Stats = { total: number; byRoute: Record<string, number> };
type Reply = { status: number; ctype: string; st: string | null; text: string; body: any };

function parseHeader(h: string | null): { dur: number; n: number; desc: string } {
  expect(h, 'server-timing header missing').not.toBeNull();
  expect(h!).toMatch(FORMAT);
  const m = /^downstream;dur=(\d+\.\d);desc="(\d+) (calls?)"$/.exec(h!)!;
  const n = Number(m[2]);
  // "1 call" for exactly one, "<N> calls" otherwise (including 0)
  expect(m[3]).toBe(n === 1 ? 'call' : 'calls');
  return { dur: Number(m[1]), n, desc: `${m[2]} ${m[3]}` };
}

async function startBackend(latencyMs = 0): Promise<{ url: string; stats: () => Promise<Stats>; close: () => Promise<void> }> {
  const app: FastifyInstance = buildBackend({ latencyMs }).app;
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return {
    url,
    stats: async () => (await (await fetch(`${url}/__stats`)).json()) as Stats,
    close: async () => {
      const closing = app.close();
      app.server.closeAllConnections();
      await closing;
    },
  };
}

type Env = {
  gw: Gw;
  events: DownstreamCallEvent[];
  /** Run `fn`, return the backend hit delta it caused. */
  measure: <R>(fn: () => Promise<R>) => Promise<{ calls: number; value: R }>;
};

async function withEnv<T>(
  opts: Omit<GatewayOptions, 'restBaseUrl'>,
  fn: (env: Env) => Promise<T>,
  latencyMs = 0,
): Promise<T> {
  const be = await startBackend(latencyMs);
  const events: DownstreamCallEvent[] = [];
  const user = opts.onDownstreamCall;
  const gw = createGateway({
    restBaseUrl: be.url,
    ...opts,
    onDownstreamCall: (e) => {
      events.push(e);
      return user?.(e);
    },
  });
  const measure: Env['measure'] = async (f) => {
    const before = await be.stats();
    const value = await f();
    await sleep(20);
    const after = await be.stats();
    return { calls: after.total - before.total, value };
  };
  try {
    return await fn({ gw, events, measure });
  } finally {
    await gw.close();
    await be.close();
  }
}

async function toReply(res: Response): Promise<Reply> {
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, ctype: res.headers.get('content-type') ?? '', st: res.headers.get('server-timing'), text, body };
}

async function post(gw: Gw, query: string, headers: Record<string, string> = {}, payload?: unknown): Promise<Reply> {
  const res = await gw.fetch(
    new Request('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: payload !== undefined ? JSON.stringify(payload) : JSON.stringify({ query }),
    }),
  );
  return toReply(res);
}

async function get(gw: Gw, path: string, headers: Record<string, string> = { accept: 'application/json' }): Promise<Reply> {
  return toReply(await gw.fetch(new Request(`http://gateway.local${path}`, { method: 'GET', headers })));
}

const totalOf = (b: Body) => b?.extensions?.downstreamCalls?.total as number;
const codes = (b: Body) => (b?.errors ?? []).map((e) => e.extensions?.code);

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

// ------------------------------------------------------------------- EBs ---

describe('EB1: format', () => {
  it('every JSON reply (ok, error, refusal) under both JSON media types carries exactly one well-formed header', async () => {
    await withEnv({ serverTiming: true, maxDepth: 3 }, async ({ gw }) => {
      for (const accept of JSON_TYPES) {
        for (const q of [SAMPLE, ONE_BOOK, NOT_FOUND, '{ authors(', '{ nope }', SAMPLE.replace('BenchmarkQuery', 'Deep')]) {
          const r = await post(gw, q, { accept });
          expect(r.ctype.startsWith('application/json') || r.ctype.startsWith('application/graphql-response+json')).toBe(true);
          expect(r.st, `${accept} ${q.slice(0, 30)}`).not.toBeNull();
          // one header only: Headers.get joins duplicates with ", ", which the anchored regex refuses
          expect(r.st!).toMatch(FORMAT);
          expect(r.st!).not.toContain(',');
          // aggregate only: no route names
          expect(r.st!).not.toMatch(/\/(authors|books|reviews)/);
        }
      }
    });
  });

  it('pluralisation: "1 call" for one, "3 calls" for three, "0 calls" for zero; dur has exactly one decimal', async () => {
    await withEnv({ serverTiming: true }, async ({ gw }) => {
      expect(parseHeader((await post(gw, ONE_BOOK)).st).desc).toBe('1 call');
      expect(parseHeader((await post(gw, SAMPLE)).st).desc).toBe('3 calls');
      const z = (await post(gw, '{ nope }')).st;
      expect(parseHeader(z).desc).toBe('0 calls');
      expect(z).toBe(ZERO);
      expect(z).toContain('dur=0.0;');
    });
  });
});

describe('EB2: count oracle (header N == extensions total == hook events == backend hits)', () => {
  it('SAMPLE over POST: 200, desc="3 calls", total 3, 3 events, 3 hits', async () => {
    await withEnv({ serverTiming: true }, async ({ gw, events, measure }) => {
      const m = await measure(() => post(gw, SAMPLE));
      expect(m.value.status).toBe(200);
      expect(m.value.body.errors).toBeUndefined();
      const h = parseHeader(m.value.st);
      expect(h.desc).toBe('3 calls');
      expect(totalOf(m.value.body)).toBe(3);
      expect(events).toHaveLength(3);
      expect(m.calls).toBe(3);
    });
  });

  it('SAMPLE over GET: desc="3 calls" == total == events == hits', async () => {
    await withEnv({ serverTiming: true }, async ({ gw, events, measure }) => {
      const m = await measure(() => get(gw, `/graphql?query=${encodeURIComponent(SAMPLE)}`));
      expect(m.value.status).toBe(200);
      expect(m.value.body.errors).toBeUndefined();
      expect(parseHeader(m.value.st).n).toBe(3);
      expect(totalOf(m.value.body)).toBe(3);
      expect(events).toHaveLength(3);
      expect(m.calls).toBe(3);
    });
  });

  it('root book(id:"a1-b1"){title}: desc="1 call" == total == events == hits', async () => {
    await withEnv({ serverTiming: true }, async ({ gw, events, measure }) => {
      const m = await measure(() => post(gw, ONE_BOOK));
      expect(m.value.body.data.book.title).toEqual(expect.any(String));
      expect(parseHeader(m.value.st).desc).toBe('1 call');
      expect(totalOf(m.value.body)).toBe(1);
      expect(events).toHaveLength(1);
      expect(m.calls).toBe(1);
    });
  });

  it('sequential requests each report their own count (3, 1, 3), never a running total', async () => {
    await withEnv({ serverTiming: true }, async ({ gw }) => {
      const ns = [];
      for (const q of [SAMPLE, ONE_BOOK, SAMPLE]) ns.push(parseHeader((await post(gw, q)).st).n);
      expect(ns).toEqual([3, 1, 3]);
    });
  });
});

describe('EB3: duration oracle (sum of settled durationMs, not wall-clock)', () => {
  const L = 15;
  it(`latency ${L} ms: |dur − Σ event.durationMs| ≤ 0.1 and dur ≥ N × L − 1`, async () => {
    await withEnv(
      { serverTiming: true },
      async ({ gw, events }) => {
        const r = await post(gw, SAMPLE);
        // snapshot at reply time; every event of this request has settled before the reply
        const atReply = events.map((e) => e.durationMs);
        const h = parseHeader(r.st);
        expect(h.n).toBe(3);
        expect(atReply).toHaveLength(3);
        const sum = atReply.reduce((a, b) => a + b, 0);
        expect(Math.abs(h.dur - sum)).toBeLessThanOrEqual(0.1);
        expect(h.dur).toBeGreaterThanOrEqual(h.n * L - 1);
        // no late events change the picture
        await sleep(100);
        expect(events).toHaveLength(3);
      },
      L,
    );
  });

  it(`latency ${L} ms, one call: dur ≈ that call's durationMs and ≥ L − 1`, async () => {
    await withEnv(
      { serverTiming: true },
      async ({ gw, events }) => {
        const h = parseHeader((await post(gw, ONE_BOOK)).st);
        expect(h.n).toBe(1);
        expect(events).toHaveLength(1);
        expect(Math.abs(h.dur - events[0]!.durationMs)).toBeLessThanOrEqual(0.1);
        expect(h.dur).toBeGreaterThanOrEqual(L - 1);
      },
      L,
    );
  });
});

describe('EB4: zero-call replies report dur=0.0 / "0 calls" at 0 backend hits', () => {
  const cases: Array<[string, string, Omit<GatewayOptions, 'restBaseUrl'>, string | null]> = [
    ['syntax error', '{ authors(', {}, null],
    ['validation error (unknown field)', '{ nope }', {}, null],
    ['QUERY_TOO_DEEP (maxDepth 2)', SAMPLE, { maxDepth: 2 }, 'QUERY_TOO_DEEP'],
    ['addReview without auth', ADD_REVIEW, {}, 'UNAUTHENTICATED'],
  ];
  for (const [name, q, opts, code] of cases) {
    for (const accept of JSON_TYPES) {
      it(`${name} under ${accept}`, async () => {
        await withEnv({ serverTiming: true, ...opts }, async ({ gw, events, measure }) => {
          const m = await measure(() => post(gw, q, { accept }));
          expect(m.value.body.errors?.length ?? 0).toBeGreaterThan(0);
          if (code) expect(codes(m.value.body)).toContain(code);
          expect(m.value.st).toBe(ZERO);
          expect(m.calls).toBe(0);
          expect(events).toHaveLength(0);
        });
      });
    }
  }
});

describe('EB5: failed calls count', () => {
  it('refused restBaseUrl: DOWNSTREAM_UNREACHABLE with desc="1 call" == extensions total', async () => {
    const port = await closedPort();
    const events: DownstreamCallEvent[] = [];
    const gw = createGateway({ restBaseUrl: `http://127.0.0.1:${port}`, serverTiming: true, onDownstreamCall: (e) => void events.push(e) });
    try {
      const r = await post(gw, ONE_BOOK);
      expect(codes(r.body)).toContain('DOWNSTREAM_UNREACHABLE');
      const h = parseHeader(r.st);
      expect(h.desc).toBe('1 call');
      expect(totalOf(r.body)).toBe(1);
      expect(events).toHaveLength(1);
    } finally {
      await gw.close();
    }
  });

  it('NOT_FOUND book(id:"nope"): desc="1 call" == total == hits', async () => {
    await withEnv({ serverTiming: true }, async ({ gw, measure }) => {
      const m = await measure(() => post(gw, NOT_FOUND));
      expect(codes(m.value.body)).toContain('NOT_FOUND');
      expect(parseHeader(m.value.st).desc).toBe('1 call');
      expect(totalOf(m.value.body)).toBe(1);
      expect(m.calls).toBe(1);
    });
  });
});

describe('EB6: shared cache and coalescing count what this request sent', () => {
  it('TTL 60000: first SAMPLE "3 calls", identical repeat is exactly ZERO with total 0 and 0 hits', async () => {
    await withEnv({ serverTiming: true, downstreamCacheTtlMs: 60_000 }, async ({ gw, measure }) => {
      const a = await measure(() => post(gw, SAMPLE));
      expect(parseHeader(a.value.st).desc).toBe('3 calls');
      expect(a.calls).toBe(3);
      const b = await measure(() => post(gw, SAMPLE));
      expect(b.value.body.errors).toBeUndefined();
      expect(b.value.st).toBe(ZERO);
      expect(totalOf(b.value.body)).toBe(0);
      expect(b.calls).toBe(0);
      expect(b.value.body.data).toEqual(a.value.body.data);
    });
  });

  it('coalesceInFlight: in a concurrent burst every header N equals that request\'s own total; ΣN == backend hits', async () => {
    await withEnv(
      { serverTiming: true, coalesceInFlight: true },
      async ({ gw, measure }) => {
        const m = await measure(() => Promise.all(Array.from({ length: 8 }, () => post(gw, SAMPLE))));
        let sumN = 0;
        for (const r of m.value) {
          expect(r.status).toBe(200);
          expect(r.body.errors).toBeUndefined();
          const n = parseHeader(r.st).n;
          expect(n).toBe(totalOf(r.body));
          sumN += n;
        }
        expect(sumN).toBe(m.calls);
        // coalescing actually happened (otherwise this case proves nothing about joiners)
        expect(m.calls).toBeLessThan(8 * 3);
      },
      30,
    );
  });
});

describe('EB7: batching', () => {
  it('maxBatchSize 5, a 2-element batch: exactly ONE header whose N is the largest element total', async () => {
    await withEnv({ serverTiming: true, maxBatchSize: 5 }, async ({ gw, measure }) => {
      const m = await measure(() => post(gw, '', {}, [{ query: SAMPLE }, { query: ONE_BOOK }]));
      expect(m.value.status).toBe(200);
      expect(Array.isArray(m.value.body)).toBe(true);
      expect(m.value.body).toHaveLength(2);
      expect(m.value.st!).toMatch(FORMAT);
      expect(m.value.st!).not.toContain(',');
      const totals = (m.value.body as Body[]).map(totalOf);
      const n = parseHeader(m.value.st).n;
      expect(n).toBe(Math.max(...totals));
      expect(n).toBe(m.calls);
    });
  });
});

describe('EB8: streams and non-GraphQL routes carry no header', () => {
  it('@defer served as multipart/mixed: absent', async () => {
    await withEnv({ serverTiming: true }, async ({ gw }) => {
      const r = await post(gw, Q_DEFER, { accept: 'multipart/mixed' });
      expect(r.ctype.startsWith('multipart/mixed')).toBe(true);
      expect(r.st).toBeNull();
    });
  });
  it('text/event-stream (deferred and plain): absent', async () => {
    await withEnv({ serverTiming: true }, async ({ gw }) => {
      for (const q of [Q_DEFER, ONE_BOOK]) {
        const r = await post(gw, q, { accept: 'text/event-stream' });
        expect(r.ctype.startsWith('text/event-stream')).toBe(true);
        expect(r.st).toBeNull();
      }
    });
  });
  it('GraphiQL HTML page: absent', async () => {
    await withEnv({ serverTiming: true }, async ({ gw }) => {
      const r = await get(gw, '/graphql', { accept: 'text/html' });
      expect(r.ctype).toContain('text/html');
      expect(r.st).toBeNull();
    });
  });
  it('/healthz and /readyz: absent', async () => {
    await withEnv({ serverTiming: true }, async ({ gw }) => {
      for (const p of ['/healthz', '/readyz']) {
        const r = await get(gw, p);
        expect(r.status).toBe(200);
        expect(r.st).toBeNull();
      }
    });
  });
});

describe('EB9: compression keeps it', () => {
  it('gw.fetch, compressMinBytes 0 + accept-encoding gzip: gzip body and desc="3 calls"', async () => {
    await withEnv({ serverTiming: true, compressMinBytes: 0 }, async ({ gw }) => {
      const res = await gw.fetch(
        new Request('http://gateway.local/graphql', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'accept-encoding': 'gzip' },
          body: JSON.stringify({ query: SAMPLE }),
        }),
      );
      expect(res.headers.get('content-encoding')).toBe('gzip');
      expect(parseHeader(res.headers.get('server-timing')).desc).toBe('3 calls');
      const body = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8')) as Body;
      expect(totalOf(body)).toBe(3);
    });
  });

  it('real HTTP (nodeListener), compressMinBytes 0 + gzip: one server-timing header with desc="3 calls"', async () => {
    await withEnv({ serverTiming: true, compressMinBytes: 0 }, async ({ gw }) => {
      const server = http.createServer(gw.nodeListener);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      try {
        const port = (server.address() as AddressInfo).port;
        const res = await new Promise<{ headers: http.IncomingHttpHeaders; raw: Buffer; rawHeaders: string[] }>((ok, fail) => {
          const req = http.request(
            { host: '127.0.0.1', port, path: '/graphql', method: 'POST', agent: false, headers: { 'content-type': 'application/json', accept: 'application/json', 'accept-encoding': 'gzip' } },
            (r) => {
              const chunks: Buffer[] = [];
              r.on('data', (c: Buffer) => chunks.push(c));
              r.on('end', () => ok({ headers: r.headers, raw: Buffer.concat(chunks), rawHeaders: r.rawHeaders }));
              r.on('error', fail);
            },
          );
          req.on('error', fail);
          req.end(JSON.stringify({ query: SAMPLE }));
        });
        expect(res.headers['content-encoding']).toBe('gzip');
        const names = res.rawHeaders.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase());
        expect(names.filter((n) => n === 'server-timing')).toHaveLength(1);
        expect(parseHeader(String(res.headers['server-timing'])).desc).toBe('3 calls');
        expect(totalOf(JSON.parse(gunzipSync(res.raw).toString('utf8')))).toBe(3);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  });
});

describe('EB10: default off, zero cost', () => {
  for (const off of [{}, { serverTiming: false }] as Array<Omit<GatewayOptions, 'restBaseUrl'>>) {
    it(`${JSON.stringify(off)}: header absent on every EB2/4/5/6/7/9 shape`, async () => {
      await withEnv({ ...off, maxDepth: 3, downstreamCacheTtlMs: 60_000, maxBatchSize: 5, compressMinBytes: 0 }, async ({ gw }) => {
        for (const q of [SAMPLE, SAMPLE, ONE_BOOK, NOT_FOUND, '{ authors(', '{ nope }', ADD_REVIEW]) {
          for (const accept of JSON_TYPES) expect((await post(gw, q, { accept })).st).toBeNull();
        }
        expect((await get(gw, `/graphql?query=${encodeURIComponent(ONE_BOOK)}`)).st).toBeNull();
        expect((await post(gw, '', {}, [{ query: ONE_BOOK }, { query: NOT_FOUND }])).st).toBeNull();
        expect((await post(gw, ONE_BOOK, { 'accept-encoding': 'gzip' })).st).toBeNull();
      });
      const port = await closedPort();
      const gw = createGateway({ restBaseUrl: `http://127.0.0.1:${port}`, ...off });
      try {
        const r = await post(gw, ONE_BOOK);
        expect(codes(r.body)).toContain('DOWNSTREAM_UNREACHABLE');
        expect(r.st).toBeNull();
      } finally {
        await gw.close();
      }
    });
  }

  it('on vs off: byte-identical SAMPLE bodies and 3 backend hits each (the option adds 0 calls)', async () => {
    const run = (opts: Omit<GatewayOptions, 'restBaseUrl'>) =>
      withEnv(opts, async ({ gw, measure }) => {
        const m = await measure(() => post(gw, SAMPLE));
        const e = await post(gw, '{ nope }');
        return { text: m.value.text, calls: m.calls, st: m.value.st, err: e.text };
      });
    const on = await run({ serverTiming: true });
    const off = await run({});
    expect(on.st).not.toBeNull();
    expect(off.st).toBeNull();
    expect(on.text).toBe(off.text);
    expect(on.err).toBe(off.err);
    expect([on.calls, off.calls]).toEqual([3, 3]);
  });
});

describe('EB11: option validation', () => {
  const throwsOf = (opts: Record<string, unknown>): unknown => {
    try {
      const gw = createGateway({ restBaseUrl: 'http://127.0.0.1:9', ...opts } as GatewayOptions);
      void gw.close();
    } catch (e) {
      return e;
    }
    return undefined;
  };
  for (const v of ['yes', 1] as unknown[]) {
    it(`serverTiming: ${JSON.stringify(v)} throws TypeError "serverTiming must be a boolean, got …"`, () => {
      const e = throwsOf({ serverTiming: v });
      expect(e).toBeInstanceOf(TypeError);
      expect((e as Error).message).toMatch(/^serverTiming must be a boolean, got /);
    });
  }
  it('true and false are accepted', () => {
    expect(throwsOf({ serverTiming: true })).toBeUndefined();
    expect(throwsOf({ serverTiming: false })).toBeUndefined();
  });
  it('the unknown key "servertiming" is rejected with the typo suggestion', () => {
    const e = throwsOf({ servertiming: true });
    expect(e).toBeInstanceOf(TypeError);
    expect((e as Error).message).toBe('Unknown createGateway option "servertiming" (did you mean serverTiming?)');
  });
});

// ------------------------------------------------------------------- CLI ---

type Running = { url: string; restBaseUrl: string; close(): Promise<void> };
type StartFromEnv = (env: Record<string, string | undefined>, log?: (line: string) => void) => Promise<Running>;
async function loadStart(): Promise<StartFromEnv> {
  return ((await import('../src/cli')) as unknown as { startFromEnv: StartFromEnv }).startFromEnv;
}

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '' };
  for (const k of Object.keys(env)) {
    if (k.startsWith('VITEST') || k.startsWith('npm_')) delete env[k];
    if (k === 'REST_BASE_URL' || k === 'PORT' || k === 'TEST' || k === 'NODE_ENV' || k === 'SERVER_TIMING') delete env[k];
  }
  env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`;
  return { ...env, ...extra };
}

describe('EB12: CLI', () => {
  it('OPTION_ENV.serverTiming === "SERVER_TIMING"', () => {
    expect(OPTION_ENV.serverTiming).toBe('SERVER_TIMING');
  });

  for (const v of ['1', 'true']) {
    it(`SERVER_TIMING=${v}: SAMPLE carries desc="3 calls" == total == backend hits`, async () => {
      const r = await (await loadStart())({ PORT: '0', SERVER_TIMING: v }, () => {});
      try {
        const statsUrl = `${r.restBaseUrl.replace(/\/$/, '')}/__stats`;
        const before = ((await (await fetch(statsUrl)).json()) as Stats).total;
        const res = await fetch(r.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ query: SAMPLE }) });
        const body = (await res.json()) as Body;
        await sleep(20);
        const after = ((await (await fetch(statsUrl)).json()) as Stats).total;
        expect(parseHeader(res.headers.get('server-timing')).desc).toBe('3 calls');
        expect(totalOf(body)).toBe(3);
        expect(after - before).toBe(3);
      } finally {
        await r.close();
      }
    });
  }

  for (const v of [undefined, '0', 'false', '']) {
    it(`SERVER_TIMING=${JSON.stringify(v)}: no header`, async () => {
      const r = await (await loadStart())({ PORT: '0', SERVER_TIMING: v }, () => {});
      try {
        const res = await fetch(r.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ query: SAMPLE }) });
        expect(res.status).toBe(200);
        expect(totalOf((await res.json()) as Body)).toBe(3);
        expect(res.headers.get('server-timing')).toBeNull();
      } finally {
        await r.close();
      }
    });
  }

  it('in-process SERVER_TIMING=yes rejects before listening with the exact message', async () => {
    const logs: string[] = [];
    let err: unknown;
    try {
      const r = await (await loadStart())({ PORT: '0', SERVER_TIMING: 'yes' }, (l) => logs.push(l));
      await r.close();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('SERVER_TIMING must be 1, true, 0 or false, got "yes"');
    expect(logs.join('\n')).not.toMatch(/listening|http:\/\//i);
  });

  it('spawned `tsx src/index.ts` with SERVER_TIMING=yes: exit 1, message on stderr, never listens', { timeout: SPAWN_T }, async () => {
    const port = await closedPort();
    const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((ok) => {
      execFile(
        process.execPath,
        [TSX, 'src/index.ts'],
        { cwd: root, env: cleanEnv({ PORT: String(port), SERVER_TIMING: 'yes' }), timeout: 25_000, maxBuffer: 8 * 1024 * 1024 },
        (err: ExecFileException | null, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
          ok({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('SERVER_TIMING must be 1, true, 0 or false, got "yes"');
    expect(run.stdout).not.toContain(`:${port}`);
  });

  it('README env table and options table each carry one serverTiming / SERVER_TIMING row naming the trade-off', () => {
    const envRows = readme.split('\n').filter((l) => l.startsWith('| `SERVER_TIMING`'));
    expect(envRows).toHaveLength(1);
    const optRows = readme.split('\n').filter((l) => l.startsWith('| `serverTiming`'));
    expect(optRows).toHaveLength(1);
    expect(optRows[0]).toMatch(/side channel/i);
    expect(optRows[0]).toMatch(/SUM|sum/);
    expect(optRows[0]).toMatch(/not wall-clock/i);
    expect(readme).toMatch(/server-timing: downstream;dur=/);
  });
});
