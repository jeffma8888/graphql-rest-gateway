import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createGateway, buildBackend, NAIVE } from '../src/lib';

/**
 * iter-76: root fragments (named / inline / nested) and root `__typename`
 * keep the by-id lookahead prefetch (row 62 re-land).
 * Black-box: bundled backend in-process on port 0, gateway driven through
 * createGateway(...).fetch. Call counts come from the backend's /__stats
 * counter (total + byRoute) and are cross-checked against
 * extensions.downstreamCalls.total. Hops: fastest of 5 runs (after 1 warm-up)
 * on a latencyMs:50 backend; "2 hops" < 145 ms, "3 hops" >= 145 ms.
 * All hop shapes are measured concurrently in beforeAll to keep the file fast.
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

const HOP_MS = 145;

const A = 'author(id:"a1"){ name books { title reviews { rating } } }';
const B = 'book(id:"a1-b1"){ title reviews { rating } author { name books { title } } }';
const L = 'fragment L on Query { authors(first:2){ edges { node { books { title } } } } }';

const INLINE_A = `{ ${A} }`;
const INLINE_B = `{ ${B} }`;
const EB1_Q = `query { ...Q } fragment Q on Query { ${A} }`;
const EB2_TYPED = `query { ... on Query { ${A} } }`;
const EB2_UNTYPED = `query { ... { ${A} } }`;
const EB3_DIRECT = `{ __typename ${A} }`;
const EB3_FRAG = `query { ...Q } fragment Q on Query { __typename ${A} }`;
const EB4_NESTED = `query { ...Q } fragment Q on Query { ...R } fragment R on Query { ${A} }`;
const EB5_B = `query { ...Q } fragment Q on Query { ${B} }`;
const EB5_R = 'query { ...R } fragment R on Query { book(id:"a1-b1"){ author{ books{ id } } } }';
const EB5_T = '{ __typename book(id:"a1-b1"){ author{ books{ id } } } }';
const EB6_MULTI = `query { x: author(id:"a2"){ books { title } } ...Q } fragment Q on Query { ${A} }`;
const EB7_HIDDEN = `query { ${A} ...L } ${L}`;
const EB7_INLINE_COUNT = `query { ${A} ... on Query { authors(first:2){ totalCount } } }`;
const ITER58_EB8 = `query { ...R } fragment R on Query { author(id:"a1"){ books{ reviews{ rating } } } authors(first:2){ edges{ node{ books{ reviews{ rating } } } } } }`;
const EB8_SKIP = `query($s: Boolean!) { ${A} ...L @skip(if: $s) } ${L}`;
const EB8_INCLUDE = `query($s: Boolean!) { ${A} ... on Query { authors(first:2) @include(if: $s) { totalCount } } }`;
const EB9_LIST = `{ ${A} authors(first:2){ edges { node { books { title } } } } }`;
const EB9_SCHEMA = `{ __schema { queryType { name } } ${A} }`;
const EB10_FRAG = 'query { ...Q } fragment Q on Query { author(id:"missing"){ books { title } } }';
const EB10_INLINE = '{ author(id:"missing"){ books { title } } }';

const R_A = { '/authors/by-ids': 1, '/books/by-author': 1, '/reviews/by-book': 1 };
const R_B = { '/books/by-ids': 1, '/reviews/by-book': 1, '/authors/by-ids': 1, '/books/by-author': 1 };
const R_BAB = { '/books/by-ids': 1, '/authors/by-ids': 1, '/books/by-author': 1 };
const R_LIST = { '/authors/by-ids': 1, '/authors': 1, '/books/by-author': 1, '/reviews/by-book': 1 };

async function post(gw: Gateway, payload: unknown): Promise<{ status: number; body: unknown }> {
  const res = await gw.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function gql(gw: Gateway, query: string, variables?: Record<string, unknown>): Promise<GqlResult> {
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

/** One request against the fast backend; EB11: extensions total == backend total. */
async function measured(
  g: Gateway,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ body: GqlResult; stats: Stats }> {
  await resetStats(base);
  const body = await gql(g, query, variables);
  const stats = await readStats(base);
  expect(body.extensions?.downstreamCalls?.total).toBe(stats.total);
  return { body, stats };
}

/**
 * Fastest of 5 timed sequential requests after 1 untimed warm-up. WHY the minimum:
 * the bundled backend sleeps latencyMs inside every handler, so a k-hop path can
 * never beat k x latencyMs (a hop regression still fails), while host CPU
 * contention only ever adds time (a loaded host cannot turn it red).
 */
async function fastestMs(g: Gateway, query: string, variables?: Record<string, unknown>): Promise<number> {
  await gql(g, query, variables); // warm-up
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await gql(g, query, variables);
    samples.push(performance.now() - t0);
  }
  return Math.min(...samples);
}

type HopKey = string;
const hopShapes: Array<[HopKey, 'batched' | 'naive', string, Record<string, unknown> | undefined]> = [
  ['INLINE_A', 'batched', INLINE_A, undefined],
  ['EB1_Q', 'batched', EB1_Q, undefined],
  ['EB2_TYPED', 'batched', EB2_TYPED, undefined],
  ['EB2_UNTYPED', 'batched', EB2_UNTYPED, undefined],
  ['EB3_DIRECT', 'batched', EB3_DIRECT, undefined],
  ['EB3_FRAG', 'batched', EB3_FRAG, undefined],
  ['EB4_NESTED', 'batched', EB4_NESTED, undefined],
  ['EB5_B', 'batched', EB5_B, undefined],
  ['EB5_R', 'batched', EB5_R, undefined],
  ['EB5_T', 'batched', EB5_T, undefined],
  ['EB6_MULTI', 'batched', EB6_MULTI, undefined],
  ['EB7_HIDDEN', 'batched', EB7_HIDDEN, undefined],
  ['EB7_INLINE_COUNT', 'batched', EB7_INLINE_COUNT, undefined],
  ['EB8_SKIP_T', 'batched', EB8_SKIP, { s: true }],
  ['EB8_SKIP_F', 'batched', EB8_SKIP, { s: false }],
  ['EB8_INCLUDE_F', 'batched', EB8_INCLUDE, { s: false }],
  ['EB9_LIST', 'batched', EB9_LIST, undefined],
  ['EB9_SCHEMA', 'batched', EB9_SCHEMA, undefined],
  ['EB9_NAIVE', 'naive', EB1_Q, undefined],
];
const hops = new Map<HopKey, number>();

let app: FastifyInstance;
let base: string;
let slowApp: FastifyInstance;
let gw: Gateway;
let naive: Gateway;

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  slowApp = buildBackend({ latencyMs: 50 }).app;
  const slowBase = await slowApp.listen({ port: 0, host: '127.0.0.1' });
  gw = createGateway({ restBaseUrl: base });
  naive = createGateway({ restBaseUrl: base, loaderOptions: NAIVE });
  const slow = createGateway({ restBaseUrl: slowBase });
  const slowNaive = createGateway({ restBaseUrl: slowBase, loaderOptions: NAIVE });
  await Promise.all(
    hopShapes.map(async ([key, kind, q, v]) => {
      hops.set(key, await fastestMs(kind === 'naive' ? slowNaive : slow, q, v));
    }),
  );
}, 30_000);

afterAll(async () => {
  await app.close();
  await slowApp.close();
});

function hop(key: HopKey): number {
  const ms = hops.get(key);
  expect(ms, `no hop sample for ${key}`).toBeTypeOf('number');
  return ms!;
}

describe('control - the inline { A } spelling is 2 hops and 3 calls', () => {
  it('inline A: 3 calls one per route, < 145 ms', async () => {
    const { body, stats } = await measured(gw, INLINE_A);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(3);
    expect(stats.byRoute).toEqual(R_A);
    expect(hop('INLINE_A')).toBeLessThan(HOP_MS);
  });
});

describe('EB1 - named root fragment prefetches like the inline spelling', () => {
  it('query { ...Q }: no errors, 3 calls one per route, 2 hops, same data as inline', async () => {
    const { body, stats } = await measured(gw, EB1_Q);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(3);
    expect(stats.byRoute).toEqual(R_A);
    expect(hop('EB1_Q')).toBeLessThan(HOP_MS);
    const inline = await gql(gw, INLINE_A);
    expect(body.data).toEqual(inline.data);
    const author = body.data?.author as { name: string; books: Array<{ reviews: unknown[] }> };
    expect(author.books.length).toBeGreaterThan(0);
  });
});

describe('EB2 - inline root fragment, with and without a type condition', () => {
  for (const [name, key, q] of [
    ['... on Query { A }', 'EB2_TYPED', EB2_TYPED],
    ['... { A }', 'EB2_UNTYPED', EB2_UNTYPED],
  ] as const) {
    it(`${name}: 3 calls one per route, 2 hops, same data as EB1`, async () => {
      const { body, stats } = await measured(gw, q);
      expect(body.errors).toBeUndefined();
      expect(stats.total).toBe(3);
      expect(stats.byRoute).toEqual(R_A);
      expect(hop(key)).toBeLessThan(HOP_MS);
      const eb1 = await gql(gw, EB1_Q);
      expect(body.data).toEqual(eb1.data);
    });
  }
});

describe('EB3 - root __typename is ignored by the gate', () => {
  for (const [name, key, q] of [
    ['{ __typename A }', 'EB3_DIRECT', EB3_DIRECT],
    ['query { ...Q } with __typename inside Q', 'EB3_FRAG', EB3_FRAG],
  ] as const) {
    it(`${name}: 3 calls, 2 hops, __typename "Query", rest unchanged`, async () => {
      const { body, stats } = await measured(gw, q);
      expect(body.errors).toBeUndefined();
      expect(stats.total).toBe(3);
      expect(stats.byRoute).toEqual(R_A);
      expect(hop(key)).toBeLessThan(HOP_MS);
      expect(body.data?.__typename).toBe('Query');
      const { __typename: _t, ...rest } = body.data!;
      const inline = await gql(gw, INLINE_A);
      expect(rest).toEqual(inline.data);
    });
  }
});

describe('EB4 - nested named root fragments', () => {
  it('query { ...Q } -> ...R -> A: 3 calls one per route, 2 hops, same data as EB1', async () => {
    const { body, stats } = await measured(gw, EB4_NESTED);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(3);
    expect(stats.byRoute).toEqual(R_A);
    expect(hop('EB4_NESTED')).toBeLessThan(HOP_MS);
    const eb1 = await gql(gw, EB1_Q);
    expect(body.data).toEqual(eb1.data);
  });
});

describe('EB5 - Book roots and the iter-70 Book.author lookahead through a root fragment', () => {
  it('query { ...Q } with B: 4 calls one per route, 2 hops, same data as inline B', async () => {
    const { body, stats } = await measured(gw, EB5_B);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(4);
    expect(stats.byRoute).toEqual(R_B);
    expect(hop('EB5_B')).toBeLessThan(HOP_MS);
    const inline = await gql(gw, INLINE_B);
    expect(body.data).toEqual(inline.data);
  });
  for (const [name, key, q] of [
    ['query { ...R } book.author.books', 'EB5_R', EB5_R],
    ['{ __typename book.author.books }', 'EB5_T', EB5_T],
  ] as const) {
    it(`${name}: 3 calls (books/by-ids, authors/by-ids, books/by-author), 2 hops`, async () => {
      const { body, stats } = await measured(gw, q);
      expect(body.errors).toBeUndefined();
      expect(stats.total).toBe(3);
      expect(stats.byRoute).toEqual(R_BAB);
      expect(hop(key)).toBeLessThan(HOP_MS);
    });
  }
});

describe('EB6 - multi-root through a fragment', () => {
  it('aliased root + ...Q: 3 calls one per route (ids batched), 2 hops, no errors', async () => {
    const { body, stats } = await measured(gw, EB6_MULTI);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(3);
    expect(stats.byRoute).toEqual(R_A);
    expect(hop('EB6_MULTI')).toBeLessThan(HOP_MS);
    const x = body.data?.x as { books: Array<{ title: string }> };
    expect(x.books.length).toBeGreaterThan(0);
    expect(body.data?.author).toEqual((await gql(gw, INLINE_A)).data?.author);
  });
});

describe('EB7 - a list root hidden in a root fragment still refuses', () => {
  it('A ...L (authors edges books): 4 calls per route, 3 hops', async () => {
    const { body, stats } = await measured(gw, EB7_HIDDEN);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(4);
    expect(stats.byRoute).toEqual(R_LIST);
    expect(hop('EB7_HIDDEN')).toBeGreaterThanOrEqual(HOP_MS);
  });
  // iter-81 re-pin: a count-only list root never reaches books/reviews, so it keeps the prefetch (2 hops).
  it('A ... on Query { authors{ totalCount } }: 4 calls, 2 hops (iter-81)', async () => {
    const { body, stats } = await measured(gw, EB7_INLINE_COUNT);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(4);
    expect(Object.keys(stats.byRoute).sort()).toEqual(['/authors', '/authors/by-ids', '/books/by-author', '/reviews/by-book']);
    expect(hop('EB7_INLINE_COUNT')).toBeLessThan(HOP_MS);
  });
  it('iter-58 EB8 query { ...R } keeps its 4 calls', async () => {
    const { body, stats } = await measured(gw, ITER58_EB8);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(4);
    expect(stats.byRoute).toEqual(R_LIST);
  });
});

describe('EB8 - @skip/@include decide it the way graphql-js does', () => {
  it('...L @skip(if: true): 3 calls (EB1 routes), 2 hops', async () => {
    const { body, stats } = await measured(gw, EB8_SKIP, { s: true });
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(3);
    expect(stats.byRoute).toEqual(R_A);
    expect(body.data?.authors).toBeUndefined();
    expect(hop('EB8_SKIP_T')).toBeLessThan(HOP_MS);
  });
  it('...L @skip(if: false): 4 calls (EB7 routes), 3 hops', async () => {
    const { body, stats } = await measured(gw, EB8_SKIP, { s: false });
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(4);
    expect(stats.byRoute).toEqual(R_LIST);
    expect(body.data?.authors).toBeDefined();
    expect(hop('EB8_SKIP_F')).toBeGreaterThanOrEqual(HOP_MS);
  });
  it('authors @include(if: false) inside an inline root fragment: 3 calls, 2 hops', async () => {
    const { body, stats } = await measured(gw, EB8_INCLUDE, { s: false });
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(3);
    expect(stats.byRoute).toEqual(R_A);
    expect(hop('EB8_INCLUDE_F')).toBeLessThan(HOP_MS);
  });
});

describe('EB9 - unchanged refusals', () => {
  it('{ A authors{ edges ... } }: 4 calls, 3 hops', async () => {
    const { body, stats } = await measured(gw, EB9_LIST);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(4);
    expect(stats.byRoute).toEqual(R_LIST);
    expect(hop('EB9_LIST')).toBeGreaterThanOrEqual(HOP_MS);
  });
  it('{ __schema A }: 3 calls, 3 hops (introspection roots other than __typename refuse)', async () => {
    const { body, stats } = await measured(gw, EB9_SCHEMA);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(3);
    expect(stats.byRoute).toEqual(R_A);
    expect((body.data?.__schema as { queryType: { name: string } }).queryType.name).toBe('Query');
    expect(hop('EB9_SCHEMA')).toBeGreaterThanOrEqual(HOP_MS);
  });
  it('NAIVE: query { ...Q } makes the same 5 calls as inline { A } under NAIVE, 3 hops', async () => {
    const inline = await measured(naive, INLINE_A);
    const frag = await measured(naive, EB1_Q);
    expect(frag.body.errors).toBeUndefined();
    expect(inline.stats.total).toBe(5);
    expect(frag.stats.total).toBe(5);
    expect(frag.stats.byRoute).toEqual(inline.stats.byRoute);
    expect(frag.body.data).toEqual(inline.body.data);
    expect(hop('EB9_NAIVE')).toBeGreaterThanOrEqual(HOP_MS);
  });
});

describe('EB10 - prefetch cost and error semantics carry over through fragments', () => {
  it('missing id through ...Q: 2 calls, author null, one NOT_FOUND, identical to inline', async () => {
    const frag = await measured(gw, EB10_FRAG);
    expect(frag.stats.total).toBe(2);
    expect(frag.stats.byRoute).toEqual({ '/authors/by-ids': 1, '/books/by-author': 1 });
    expect(frag.body.data).not.toBeNull();
    expect(frag.body.data?.author).toBeNull();
    expect(frag.body.errors).toHaveLength(1);
    expect(frag.body.errors![0]!.extensions?.code).toBe('NOT_FOUND');
    const inline = await measured(gw, EB10_INLINE);
    expect(inline.stats).toEqual(frag.stats);
    expect(frag.body.data).toEqual(inline.body.data);
    // source locations legitimately differ between spellings; everything else must match
    const strip = (es: GqlError[] | undefined) => (es ?? []).map(({ message, path, extensions }) => ({ message, path, extensions }));
    expect(strip(frag.body.errors)).toEqual(strip(inline.body.errors));
  });
});

describe('EB11 - extensions and admission unchanged by fragments', () => {
  // downstreamCalls.total == backend total is asserted inside measured() for every EB1-EB10 shape.
  it('queryComplexity for EB1, EB2 and EB4 equals inline { A } ({ cost: 38, depth: 4 })', async () => {
    const inline = await gql(gw, INLINE_A);
    expect(inline.extensions?.queryComplexity).toEqual({ cost: 38, depth: 4 });
    for (const q of [EB1_Q, EB2_TYPED, EB2_UNTYPED, EB4_NESTED]) {
      const r = await gql(gw, q);
      expect(r.extensions?.queryComplexity, q).toEqual(inline.extensions?.queryComplexity);
    }
  });
  it('maxDownstreamCalls: 3 admits the EB1 fragment query with no error', async () => {
    const budget = createGateway({ restBaseUrl: base, maxDownstreamCalls: 3 });
    await resetStats(base);
    const r = await gql(budget, EB1_Q);
    const stats = await readStats(base);
    expect(r.errors).toBeUndefined();
    expect(stats.total).toBe(3);
    expect(stats.byRoute).toEqual(R_A);
    expect(r.extensions?.downstreamCalls?.total).toBe(3);
    expect(r.data).toEqual((await gql(gw, INLINE_A)).data);
  });
});

describe('EB12 - README lookahead paragraph states the new rule', () => {
  const para = README.split('\n').find((l) => l.includes('Lookahead prefetch on by-id roots')) ?? '';
  it('the paragraph exists', () => {
    expect(para.length).toBeGreaterThan(200);
  });
  it('no longer says a root-level fragment or root __typename disables the prefetch', () => {
    expect(para).not.toContain('a root-level fragment (named or inline)');
    expect(para).not.toMatch(/root-level fragment[^.]*disables/i);
    expect(para).not.toMatch(/`__typename`[^.]*disables/);
  });
  it('states root fragments (named or inline) are flattened and __typename is ignored', () => {
    expect(para.toLowerCase()).toContain('flattened');
    expect(para).toMatch(/root fragment \(named or inline/);
    expect(para).toMatch(/`__typename` is ignored/);
  });
  it('states a list root disables it even when hidden in a root fragment', () => {
    expect(para).toMatch(/list root[^.]*disables it[^.]*even when it is hidden in a root fragment/);
  });
  it('keeps the iter-63 EB13 substrings', () => {
    for (const s of [
      'every root selection is a by-id `author`/`book` field',
      'aliases included',
      'list root',
      'root fragment',
      '`__typename`',
      'disables',
    ]) {
      expect(para.toLowerCase()).toContain(s.toLowerCase());
    }
  });
});
