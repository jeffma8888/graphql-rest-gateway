import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend, createGateway, NAIVE, type GatewayOptions, type DownstreamCallEvent } from '../src/lib';
import { OPTION_ENV } from '../src/cli';
import { BENCHMARK_QUERY } from '../benchmark/benchmark';

/**
 * iter-105: opt-in shared TTL cache for downstream GETs
 * (`downstreamCacheTtlMs` / env `DOWNSTREAM_CACHE_TTL_MS`, PRODUCT row 9).
 *
 * Black-box: every case builds its OWN bundled backend (latency 0, so writes
 * and counters never leak between cases), puts `createGateway` in front of it
 * and drives `gateway.fetch`. "calls" is the delta of the backend's own
 * `GET /__stats` (`total` + `byRoute`), cross-checked against
 * `extensions.downstreamCalls.total` and `onDownstreamCall` events where the
 * spec says so. EB7 puts a node:http stub in front of the backend whose
 * per-path behaviour (500 / off-contract 2xx / stall / socket reset / proxy)
 * the test flips, and counts the hits the stub received.
 *
 * Timing: no wall-clock bound is asserted. EB4 only sleeps 150 ms past a 50 ms
 * TTL (expiry) and uses a 60 s TTL for the "within" arm.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(resolve(__dirname, '..', 'README.md'), 'utf8');

const SAMPLE = BENCHMARK_QUERY;
const ONE_CALL = '{ authors(first: 2) { edges { node { name } } } }';
const TTL = 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Body = { data?: any; errors?: Array<{ message: string; extensions?: Record<string, any> }>; extensions?: any };
type Gw = ReturnType<typeof createGateway>;
type Stats = { total: number; byRoute: Record<string, number> };
type Reply = { status: number; body: Body };

async function startBackend(): Promise<{ url: string; stats: () => Promise<Stats>; close: () => Promise<void> }> {
  const app: FastifyInstance = buildBackend({ latencyMs: 0 }).app;
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
  url: string;
  stats: () => Promise<Stats>;
  /** Run `fn`, return the backend delta it caused. */
  measure: <R>(fn: () => Promise<R>) => Promise<{ calls: number; byRoute: Record<string, number>; value: R }>;
  /** POST one query and return the reply plus the backend calls it caused. */
  q: (query: string, headers?: Record<string, string>) => Promise<Reply & { calls: number; byRoute: Record<string, number> }>;
};

async function withEnv<T>(opts: Omit<GatewayOptions, 'restBaseUrl'>, fn: (env: Env) => Promise<T>): Promise<T> {
  const be = await startBackend();
  const gw = createGateway({ restBaseUrl: be.url, ...opts });
  const measure: Env['measure'] = async (f) => {
    const before = await be.stats();
    const value = await f();
    await sleep(20);
    const after = await be.stats();
    const byRoute: Record<string, number> = {};
    for (const [k, v] of Object.entries(after.byRoute ?? {})) {
      const d = v - (before.byRoute?.[k] ?? 0);
      if (d !== 0) byRoute[k] = d;
    }
    return { calls: after.total - before.total, byRoute, value };
  };
  const q: Env['q'] = async (query, headers = {}) => {
    const m = await measure(() => post(gw, query, headers));
    return { ...m.value, calls: m.calls, byRoute: m.byRoute };
  };
  try {
    return await fn({ gw, url: be.url, stats: be.stats, measure, q });
  } finally {
    await gw.close();
    await be.close();
  }
}

async function post(gw: Gw, query: string, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await gw.fetch(
    new Request('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ query }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Body };
}

const codes = (b: Body) => (b.errors ?? []).map((e) => e.extensions?.code);
const totalOf = (b: Body) => b.extensions?.downstreamCalls?.total as number;

// ------------------------------------------------------------------- EBs ---

describe('EB1: off by default', () => {
  it('option unset: two serial SAMPLE POSTs cost 3 + 3 = 6 calls', async () => {
    await withEnv({}, async ({ q }) => {
      const a = await q(SAMPLE);
      const b = await q(SAMPLE);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect([a.calls, b.calls]).toEqual([3, 3]);
      expect([totalOf(a.body), totalOf(b.body)]).toEqual([3, 3]);
      expect(b.body.data).toEqual(a.body.data);
    });
  });
  it('option explicitly undefined behaves like unset (6 calls)', async () => {
    await withEnv({ downstreamCacheTtlMs: undefined }, async ({ q }) => {
      const a = await q(SAMPLE);
      const b = await q(SAMPLE);
      expect(a.calls + b.calls).toBe(6);
    });
  });
});

describe('EB2: a repeat read is free', () => {
  it('TTL 60000: SAMPLE costs 3, the identical repeat costs 0 calls / total 0 / 0 hook events with equal data', async () => {
    const events: DownstreamCallEvent[] = [];
    await withEnv({ downstreamCacheTtlMs: TTL, onDownstreamCall: (e) => events.push(e) }, async ({ q }) => {
      const a = await q(SAMPLE);
      expect(a.status).toBe(200);
      expect(a.body.errors).toBeUndefined();
      expect(a.calls).toBe(3);
      expect(totalOf(a.body)).toBe(3);
      expect(events).toHaveLength(3);
      const b = await q(SAMPLE);
      expect(b.status).toBe(200);
      expect(b.body.errors).toBeUndefined();
      expect(b.body.data).toEqual(a.body.data);
      expect(b.calls).toBe(0);
      expect(totalOf(b.body)).toBe(0);
      expect(events).toHaveLength(3);
    });
  });
});

describe('EB2b: cache + coalesceInFlight', () => {
  it('2 concurrent SAMPLE cost 3 (coalesced), then a serial repeat costs 0', async () => {
    await withEnv({ downstreamCacheTtlMs: TTL, coalesceInFlight: true }, async ({ gw, measure, q }) => {
      const both = await measure(() => Promise.all([post(gw, SAMPLE), post(gw, SAMPLE)]));
      expect(both.calls).toBe(3);
      const sum = both.value.reduce((s, r) => s + totalOf(r.body), 0);
      expect(sum).toBe(3);
      for (const r of both.value) expect(r.body.errors).toBeUndefined();
      const again = await q(SAMPLE);
      expect(again.calls).toBe(0);
      expect(totalOf(again.body)).toBe(0);
      expect(again.body.data).toEqual(both.value[0].body.data);
    });
  });
});

describe('EB3: partial hits only send the misses', () => {
  it('author(a1){name} costs 1 (/authors/by-ids); then author(a1){name books{id}} costs 1 (/books/by-author only)', async () => {
    await withEnv({ downstreamCacheTtlMs: TTL }, async ({ q }) => {
      const first = await q('{ author(id: "a1") { name } }');
      expect(first.status).toBe(200);
      expect(first.body.errors).toBeUndefined();
      expect(first.calls).toBe(1);
      expect(first.byRoute).toEqual({ '/authors/by-ids': 1 });
      expect(totalOf(first.body)).toBe(1);
      const second = await q('{ author(id: "a1") { name books { id } } }');
      expect(second.status).toBe(200);
      expect(second.body.errors).toBeUndefined();
      expect(second.body.data.author.name).toBe(first.body.data.author.name);
      expect(second.body.data.author.books.length).toBeGreaterThan(0);
      expect(second.calls).toBe(1);
      expect(second.byRoute).toEqual({ '/books/by-author': 1 });
      expect(totalOf(second.body)).toBe(second.calls);
    });
  });
  it('control (cache off): the second query costs 2 (re-sends /authors/by-ids)', async () => {
    await withEnv({}, async ({ q }) => {
      await q('{ author(id: "a1") { name } }');
      const second = await q('{ author(id: "a1") { name books { id } } }');
      expect(second.calls).toBe(2);
      expect(second.byRoute['/authors/by-ids']).toBe(1);
    });
  });
});

describe('EB4: expiry', () => {
  it('TTL 50: a SAMPLE sent 150 ms after the first settled costs 3 again', async () => {
    await withEnv({ downstreamCacheTtlMs: 50 }, async ({ q }) => {
      const a = await q(SAMPLE);
      expect(a.calls).toBe(3);
      await sleep(150);
      const b = await q(SAMPLE);
      expect(b.calls).toBe(3);
      expect(totalOf(b.body)).toBe(3);
      expect(b.body.data).toEqual(a.body.data);
    });
  });
  it('within the TTL (60 s): the repeat costs 0', async () => {
    await withEnv({ downstreamCacheTtlMs: TTL }, async ({ q }) => {
      expect((await q(SAMPLE)).calls).toBe(3);
      expect((await q(SAMPLE)).calls).toBe(0);
    });
  });
});

describe('EB5: credentials never share', () => {
  const opts = { downstreamCacheTtlMs: TTL, forwardHeaders: ['authorization'] };
  it('authorization user:u1 then user:u2: 6 calls in total', async () => {
    await withEnv(opts, async ({ q }) => {
      const a = await q(SAMPLE, { authorization: 'Bearer user:u1' });
      const b = await q(SAMPLE, { authorization: 'Bearer user:u2' });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.calls + b.calls).toBe(6);
      expect(totalOf(b.body)).toBe(3);
    });
  });
  it('authorization user:u1 twice: 3 calls in total', async () => {
    await withEnv(opts, async ({ q }) => {
      const a = await q(SAMPLE, { authorization: 'Bearer user:u1' });
      const b = await q(SAMPLE, { authorization: 'Bearer user:u1' });
      expect(a.calls + b.calls).toBe(3);
      expect(b.calls).toBe(0);
    });
  });
  it('a forwarded header vs no header never share: 6 calls', async () => {
    await withEnv(opts, async ({ q }) => {
      const a = await q(SAMPLE, { authorization: 'Bearer user:u1' });
      const b = await q(SAMPLE);
      expect(a.calls + b.calls).toBe(6);
    });
  });
  it('different query strings never share (first:2 then first:3 cost 1 + 1)', async () => {
    await withEnv({ downstreamCacheTtlMs: TTL }, async ({ q }) => {
      const a = await q('{ authors(first: 2) { edges { node { name } } } }');
      const b = await q('{ authors(first: 3) { edges { node { name } } } }');
      expect([a.calls, b.calls]).toEqual([1, 1]);
      expect(b.body.data.authors.edges).toHaveLength(3);
    });
  });
});

describe('EB6: per-request field auth still applies on a hit', () => {
  const Q = '{ book(id: "a1-b1") { reviews { id reviewer } } }';
  it('pii caller first, then an anonymous caller: 0 calls and the same reviewer result as with the cache off', async () => {
    const control = await withEnv({}, async ({ q }) => q(Q));
    expect(control.status).toBe(200);
    expect(control.body.data.book.reviews.length).toBeGreaterThan(0);
    for (const r of control.body.data.book.reviews) expect(r.reviewer).toBe('REDACTED');

    await withEnv({ downstreamCacheTtlMs: TTL }, async ({ q }) => {
      const pii = await q(Q, { authorization: 'Bearer user:u1:pii' });
      expect(pii.status).toBe(200);
      expect(pii.body.errors).toBeUndefined();
      const revealed = pii.body.data.book.reviews.map((r: any) => r.reviewer);
      expect(revealed.length).toBeGreaterThan(0);
      for (const v of revealed) expect(v).not.toBe('REDACTED');

      const anon = await q(Q);
      expect(anon.calls).toBe(0);
      expect(anon.body.data).toEqual(control.body.data);
      expect(anon.body.errors).toEqual(control.body.errors);
    });
  });
  it('anonymous first, then pii: the pii caller still sees the real reviewers from a hit', async () => {
    await withEnv({ downstreamCacheTtlMs: TTL }, async ({ q }) => {
      const anon = await q(Q);
      for (const r of anon.body.data.book.reviews) expect(r.reviewer).toBe('REDACTED');
      const pii = await q(Q, { authorization: 'Bearer user:u1:pii' });
      expect(pii.calls).toBe(0);
      for (const r of pii.body.data.book.reviews) expect(r.reviewer).not.toBe('REDACTED');
    });
  });
});

// ---------------------------------------------------------- EB7 stub ----

type Mode = 'ok' | '500' | 'bad' | 'stall' | 'reset';
type Stub = { url: string; hits: () => number; setMode: (m: Mode) => void; close: () => Promise<void> };

/** Stub in front of `backendUrl`: `/authors` behaves per `mode`; everything else is proxied. */
async function startStub(backendUrl: string): Promise<Stub> {
  let mode: Mode = 'ok';
  let authorsHits = 0;
  const proxy = (req: IncomingMessage, res: ServerResponse) => {
    fetch(backendUrl + (req.url ?? '/'))
      .then(async (r) => {
        const text = await r.text();
        if (res.destroyed) return;
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
        res.end(text);
      })
      .catch(() => {
        if (!res.destroyed) {
          res.writeHead(502);
          res.end();
        }
      });
  };
  const server: Server = createServer((req, res) => {
    res.on('error', () => {});
    const path = new URL(req.url ?? '/', 'http://stub.local').pathname;
    if (path !== '/authors') return proxy(req, res);
    authorsHits += 1;
    switch (mode) {
      case 'ok':
        return proxy(req, res);
      case '500':
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end('{"error":"boom"}');
      case 'bad':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"items":"not-a-list","total":"x"}');
      case 'stall':
        return; // never answers; the gateway's downstreamTimeoutMs fires
      case 'reset':
        req.socket.destroy();
        return;
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    hits: () => authorsHits,
    setMode: (m) => {
      mode = m;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

describe('EB7: failures are never cached', () => {
  for (const [mode, code] of [
    ['500', 'DOWNSTREAM_ERROR'],
    ['bad', 'DOWNSTREAM_BAD_RESPONSE'],
    ['stall', 'DOWNSTREAM_TIMEOUT'],
    ['reset', 'DOWNSTREAM_UNREACHABLE'],
  ] as const) {
    it(`${mode} → ${code}; once healthy the next identical request sends the call, then it is cached`, async () => {
      const be = await startBackend();
      const stub = await startStub(be.url);
      const gw = createGateway({ restBaseUrl: stub.url, downstreamCacheTtlMs: TTL, downstreamTimeoutMs: 150 });
      try {
        stub.setMode(mode);
        const bad = await post(gw, ONE_CALL);
        expect(codes(bad.body)).toContain(code);
        expect(stub.hits()).toBe(1);

        // a second failing request also sends (no negative caching)
        const bad2 = await post(gw, ONE_CALL);
        expect(codes(bad2.body)).toContain(code);
        expect(stub.hits()).toBe(2);

        stub.setMode('ok');
        const good = await post(gw, ONE_CALL);
        expect(good.status).toBe(200);
        expect(good.body.errors).toBeUndefined();
        expect(good.body.data.authors.edges).toHaveLength(2);
        expect(stub.hits()).toBe(3); // the healthy retry costs a real call
        expect(totalOf(good.body)).toBe(1);

        const cached = await post(gw, ONE_CALL);
        expect(cached.body.data).toEqual(good.body.data);
        expect(stub.hits()).toBe(3);
        expect(totalOf(cached.body)).toBe(0);
      } finally {
        await gw.close();
        await stub.close();
        await be.close();
      }
    });
  }
});

describe('EB8: writes invalidate', () => {
  const READ = '{ book(id: "a1-b1") { reviews { id } } }';
  const WRITE = 'mutation { addReview(bookId: "a1-b1", rating: 5, body: "Great read") { id } }';
  const AUTH = { authorization: 'Bearer user:u7:pii' };

  it('read (cached), addReview OK, then the same read sends ≥1 call and lists the new id', async () => {
    await withEnv({ downstreamCacheTtlMs: TTL }, async ({ q }) => {
      const r1 = await q(READ);
      expect(r1.calls).toBeGreaterThanOrEqual(1);
      expect((await q(READ)).calls).toBe(0); // proven cached
      const w = await q(WRITE, AUTH);
      expect(w.body.errors).toBeUndefined();
      expect(w.calls).toBe(1);
      const newId = w.body.data.addReview.id as string;
      expect(typeof newId).toBe('string');
      expect(r1.body.data.book.reviews.map((r: any) => r.id)).not.toContain(newId);
      const r2 = await q(READ);
      expect(r2.calls).toBeGreaterThanOrEqual(1);
      expect(r2.body.data.book.reviews.map((r: any) => r.id)).toContain(newId);
    });
  });

  it('a backend-rejected write (unknown book, NOT_FOUND after 1 call) still clears the cache', async () => {
    await withEnv({ downstreamCacheTtlMs: TTL }, async ({ q }) => {
      await q(READ);
      expect((await q(READ)).calls).toBe(0);
      const w = await q('mutation { addReview(bookId: "nope-b9", rating: 5, body: "x") { id } }', AUTH);
      expect(codes(w.body)).toContain('NOT_FOUND');
      expect(w.calls).toBe(1);
      expect((await q(READ)).calls).toBeGreaterThanOrEqual(1);
    });
  });

  it('a gateway-rejected write at 0 calls (UNAUTHENTICATED) sends nothing', async () => {
    await withEnv({ downstreamCacheTtlMs: TTL }, async ({ q }) => {
      await q(READ);
      const w = await q(WRITE);
      expect(codes(w.body)).toContain('UNAUTHENTICATED');
      expect(w.calls).toBe(0);
    });
  });

  it('a request that writes reads its own write even after its book/reviews were cached (3 calls)', async () => {
    await withEnv({ downstreamCacheTtlMs: TTL }, async ({ q }) => {
      await q('{ book(id: "a1-b1") { id reviews { id } } }');
      const w = await q('mutation { addReview(bookId: "a1-b1", rating: 4, body: "ok") { id book { reviews { id } } } }', AUTH);
      expect(w.body.errors).toBeUndefined();
      const id = w.body.data.addReview.id as string;
      expect(w.body.data.addReview.book.reviews.map((r: any) => r.id)).toContain(id);
      expect(w.calls).toBe(3);
      expect(totalOf(w.body)).toBe(3);
    });
  });
});

describe('EB9: bounded memory (1000 entries, oldest evicted first)', () => {
  it('1001 distinct x-tenant values: t1000 again costs 0, t0 again costs ≥ 1', async () => {
    await withEnv({ downstreamCacheTtlMs: TTL, forwardHeaders: ['x-tenant'] }, async ({ gw, stats, q }) => {
      const Q = '{ authors(first: 1) { edges { node { id } } } }';
      const before = await stats();
      for (let i = 0; i <= 1000; i++) {
        const r = await post(gw, Q, { 'x-tenant': `t${i}` });
        expect(r.status).toBe(200);
      }
      const after = await stats();
      expect(after.total - before.total).toBe(1001);
      const last = await q(Q, { 'x-tenant': 't1000' });
      expect(last.calls).toBe(0);
      expect(totalOf(last.body)).toBe(0);
      const first = await q(Q, { 'x-tenant': 't0' });
      expect(first.calls).toBeGreaterThanOrEqual(1);
      expect(first.body.data).toEqual(last.body.data);
    });
  }, 30_000);
  it('the cap is not exported from the library entry', async () => {
    const lib = (await import('../src/lib')) as Record<string, unknown>;
    for (const k of Object.keys(lib)) expect(lib[k]).not.toBe(1000);
  });
});

describe('EB10: the N+1 demonstration is never hidden', () => {
  for (const [label, lo] of [
    ['NAIVE preset', NAIVE],
    ['literal { batch: false, cache: false }', { batch: false, cache: false }],
  ] as const) {
    it(`${label} + TTL: two serial SAMPLE requests each cost exactly 21`, async () => {
      await withEnv({ downstreamCacheTtlMs: TTL, loaderOptions: lo }, async ({ q }) => {
        const a = await q(SAMPLE);
        const b = await q(SAMPLE);
        expect([a.calls, b.calls]).toEqual([21, 21]);
        expect([totalOf(a.body), totalOf(b.body)]).toEqual([21, 21]);
        expect(b.body.data).toEqual(a.body.data);
      });
    });
  }
});

describe('EB11: probes and budget', () => {
  it('/readyz never reads or writes the cache: 2 serial probes cost 1 call each (also after a warm first-page read)', async () => {
    await withEnv({ downstreamCacheTtlMs: TTL }, async ({ gw, measure, q }) => {
      await q('{ authors(first: 1) { edges { node { id } } } }');
      for (let i = 0; i < 2; i++) {
        const m = await measure(async () => {
          const res = await gw.fetch(new Request('http://gateway.local/readyz'));
          return { status: res.status, body: await res.json() };
        });
        expect(m.value.status).toBe(200);
        expect(m.calls).toBe(1);
      }
    });
  });
  it('maxDownstreamCalls: 1 + TTL: hits use no budget unit; a fully cached SAMPLE answers whole', async () => {
    await withEnv({}, async ({ q }) => {
      const ref = await q(SAMPLE);
      expect(ref.calls).toBe(3);
      await withEnv({ downstreamCacheTtlMs: TTL, maxDownstreamCalls: 1 }, async ({ q: q2 }) => {
        // control: an uncached SAMPLE is over budget
        const cold = await q2('{ authors(first: 5) { totalCount edges { node { id } } } }');
        expect(cold.calls).toBe(1);
        expect(cold.body.errors).toBeUndefined();
        const hop2 = await q2('{ authors(first: 5) { totalCount edges { node { id books { id } } } } }');
        expect(hop2.calls).toBe(1);
        expect(codes(hop2.body)).not.toContain('DOWNSTREAM_BUDGET_EXCEEDED');
        const hop3 = await q2(SAMPLE); // 2 hits + 1 miss: fits a budget of 1
        expect(hop3.calls).toBe(1);
        expect(codes(hop3.body)).not.toContain('DOWNSTREAM_BUDGET_EXCEEDED');
        const full = await q2(SAMPLE);
        expect(full.calls).toBe(0);
        expect(full.body.errors).toBeUndefined();
        expect(full.body.data).toEqual(ref.body.data);
      });
    });
  });
  it('control: maxDownstreamCalls: 1 without the cache refuses SAMPLE with DOWNSTREAM_BUDGET_EXCEEDED', async () => {
    await withEnv({ maxDownstreamCalls: 1 }, async ({ q }) => {
      const r = await q(SAMPLE);
      expect(codes(r.body)).toContain('DOWNSTREAM_BUDGET_EXCEEDED');
    });
  });
});

describe('EB12: validation and per-gateway scope', () => {
  const be = 'http://127.0.0.1:9';
  for (const v of [0, -1, 1.5, NaN, Infinity, '1000', 2 ** 31] as const) {
    it(`downstreamCacheTtlMs: ${typeof v === 'string' ? JSON.stringify(v) : String(v)} throws naming the option`, () => {
      let err: unknown;
      try {
        createGateway({ restBaseUrl: be, downstreamCacheTtlMs: v as unknown as number });
      } catch (e) {
        err = e;
      }
      expect(err instanceof TypeError || err instanceof RangeError).toBe(true);
      expect((err as Error).message).toContain('downstreamCacheTtlMs');
    });
  }
  it('accepts the bounds 1 and 2**31 - 1', async () => {
    for (const v of [1, 2 ** 31 - 1]) {
      let gw: Gw | undefined;
      expect(() => {
        gw = createGateway({ restBaseUrl: be, downstreamCacheTtlMs: v });
      }).not.toThrow();
      expect(typeof gw?.fetch).toBe('function');
      await gw!.close();
    }
  });
  it('two gateways with the TTL on never share entries: SAMPLE on A then B costs 3 + 3', async () => {
    const b = await startBackend();
    const A = createGateway({ restBaseUrl: b.url, downstreamCacheTtlMs: TTL });
    const B = createGateway({ restBaseUrl: b.url, downstreamCacheTtlMs: TTL });
    try {
      const t0 = (await b.stats()).total;
      const ra = await post(A, SAMPLE);
      const t1 = (await b.stats()).total;
      const rb = await post(B, SAMPLE);
      const t2 = (await b.stats()).total;
      expect([t1 - t0, t2 - t1]).toEqual([3, 3]);
      expect(totalOf(rb.body)).toBe(3);
      expect(rb.body.data).toEqual(ra.body.data);
      await post(A, SAMPLE);
      expect((await b.stats()).total - t2).toBe(0);
    } finally {
      await A.close();
      await B.close();
      await b.close();
    }
  });
});

// ------------------------------------------------------------ EB13 env ----

type Running = { url: string; restBaseUrl: string; close(): Promise<void> };
type StartFromEnv = (env: Record<string, string | undefined>, log?: (line: string) => void) => Promise<Running>;
async function loadStart(): Promise<StartFromEnv> {
  return ((await import('../src/cli')) as unknown as { startFromEnv: StartFromEnv }).startFromEnv;
}
async function envPost(url: string, query: string): Promise<Body> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query }),
  });
  return (await res.json()) as Body;
}
async function envHits(r: Running): Promise<number> {
  const res = await fetch(`${r.restBaseUrl.replace(/\/$/, '')}/__stats`);
  return ((await res.json()) as { total: number }).total;
}
async function rejectionOf(env: Record<string, string>): Promise<{ err: unknown; lines: string[]; booted: boolean }> {
  const startFromEnv = await loadStart();
  const lines: string[] = [];
  let err: unknown;
  let running: Running | undefined;
  try {
    running = await startFromEnv({ PORT: '0', REST_LATENCY_MS: '0', ...env }, (l) => lines.push(l));
  } catch (e) {
    err = e;
  }
  if (running) await running.close();
  return { err, lines, booted: running !== undefined };
}

describe('EB13: npm start / env', () => {
  it("OPTION_ENV.downstreamCacheTtlMs === 'DOWNSTREAM_CACHE_TTL_MS'", () => {
    expect(OPTION_ENV.downstreamCacheTtlMs).toBe('DOWNSTREAM_CACHE_TTL_MS');
  });

  for (const [label, env, second] of [
    ['DOWNSTREAM_CACHE_TTL_MS=60000', { DOWNSTREAM_CACHE_TTL_MS: '60000' }, 0],
    ['unset', {}, 3],
  ] as const) {
    it(`startFromEnv ${label}: SAMPLE costs 3, then ${second}`, async () => {
      const startFromEnv = await loadStart();
      const r = await startFromEnv({ PORT: '0', REST_LATENCY_MS: '0', ...env }, () => {});
      try {
        const h0 = await envHits(r);
        const a = await envPost(r.url, SAMPLE);
        const h1 = await envHits(r);
        const b = await envPost(r.url, SAMPLE);
        const h2 = await envHits(r);
        expect(a.errors).toBeUndefined();
        expect([h1 - h0, h2 - h1]).toEqual([3, second]);
        expect(totalOf(a)).toBe(3);
        expect(totalOf(b)).toBe(second);
        expect(b.data).toEqual(a.data);
      } finally {
        await r.close();
      }
    });
  }

  for (const raw of ['0', 'abc', '-5', '2147483648']) {
    it(`DOWNSTREAM_CACHE_TTL_MS=${JSON.stringify(raw)} fails fast before listening, shaped like DOWNSTREAM_TIMEOUT_MS`, async () => {
      const mine = await rejectionOf({ DOWNSTREAM_CACHE_TTL_MS: raw });
      const ref = await rejectionOf({ DOWNSTREAM_TIMEOUT_MS: raw });
      for (const x of [mine, ref]) {
        expect(x.booted).toBe(false);
        expect(x.err).toBeInstanceOf(Error);
        expect(x.lines).toEqual([]);
      }
      const msg = (mine.err as Error).message;
      expect(msg).toContain('DOWNSTREAM_CACHE_TTL_MS');
      expect(msg).toContain(JSON.stringify(raw));
      expect((mine.err as Error).constructor).toBe((ref.err as Error).constructor);
      expect(msg.replaceAll('DOWNSTREAM_CACHE_TTL_MS', 'X')).toBe((ref.err as Error).message.replaceAll('DOWNSTREAM_TIMEOUT_MS', 'X'));
    });
  }

  it('README: options-table row, env row and a staleness trade-off sentence', () => {
    expect(readme).toMatch(/^\| `downstreamCacheTtlMs` \|/m);
    expect(readme).toMatch(/^\| `DOWNSTREAM_CACHE_TTL_MS` \|/m);
    const section = (n: number) => {
      const start = readme.indexOf(`\n## ${n}. `);
      const end = readme.indexOf(`\n## ${n + 1}. `);
      expect(start).toBeGreaterThan(-1);
      return readme.slice(start, end);
    };
    for (const n of [2, 6]) {
      const s = section(n);
      expect(s).toContain('downstreamCacheTtlMs');
      expect(s.toLowerCase()).toMatch(/stale/);
    }
  });
});
