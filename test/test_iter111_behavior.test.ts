import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend, createGateway, NAIVE, type GatewayOptions, type DownstreamCallEvent } from '../src/lib';
import { BENCHMARK_QUERY } from '../benchmark/benchmark';

/**
 * iter-111: single-flight fills for the opt-in shared TTL cache
 * (`downstreamCacheTtlMs`, PRODUCT row 129).
 *
 * Black-box: every case builds its OWN bundled backend (latency 50 ms, so a
 * burst really overlaps), puts `createGateway` in front of it (directly or
 * through an in-process node:http proxy/stub) and drives `gateway.fetch`.
 * "calls" is the backend `/__stats` total delta, "events" the
 * `onDownstreamCall` events, "Σ total" the sum of
 * `extensions.downstreamCalls.total` over the replies.
 *
 * Timing: no wall-clock bound is asserted (H2). Sleeps only order events
 * (expiry past a 200 ms TTL, a write while a 400 ms-delayed GET is pending).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(resolve(__dirname, '..', 'README.md'), 'utf8');

const SAMPLE = BENCHMARK_QUERY;
const AUTHOR = '{ author(id: "a1") { name } }';
const TTL = 60_000;
const LATENCY = 50;
const BURST = 50;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Body = { data?: any; errors?: Array<{ message: string; extensions?: Record<string, any> }>; extensions?: any };
type Gw = ReturnType<typeof createGateway>;
type Stats = { total: number; byRoute: Record<string, number> };
type Reply = { status: number; body: Body };

async function startBackend(latencyMs = LATENCY): Promise<{ url: string; stats: () => Promise<Stats>; close: () => Promise<void> }> {
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

async function post(gw: Gw, query: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Reply> {
  const res = await gw.fetch(
    new Request('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ query }),
      signal,
    }),
  );
  return { status: res.status, body: (await res.json()) as Body };
}

const totalOf = (b: Body) => b.extensions?.downstreamCalls?.total as number;
const sumTotal = (rs: Reply[]) => rs.reduce((s, r) => s + (totalOf(r.body) ?? NaN), 0);
const codes = (b: Body) => (b.errors ?? []).map((e) => e.extensions?.code);

type Env = {
  gw: Gw;
  events: DownstreamCallEvent[];
  /** Run `fn`; return the backend calls and hook events it caused. */
  measure: <R>(fn: () => Promise<R>) => Promise<{ calls: number; events: number; value: R }>;
  burst: (n: number, query?: string, headers?: (i: number) => Record<string, string>) => Promise<{ calls: number; events: number; replies: Reply[] }>;
};

async function withEnv<T>(opts: Omit<GatewayOptions, 'restBaseUrl' | 'onDownstreamCall'>, fn: (env: Env) => Promise<T>): Promise<T> {
  const be = await startBackend();
  const events: DownstreamCallEvent[] = [];
  const gw = createGateway({ restBaseUrl: be.url, ...opts, onDownstreamCall: (e) => events.push(e) });
  const measure: Env['measure'] = async (f) => {
    const before = await be.stats();
    const ev0 = events.length;
    const value = await f();
    await sleep(20);
    const after = await be.stats();
    return { calls: after.total - before.total, events: events.length - ev0, value };
  };
  const burst: Env['burst'] = async (n, query = SAMPLE, headers = () => ({})) => {
    const m = await measure(() => Promise.all(Array.from({ length: n }, (_, i) => post(gw, query, headers(i)))));
    return { calls: m.calls, events: m.events, replies: m.value };
  };
  try {
    return await fn({ gw, events, measure, burst });
  } finally {
    await gw.close();
    await be.close();
  }
}

let serialData: any;
async function serialSampleData(): Promise<any> {
  if (serialData !== undefined) return serialData;
  await withEnv({}, async ({ gw }) => {
    const r = await post(gw, SAMPLE);
    expect(r.status).toBe(200);
    expect(r.body.errors).toBeUndefined();
    serialData = r.body.data;
  });
  return serialData;
}

function expectAllOk(replies: Reply[], data: any) {
  for (const r of replies) {
    expect(r.status).toBe(200);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data).toEqual(data);
  }
}

// ------------------------------------------------------- proxy / stub ----

type Hit = { method: string; path: string; authorization?: string };
type Rule = { delayMs?: number; status?: number };
type Proxy = { url: string; hits: Hit[]; count: (path: string, method?: string) => number; close: () => Promise<void> };

/** node:http proxy in front of `backendUrl`; per-path rules delay or replace the answer; every request is recorded. */
async function startProxy(backendUrl: string, rules: Record<string, Rule> = {}): Promise<Proxy> {
  const hits: Hit[] = [];
  const forward = (req: IncomingMessage, res: ServerResponse, body: Buffer) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string' && !['host', 'connection', 'content-length', 'transfer-encoding'].includes(k)) headers[k] = v;
    }
    const method = req.method ?? 'GET';
    fetch(backendUrl + (req.url ?? '/'), { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body.toString('utf8') })
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
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://proxy.local').pathname;
      const auth = req.headers['authorization'];
      hits.push({ method: req.method ?? 'GET', path, authorization: typeof auth === 'string' ? auth : undefined });
      const rule = rules[path];
      const act = () => {
        if (rule?.status !== undefined) {
          if (res.destroyed) return;
          res.writeHead(rule.status, { 'content-type': 'application/json' });
          res.end('{"error":"boom"}');
          return;
        }
        forward(req, res, Buffer.concat(chunks));
      };
      if (rule?.delayMs) setTimeout(act, rule.delayMs);
      else act();
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    hits,
    count: (path, method = 'GET') => hits.filter((h) => h.path === path && h.method === method).length,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

async function waitFor(pred: () => boolean, limitMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > limitMs) throw new Error('waitFor: condition never held');
    await sleep(5);
  }
}

// ------------------------------------------------------------------- EBs ---

describe('EB1: cold burst shares one in-flight GET per hop', () => {
  it(`TTL on: ${BURST} concurrent SAMPLE all 200, equal data, calls == events == Σ total == 3`, async () => {
    const data = await serialSampleData();
    await withEnv({ downstreamCacheTtlMs: TTL }, async ({ burst }) => {
      const b = await burst(BURST);
      expect(b.replies).toHaveLength(BURST);
      expectAllOk(b.replies, data);
      expect(b.calls).toBe(3);
      expect(b.events).toBe(3);
      expect(sumTotal(b.replies)).toBe(3);
    });
  });
});

describe('EB2: warm burst is free', () => {
  it('after a cold burst, a serial SAMPLE and another burst cost 0 calls / 0 events / Σ total 0', async () => {
    const data = await serialSampleData();
    await withEnv({ downstreamCacheTtlMs: TTL }, async ({ gw, burst, measure }) => {
      const cold = await burst(BURST);
      expect(cold.calls).toBe(3);
      const s = await measure(() => post(gw, SAMPLE));
      expect(s.calls).toBe(0);
      expect(s.events).toBe(0);
      expect(totalOf(s.value.body)).toBe(0);
      expect(s.value.body.data).toEqual(data);
      const warm = await burst(BURST);
      expectAllOk(warm.replies, data);
      expect([warm.calls, warm.events, sumTotal(warm.replies)]).toEqual([0, 0, 0]);
    });
  });
});

describe('EB3: expiry burst', () => {
  it('TTL 200: serial 3, after 300 ms a burst costs 3 (not 150), then a serial repeat costs 0', async () => {
    const data = await serialSampleData();
    await withEnv({ downstreamCacheTtlMs: 200 }, async ({ gw, burst, measure }) => {
      const first = await measure(() => post(gw, SAMPLE));
      expect(first.calls).toBe(3);
      await sleep(300);
      const b = await burst(BURST);
      expectAllOk(b.replies, data);
      expect([b.calls, b.events, sumTotal(b.replies)]).toEqual([3, 3, 3]);
      const again = await measure(() => post(gw, SAMPLE));
      expect(again.calls).toBe(0);
      expect(totalOf(again.value.body)).toBe(0);
    });
  });
});

describe('EB4: sender counts, joiners count 0', () => {
  it('2 concurrent author(a1): 1 call, 1 event, totals {1,0}, both names equal the serial answer', async () => {
    let serialName: string | undefined;
    await withEnv({}, async ({ gw }) => {
      serialName = (await post(gw, AUTHOR)).body.data.author.name;
    });
    expect(typeof serialName).toBe('string');
    await withEnv({ downstreamCacheTtlMs: TTL }, async ({ burst }) => {
      const b = await burst(2, AUTHOR);
      expect(b.calls).toBe(1);
      expect(b.events).toBe(1);
      expect(b.replies.map((r) => totalOf(r.body)).sort()).toEqual([0, 1]);
      for (const r of b.replies) {
        expect(r.status).toBe(200);
        expect(r.body.errors).toBeUndefined();
        expect(r.body.data.author.name).toBe(serialName);
      }
    });
  });
});

describe('EB5: forwarded headers keep fills apart', () => {
  it('25 x Bearer A + 25 x Bearer B interleaved: 6 calls, 3 per value, each downstream GET carries a waiting caller value', async () => {
    const data = await serialSampleData();
    const be = await startBackend();
    const px = await startProxy(be.url);
    const gw = createGateway({ restBaseUrl: px.url, downstreamCacheTtlMs: TTL, forwardHeaders: ['authorization'] });
    try {
      const before = (await be.stats()).total;
      const replies = await Promise.all(
        Array.from({ length: BURST }, (_, i) => post(gw, SAMPLE, { authorization: i % 2 === 0 ? 'Bearer A' : 'Bearer B' })),
      );
      await sleep(20);
      expect((await be.stats()).total - before).toBe(6);
      expectAllOk(replies, data);
      const gets = px.hits.filter((h) => h.method === 'GET');
      expect(gets).toHaveLength(6);
      expect(gets.filter((h) => h.authorization === 'Bearer A')).toHaveLength(3);
      expect(gets.filter((h) => h.authorization === 'Bearer B')).toHaveLength(3);
      for (const value of ['Bearer A', 'Bearer B']) {
        const paths = gets.filter((h) => h.authorization === value).map((h) => h.path).sort();
        expect(paths).toEqual(['/authors', '/books/by-author', '/reviews/by-book']);
      }
      expect(sumTotal(replies)).toBe(6);
    } finally {
      await gw.close();
      await px.close();
      await be.close();
    }
  });
});

describe('EB6: gateways never share', () => {
  it('two TTL gateways over one backend, concurrent 10-bursts each: 6 calls', async () => {
    const be = await startBackend();
    const g1 = createGateway({ restBaseUrl: be.url, downstreamCacheTtlMs: TTL });
    const g2 = createGateway({ restBaseUrl: be.url, downstreamCacheTtlMs: TTL });
    try {
      const before = (await be.stats()).total;
      const replies = await Promise.all([
        ...Array.from({ length: 10 }, () => post(g1, SAMPLE)),
        ...Array.from({ length: 10 }, () => post(g2, SAMPLE)),
      ]);
      await sleep(20);
      expect((await be.stats()).total - before).toBe(6);
      expectAllOk(replies, await serialSampleData());
      expect(sumTotal(replies.slice(0, 10))).toBe(3);
      expect(sumTotal(replies.slice(10))).toBe(3);
    } finally {
      await g1.close();
      await g2.close();
      await be.close();
    }
  });
});

describe('EB7: a failed fill is shared and never stored', () => {
  it('500 after 100 ms: 10 concurrent author(a1) hit the route once, all DOWNSTREAM_ERROR, 1 event; a serial repeat hits again', async () => {
    const be = await startBackend();
    const px = await startProxy(be.url, { '/authors/by-ids': { delayMs: 100, status: 500 } });
    const events: DownstreamCallEvent[] = [];
    const gw = createGateway({ restBaseUrl: px.url, downstreamCacheTtlMs: TTL, onDownstreamCall: (e) => events.push(e) });
    try {
      const replies = await Promise.all(Array.from({ length: 10 }, () => post(gw, AUTHOR)));
      expect(px.count('/authors/by-ids')).toBe(1);
      for (const r of replies) expect(codes(r.body)).toContain('DOWNSTREAM_ERROR');
      await sleep(20);
      expect(events).toHaveLength(1);
      const again = await post(gw, AUTHOR);
      expect(codes(again.body)).toContain('DOWNSTREAM_ERROR');
      expect(px.count('/authors/by-ids')).toBe(2);
    } finally {
      await gw.close();
      await px.close();
      await be.close();
    }
  });
});

const READ = '{ book(id: "a1-b1") { reviews { id } } }';
const AUTH = { authorization: 'Bearer user:u7:pii' };

describe('EB8: write barrier for other requests', () => {
  it('a read started after a completed write never joins the pre-write fill and lists the new review', async () => {
    const be = await startBackend();
    const px = await startProxy(be.url, { '/reviews/by-book': { delayMs: 400 } });
    const gw = createGateway({ restBaseUrl: px.url, downstreamCacheTtlMs: TTL });
    try {
      const a = post(gw, READ);
      await waitFor(() => px.count('/reviews/by-book') === 1);
      const w = await post(gw, 'mutation { addReview(bookId: "a1-b1", rating: 5, body: "Great read") { id } }', AUTH);
      expect(w.status).toBe(200);
      expect(w.body.errors).toBeUndefined();
      const newId = w.body.data.addReview.id as string;
      expect(typeof newId).toBe('string');
      expect(px.count('/reviews', 'POST')).toBe(1);
      const b = post(gw, READ);
      const [ra, rb] = await Promise.all([a, b]);
      expect(px.count('/reviews/by-book')).toBe(2);
      expect(ra.status).toBe(200);
      expect(rb.status).toBe(200);
      expect(rb.body.errors).toBeUndefined();
      expect(rb.body.data.book.reviews.map((r: any) => r.id)).toContain(newId);
    } finally {
      await gw.close();
      await px.close();
      await be.close();
    }
  });
});

describe("EB9: writer's own reads", () => {
  it('addReview { book { reviews } } with an identical read in flight still sends its own GET and lists the new review', async () => {
    const be = await startBackend();
    const px = await startProxy(be.url, { '/reviews/by-book': { delayMs: 400 } });
    const gw = createGateway({ restBaseUrl: px.url, downstreamCacheTtlMs: TTL });
    try {
      const a = post(gw, READ);
      await waitFor(() => px.count('/reviews/by-book') === 1);
      const w = await post(gw, 'mutation { addReview(bookId: "a1-b1", rating: 4, body: "ok") { id book { reviews { id } } } }', AUTH);
      expect(w.status).toBe(200);
      expect(w.body.errors).toBeUndefined();
      const id = w.body.data.addReview.id as string;
      expect(w.body.data.addReview.book.reviews.map((r: any) => r.id)).toContain(id);
      expect(px.count('/reviews/by-book')).toBe(2);
      expect((await a).status).toBe(200);
    } finally {
      await gw.close();
      await px.close();
      await be.close();
    }
  });
});

describe('EB10: edge abort', () => {
  it('aborting the first of 2 identical requests leaves the other at 200 with the name, 1 stub GET', async () => {
    const be = await startBackend();
    const px = await startProxy(be.url, { '/authors/by-ids': { delayMs: 300 } });
    const gw = createGateway({ restBaseUrl: px.url, downstreamCacheTtlMs: TTL });
    try {
      const ac = new AbortController();
      const first = post(gw, AUTHOR, {}, ac.signal).catch((e: unknown) => e);
      await sleep(5);
      const second = post(gw, AUTHOR);
      await sleep(50);
      ac.abort();
      const r2 = await second;
      await first;
      expect(r2.status).toBe(200);
      expect(r2.body.errors).toBeUndefined();
      expect(typeof r2.body.data.author.name).toBe('string');
      expect(r2.body.data.author.name.length).toBeGreaterThan(0);
      expect(px.count('/authors/by-ids')).toBe(1);
    } finally {
      await gw.close();
      await px.close();
      await be.close();
    }
  });
});

describe('EB11: unchanged elsewhere', () => {
  it(`neither option: a ${BURST}-burst costs 150`, async () => {
    await withEnv({}, async ({ burst }) => {
      expect((await burst(BURST)).calls).toBe(150);
    });
  });
  it(`both options: a ${BURST}-burst costs 3`, async () => {
    await withEnv({ downstreamCacheTtlMs: TTL, coalesceInFlight: true }, async ({ burst }) => {
      const b = await burst(BURST);
      expect(b.calls).toBe(3);
      expect(sumTotal(b.replies)).toBe(3);
    });
  });
  it('coalesceInFlight alone: a burst still costs 3 (its semantics unchanged)', async () => {
    await withEnv({ coalesceInFlight: true }, async ({ burst }) => {
      expect((await burst(BURST)).calls).toBe(3);
    });
  });
  it('NAIVE with TTL: a 5-burst costs the same calls as NAIVE without TTL', async () => {
    const without = await withEnv({ loaderOptions: NAIVE }, async ({ burst }) => (await burst(5)).calls);
    const withTtl = await withEnv({ loaderOptions: NAIVE, downstreamCacheTtlMs: TTL }, async ({ burst }) => (await burst(5)).calls);
    expect(without).toBe(105);
    expect(withTtl).toBe(without);
  });
  it('/readyz still costs 1 call per serial probe with TTL on (concurrent probes keep sharing one check)', async () => {
    await withEnv({ downstreamCacheTtlMs: TTL }, async ({ gw, measure }) => {
      for (let i = 0; i < 2; i++) {
        const m = await measure(() => gw.fetch(new Request('http://gateway.local/readyz')));
        expect(m.value.status).toBe(200);
        expect(m.calls).toBe(1);
      }
      const c = await measure(() => Promise.all([1, 2, 3].map(() => gw.fetch(new Request('http://gateway.local/readyz')))));
      expect(c.calls).toBe(1); // README: concurrent probes share one in-flight check, never cached
      const after = await measure(() => gw.fetch(new Request('http://gateway.local/readyz')));
      expect(after.calls).toBe(1);
    });
  });
  it('a cold serial SAMPLE with TTL costs 3', async () => {
    await withEnv({ downstreamCacheTtlMs: TTL }, async ({ gw, measure }) => {
      const m = await measure(() => post(gw, SAMPLE));
      expect(m.calls).toBe(3);
      expect(m.events).toBe(3);
      expect(totalOf(m.value.body)).toBe(3);
    });
  });
});

describe('EB12: docs', () => {
  const row = readme.split('\n').find((l) => l.startsWith('| `downstreamCacheTtlMs` |')) ?? '';
  const envRow = readme.split('\n').find((l) => l.startsWith('| `DOWNSTREAM_CACHE_TTL_MS` |')) ?? '';
  it('options row says concurrent misses share one in-flight GET; sender counts, joiners 0', () => {
    expect(row).not.toBe('');
    expect(row).toContain('concurrent');
    expect(row).toContain('one in-flight');
    expect(row).toMatch(/sender counts it/);
    expect(row).toMatch(/joiners count 0/);
    expect(row).toContain('coalesceInFlight');
  });
  it('env row is unchanged in meaning', () => {
    expect(envRow).toContain('positive integer ≤ 2147483647 → `downstreamCacheTtlMs`');
    expect(envRow).toContain('unset → no shared cache');
  });
  it('README test-index lists this file', () => {
    expect(readme).toContain('test_iter111_behavior.test.ts');
  });
});
