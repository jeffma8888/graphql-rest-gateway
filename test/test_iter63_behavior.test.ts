import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createGateway, buildBackend } from '../src/lib';
import { NAIVE } from '../src/gateway/loaders';

/**
 * iter-63: multi-root by-id lookahead prefetch.
 * Black-box: the bundled backend runs in-process on port 0 and the gateway is
 * driven through createGateway(...).fetch. Every call count is read from the
 * backend's own /__stats counter (total + byRoute) and cross-checked against
 * the response's extensions.downstreamCalls.total. Latency is the median of 5
 * timed requests after 1 warm-up against a backend with latencyMs: 50.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

type Gateway = ReturnType<typeof createGateway>;
type Stats = { total: number; byRoute: Record<string, number> };
type GqlError = { message: string; path?: Array<string | number>; extensions?: Record<string, unknown> };
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
  extensions?: { downstreamCalls?: { total: number } };
};

const TWO_AUTHORS = `{ a: author(id:"a1"){ books{ title } } b: author(id:"a2"){ books{ title } } }`;
const FIVE_AUTHORS = `{ ${['a', 'b', 'c', 'd', 'e']
  .map((alias, i) => `${alias}: author(id:"a${i + 1}"){ name books{ title } }`)
  .join(' ')} }`;
const AUTHOR_BOOK = `{ a: author(id:"a1"){ books{ title } } b: book(id:"a2-b1"){ reviews{ rating } } }`;
const THREE_BOOKS = `{ a: book(id:"a1-b1"){ reviews{ rating } } b: book(id:"a1-b2"){ reviews{ rating } } c: book(id:"a2-b1"){ reviews{ rating } } }`;
const DEEP_MIX = `{ a: author(id:"a1"){ books{ reviews{ rating } } } b: book(id:"a2-b1"){ reviews{ rating } } }`;
const DUP_IDS = `{ a: author(id:"a1"){ books{ title } } b: author(id:"a1"){ books{ title } } }`;
const ONE_MISSING = `{ a: author(id:"zz"){ books{ title } } b: author(id:"a2"){ books{ title } } }`;
const ALL_MISSING = `{ a: author(id:"zz"){ books{ title } } b: book(id:"zz"){ reviews{ rating } } }`;
const SKIP_CHILD = `query($x:Boolean!){ a: author(id:"a1"){ books @skip(if:$x){ title } } b: author(id:"a2"){ books{ title } } }`;
const NO_CHILD = `{ a: author(id:"a1"){ name } b: author(id:"a2"){ books{ title } } }`;
const INCLUDE_ROOT = `query($x:Boolean!){ a: author(id:"a1"){ books{ title } } b: author(id:"a2") @include(if:$x){ books{ title } } }`;
const CROSS_A2 = `{ a: book(id:"a2-b1"){ author{ books{ title } } } b: author(id:"a1"){ books{ title } } }`;
const CROSS_A1 = `{ a: book(id:"a1-b1"){ author{ books{ title } } } b: author(id:"a1"){ books{ title } } }`;
const BACK_EDGE = `{ a: book(id:"a1-b1"){ reviews{ book{ reviews{ rating } } } } b: book(id:"a2-b1"){ reviews{ rating } } }`;
const WITH_LIST_ROOT = `{ a: author(id:"a1"){ books{ title } } authors(first:2){ edges{ node{ books{ title } } } } }`;
const ROOT_FRAGMENT = `query { ...R } fragment R on Query { a: author(id:"a1"){ books{ title } } b: author(id:"a2"){ books{ title } } }`;
const ROOT_TYPENAME = `{ __typename a: author(id:"a1"){ books{ title } } b: author(id:"a2"){ books{ title } } }`;
const BUDGET_CODE = 'DOWNSTREAM_BUDGET_EXCEEDED';

async function gql(gw: Gateway, query: string, variables?: Record<string, unknown>): Promise<GqlResult> {
  const res = await gw.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as GqlResult;
}

async function resetStats(b: string): Promise<void> {
  const r = await fetch(`${b}/__stats/reset`, { method: 'POST' });
  expect(r.ok).toBe(true);
}

async function readStats(b: string): Promise<Stats> {
  const r = await fetch(`${b}/__stats`);
  return (await r.json()) as Stats;
}

/** Runs one request; returns its body and the backend's measured stats (edge === backend). */
async function measured(
  gw: Gateway,
  b: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ body: GqlResult; stats: Stats }> {
  await resetStats(b);
  const body = await gql(gw, query, variables);
  await settle(20);
  const stats = await readStats(b);
  expect(body.extensions?.downstreamCalls?.total).toBe(stats.total);
  return { body, stats };
}

async function medianMs(gw: Gateway, query: string): Promise<number> {
  await gql(gw, query); // warm-up
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const body = await gql(gw, query);
    samples.push(performance.now() - t0);
    expect(body.errors).toBeUndefined();
  }
  samples.sort((x, y) => x - y);
  return samples[2]!;
}

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

const rejections: unknown[] = [];
const onRejection = (reason: unknown): void => {
  rejections.push(reason);
};

let app: FastifyInstance;
let base: string;
let slowApp: FastifyInstance;
let slowBase: string;
let batched: Gateway;
let naive: Gateway;
let slow: Gateway;

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  slowApp = buildBackend({ latencyMs: 50 }).app;
  slowBase = await slowApp.listen({ port: 0, host: '127.0.0.1' });
  batched = createGateway({ restBaseUrl: base });
  naive = createGateway({ restBaseUrl: base, loaderOptions: NAIVE });
  slow = createGateway({ restBaseUrl: slowBase });
  process.on('unhandledRejection', onRejection);
});

afterAll(async () => {
  process.off('unhandledRejection', onRejection);
  await app.close();
  await slowApp.close();
});

afterEach(() => {
  rejections.length = 0;
});

async function naiveData(query: string, variables?: Record<string, unknown>): Promise<unknown> {
  const body = await gql(naive, query, variables);
  return body.data;
}

/** Shared shape check: exact count + routes, no errors, data equals NAIVE's. */
async function expectShape(
  query: string,
  total: number,
  byRoute: Record<string, number> | null,
  variables?: Record<string, unknown>,
): Promise<GqlResult> {
  const { body, stats } = await measured(batched, base, query, variables);
  expect(body.errors).toBeUndefined();
  expect(stats.total).toBe(total);
  if (byRoute) expect(stats.byRoute).toEqual(byRoute);
  expect(body.data).toEqual(await naiveData(query, variables));
  expect(body.data).not.toBeNull();
  return body;
}

describe('EB1 - two aliased authors', () => {
  it('2 calls, one per route, data equals NAIVE', async () => {
    const body = await expectShape(TWO_AUTHORS, 2, { '/authors/by-ids': 1, '/books/by-author': 1 });
    const a = body.data?.a as { books: unknown[] };
    const b = body.data?.b as { books: unknown[] };
    expect(a.books.length).toBeGreaterThan(0);
    expect(b.books.length).toBeGreaterThan(0);
  });
  it('median < 85 ms at 50 ms latency (HEAD ~110 ms)', async () => {
    expect(await medianMs(slow, TWO_AUTHORS)).toBeLessThan(85);
  });
});

describe('EB2 - five aliased authors', () => {
  it('2 calls, one per route, data equals NAIVE', async () => {
    const body = await expectShape(FIVE_AUTHORS, 2, { '/authors/by-ids': 1, '/books/by-author': 1 });
    expect(Object.keys(body.data ?? {}).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('median < 85 ms', async () => {
    expect(await medianMs(slow, FIVE_AUTHORS)).toBeLessThan(85);
  });
});

describe('EB3 - author + book roots', () => {
  it('4 calls, one per route, data equals NAIVE', async () => {
    await expectShape(AUTHOR_BOOK, 4, {
      '/authors/by-ids': 1,
      '/books/by-author': 1,
      '/books/by-ids': 1,
      '/reviews/by-book': 1,
    });
  });
  it('median < 85 ms (HEAD ~111 ms)', async () => {
    expect(await medianMs(slow, AUTHOR_BOOK)).toBeLessThan(85);
  });
});

describe('EB4 - three book roots', () => {
  it('2 calls, one per route, data equals NAIVE', async () => {
    const body = await expectShape(THREE_BOOKS, 2, { '/books/by-ids': 1, '/reviews/by-book': 1 });
    expect(Object.keys(body.data ?? {}).sort()).toEqual(['a', 'b', 'c']);
  });
  it('median < 85 ms', async () => {
    expect(await medianMs(slow, THREE_BOOKS)).toBeLessThan(85);
  });
});

describe('EB5 - deep mix keeps its count and loses one hop', () => {
  it('5 calls with /reviews/by-book twice, data equals NAIVE', async () => {
    await expectShape(DEEP_MIX, 5, {
      '/authors/by-ids': 1,
      '/books/by-author': 1,
      '/books/by-ids': 1,
      '/reviews/by-book': 2,
    });
  });
  it('median < 135 ms (HEAD ~158 ms)', async () => {
    expect(await medianMs(slow, DEEP_MIX)).toBeLessThan(135);
  });
});

describe('EB6 - duplicate and missing ids', () => {
  it('duplicate id: 2 calls and data.a equals data.b', async () => {
    const { body, stats } = await measured(batched, base, DUP_IDS);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(2);
    expect(stats.byRoute).toEqual({ '/authors/by-ids': 1, '/books/by-author': 1 });
    expect(body.data?.a).not.toBeNull();
    expect(body.data?.a).toEqual(body.data?.b);
  });
  it('one missing id: 2 calls, a null with one NOT_FOUND at ["a"], b equals NAIVE', async () => {
    const { body, stats } = await measured(batched, base, ONE_MISSING);
    expect(stats.total).toBe(2);
    expect(body.data?.a).toBeNull();
    expect(body.errors).toHaveLength(1);
    const err = body.errors![0]!;
    expect(err.extensions?.code).toBe('NOT_FOUND');
    expect(err.extensions?.id).toBe('zz');
    expect(err.path).toEqual(['a']);
    const n = (await naiveData(ONE_MISSING)) as Record<string, unknown>;
    expect(body.data?.b).toEqual(n.b);
    expect(body.data?.b).not.toBeNull();
  });
});

describe('EB7 - all-missing roots spend one honest call per child route', () => {
  it('4 calls one per route, { a: null, b: null }, 2 NOT_FOUND, no unhandledRejection', async () => {
    const { body, stats } = await measured(batched, base, ALL_MISSING);
    expect(stats.total).toBe(4);
    expect(stats.byRoute).toEqual({
      '/authors/by-ids': 1,
      '/books/by-author': 1,
      '/books/by-ids': 1,
      '/reviews/by-book': 1,
    });
    expect(body.data).toEqual({ a: null, b: null });
    expect(body.errors).toHaveLength(2);
    for (const e of body.errors!) expect(e.extensions?.code).toBe('NOT_FOUND');
    await settle(50);
    expect(rejections).toEqual([]);
  });
});

describe('EB8 - per-root child exclusion still holds', () => {
  const routes = { '/authors/by-ids': 1, '/books/by-author': 1 };
  it('(a) @skip on one root child: 2 calls, no a.books key', async () => {
    const body = await expectShape(SKIP_CHILD, 2, routes, { x: true });
    const a = body.data?.a as Record<string, unknown>;
    expect(a).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(a, 'books')).toBe(false);
  });
  it('(b) one root without child: 2 calls', async () => {
    await expectShape(NO_CHILD, 2, routes);
  });
  it('(c) @include(false) root: 2 calls, no b key', async () => {
    const body = await expectShape(INCLUDE_ROOT, 2, routes, { x: false });
    expect(Object.prototype.hasOwnProperty.call(body.data, 'b')).toBe(false);
    expect(body.data?.a).toBeTruthy();
  });
});

describe('EB9 - cross-edge shapes keep their counts', () => {
  it('book(a2-b1){author{books}} + author(a1){books}: 5 calls', async () => {
    await expectShape(CROSS_A2, 5, { '/authors/by-ids': 2, '/books/by-author': 2, '/books/by-ids': 1 });
  });
  it('book(a1-b1){author{books}} + author(a1){books}: 3 calls, one per route', async () => {
    await expectShape(CROSS_A1, 3, { '/authors/by-ids': 1, '/books/by-author': 1, '/books/by-ids': 1 });
  });
  it('Review.book back-edge mix: 2 calls', async () => {
    await expectShape(BACK_EDGE, 2, null);
  });
});

describe('EB10 - non-by-id roots disable prefetch, batches never split', () => {
  it('by-id + list root: 3 calls', async () => {
    await expectShape(WITH_LIST_ROOT, 3, { '/authors/by-ids': 1, '/books/by-author': 1, '/authors': 1 });
  });
  it('root named fragment around two by-id roots: 2 calls', async () => {
    await expectShape(ROOT_FRAGMENT, 2, { '/authors/by-ids': 1, '/books/by-author': 1 });
  });
  it('root __typename beside two by-id roots: 2 calls', async () => {
    const body = await expectShape(ROOT_TYPENAME, 2, { '/authors/by-ids': 1, '/books/by-author': 1 });
    expect(body.data?.__typename).toBe('Query');
  });
});

describe('EB11 - no-cache modes never prefetch', () => {
  it('EB1 query: 4 calls under NAIVE, 2 under cache:false', async () => {
    const noCache = createGateway({ restBaseUrl: base, loaderOptions: { batch: true, cache: false } });
    const n = await measured(naive, base, TWO_AUTHORS);
    expect(n.body.errors).toBeUndefined();
    expect(n.stats.total).toBe(4);
    const c = await measured(noCache, base, TWO_AUTHORS);
    expect(c.body.errors).toBeUndefined();
    expect(c.stats.total).toBe(2);
  });
  it('EB3 query: 4 calls in both modes', async () => {
    const noCache = createGateway({ restBaseUrl: base, loaderOptions: { batch: true, cache: false } });
    const n = await measured(naive, base, AUTHOR_BOOK);
    expect(n.stats.total).toBe(4);
    const c = await measured(noCache, base, AUTHOR_BOOK);
    expect(c.stats.total).toBe(4);
  });
  it('EB1 query median >= 95 ms in both modes (still the waterfall)', async () => {
    const slowNaive = createGateway({ restBaseUrl: slowBase, loaderOptions: NAIVE });
    const slowNoCache = createGateway({ restBaseUrl: slowBase, loaderOptions: { batch: true, cache: false } });
    expect(await medianMs(slowNaive, TWO_AUTHORS)).toBeGreaterThanOrEqual(95);
    expect(await medianMs(slowNoCache, TWO_AUTHORS)).toBeGreaterThanOrEqual(95);
  });
});

describe('EB12 - the budget is still a hard ceiling', () => {
  it('maxDownstreamCalls 2: EB1 query has no errors and 2 calls', async () => {
    const gw = createGateway({ restBaseUrl: base, maxDownstreamCalls: 2 });
    const { body, stats } = await measured(gw, base, TWO_AUTHORS);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(2);
    expect(body.data).toEqual(await naiveData(TWO_AUTHORS));
  });
  it('maxDownstreamCalls 2: EB3 query makes exactly 2 calls and reports a budget error', async () => {
    const gw = createGateway({ restBaseUrl: base, maxDownstreamCalls: 2 });
    await resetStats(base);
    const body = await gql(gw, AUTHOR_BOOK);
    // Never exceeds 2 on any read, and settles at exactly 2.
    for (let i = 0; i < 5; i++) {
      expect((await readStats(base)).total).toBeLessThanOrEqual(2);
      await settle(20);
    }
    expect((await readStats(base)).total).toBe(2);
    expect(body.extensions?.downstreamCalls?.total).toBe(2);
    const budgetErrors = (body.errors ?? []).filter((e) => e.extensions?.code === BUDGET_CODE);
    expect(budgetErrors.length).toBeGreaterThanOrEqual(1);
    for (const e of budgetErrors) expect(e.extensions?.budget).toBe(2);
  });
});

describe('EB13 - README states the new prefetch rule', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  const para = readme.split('\n').find((l) => l.includes('Lookahead prefetch')) ?? '';
  it('the lookahead paragraph exists and no longer says "sole root field"', () => {
    expect(para.length).toBeGreaterThan(100);
    expect(para.toLowerCase()).not.toContain('sole root field');
  });
  it('states the every-root by-id rule, aliases included', () => {
    expect(para).toMatch(/every root selection is a by-id `author`\/`book` field/);
    expect(para.toLowerCase()).toContain('aliases included');
  });
  it('names list root, root fragment and root __typename as disabling it', () => {
    expect(para).toContain('list root');
    expect(para.toLowerCase()).toMatch(/root-level fragment|root fragment/);
    expect(para).toContain('`__typename`');
    expect(para.toLowerCase()).toContain('disables');
  });
  it('keeps the missing-id +1-call-per-child-route cost documented', () => {
    expect(para).toContain('2 downstream calls instead of 1');
    expect(para.toLowerCase()).toContain('once per child route');
  });
});
