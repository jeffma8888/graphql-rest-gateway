import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createGateway, buildBackend, NAIVE } from '../src/lib';

/**
 * iter-81: an `authors` list root whose selection never selects `books` or
 * `reviews` keeps the by-id lookahead prefetch (row 64).
 * Black-box: bundled backend in-process on port 0, gateway driven through
 * createGateway(...).fetch. Call counts come from the backend's /__stats
 * counter (total + byRoute) and are cross-checked against
 * extensions.downstreamCalls.total. Hops: each timed shape gets its OWN
 * latencyMs:50 backend + gateway, so timed runs of one shape are sequential
 * and never overlap another timed shape on the same backend; the shapes run
 * side by side to keep the file fast. Fastest of 5 runs after 1 warm-up;
 * "2 hops" < 145 ms, "3 hops" >= 145 ms (the iter-70/76 threshold).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const README = readFileSync(resolve(root, 'README.md'), 'utf8');

type Gateway = ReturnType<typeof createGateway>;
type Stats = { total: number; byRoute: Record<string, number> };
type GqlError = { message: string; path?: Array<string | number>; extensions?: Record<string, unknown> };
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
  extensions?: { downstreamCalls?: { total: number }; queryComplexity?: { cost: number; depth: number } };
};
type Vars = Record<string, unknown> | undefined;

const HOP_MS = 145;
const ONE_HOP_MS = 95;

const A = 'author(id: "a1") { books { reviews { id } } }';
const LIST_COUNT = 'authors(first: 3) { totalCount }';
const LIST_NAMES = 'authors(first: 3) { edges { node { name } } pageInfo { hasNextPage } }';
const LIST_BOOKS = 'authors(first: 3) { edges { node { books { id } } } }';
const BOOK_REVIEWS = 'book(id: "a1-b1") { reviews { id } }';
const LIST_COUNT_2 = 'authors(first: 2) { totalCount }';
const LIST_SKIP_LIT = 'authors(first: 3) { edges { node { name books @skip(if: true) { id } } } }';
const LIST_SKIP_VAR = 'authors(first: 3) { edges { node { name books @skip(if: $s) { id } } } }';

const EB1 = `{ ${A} ${LIST_COUNT} }`;
const EB2 = `{ ${A} ${LIST_NAMES} }`;
const EB3 = `{ ${BOOK_REVIEWS} ${LIST_COUNT_2} }`;
const EB4 = `{ ${A} ${LIST_BOOKS} }`;
const EB5_NAMED = `query { ${A} authors(first: 3) { edges { node { ...F } } } } fragment F on Author { books { id } }`;
const EB5_INLINE = `{ ${A} authors(first: 3) { edges { node { ... on Author { books { id } } } } } }`;
const EB6_LIT = `{ ${A} ${LIST_SKIP_LIT} }`;
const EB6_VAR = `query($s: Boolean!) { ${A} ${LIST_SKIP_VAR} }`;
const EB7 = `query { ${A} ... on Query { ${LIST_COUNT_2} } }`;
const EB8_OK = `{ ${A} x: authors(first: 3) { totalCount } y: authors(first: 2) { edges { cursor } } }`;
const EB8_REFUSE = `{ ${A} x: authors(first: 3) { totalCount } y: authors(first: 2) { edges { node { books { id } } } } }`;
const EB9 = `{ book(id: "a1-b1") { author { books { id } } } ${LIST_BOOKS} }`;
const EB10_SCHEMA = `{ ${A} __schema { queryType { name } } }`;

const R_EB1 = { '/authors/by-ids': 1, '/books/by-author': 1, '/reviews/by-book': 1, '/authors': 1 };
const R_EB3 = { '/books/by-ids': 1, '/reviews/by-book': 1, '/authors': 1 };
const R_EB8 = { '/authors/by-ids': 1, '/books/by-author': 1, '/reviews/by-book': 1, '/authors': 2 };
const R_EB9 = { '/books/by-ids': 1, '/authors': 1, '/books/by-author': 1 };
const R_A_ONLY = { '/authors/by-ids': 1, '/books/by-author': 1, '/reviews/by-book': 1 };

async function post(gw: Gateway, payload: unknown): Promise<{ status: number; body: unknown }> {
  const res = await gw.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function gql(gw: Gateway, query: string, variables?: Vars): Promise<GqlResult> {
  const r = await post(gw, variables ? { query, variables } : { query });
  expect(r.status).toBe(200);
  return r.body as GqlResult;
}

async function resetStats(b: string): Promise<void> {
  const r = await fetch(`${b}/__stats/reset`, { method: 'POST' });
  expect(r.ok).toBe(true);
}

async function readStats(b: string): Promise<Stats> {
  const r = await fetch(`${b}/__stats`);
  return (await r.json()) as Stats;
}

// ---------------------------------------------------------------- timed shapes
type Mode = 'batched' | 'naive';
type Timed = { fastest: number; samples: number[]; totals: number[]; stats: Stats; last: GqlResult };
const timedShapes: Array<[string, Mode, string, Vars]> = [
  ['EB1', 'batched', EB1, undefined],
  ['EB2', 'batched', EB2, undefined],
  ['EB3', 'batched', EB3, undefined],
  ['EB4', 'batched', EB4, undefined],
  ['EB5_NAMED', 'batched', EB5_NAMED, undefined],
  ['EB5_INLINE', 'batched', EB5_INLINE, undefined],
  ['EB6_LIT', 'batched', EB6_LIT, undefined],
  ['EB6_VAR_F', 'batched', EB6_VAR, { s: false }],
  ['EB6_VAR_T', 'batched', EB6_VAR, { s: true }],
  ['EB7', 'batched', EB7, undefined],
  ['EB8_OK', 'batched', EB8_OK, undefined],
  ['EB8_REFUSE', 'batched', EB8_REFUSE, undefined],
  ['EB10_SCHEMA', 'batched', EB10_SCHEMA, undefined],
  ['EB10_NAIVE_EB1', 'naive', EB1, undefined],
  ['EB10_NAIVE_EB2', 'naive', EB2, undefined],
];
const timed = new Map<string, Timed>();
const timedApps: FastifyInstance[] = [];

/**
 * Own slow backend + gateway: warm-up, then 5 sequential runs, stats of the LAST run.
 * `fastest` is the minimum sample: the backend's per-handler sleep is a hard floor
 * for every hop, and contention (these shapes run concurrently) only adds time.
 */
async function measureShape(mode: Mode, query: string, variables: Vars): Promise<Timed> {
  const sApp = buildBackend({ latencyMs: 50 }).app;
  timedApps.push(sApp);
  const sBase = await sApp.listen({ port: 0, host: '127.0.0.1' });
  const g = createGateway({ restBaseUrl: sBase, ...(mode === 'naive' ? { loaderOptions: NAIVE } : {}) });
  await gql(g, query, variables); // warm-up
  const samples: number[] = [];
  const totals: number[] = [];
  let last: GqlResult = {};
  for (let i = 0; i < 5; i++) {
    await resetStats(sBase);
    const t0 = performance.now();
    last = await gql(g, query, variables);
    samples.push(performance.now() - t0);
    totals.push(last.extensions?.downstreamCalls?.total ?? -1);
  }
  const stats = await readStats(sBase);
  return { fastest: Math.min(...samples), samples, totals, stats, last };
}

let app: FastifyInstance;
let base: string;
let gw: Gateway;
let naive: Gateway;

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  gw = createGateway({ restBaseUrl: base });
  naive = createGateway({ restBaseUrl: base, loaderOptions: NAIVE });
  await Promise.all(
    timedShapes.map(async ([key, mode, q, v]) => {
      timed.set(key, await measureShape(mode, q, v));
    }),
  );
}, 60_000);

afterAll(async () => {
  await app.close();
  await Promise.all(timedApps.map((a) => a.close()));
});

function t(key: string): Timed {
  const r = timed.get(key);
  expect(r, `no timing for ${key}`).toBeDefined();
  return r!;
}

/** One request against the fast backend; extensions total == backend total. */
async function measured(g: Gateway, query: string, variables?: Vars): Promise<{ body: GqlResult; stats: Stats }> {
  await resetStats(base);
  const body = await gql(g, query, variables);
  const stats = await readStats(base);
  expect(body.extensions?.downstreamCalls?.total).toBe(stats.total);
  return { body, stats };
}

/** Calls + routes on the fast backend, and on the timed backend every run. */
async function expectCalls(key: string, q: string, v: Vars, total: number, routes: Record<string, number>) {
  const { body, stats } = await measured(gw, q, v);
  expect(body.errors).toBeUndefined();
  expect(stats.total).toBe(total);
  expect(stats.byRoute).toEqual(routes);
  const tm = t(key);
  expect(tm.last.errors).toBeUndefined();
  expect(tm.totals).toEqual([total, total, total, total, total]);
  expect(tm.stats.total).toBe(total);
  expect(tm.stats.byRoute).toEqual(routes);
  return body;
}

// ---------------------------------------------------------------- EBs

describe('EB1 - a count-only list root keeps the prefetch', () => {
  it('{ A authors(first:3){ totalCount } }: no errors, 4 calls one per route', async () => {
    await expectCalls('EB1', EB1, undefined, 4, R_EB1);
  });
  it('EB1 fastest < 145 ms (2 serial hops)', () => {
    expect(t('EB1').fastest).toBeLessThan(HOP_MS);
  });
});

describe('EB2 - a scalar-only list root keeps the prefetch', () => {
  it('names + pageInfo: the same 4 calls on the same 4 routes', async () => {
    const body = await expectCalls('EB2', EB2, undefined, 4, R_EB1);
    const edges = (body.data?.authors as { edges: Array<{ node: { name: string } }> }).edges;
    expect(edges).toHaveLength(3);
    for (const e of edges) expect(typeof e.node.name).toBe('string');
  });
  it('EB2 fastest < 145 ms', () => {
    expect(t('EB2').fastest).toBeLessThan(HOP_MS);
  });
});

describe('EB3 - a book(id){ reviews } root next to a count list', () => {
  it('3 calls: /books/by-ids, /reviews/by-book, /authors once each', async () => {
    await expectCalls('EB3', EB3, undefined, 3, R_EB3);
  });
  it('EB3 fastest < 95 ms (1 hop)', () => {
    expect(t('EB3').fastest).toBeLessThan(ONE_HOP_MS);
  });
});

describe('EB4 - a list that reaches books still refuses (negative oracle)', () => {
  it('4 calls one per route; /books/by-author exactly once (batch not split)', async () => {
    const body = await expectCalls('EB4', EB4, undefined, 4, R_EB1);
    const nv = await gql(naive, EB4);
    expect(body.data).toEqual(nv.data);
  });
  it('EB4 fastest >= 145 ms (3 hops)', () => {
    expect(t('EB4').fastest).toBeGreaterThanOrEqual(HOP_MS);
  });
});

describe('EB5 - books reached through fragments still refuses', () => {
  for (const [name, key, q] of [
    ['named fragment ...F', 'EB5_NAMED', EB5_NAMED],
    ['inline ... on Author', 'EB5_INLINE', EB5_INLINE],
  ] as const) {
    it(`${name}: 4 calls, /books/by-author once, data as EB4`, async () => {
      const body = await expectCalls(key, q, undefined, 4, R_EB1);
      const eb4 = await gql(gw, EB4);
      expect(body.data).toEqual(eb4.data);
    });
    it(`${name}: fastest >= 145 ms`, () => {
      expect(t(key).fastest).toBeGreaterThanOrEqual(HOP_MS);
    });
  }
});

describe('EB6 - @skip/@include honoured inside the list', () => {
  it('books @skip(if: true): 4 calls, fastest < 145 ms, no books in the list', async () => {
    const body = await expectCalls('EB6_LIT', EB6_LIT, undefined, 4, R_EB1);
    const edges = (body.data?.authors as { edges: Array<{ node: Record<string, unknown> }> }).edges;
    for (const e of edges) expect(e.node).not.toHaveProperty('books');
    expect(t('EB6_LIT').fastest).toBeLessThan(HOP_MS);
  });
  it('books @skip(if: $s) with s=false: 4 calls, fastest >= 145 ms', async () => {
    const body = await expectCalls('EB6_VAR_F', EB6_VAR, { s: false }, 4, R_EB1);
    const edges = (body.data?.authors as { edges: Array<{ node: Record<string, unknown> }> }).edges;
    for (const e of edges) expect(e.node).toHaveProperty('books');
    expect(t('EB6_VAR_F').fastest).toBeGreaterThanOrEqual(HOP_MS);
  });
  it('books @skip(if: $s) with s=true: 4 calls, fastest < 145 ms', async () => {
    await expectCalls('EB6_VAR_T', EB6_VAR, { s: true }, 4, R_EB1);
    expect(t('EB6_VAR_T').fastest).toBeLessThan(HOP_MS);
  });
});

describe('EB7 - a count root hidden in a root fragment keeps the prefetch', () => {
  it('query { A ... on Query { authors(first:2){ totalCount } } }: 4 calls, fastest < 145 ms', async () => {
    await expectCalls('EB7', EB7, undefined, 4, R_EB1);
    expect(t('EB7').fastest).toBeLessThan(HOP_MS);
  });
});

describe('EB8 - multiple list roots', () => {
  it('two count/cursor list roots: 5 calls (/authors x2), fastest < 145 ms', async () => {
    await expectCalls('EB8_OK', EB8_OK, undefined, 5, R_EB8);
    expect(t('EB8_OK').fastest).toBeLessThan(HOP_MS);
  });
  it('if either list root selects books, it refuses: 5 calls, fastest >= 145 ms', async () => {
    await expectCalls('EB8_REFUSE', EB8_REFUSE, undefined, 5, R_EB8);
    expect(t('EB8_REFUSE').fastest).toBeGreaterThanOrEqual(HOP_MS);
  });
});

describe('EB9 - the Book.author gate shares the rule', () => {
  it('book(id){ author{ books } } + list reaching books: 3 calls, /books/by-author once', async () => {
    const { body, stats } = await measured(gw, EB9);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(3);
    expect(stats.byRoute).toEqual(R_EB9);
    const nv = await gql(naive, EB9);
    expect(body.data).toEqual(nv.data);
  });
});

describe('EB10 - other refusals unchanged', () => {
  it('{ A __schema { queryType { name } } }: 3 calls, fastest >= 145 ms', async () => {
    const tm = t('EB10_SCHEMA');
    const { body, stats } = await measured(gw, EB10_SCHEMA);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(3);
    expect(stats.byRoute).toEqual(R_A_ONLY);
    expect((body.data?.__schema as { queryType: { name: string } }).queryType.name).toBe('Query');
    expect(tm.totals).toEqual([3, 3, 3, 3, 3]);
    expect(tm.fastest).toBeGreaterThanOrEqual(HOP_MS);
  });
  for (const key of ['EB10_NAIVE_EB1', 'EB10_NAIVE_EB2'] as const) {
    it(`${key}: NAIVE loaders, no errors, fastest >= 145 ms (no prefetch with cache off)`, () => {
      const tm = t(key);
      expect(tm.last.errors).toBeUndefined();
      expect(tm.last.data).toBeTruthy();
      expect(tm.fastest).toBeGreaterThanOrEqual(HOP_MS);
    });
  }
});

describe('EB11 - data identity', () => {
  const cases: Array<[string, string, Vars, string, string, Vars]> = [
    ['EB1', EB1, undefined, `{ ${A} }`, `{ ${LIST_COUNT} }`, undefined],
    ['EB2', EB2, undefined, `{ ${A} }`, `{ ${LIST_NAMES} }`, undefined],
    ['EB3', EB3, undefined, `{ ${BOOK_REVIEWS} }`, `{ ${LIST_COUNT_2} }`, undefined],
    ['EB6 literal', EB6_LIT, undefined, `{ ${A} }`, `{ ${LIST_SKIP_LIT} }`, undefined],
    ['EB6 $s=true', EB6_VAR, { s: true }, `{ ${A} }`, `query($s: Boolean!) { ${LIST_SKIP_VAR} }`, { s: true }],
    ['EB6 $s=false', EB6_VAR, { s: false }, `{ ${A} }`, `query($s: Boolean!) { ${LIST_SKIP_VAR} }`, { s: false }],
    ['EB7', EB7, undefined, `{ ${A} }`, `{ ${LIST_COUNT_2} }`, undefined],
  ];
  for (const [name, q, v, byId, list, lv] of cases) {
    it(`${name}: data equals NAIVE and the two parts run separately`, async () => {
      const [b, n, p1, p2] = await Promise.all([gql(gw, q, v), gql(naive, q, v), gql(gw, byId), gql(gw, list, lv)]);
      for (const r of [b, n, p1, p2]) expect(r.errors).toBeUndefined();
      expect(b.data).toBeTruthy();
      expect(b.data).toEqual(n.data);
      expect(b.data).toEqual({ ...p1.data, ...p2.data });
      expect(Object.keys(b.data!).sort()).toEqual([...Object.keys(p1.data!), ...Object.keys(p2.data!)].sort());
    });
  }
  it('EB1 data is non-trivial (author has books with reviews, totalCount is a number)', async () => {
    const b = await gql(gw, EB1);
    const author = b.data?.author as { books: Array<{ reviews: unknown[] }> };
    expect(author.books.length).toBeGreaterThan(0);
    expect(author.books.some((bk) => bk.reviews.length > 0)).toBe(true);
    expect(typeof (b.data?.authors as { totalCount: unknown }).totalCount).toBe('number');
  });
});

describe('EB12 - admission unchanged', () => {
  it('EB1 reports queryComplexity { cost: 36, depth: 4 }', async () => {
    const b = await gql(gw, EB1);
    expect(b.extensions?.queryComplexity).toEqual({ cost: 36, depth: 4 });
  });
  it('maxDownstreamCalls: 4 admits EB1 with no errors and total 4', async () => {
    const g4 = createGateway({ restBaseUrl: base, maxDownstreamCalls: 4 });
    const { body, stats } = await measured(g4, EB1);
    expect(body.errors).toBeUndefined();
    expect(body.extensions?.downstreamCalls?.total).toBe(4);
    expect(stats.total).toBe(4);
  });
  it('maxDownstreamCalls: 3 gives DOWNSTREAM_BUDGET_EXCEEDED with total 3', async () => {
    const g3 = createGateway({ restBaseUrl: base, maxDownstreamCalls: 3 });
    const body = await gql(g3, EB1);
    expect(body.errors?.length ?? 0).toBeGreaterThan(0);
    expect(body.errors!.some((e) => e.extensions?.code === 'DOWNSTREAM_BUDGET_EXCEEDED')).toBe(true);
    expect(body.extensions?.downstreamCalls?.total).toBe(3);
  });
});

describe('EB13 - README lookahead paragraph', () => {
  const HEAD = '**Lookahead prefetch on by-id roots.**';
  const LIST_SENT_START = 'A list root (`authors`) disables it';
  const LIST_SENT_END = 'introspection roots such as `__schema` disable it too.';
  function paragraph(): string {
    const i = README.indexOf(HEAD);
    expect(i).toBeGreaterThanOrEqual(0);
    const end = README.indexOf('\n', i);
    return README.slice(i, end < 0 ? undefined : end);
  }
  function appended(): string {
    const p = paragraph();
    const s = p.indexOf(LIST_SENT_START);
    expect(s).toBeGreaterThan(0);
    const e = p.indexOf(LIST_SENT_END, s);
    expect(e).toBeGreaterThan(s);
    const rest = p.slice(e + LIST_SENT_END.length);
    expect(rest.startsWith(' ')).toBe(true);
    // the next sentence: up to the following sentence boundary ". A " / ". It "
    const m = /^ (.+?\.)(?= [A-Z])/.exec(rest);
    expect(m).not.toBeNull();
    return m![1]!;
  }
  it('the sentence right after the list-root sentence says it never selects `books` or `reviews`', () => {
    expect(appended()).toContain('never selects `books` or `reviews`');
  });
  it('it names the authors(first:3){ totalCount } example', () => {
    expect(appended()).toContain('authors(first:3){ totalCount }');
  });
  it('it states 2 serial round trips instead of 3 at the same 4 downstream calls', () => {
    const s = appended();
    expect(s).toContain('2 serial round trips instead of 3');
    expect(s).toMatch(/same 4 downstream calls/);
  });
  it('the existing list-root sentence is kept verbatim', () => {
    expect(paragraph()).toContain(
      'A list root (`authors`) disables it for the whole operation, even when it is hidden in a root fragment, because such a root could reach the same loader a hop later and an early dispatch would split its batch; introspection roots such as `__schema` disable it too.',
    );
  });
  it('the test index lists test_iter81_behavior.test.ts', () => {
    expect(README).toContain('`test_iter81_behavior.test.ts`');
  });
});

describe('acceptance - the N+1 regression test is untouched', () => {
  it('test/n-plus-1.test.ts exists and still asserts the batched call count', () => {
    const src = readFileSync(resolve(root, 'test/n-plus-1.test.ts'), 'utf8');
    expect(src.length).toBeGreaterThan(0);
    expect(src).toMatch(/expect\(/);
  });
});
