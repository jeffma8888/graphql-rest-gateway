import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend, createGateway, NAIVE, type GatewayOptions, type DownstreamCallEvent } from '../src/lib';
import { BENCHMARK_QUERY } from '../benchmark/benchmark';

/**
 * iter-117: the 4 batched by-key DataLoaders send their sendable keys as a
 * DISTINCT, SORTED id list (PRODUCT row 145), so the same id set in any order
 * is one downstream URL and the opt-in TTL cache / in-flight coalescing reuse it.
 *
 * Black-box: every case builds its OWN bundled Fastify backend on port 0 with
 * an `onRequest` hook (added before `listen`) that records every `req.url`, and
 * drives `createGateway(...).fetch` in-process. No wall-clock bound (H2).
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = BENCHMARK_QUERY;
const NESTED = '{ authors(first:5){ edges{ node{ id books{ id title reviews{ id rating } } } } } }';
const LAST = '{ last: authors(last:5){ edges{ node{ books{ reviews{ id } } } } } }';
const Q1 = '{ books(ids:["a1-b1","a2-b1","a3-b1"]) { id title author { id name } } }';
const Q2 = '{ books(ids:["a3-b1","a1-b1","a2-b1"]) { id title author { id name } } }';
const DUPS = '{ books(ids:["a5-b3","a1-b2","a5-b3","a3-b1"]){ id reviews{ id } } }';
const AUTHOR2 = '{ author(id:"a2"){ books{ id reviews{ id } } } }';
const TWO_AUTHORS = `{ a: author(id:"a1"){ books{ title } } b: author(id:"a2"){ books{ title } } }`;
const UNSENDABLE = '{ books(ids:["x,y"," a1-b1","a2-b1"]){ id } }';
const ALL_UNSENDABLE = '{ books(ids:["x,y"]){ id } }';

/** by-key route -> its id-list query param */
const BY_KEY: Record<string, string> = {
  '/authors/by-ids': 'ids',
  '/books/by-ids': 'ids',
  '/books/by-author': 'authorIds',
  '/reviews/by-book': 'bookIds',
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Gw = ReturnType<typeof createGateway>;
type Body = { data?: any; errors?: Array<{ message: string; path?: unknown[]; extensions?: Record<string, any> }>; extensions?: any };

type Env = { gw: Gw; urls: string[] };

async function withGw<T>(opts: Omit<GatewayOptions, 'restBaseUrl'>, fn: (env: Env) => Promise<T>, latencyMs = 0): Promise<T> {
  const app: FastifyInstance = buildBackend({ latencyMs }).app;
  const urls: string[] = [];
  app.addHook('onRequest', async (req) => {
    urls.push(req.url);
  });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  const gw = createGateway({ restBaseUrl: url, ...opts });
  try {
    return await fn({ gw, urls });
  } finally {
    await gw.close();
    const closing = app.close();
    app.server.closeAllConnections();
    await closing;
  }
}

async function post(gw: Gw, query: string): Promise<Body> {
  const res = await gw.fetch(
    new Request('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query }),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
}

const totalOf = (b: Body) => b.extensions?.downstreamCalls?.total as number;
const pathOf = (u: string) => new URL(u, 'http://x').pathname;
const param = (u: string, name: string) => new URL(u, 'http://x').searchParams.get(name);

/** Run `query` on a fresh gateway with `opts`; return body + backend URLs it caused. */
async function once(query: string, opts: Omit<GatewayOptions, 'restBaseUrl'> = {}): Promise<{ body: Body; urls: string[] }> {
  return withGw(opts, async ({ gw, urls }) => {
    const body = await post(gw, query);
    await sleep(10);
    return { body, urls: [...urls] };
  });
}

function assertSortedDistinct(urls: string[]): number {
  let checked = 0;
  for (const u of urls) {
    const name = BY_KEY[pathOf(u)];
    if (!name) continue;
    const raw = param(u, name);
    expect(raw, `${u} has no ${name}`).not.toBeNull();
    const ids = raw!.split(',');
    expect(ids.length).toBeGreaterThan(0);
    expect(ids, `${u} sorted`).toEqual([...ids].sort());
    expect(new Set(ids).size, `${u} distinct`).toBe(ids.length);
    checked++;
  }
  return checked;
}

// ------------------------------------------------------------------- EBs ---

describe('EB1: sorted URL on a default gateway', () => {
  it('Q2 sends exactly 2 requests with sorted id lists; data keeps request order', async () => {
    const { body, urls } = await once(Q2);
    expect(body.errors).toBeUndefined();
    expect(urls).toHaveLength(2);
    const books = urls.filter((u) => pathOf(u) === '/books/by-ids');
    const authors = urls.filter((u) => pathOf(u) === '/authors/by-ids');
    expect(books).toHaveLength(1);
    expect(authors).toHaveLength(1);
    expect(param(books[0]!, 'ids')).toBe('a1-b1,a2-b1,a3-b1');
    expect(param(authors[0]!, 'ids')).toBe('a1,a2,a3');
    expect(body.data.books.map((b: { id: string }) => b.id)).toEqual(['a3-b1', 'a1-b1', 'a2-b1']);
    expect(body.data.books.map((b: { author: { id: string } }) => b.author.id)).toEqual(['a3', 'a1', 'a2']);
    expect(totalOf(body)).toBe(2);
  });
});

describe('EB2: every batched by-key route is sorted and distinct', () => {
  it.each([
    ['nested sample', NESTED, ['/books/by-author', '/reviews/by-book']],
    ['last page', LAST, ['/books/by-author', '/reviews/by-book']],
    ['Q2', Q2, ['/books/by-ids', '/authors/by-ids']],
    ['duplicate ids', DUPS, ['/books/by-ids', '/reviews/by-book']],
  ])('%s', async (_name, query, routes) => {
    const { body, urls } = await once(query);
    expect(body.errors).toBeUndefined();
    for (const r of routes) expect(urls.map(pathOf), r).toContain(r);
    expect(assertSortedDistinct(urls)).toBeGreaterThanOrEqual(routes.length);
  });

  it('the checker itself rejects unsorted and repeated lists (negative control)', () => {
    expect(() => assertSortedDistinct(['/books/by-ids?ids=a3-b1%2Ca1-b1'])).toThrow();
    expect(() => assertSortedDistinct(['/reviews/by-book?bookIds=a1-b1%2Ca1-b1'])).toThrow();
    expect(assertSortedDistinct(['/authors/by-ids?ids=a1%2Ca2'])).toBe(1);
  });

  it('duplicate ids: bookIds decodes to a1-b2,a3-b1,a5-b3 and data has 4 entries in request order', async () => {
    const { body, urls } = await once(DUPS);
    expect(body.errors).toBeUndefined();
    const rev = urls.filter((u) => pathOf(u) === '/reviews/by-book');
    expect(rev).toHaveLength(1);
    expect(param(rev[0]!, 'bookIds')).toBe('a1-b2,a3-b1,a5-b3');
    const byIds = urls.filter((u) => pathOf(u) === '/books/by-ids');
    expect(byIds).toHaveLength(1);
    expect(param(byIds[0]!, 'ids')).toBe('a1-b2,a3-b1,a5-b3');
    const ids = body.data.books.map((b: { id: string }) => b.id);
    expect(ids).toEqual(['a5-b3', 'a1-b2', 'a5-b3', 'a3-b1']);
    expect(body.data.books[2]).toEqual(body.data.books[0]);
  });
});

describe('EB3: TTL cache hits on a reordered set', () => {
  it('Q1 costs 2, then Q2 costs 0 (total, events, backend hits); data equals a fresh default Q2', async () => {
    const events: DownstreamCallEvent[] = [];
    const fresh = await once(Q2);
    await withGw({ downstreamCacheTtlMs: 600000, onDownstreamCall: (e) => void events.push(e) }, async ({ gw, urls }) => {
      const b1 = await post(gw, Q1);
      expect(b1.errors).toBeUndefined();
      expect(totalOf(b1)).toBe(2);
      await sleep(10);
      const ev0 = events.length;
      const hits0 = urls.length;
      expect(ev0).toBe(2);
      expect(hits0).toBe(2);
      const b2 = await post(gw, Q2);
      await sleep(10);
      expect(b2.errors).toBeUndefined();
      expect(totalOf(b2)).toBe(0);
      expect(events.length - ev0).toBe(0);
      expect(urls.length - hits0).toBe(0);
      expect(b2.data).toEqual(fresh.body.data);
    });
  });
});

describe('EB4: coalescing joins a reordered set', () => {
  it('concurrent Q1,Q2,Q1 at 50 ms latency: 2 backend requests, totals sum to 2, data per query', async () => {
    const d1 = (await once(Q1)).body.data;
    const d2 = (await once(Q2)).body.data;
    await withGw(
      { coalesceInFlight: true },
      async ({ gw, urls }) => {
        const [r1, r2, r3] = await Promise.all([post(gw, Q1), post(gw, Q2), post(gw, Q1)]);
        await sleep(20);
        expect(urls).toHaveLength(2);
        expect(urls.filter((u) => pathOf(u) === '/books/by-ids')).toHaveLength(1);
        expect(urls.filter((u) => pathOf(u) === '/authors/by-ids')).toHaveLength(1);
        expect(totalOf(r1!) + totalOf(r2!) + totalOf(r3!)).toBe(2);
        expect(r1!.data).toEqual(d1);
        expect(r2!.data).toEqual(d2);
        expect(r3!.data).toEqual(d1);
      },
      50,
    );
  });
});

describe('EB5: output identical to NAIVE', () => {
  it.each([
    ['nested sample', NESTED],
    ['last page', LAST],
    ['Q2', Q2],
    ['duplicate ids', DUPS],
    ['author a2', AUTHOR2],
  ])('%s: BATCHED data deep-equals NAIVE data', async (_name, query) => {
    const batched = await once(query);
    const naive = await once(query, { loaderOptions: NAIVE });
    expect(batched.body.errors).toBeUndefined();
    expect(naive.body.errors).toBeUndefined();
    expect(batched.body.data).toEqual(naive.body.data);
    expect(batched.body.data).toBeTruthy();
  });

  it('NAIVE really is one key per call (control: it costs more than BATCHED on the nested sample)', async () => {
    const batched = await once(NESTED);
    const naive = await once(NESTED, { loaderOptions: NAIVE });
    expect(naive.urls.length).toBeGreaterThan(batched.urls.length);
  });
});

describe('EB6: call counts unchanged', () => {
  it('nested sample (benchmark) costs exactly 3 BATCHED: 1 /authors, 1 /books/by-author, 1 /reviews/by-book', async () => {
    const { body, urls } = await once(SAMPLE);
    expect(body.errors).toBeUndefined();
    expect(totalOf(body)).toBe(3);
    expect(urls.map(pathOf).sort()).toEqual(['/authors', '/books/by-author', '/reviews/by-book']);
  });

  it('{ batch: true, cache: false } still costs 2 on TWO_AUTHORS', async () => {
    const { body, urls } = await once(TWO_AUTHORS, { loaderOptions: { batch: true, cache: false } });
    expect(body.errors).toBeUndefined();
    expect(totalOf(body)).toBe(2);
    expect(urls).toHaveLength(2);
  });

  it('cache:false with an aliased duplicate key sends it once and does not double list rows', async () => {
    const dup = `{ a: author(id:"a1"){ books{ id } } b: author(id:"a1"){ books{ id } } }`;
    const off = await once(dup, { loaderOptions: { batch: true, cache: false } });
    const naive = await once(dup, { loaderOptions: NAIVE });
    expect(off.body.errors).toBeUndefined();
    expect(off.body.data).toEqual(naive.body.data);
    expect(assertSortedDistinct(off.urls)).toBeGreaterThanOrEqual(1);
  });

  it('the N+1 regression test file is still present', () => {
    expect(existsSync(resolve(root, 'test', 'n-plus-1.test.ts'))).toBe(true);
  });
});

describe('EB7: unsendable keys still filtered', () => {
  it('["x,y"," a1-b1","a2-b1"] sends 1 /books/by-ids with ids=a2-b1; others null + NOT_FOUND', async () => {
    const { body, urls } = await once(UNSENDABLE);
    const byIds = urls.filter((u) => pathOf(u) === '/books/by-ids');
    expect(byIds).toHaveLength(1);
    expect(urls).toHaveLength(1);
    expect(param(byIds[0]!, 'ids')).toBe('a2-b1');
    expect(body.data.books[0]).toBeNull();
    expect(body.data.books[1]).toBeNull();
    expect(body.data.books[2]).toEqual({ id: 'a2-b1' });
    const codes = (body.errors ?? []).map((e) => e.extensions?.code);
    expect(codes.length).toBeGreaterThanOrEqual(2);
    for (const c of codes) expect(c).toBe('NOT_FOUND');
  });

  it('all-unsendable ["x,y"] costs 0 downstream calls', async () => {
    const { body, urls } = await once(ALL_UNSENDABLE);
    expect(urls).toHaveLength(0);
    expect(totalOf(body)).toBe(0);
    expect(body.data.books).toEqual([null]);
  });
});

describe('EB8: README states it', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  const start = readme.indexOf('## 6. Architecture');
  const end = readme.indexOf('## 7.', start);
  const s6 = readme.slice(start, end);

  it('§6 has the DataLoader paragraph with "distinct ids in sorted order" and the cache/coalesce claim', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const para = s6.split(/\n\s*\n/).find((p) => p.includes('distinct ids in sorted order'));
    expect(para, 'no §6 paragraph with the fragment').toBeDefined();
    expect(para!).toMatch(/request-scoped/i);
    expect(para!).toContain('downstreamCacheTtlMs');
    expect(para!).toContain('coalesceInFlight');
    expect(para!).toMatch(/any order/);
  });

  it('§8 inventory names this file', () => {
    expect(readme.includes('test_iter117_behavior.test.ts'), 'README §8 lacks the iter117 bullet').toBe(true);
  });
});
