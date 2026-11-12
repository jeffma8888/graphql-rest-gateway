import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import codegenConfig from '../codegen';
import { createGateway, buildBackend, NAIVE } from '../src/lib';
import { BENCHMARK_QUERY } from '../benchmark/benchmark';

/**
 * iter-78: bounded nested lists `Author.books(first: Int)` and
 * `Book.reviews(first: Int)` (row 48). At most `first` items (clamped 0..100),
 * sliced after the one batched by-key fetch.
 * Black-box: the bundled backend runs in-process on port 0 and the gateway is
 * driven through createGateway(...).fetch. Call counts come from the backend's
 * /__stats counter and are cross-checked against extensions.downstreamCalls.total.
 * A recording proxy (forwards to the bundled backend, records each URL plus its
 * arrival / response times, optional per-route delay) observes the grandchild
 * keys (EB7) and the lookahead prefetch (EB10). A 150-row stub backend exercises
 * the 100 clamp (EB4), which the bundled 3-books / 2-reviews data cannot reach.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const README = readFileSync(resolve(root, 'README.md'), 'utf8');
const SDL = readFileSync(resolve(root, 'schema.graphql'), 'utf8');
const GENERATED = readFileSync(resolve(root, 'src/generated/graphql.ts'), 'utf8');

type Gateway = ReturnType<typeof createGateway>;
type Stats = { total: number; byRoute: Record<string, number> };
type GqlError = { message: string; path?: Array<string | number>; extensions?: Record<string, unknown> };
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
  extensions?: { downstreamCalls?: { total: number }; queryComplexity?: { cost: number; depth: number } };
};
type Ided = { id: string };
type BookOut = { id: string; reviews?: Ided[] };
type Rec = { path: string; url: string; arrive: number; done: number };

const HOP_MS = 145;

/** EB6 query (nested first on both levels). */
const EB6_Q = '{ authors(first:5){ edges{ node{ id books(first:1){ id reviews(first:1){ id } } } } } }';
/** Same shape without nested first. */
const EB6_PLAIN = '{ authors(first:5){ edges{ node{ id books{ id reviews{ id } } } } } }';
/** The benchmark shape from the spec (346) and its first:1/first:1 variant (46). */
const BENCH_SHAPE = '{ authors(first:5){ edges{ node{ id books{ id title reviews{ id rating } } } } } }';
const BENCH_FIRST1 =
  '{ authors(first:5){ edges{ node{ id books(first:1){ id title reviews(first:1){ id rating } } } } } }';
const A1_BOOKS = ['a1-b1', 'a1-b2', 'a1-b3'];
const B1_REVIEWS = ['a1-b1-r1', 'a1-b1-r2'];

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

const ids = (xs: unknown): string[] => (xs as Ided[]).map((x) => x.id);
const cost = (b: GqlResult): number | undefined => b.extensions?.queryComplexity?.cost;
const codes = (b: GqlResult): unknown[] => (b.errors ?? []).map((e) => e.extensions?.code);

let app: FastifyInstance;
let base: string;
let slowApp: FastifyInstance;
let proxy: FastifyInstance;
let proxyBase: string;
let stub: FastifyInstance;
let stubBase: string;
let gw: Gateway;
let naive: Gateway;
let viaProxy: Gateway;
const recs: Rec[] = [];
const delays: Record<string, number> = {};
const hops = new Map<string, number>();

async function resetStats(): Promise<void> {
  const r = await fetch(`${base}/__stats/reset`, { method: 'POST' });
  expect(r.ok).toBe(true);
}
async function readStats(): Promise<Stats> {
  return (await (await fetch(`${base}/__stats`)).json()) as Stats;
}

/** One request; extensions total must equal the backend's own counter. */
async function measured(
  g: Gateway,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ body: GqlResult; stats: Stats }> {
  await resetStats();
  const body = await gql(g, query, variables);
  await new Promise((r) => setTimeout(r, 20)); // let any orphaned call land
  const stats = await readStats();
  expect(body.extensions?.downstreamCalls?.total).toBe(stats.total);
  return { body, stats };
}

/** One request through the recording proxy. */
async function recorded(query: string): Promise<{ body: GqlResult; recs: Rec[] }> {
  recs.length = 0;
  const body = await gql(viaProxy, query);
  await new Promise((r) => setTimeout(r, 20));
  return { body, recs: [...recs] };
}

/**
 * Fastest of 5 timed sequential requests after 1 untimed warm-up. WHY the minimum:
 * the bundled backend sleeps latencyMs inside every handler, so a k-hop path can
 * never beat k x latencyMs (a hop regression still fails), while host CPU
 * contention only ever adds time (a loaded host cannot turn it red).
 */
async function fastestMs(g: Gateway, query: string): Promise<number> {
  await gql(g, query); // warm-up
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await gql(g, query);
    samples.push(performance.now() - t0);
  }
  return Math.min(...samples);
}

function idsParam(url: string, name: string): string[] {
  const u = new URL(url, 'http://stub.local');
  return String(u.searchParams.get(name) ?? '').split(',').filter(Boolean);
}

const hopShapes: Array<[string, string]> = [
  ['BAB_FIRST', '{ book(id:"a1-b1"){ author{ books(first:1){ id } } } }'],
  ['BAB_PLAIN', '{ book(id:"a1-b1"){ author{ books{ id } } } }'],
  ['AUTHOR_FIRST', '{ author(id:"a1"){ books(first:1){ id } } }'],
  ['BOOK_FIRST', '{ book(id:"a1-b1"){ reviews(first:1){ id } } }'],
];

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  slowApp = buildBackend({ latencyMs: 50 }).app;
  const slowBase = await slowApp.listen({ port: 0, host: '127.0.0.1' });

  proxy = Fastify();
  proxy.get('/*', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    const rec: Rec = { path, url: req.url, arrive: performance.now(), done: Number.POSITIVE_INFINITY };
    recs.push(rec);
    const r = await fetch(base + req.url);
    const json = await r.json();
    const d = delays[path] ?? 0;
    if (d > 0) await new Promise((res) => setTimeout(res, d));
    rec.done = performance.now();
    reply.code(r.status);
    return json;
  });
  proxyBase = await proxy.listen({ port: 0, host: '127.0.0.1' });

  // 150 books per author, 150 reviews per book: enough to hit the 100 clamp.
  stub = Fastify();
  const q = (req: { query: unknown }, k: string): string[] =>
    String((req.query as Record<string, unknown>)[k] ?? '').split(',').filter(Boolean);
  stub.get('/authors/by-ids', async (req) => q(req, 'ids').map((id) => ({ id, name: `N-${id}`, bio: '' })));
  stub.get('/books/by-ids', async (req) =>
    q(req, 'ids').map((id) => ({ id, authorId: 'x1', title: `T-${id}`, year: 2000 })),
  );
  stub.get('/books/by-author', async (req) =>
    q(req, 'authorIds').flatMap((a) =>
      Array.from({ length: 150 }, (_, i) => ({ id: `${a}-b${i + 1}`, authorId: a, title: `T${i}`, year: 2000 })),
    ),
  );
  stub.get('/reviews/by-book', async (req) =>
    q(req, 'bookIds').flatMap((b) =>
      Array.from({ length: 150 }, (_, i) => ({ id: `${b}-r${i + 1}`, bookId: b, body: 'ok', reviewer: 'r', rating: 5 })),
    ),
  );
  stubBase = await stub.listen({ port: 0, host: '127.0.0.1' });

  gw = createGateway({ restBaseUrl: base });
  naive = createGateway({ restBaseUrl: base, loaderOptions: NAIVE });
  viaProxy = createGateway({ restBaseUrl: proxyBase });
  const slow = createGateway({ restBaseUrl: slowBase });
  await Promise.all(hopShapes.map(async ([k, s]) => hops.set(k, await fastestMs(slow, s))));
}, 30_000);

afterAll(async () => {
  await app.close();
  await slowApp.close();
  await proxy.close();
  await stub.close();
});

// ---------- EB1 ----------
describe('EB1 - SDL contract', () => {
  // iter-89 (PRODUCT row 88) widened both arg lists to `(first: Int, orderBy: <Order>)`; `first` is unchanged.
  it('schema.graphql declares books(first: Int, orderBy: BookOrder): [Book!]! on Author and reviews(first: Int, orderBy: ReviewOrder): [Review!]! on Book, no default', () => {
    const author = SDL.match(/type\s+Author\b[^{]*\{([\s\S]*?)\}/);
    const book = SDL.match(/type\s+Book\b[^{]*\{([\s\S]*?)\}/);
    expect(author).not.toBeNull();
    expect(book).not.toBeNull();
    expect(author![1]).toMatch(/\bbooks\s*\(\s*first\s*:\s*Int\s*,\s*orderBy\s*:\s*BookOrder\s*\)\s*:\s*\[\s*Book!\s*\]!/);
    expect(book![1]).toMatch(/\breviews\s*\(\s*first\s*:\s*Int\s*,\s*orderBy\s*:\s*ReviewOrder\s*\)\s*:\s*\[\s*Review!\s*\]!/);
  });

  it.each([
    ['Author', 'books', 'Book', 'BookOrder'],
    ['Book', 'reviews', 'Review', 'ReviewOrder'],
  ])('introspection: %s.%s has args [first: Int, orderBy], no defaults, type [%s!]!', async (type, field, item, order) => {
    const body = await gql(
      gw,
      `{ __type(name:"${type}"){ fields{ name args{ name defaultValue type{ kind name ofType{ name } } }
         type{ kind ofType{ kind ofType{ kind name } } } } } }`,
    );
    expect(body.errors).toBeUndefined();
    const fields = (body.data?.__type as { fields: Array<{ name: string; args: unknown[]; type: unknown }> }).fields;
    const f = fields.find((x) => x.name === field);
    expect(f).toBeDefined();
    expect(f!.args).toEqual([
      { name: 'first', defaultValue: null, type: { kind: 'SCALAR', name: 'Int', ofType: null } },
      { name: 'orderBy', defaultValue: null, type: { kind: 'ENUM', name: order, ofType: null } },
    ]);
    expect(f!.type).toEqual({ kind: 'NON_NULL', ofType: { kind: 'LIST', ofType: { kind: 'NON_NULL', name: null } } });
    const inner = await gql(gw, `{ __type(name:"${type}"){ fields{ name type{ ofType{ ofType{ ofType{ name } } } } } } }`);
    const g = (inner.data?.__type as { fields: Array<{ name: string; type: { ofType: { ofType: { ofType: { name: string } } } } }> })
      .fields.find((x) => x.name === field)!;
    expect(g.type.ofType.ofType.ofType.name).toBe(item);
  });

  it('generated AuthorBooksArgs / BookReviewsArgs carry an optional first', () => {
    for (const name of ['AuthorBooksArgs', 'BookReviewsArgs']) {
      const m = GENERATED.match(new RegExp(`export type ${name} = \\{([\\s\\S]*?)\\};`));
      expect(m, name).not.toBeNull();
      expect(m![1]).toMatch(/first\?:/);
    }
  });

  it('re-running codegen reproduces src/generated/graphql.ts byte for byte', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'iter78-codegen-'));
    try {
      const out = join(dir, 'graphql.ts');
      const cfg = {
        ...codegenConfig,
        schema: resolve(root, 'schema.graphql'),
        generates: { [out]: Object.values(codegenConfig.generates)[0] },
      };
      const cfgPath = join(dir, 'codegen.json');
      writeFileSync(cfgPath, JSON.stringify(cfg));
      execFileSync(resolve(root, 'node_modules/.bin/graphql-codegen'), ['--config', cfgPath, '--silent'], {
        cwd: root,
        stdio: 'pipe',
      });
      expect(readFileSync(out, 'utf8')).toBe(GENERATED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- EB2 ----------
describe('EB2 - slice keeps the first N rows in downstream order', () => {
  it('author(a1){ books(first:2) } returns a1-b1, a1-b2 with no errors', async () => {
    const body = await gql(gw, '{ author(id:"a1"){ books(first:2){ id } } }');
    expect(body.errors).toBeUndefined();
    expect((body.data?.author as { books: unknown }).books).toEqual([{ id: 'a1-b1' }, { id: 'a1-b2' }]);
  });

  it('book(a1-b1){ reviews(first:1) } returns a1-b1-r1 with no errors', async () => {
    const body = await gql(gw, '{ book(id:"a1-b1"){ reviews(first:1){ id } } }');
    expect(body.errors).toBeUndefined();
    expect((body.data?.book as { reviews: unknown }).reviews).toEqual([{ id: 'a1-b1-r1' }]);
  });

  it('the slice is a prefix of the unbounded list for every first 0..3', async () => {
    const all = await gql(gw, '{ author(id:"a1"){ books{ id } } }');
    expect(ids((all.data?.author as { books: unknown }).books)).toEqual(A1_BOOKS);
    for (const n of [0, 1, 2, 3]) {
      const b = await gql(gw, `{ author(id:"a1"){ books(first:${n}){ id } } }`);
      expect(b.errors).toBeUndefined();
      expect(ids((b.data?.author as { books: unknown }).books)).toEqual(A1_BOOKS.slice(0, n));
    }
  });
});

// ---------- EB3 ----------
describe('EB3 - omitted / null first is unchanged', () => {
  it.each([
    ['omitted', '{ author(id:"a1"){ books{ id } } }', undefined],
    ['literal null', '{ author(id:"a1"){ books(first:null){ id } } }', undefined],
    ['variable omitted', 'query($n: Int){ author(id:"a1"){ books(first:$n){ id } } }', {}],
    ['variable null', 'query($n: Int){ author(id:"a1"){ books(first:$n){ id } } }', { n: null }],
  ])('books with first %s returns all 3 books, cost 7, 2 calls', async (_l, q, v) => {
    const { body, stats } = await measured(gw, q, v);
    expect(body.errors).toBeUndefined();
    expect(ids((body.data?.author as { books: unknown }).books)).toEqual(A1_BOOKS);
    expect(cost(body)).toBe(7);
    expect(stats.total).toBe(2);
  });

  it.each([
    ['omitted', '{ book(id:"a1-b1"){ reviews{ id } } }', undefined],
    ['literal null', '{ book(id:"a1-b1"){ reviews(first:null){ id } } }', undefined],
    ['variable omitted', 'query($n: Int){ book(id:"a1-b1"){ reviews(first:$n){ id } } }', {}],
    ['variable null', 'query($n: Int){ book(id:"a1-b1"){ reviews(first:$n){ id } } }', { n: null }],
  ])('reviews with first %s returns both reviews', async (_l, q, v) => {
    const { body, stats } = await measured(gw, q, v);
    expect(body.errors).toBeUndefined();
    expect(ids((body.data?.book as { reviews: unknown }).reviews)).toEqual(B1_REVIEWS);
    expect(stats.total).toBe(2);
  });

  it('benchmark shape without nested first: cost 346, 3 calls BATCHED, every author has 3 books x 2 reviews', async () => {
    const { body, stats } = await measured(gw, BENCH_SHAPE);
    expect(body.errors).toBeUndefined();
    expect(cost(body)).toBe(346);
    expect(stats.total).toBe(3);
    const edges = (body.data?.authors as { edges: Array<{ node: { books: BookOut[] } }> }).edges;
    expect(edges).toHaveLength(5);
    for (const e of edges) {
      expect(e.node.books).toHaveLength(3);
      for (const b of e.node.books) expect(b.reviews).toHaveLength(2);
    }
  });
});

// ---------- EB4 ----------
describe('EB4 - clamp, same as authors', () => {
  it.each([0, -1, -5, -1000])('books(first:%i) returns [] with no error', async (n) => {
    const body = await gql(gw, `{ author(id:"a1"){ books(first:${n}){ id } } }`);
    expect(body.errors).toBeUndefined();
    expect((body.data?.author as { books: unknown }).books).toEqual([]);
  });

  it.each([0, -5])('reviews(first:%i) returns [] with no error', async (n) => {
    const body = await gql(gw, `{ book(id:"a1-b1"){ reviews(first:${n}){ id } } }`);
    expect(body.errors).toBeUndefined();
    expect((body.data?.book as { reviews: unknown }).reviews).toEqual([]);
  });

  it('first larger than the list returns the whole list (100 under default limits; 1000 with maxComplexity raised)', async () => {
    const b100 = await gql(gw, '{ author(id:"a1"){ books(first:100){ id } } }');
    expect(b100.errors).toBeUndefined();
    expect(ids((b100.data?.author as { books: unknown }).books)).toEqual(A1_BOOKS);
    // Spec ambiguity: first:1000 is priced 1002 > default maxComplexity 1000, so
    // "no error" holds only with the limiter raised.
    const big = createGateway({ restBaseUrl: base, maxComplexity: 100_000 });
    const b = await gql(big, '{ author(id:"a1"){ books(first:1000){ id } } book(id:"a1-b1"){ reviews(first:1000){ id } } }');
    expect(b.errors).toBeUndefined();
    expect(ids((b.data?.author as { books: unknown }).books)).toEqual(A1_BOOKS);
    expect(ids((b.data?.book as { reviews: unknown }).reviews)).toEqual(B1_REVIEWS);
  });

  it('150-row backend: books / reviews never exceed 100; omitted returns all 150; prefix order kept', async () => {
    const g = createGateway({ restBaseUrl: stubBase, maxComplexity: 1_000_000 });
    const body = await gql(
      g,
      `{ author(id:"x1"){ a: books(first:1000){ id } b: books(first:101){ id } c: books(first:100){ id }
           d: books{ id } e: books(first:99){ id } }
         book(id:"x1-b1"){ r: reviews(first:1000){ id } s: reviews{ id } } }`,
    );
    expect(body.errors).toBeUndefined();
    const a = body.data?.author as Record<string, Ided[]>;
    const all = Array.from({ length: 150 }, (_, i) => `x1-b${i + 1}`);
    expect(ids(a.a)).toEqual(all.slice(0, 100));
    expect(ids(a.b)).toEqual(all.slice(0, 100));
    expect(ids(a.c)).toEqual(all.slice(0, 100));
    expect(ids(a.d)).toEqual(all);
    expect(ids(a.e)).toEqual(all.slice(0, 99));
    const bk = body.data?.book as Record<string, Ided[]>;
    expect(bk.r).toHaveLength(100);
    expect(bk.s).toHaveLength(150);
    expect(bk.r![99]!.id).toBe('x1-b1-r100');
  });

  it('150-row backend: variable first 1000 is clamped to 100 as well', async () => {
    const g = createGateway({ restBaseUrl: stubBase, maxComplexity: 1_000_000 });
    const body = await gql(g, 'query($n: Int){ author(id:"x1"){ books(first:$n){ id } } }', { n: 1000 });
    expect(body.errors).toBeUndefined();
    expect((body.data?.author as { books: unknown[] }).books).toHaveLength(100);
  });
});

// ---------- EB5 ----------
describe('EB5 - variables', () => {
  it('books(first:$n) with n=1 returns exactly 1 book and the cost of literal first:1', async () => {
    const v = await gql(gw, 'query($n: Int){ author(id:"a1"){ books(first:$n){ id } } }', { n: 1 });
    const lit = await gql(gw, 'query { author(id:"a1"){ books(first:1){ id } } }');
    expect(v.errors).toBeUndefined();
    expect(ids((v.data?.author as { books: unknown }).books)).toEqual(['a1-b1']);
    expect(typeof cost(v)).toBe('number');
    expect(cost(v)).toBe(cost(lit));
    expect(cost(v)).toBe(3);
  });

  it('reviews(first:$n) with n=1 returns 1 review and the literal cost', async () => {
    const v = await gql(gw, 'query($n: Int){ book(id:"a1-b1"){ reviews(first:$n){ id } } }', { n: 1 });
    const lit = await gql(gw, '{ book(id:"a1-b1"){ reviews(first:1){ id } } }');
    expect(v.errors).toBeUndefined();
    expect(ids((v.data?.book as { reviews: unknown }).reviews)).toEqual(['a1-b1-r1']);
    expect(cost(v)).toBe(cost(lit));
  });

  it('runtime-variable costing applies: maxComplexity 10 admits n=1 and refuses n=100 at 0 calls', async () => {
    const g = createGateway({ restBaseUrl: base, maxComplexity: 10 });
    const Q = 'query($n: Int){ author(id:"a1"){ books(first:$n){ id } } }';
    const ok = await measured(g, Q, { n: 1 });
    expect(ok.body.errors).toBeUndefined();
    expect(ok.stats.total).toBe(2);
    await resetStats();
    const bad = await gql(g, Q, { n: 100 });
    expect(codes(bad)).toEqual(['QUERY_TOO_COMPLEX']);
    expect((await readStats()).total).toBe(0);
  });
});

// ---------- EB6 ----------
describe('EB6 - BATCHED call count unchanged', () => {
  it('nested first:1/first:1 costs exactly 3 calls, same as without; 1 book and 1 review per author', async () => {
    const plain = await measured(gw, EB6_PLAIN);
    expect(plain.stats.total).toBe(3);
    const { body, stats } = await measured(gw, EB6_Q);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(3);
    expect(stats.byRoute).toEqual(plain.stats.byRoute);
    const edges = (body.data?.authors as { edges: Array<{ node: { id: string; books: BookOut[] } }> }).edges;
    expect(edges.map((e) => e.node.id)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    for (const e of edges) {
      expect(e.node.books).toEqual([{ id: `${e.node.id}-b1`, reviews: [{ id: `${e.node.id}-b1-r1` }] }]);
    }
  });
});

// ---------- EB7 ----------
describe('EB7 - grandchild keys shrink', () => {
  it('the single /reviews/by-book call asks for exactly the 5 retained book ids; /books/by-author still asks for all 5 authors', async () => {
    const { body, recs: r } = await recorded(EB6_Q);
    expect(body.errors).toBeUndefined();
    const reviews = r.filter((x) => x.path === '/reviews/by-book');
    const books = r.filter((x) => x.path === '/books/by-author');
    expect(reviews).toHaveLength(1);
    expect(books).toHaveLength(1);
    expect(new Set(idsParam(reviews[0]!.url, 'bookIds'))).toEqual(new Set(['a1-b1', 'a2-b1', 'a3-b1', 'a4-b1', 'a5-b1']));
    expect(idsParam(reviews[0]!.url, 'bookIds')).toHaveLength(5);
    expect(new Set(idsParam(books[0]!.url, 'authorIds'))).toEqual(new Set(['a1', 'a2', 'a3', 'a4', 'a5']));
  });

  it('control: without nested first the reviews call asks for all 15 books', async () => {
    const { recs: r } = await recorded(EB6_PLAIN);
    const reviews = r.filter((x) => x.path === '/reviews/by-book');
    expect(reviews).toHaveLength(1);
    expect(new Set(idsParam(reviews[0]!.url, 'bookIds')).size).toBe(15);
  });

  it('books(first:2) asks reviews for the 2 kept books of each author (10 ids)', async () => {
    const { recs: r } = await recorded('{ authors(first:5){ edges{ node{ books(first:2){ reviews{ id } } } } } }');
    const reviews = r.filter((x) => x.path === '/reviews/by-book');
    expect(reviews).toHaveLength(1);
    const got = new Set(idsParam(reviews[0]!.url, 'bookIds'));
    expect(got).toEqual(new Set(['a1', 'a2', 'a3', 'a4', 'a5'].flatMap((a) => [`${a}-b1`, `${a}-b2`])));
  });
});

// ---------- EB8 ----------
describe('EB8 - NAIVE call counts', () => {
  it('benchmark shape and BENCHMARK_QUERY still cost 21 under NAIVE', async () => {
    expect((await measured(naive, BENCH_SHAPE)).stats.total).toBe(21);
    expect((await measured(naive, BENCHMARK_QUERY)).stats.total).toBe(21);
  });

  it('BENCHMARK_QUERY still costs 3 BATCHED', async () => {
    expect((await measured(gw, BENCHMARK_QUERY)).stats.total).toBe(3);
  });

  it('EB6 query costs 11 under NAIVE (1 page + 5 books + 5 reviews) with the same data as BATCHED', async () => {
    const n = await measured(naive, EB6_Q);
    expect(n.body.errors).toBeUndefined();
    expect(n.stats.total).toBe(11);
    expect(n.stats.byRoute['/books/by-author']).toBe(5);
    expect(n.stats.byRoute['/reviews/by-book']).toBe(5);
    const b = await gql(gw, EB6_Q);
    expect(n.body.data).toEqual(b.data);
  });
});

// ---------- EB9 ----------
describe('EB9 - aliases share one load', () => {
  it('a: first:1, b: omitted, c: first:2 -> 1 / 3 / 2 books from 2 BATCHED calls', async () => {
    const base2 = await measured(gw, '{ author(id:"a1"){ books{ id } } }');
    expect(base2.stats.total).toBe(2);
    const { body, stats } = await measured(
      gw,
      '{ author(id:"a1"){ a: books(first:1){ id } b: books{ id } c: books(first:2){ id } } }',
    );
    expect(body.errors).toBeUndefined();
    const a = body.data?.author as Record<string, unknown>;
    expect(ids(a.a)).toEqual(A1_BOOKS.slice(0, 1));
    expect(ids(a.b)).toEqual(A1_BOOKS);
    expect(ids(a.c)).toEqual(A1_BOOKS.slice(0, 2));
    expect(stats.total).toBe(2);
    expect(stats.byRoute).toEqual(base2.stats.byRoute);
  });

  it('permutation 0 / 1 / omitted / -1 / 2 / omitted -> 0,1,3,0,2,3 from 2 calls (slices never mutate the shared list)', async () => {
    const { body, stats } = await measured(
      gw,
      `{ author(id:"a1"){ p: books(first:0){ id } q: books(first:1){ id } r: books{ id }
          s: books(first:-1){ id } t: books(first:2){ id } u: books{ id } } }`,
    );
    expect(body.errors).toBeUndefined();
    const a = body.data?.author as Record<string, unknown[]>;
    expect(['p', 'q', 'r', 's', 't', 'u'].map((k) => a[k]!.length)).toEqual([0, 1, 3, 0, 2, 3]);
    expect(ids(a.u)).toEqual(A1_BOOKS);
    expect(stats.total).toBe(2);
  });

  it('reviews aliases share one load too', async () => {
    const { body, stats } = await measured(gw, '{ book(id:"a1-b1"){ x: reviews(first:1){ id } y: reviews{ id } } }');
    expect(body.errors).toBeUndefined();
    const b = body.data?.book as Record<string, unknown>;
    expect(ids(b.x)).toEqual(['a1-b1-r1']);
    expect(ids(b.y)).toEqual(B1_REVIEWS);
    expect(stats.total).toBe(2);
  });
});

// ---------- EB10 ----------
describe('EB10 - lookahead preserved', () => {
  it.each([
    ['author(a1){ books(first:1) }', '{ author(id:"a1"){ books(first:1){ id } } }', '/authors/by-ids', '/books/by-author', 'AUTHOR_FIRST'],
    ['book(a1-b1){ reviews(first:1) }', '{ book(id:"a1-b1"){ reviews(first:1){ id } } }', '/books/by-ids', '/reviews/by-book', 'BOOK_FIRST'],
  ])('%s: 2 BATCHED calls, child sent before the root answers, 1 hop-pair', async (_l, q, rootPath, childPath, key) => {
    const { stats } = await measured(gw, q);
    expect(stats.total).toBe(2);
    expect(stats.byRoute).toEqual({ [rootPath]: 1, [childPath]: 1 });
    delays[rootPath] = 80;
    try {
      const { body, recs: r } = await recorded(q);
      expect(body.errors).toBeUndefined();
      const rootRec = r.filter((x) => x.path === rootPath);
      const childRec = r.filter((x) => x.path === childPath);
      expect(rootRec).toHaveLength(1);
      expect(childRec).toHaveLength(1);
      expect(childRec[0]!.arrive).toBeLessThan(rootRec[0]!.done);
    } finally {
      delete delays[rootPath];
    }
    expect(hops.get(key)).toBeLessThan(HOP_MS);
  });

  it('book(a1-b1){ author{ books(first:1) } } keeps 2 serial hops and 3 calls, one per route, like the unbounded shape', async () => {
    const plain = await measured(gw, '{ book(id:"a1-b1"){ author{ books{ id } } } }');
    const { body, stats } = await measured(gw, '{ book(id:"a1-b1"){ author{ books(first:1){ id } } } }');
    expect(body.errors).toBeUndefined();
    expect(((body.data?.book as { author: { books: unknown } }).author).books).toEqual([{ id: 'a1-b1' }]);
    expect(stats.total).toBe(3);
    expect(stats.byRoute).toEqual({ '/books/by-ids': 1, '/authors/by-ids': 1, '/books/by-author': 1 });
    expect(stats.byRoute).toEqual(plain.stats.byRoute);
    expect(hops.get('BAB_FIRST')).toBeLessThan(HOP_MS);
    expect(hops.get('BAB_PLAIN')).toBeLessThan(HOP_MS);
  });
});

// ---------- EB11 ----------
describe('EB11 - admission cost', () => {
  it('benchmark shape 346, first:1/first:1 variant 46', async () => {
    expect(cost(await gql(gw, BENCH_SHAPE))).toBe(346);
    const v = await gql(gw, BENCH_FIRST1);
    expect(v.errors).toBeUndefined();
    expect(cost(v)).toBe(46);
  });

  it('author(a1){ books(first:2){ id } } costs 4; without first 7', async () => {
    expect(cost(await gql(gw, '{ author(id:"a1"){ books(first:2){ id } } }'))).toBe(4);
    expect(cost(await gql(gw, '{ author(id:"a1"){ books{ id } } }'))).toBe(7);
  });

  it('negative nested first counts as 0 and never drives the cost negative', async () => {
    const zero = cost(await gql(gw, '{ author(id:"a1"){ books(first:0){ id } } }'));
    const neg = cost(await gql(gw, '{ author(id:"a1"){ books(first:-5){ id } } }'));
    expect(typeof zero).toBe('number');
    expect(neg).toBe(zero);
    const two = cost(await gql(gw, '{ author(id:"a1"){ b: books(first:2){ id } } }'))!;
    const mixed = cost(await gql(gw, '{ author(id:"a1"){ a: books(first:-1000){ id } b: books(first:2){ id } } }'))!;
    expect(mixed).toBeGreaterThanOrEqual(two);
    const negVar = cost(await gql(gw, 'query($n: Int){ author(id:"a1"){ books(first:$n){ id } } }', { n: -1000 }));
    expect(negVar).toBe(zero);
  });

  it('maxComplexity 100: benchmark shape refused QUERY_TOO_COMPLEX at 0 calls; first:1/first:1 variant admitted', async () => {
    const g = createGateway({ restBaseUrl: base, maxComplexity: 100 });
    await resetStats();
    const bad = await gql(g, BENCH_SHAPE);
    expect(codes(bad)).toEqual(['QUERY_TOO_COMPLEX']);
    expect(bad.data ?? null).toBeNull();
    expect((await readStats()).total).toBe(0);
    const ok = await measured(g, BENCH_FIRST1);
    expect(ok.body.errors).toBeUndefined();
    expect(cost(ok.body)).toBe(46);
    expect(ok.stats.total).toBe(3);
  });
});

// ---------- EB12 ----------
describe('EB12 - README', () => {
  const paras = README.split(/\n\s*\n/);
  const idx = paras.findIndex((p) => /Author\.books\(first/.test(p));
  const para = idx >= 0 ? paras[idx]! : '';

  it('one paragraph states the semantics, next to the pagination text', () => {
    expect(idx).toBeGreaterThanOrEqual(0);
    const paging = paras.findIndex((p) => /Paging works in both directions/.test(p));
    expect(paging).toBeGreaterThanOrEqual(0);
    expect(Math.abs(idx - paging)).toBeLessThanOrEqual(2);
    expect(paras.filter((p) => /Author\.books\(first/.test(p))).toHaveLength(1);
  });

  it('covers books/reviews, the 0..100 clamp, negative [] and omitted whole list', () => {
    expect(para).toMatch(/Book\.reviews\(first/);
    expect(para).toMatch(/0\.\.100/);
    expect(para).toMatch(/negative/i);
    expect(para).toContain('`[]`');
    expect(para).toMatch(/omitted/i);
    expect(para).toMatch(/whole list/i);
  });

  it('says the slice is after the one batched call, counts unchanged, backend bytes do not shrink, grandchild keys do', () => {
    expect(para).toMatch(/after the one batched/i);
    expect(para).toMatch(/call counts are unchanged/i);
    expect(para).toMatch(/do(es)? not shrink/i);
    expect(para).toMatch(/grandchild/i);
  });

  it('says it is a plain bound, not a connection (no after / pageInfo)', () => {
    expect(para).toMatch(/not a connection/i);
    expect(para).toContain('after');
    expect(para).toContain('pageInfo');
  });
});
