import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, buildBackend, NAIVE } from '../src/lib';
import type { BenchmarkOutput } from '../benchmark/benchmark';

/**
 * iter-89: ordered nested lists (PRODUCT row 88).
 *
 * `Author.books(first, orderBy: BookOrder)` and `Book.reviews(first, orderBy: ReviewOrder)`
 * sort the already-batched child list in the gateway, then apply `first`.
 *
 * Black-box: the bundled backend runs in-process (latencyMs 0) and records every
 * request through its own Fastify `onRequest` hook as `{ route, ids }`.
 * "N calls" = backend `onRequest` hits == `extensions.downstreamCalls.total`.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = readFileSync(path.join(REPO, 'README.md'), 'utf8');
const SDL = readFileSync(path.join(REPO, 'schema.graphql'), 'utf8');
const GENERATED = readFileSync(path.join(REPO, 'src', 'generated', 'graphql.ts'), 'utf8');

type Gateway = ReturnType<typeof createGateway>;
type GqlError = { message: string; path?: Array<string | number>; extensions?: Record<string, unknown> };
type GqlResult = {
  data?: Record<string, any> | null;
  errors?: GqlError[];
  extensions?: { downstreamCalls?: { total: number }; queryComplexity?: { cost: number; depth: number } };
};
type Hit = { route: string; ids: string[] };

let backend: FastifyInstance;
let base = '';
let hits: Hit[] = [];
let gwB: Gateway;
let gwN: Gateway;

function parse(url: string): Hit {
  const u = new URL(url, 'http://backend.local');
  const ids = [...u.searchParams.entries()]
    .filter(([k]) => k === 'ids' || /Ids$/.test(k))
    .flatMap(([, v]) => v.split(','))
    .filter(Boolean);
  return { route: u.pathname, ids };
}

beforeAll(async () => {
  backend = buildBackend({ latencyMs: 0 }).app;
  backend.addHook('onRequest', async (req) => {
    hits.push(parse(req.url));
  });
  base = (await backend.listen({ port: 0, host: '127.0.0.1' })).replace(/\/$/, '');
  gwB = createGateway({ restBaseUrl: base });
  gwN = createGateway({ restBaseUrl: base, loaderOptions: NAIVE });
});

afterAll(async () => {
  await Promise.all([gwB?.close?.(), gwN?.close?.()]);
  await backend?.close();
});

async function post(
  gw: Gateway,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ status: number; body: GqlResult }> {
  hits = [];
  const res = await gw.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  const body = (await res.json()) as GqlResult;
  // let any late request land before counting
  await new Promise((r) => setTimeout(r, 20));
  return { status: res.status, body };
}

/** 200 + no errors. */
async function ok(query: string, gw: Gateway = gwB, variables?: Record<string, unknown>): Promise<GqlResult> {
  const { status, body } = await post(gw, query, variables);
  expect(status).toBe(200);
  expect(body.errors).toBeUndefined();
  return body;
}

function expectCalls(body: GqlResult, n: number): void {
  expect(hits).toHaveLength(n);
  const total = body.extensions?.downstreamCalls?.total;
  if (n > 0) expect(total).toBe(n);
  else expect(total ?? 0).toBe(0);
}

const routes = () => hits.map((h) => h.route).sort();
const hitsTo = (route: string) => hits.filter((h) => h.route === route);
const sorted = (a: string[]) => [...a].sort();

// ---------- EB1 ----------
describe('EB1 - SDL contract', () => {
  const TYPE_REF = 'kind name ofType{ kind name ofType{ kind name ofType{ kind name } } }';
  const FIELD_Q = (t: string) =>
    `{ __type(name:"${t}"){ fields{ name description type{ ${TYPE_REF} } args{ name defaultValue type{ ${TYPE_REF} } } } } }`;

  it.each([
    ['BookOrder', ['YEAR_ASC', 'YEAR_DESC']],
    ['ReviewOrder', ['RATING_DESC', 'RATING_ASC']],
  ])('%s is an ENUM with exactly the values %j', async (name, values) => {
    const b = await ok(`{ __type(name:"${name}"){ kind enumValues(includeDeprecated:true){ name } } }`);
    expect(b.data!.__type.kind).toBe('ENUM');
    expect(sorted(b.data!.__type.enumValues.map((v: { name: string }) => v.name))).toEqual(sorted(values));
    expectCalls(b, 0);
  });

  it.each([
    ['Author', 'books', 'BookOrder', 'Book'],
    ['Book', 'reviews', 'ReviewOrder', 'Review'],
  ])('%s.%s has exactly args [first: Int, orderBy: %s], no defaults, returns [%s!]!', async (type, field, enumName, item) => {
    const b = await ok(FIELD_Q(type));
    const f = b.data!.__type.fields.find((x: { name: string }) => x.name === field);
    expect(f).toBeDefined();
    expect(f.args.map((a: { name: string }) => a.name)).toEqual(['first', 'orderBy']);
    const [first, orderBy] = f.args;
    expect(first.defaultValue).toBeNull();
    expect(first.type.kind).toBe('SCALAR');
    expect(first.type.name).toBe('Int');
    expect(orderBy.defaultValue).toBeNull();
    expect(orderBy.type.kind).toBe('ENUM');
    expect(orderBy.type.name).toBe(enumName);
    // [Item!]!
    expect(f.type.kind).toBe('NON_NULL');
    expect(f.type.ofType.kind).toBe('LIST');
    expect(f.type.ofType.ofType.kind).toBe('NON_NULL');
    expect(f.type.ofType.ofType.ofType).toEqual({ kind: 'OBJECT', name: item });
  });

  it('schema.graphql declares both enums and both orderBy args; generated types carry them', () => {
    expect(SDL).toMatch(/enum\s+BookOrder\s*\{[^}]*\bYEAR_ASC\b[^}]*\bYEAR_DESC\b[^}]*\}/);
    expect(SDL).toMatch(/enum\s+ReviewOrder\s*\{[^}]*\bRATING_DESC\b[^}]*\}/);
    expect(SDL).toMatch(/enum\s+ReviewOrder\s*\{[^}]*\bRATING_ASC\b[^}]*\}/);
    expect(SDL).toMatch(/books\s*\([^)]*orderBy\s*:\s*BookOrder\b[^)]*\)\s*:\s*\[Book!\]!/);
    expect(SDL).toMatch(/reviews\s*\([^)]*orderBy\s*:\s*ReviewOrder\b[^)]*\)\s*:\s*\[Review!\]!/);
    expect(GENERATED).toMatch(/export type BookOrder\s*=/);
    expect(GENERATED).toMatch(/export type ReviewOrder\s*=/);
    expect(GENERATED).toMatch(/orderBy\?: InputMaybe<BookOrder>/);
    expect(GENERATED).toMatch(/orderBy\?: InputMaybe<ReviewOrder>/);
  });
});

// ---------- EB2 ----------
describe('EB2 - book order', () => {
  it('YEAR_DESC returns a1-b3/1992, a1-b2/1991, a1-b1/1990 at 2 calls', async () => {
    const b = await ok('{ author(id:"a1"){ books(orderBy: YEAR_DESC){ id year } } }');
    expect(b.data!.author.books).toEqual([
      { id: 'a1-b3', year: 1992 },
      { id: 'a1-b2', year: 1991 },
      { id: 'a1-b1', year: 1990 },
    ]);
    expectCalls(b, 2);
  });

  it('YEAR_ASC returns a1-b1, a1-b2, a1-b3', async () => {
    const b = await ok('{ author(id:"a1"){ books(orderBy: YEAR_ASC){ id } } }');
    expect(b.data!.author.books.map((x: { id: string }) => x.id)).toEqual(['a1-b1', 'a1-b2', 'a1-b3']);
    expectCalls(b, 2);
  });

  it('orderBy: null and no orderBy both return backend order, byte-identical', async () => {
    const none = await ok('{ author(id:"a1"){ books{ id year } } }');
    expectCalls(none, 2);
    const nul = await ok('{ author(id:"a1"){ books(orderBy: null){ id year } } }');
    expectCalls(nul, 2);
    expect(none.data!.author.books.map((x: { id: string }) => x.id)).toEqual(['a1-b1', 'a1-b2', 'a1-b3']);
    expect(JSON.stringify(nul.data)).toBe(JSON.stringify(none.data));
    // the NAIVE gateway (no cache) agrees byte-for-byte
    const naive = await ok('{ author(id:"a1"){ books{ id year } } }', gwN);
    expect(JSON.stringify(naive.data)).toBe(JSON.stringify(none.data));
  });
});

// ---------- EB3 ----------
describe('EB3 - latest book per author, batched', () => {
  it('a1..a5 each get their latest book at 2 calls, one /books/by-author with all 5 ids', async () => {
    const b = await ok(
      '{ authors(first:5){ edges{ node{ id books(first:1, orderBy: YEAR_DESC){ id year } } } } }',
    );
    const nodes = b.data!.authors.edges.map((e: { node: unknown }) => e.node);
    expect(nodes).toEqual([
      { id: 'a1', books: [{ id: 'a1-b3', year: 1992 }] },
      { id: 'a2', books: [{ id: 'a2-b3', year: 1995 }] },
      { id: 'a3', books: [{ id: 'a3-b3', year: 1998 }] },
      { id: 'a4', books: [{ id: 'a4-b3', year: 2001 }] },
      { id: 'a5', books: [{ id: 'a5-b3', year: 2004 }] },
    ]);
    expectCalls(b, 2);
    expect(routes()).toEqual(['/authors', '/books/by-author']);
    expect(sorted(hitsTo('/books/by-author')[0]!.ids)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });
});

// ---------- EB4 ----------
describe('EB4 - review order; sort before first', () => {
  it('top/low aliases pick the max/min rating per book at 3 calls, one /reviews/by-book with 3 ids', async () => {
    const b = await ok(
      '{ author(id:"a1"){ books{ id top: reviews(first:1, orderBy: RATING_DESC){ id rating } low: reviews(first:1, orderBy: RATING_ASC){ id rating } } } }',
    );
    const books = b.data!.author.books as Array<{ id: string; top: unknown[]; low: unknown[] }>;
    expect(books.map((x) => x.id)).toEqual(['a1-b1', 'a1-b2', 'a1-b3']);
    expect(books.map((x) => x.top)).toEqual([
      [{ id: 'a1-b1-r2', rating: 4 }],
      [{ id: 'a1-b2-r2', rating: 5 }],
      [{ id: 'a1-b3-r1', rating: 5 }],
    ]);
    expect(books.map((x) => x.low)).toEqual([
      [{ id: 'a1-b1-r1', rating: 3 }],
      [{ id: 'a1-b2-r1', rating: 4 }],
      [{ id: 'a1-b3-r2', rating: 3 }],
    ]);
    expectCalls(b, 3);
    expect(hitsTo('/reviews/by-book')).toHaveLength(1);
    expect(sorted(hitsTo('/reviews/by-book')[0]!.ids)).toEqual(['a1-b1', 'a1-b2', 'a1-b3']);
  });
});

// ---------- EB5 ----------
describe('EB5 - top review for every book', () => {
  it('each of 15 books gets its max rating with orderBy; without orderBy only 5 of 15 do', async () => {
    const oracle = await ok('{ authors(first:5){ edges{ node{ books{ id reviews{ rating } } } } } }');
    const maxBy = new Map<string, number>();
    for (const e of oracle.data!.authors.edges)
      for (const bk of e.node.books) maxBy.set(bk.id, Math.max(...bk.reviews.map((r: { rating: number }) => r.rating)));
    expect(maxBy.size).toBe(15);

    const top = await ok(
      '{ authors(first:5){ edges{ node{ books{ id reviews(first:1, orderBy: RATING_DESC){ rating } } } } } }',
    );
    expectCalls(top, 3);
    let n = 0;
    for (const e of top.data!.authors.edges)
      for (const bk of e.node.books) {
        expect(bk.reviews).toHaveLength(1);
        expect(bk.reviews[0].rating).toBe(maxBy.get(bk.id));
        n++;
      }
    expect(n).toBe(15);

    const plain = await ok('{ authors(first:5){ edges{ node{ books{ id reviews(first:1){ rating } } } } } }');
    let hit = 0;
    for (const e of plain.data!.authors.edges)
      for (const bk of e.node.books) if (bk.reviews[0].rating === maxBy.get(bk.id)) hit++;
    expect(hit).toBe(5);
  });
});

// ---------- EB6 ----------
describe('EB6 - aliases share one load; cached list never mutated', () => {
  it.each([
    ['latest first', '{ author(id:"a1"){ latest: books(first:1, orderBy: YEAR_DESC){ id } all: books{ id } } }'],
    ['all first', '{ author(id:"a1"){ all: books{ id } latest: books(first:1, orderBy: YEAR_DESC){ id } } }'],
  ])('books aliases (%s): latest=[a1-b3], all=backend order, 2 calls / 1 by-author', async (_n, q) => {
    const b = await ok(q);
    expect(b.data!.author.latest).toEqual([{ id: 'a1-b3' }]);
    expect(b.data!.author.all).toEqual([{ id: 'a1-b1' }, { id: 'a1-b2' }, { id: 'a1-b3' }]);
    expectCalls(b, 2);
    expect(hitsTo('/books/by-author')).toHaveLength(1);
  });

  it.each([
    ['sorted first', '{ book(id:"a1-b1"){ sorted: reviews(orderBy: RATING_DESC){ id } plain: reviews{ id } } }'],
    ['plain first', '{ book(id:"a1-b1"){ plain: reviews{ id } sorted: reviews(orderBy: RATING_DESC){ id } } }'],
  ])('reviews aliases (%s): sorted=[r2,r1], plain=[r1,r2], 2 calls', async (_n, q) => {
    const b = await ok(q);
    expect(b.data!.book.sorted).toEqual([{ id: 'a1-b1-r2' }, { id: 'a1-b1-r1' }]);
    expect(b.data!.book.plain).toEqual([{ id: 'a1-b1-r1' }, { id: 'a1-b1-r2' }]);
    expectCalls(b, 2);
    expect(hitsTo('/reviews/by-book')).toHaveLength(1);
  });

  it('a DESC alias then ASC alias then plain alias all stay correct (no shared mutation)', async () => {
    const b = await ok(
      '{ author(id:"a1"){ d: books(orderBy: YEAR_DESC){ id } a: books(orderBy: YEAR_ASC){ id } p: books{ id } d2: books(orderBy: YEAR_DESC){ id } } }',
    );
    const ids = (k: string) => b.data!.author[k].map((x: { id: string }) => x.id);
    expect(ids('d')).toEqual(['a1-b3', 'a1-b2', 'a1-b1']);
    expect(ids('a')).toEqual(['a1-b1', 'a1-b2', 'a1-b3']);
    expect(ids('p')).toEqual(['a1-b1', 'a1-b2', 'a1-b3']);
    expect(ids('d2')).toEqual(['a1-b3', 'a1-b2', 'a1-b1']);
    expectCalls(b, 2);
  });
});

// ---------- EB7 ----------
describe('EB7 - grandchild keys follow the kept rows', () => {
  it('books(first:1, orderBy: YEAR_DESC){ reviews } asks /reviews/by-book only for a1-b3, 3 calls', async () => {
    const b = await ok('{ author(id:"a1"){ books(first:1, orderBy: YEAR_DESC){ id reviews{ id } } } }');
    expect(b.data!.author.books.map((x: { id: string }) => x.id)).toEqual(['a1-b3']);
    expectCalls(b, 3);
    expect(hitsTo('/reviews/by-book')).toHaveLength(1);
    expect(hitsTo('/reviews/by-book')[0]!.ids).toEqual(['a1-b3']);
  });
});

// ---------- EB8 ----------
describe('EB8 - N+1 numbers do not move', () => {
  const Q = '{ authors(first:5){ edges{ node{ id books(orderBy: YEAR_DESC){ id reviews(orderBy: RATING_DESC){ id } } } } } }';

  it('ordered nested query: 3 calls batched, 21 NAIVE, equal data', async () => {
    const batched = await ok(Q, gwB);
    expectCalls(batched, 3);
    const naive = await ok(Q, gwN);
    expectCalls(naive, 21);
    expect(naive.data).toEqual(batched.data);
    // and it is really ordered
    const a1 = batched.data!.authors.edges[0].node;
    expect(a1.books.map((x: { id: string }) => x.id)).toEqual(['a1-b3', 'a1-b2', 'a1-b1']);
  });

  it('benchmark still reports 21 -> 3', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const prev = process.exitCode;
    try {
      const { main } = await import('../benchmark/benchmark');
      await main(['--json']);
      let parsed: BenchmarkOutput | undefined;
      for (const call of spy.mock.calls) {
        try {
          const p = JSON.parse(call.map(String).join(' ').trim());
          if (p && typeof p === 'object' && 'naive' in p) parsed = p;
        } catch {
          /* not json */
        }
      }
      expect(parsed).toBeDefined();
      expect((parsed as any).naive.calls).toBe(21);
      expect((parsed as any).batched.calls).toBe(3);
    } finally {
      spy.mockRestore();
      process.exitCode = prev;
    }
  });

  it('test/n-plus-1.test.ts is unchanged against HEAD', () => {
    const out = execFileSync('git', ['status', '--porcelain', '--', 'test/n-plus-1.test.ts'], {
      cwd: REPO,
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('');
  });
});

// ---------- EB9 ----------
describe('EB9 - admission cost ignores orderBy', () => {
  it.each([
    [
      '{ authors(first:5){ edges{ node{ id books(first:1, orderBy: YEAR_DESC){ id title reviews(first:1, orderBy: RATING_DESC){ id rating } } } } } }',
      '{ authors(first:5){ edges{ node{ id books(first:1){ id title reviews(first:1){ id rating } } } } } }',
      { cost: 46, depth: 6 },
    ],
    [
      '{ author(id:"a1"){ books(orderBy: YEAR_ASC){ id reviews(orderBy: RATING_ASC){ id } } } }',
      '{ author(id:"a1"){ books{ id reviews{ id } } } }',
      null,
    ],
  ])('cost with orderBy equals cost without: %s', async (withO, without, expected) => {
    const a = await ok(withO);
    const b = await ok(without);
    expect(a.extensions?.queryComplexity).toBeDefined();
    expect(a.extensions!.queryComplexity).toEqual(b.extensions!.queryComplexity);
    if (expected) expect(a.extensions!.queryComplexity).toEqual(expected);
  });
});

// ---------- EB10 ----------
describe('EB10 - first keeps its contract under orderBy', () => {
  it.each([0, -1])('books(first:%i, orderBy: YEAR_DESC) returns [] with no error', async (n) => {
    const b = await ok(`{ author(id:"a1"){ books(first:${n}, orderBy: YEAR_DESC){ id } } }`);
    expect(b.data!.author.books).toEqual([]);
  });

  it('books(first:1000, orderBy: YEAR_DESC) returns all 3 in descending year order', async () => {
    const b = await ok('{ author(id:"a1"){ books(first:1000, orderBy: YEAR_DESC){ id year } } }');
    expect(b.data!.author.books.map((x: { year: number }) => x.year)).toEqual([1992, 1991, 1990]);
  });
});

// ---------- EB11 ----------
describe('EB11 - bad values rejected at 0 calls', () => {
  it.each([
    ['unknown enum value', '{ author(id:"a1"){ books(orderBy: YEAR){ id } } }'],
    ['string literal', '{ author(id:"a1"){ books(orderBy: "YEAR_DESC"){ id } } }'],
    ['wrong enum', '{ author(id:"a1"){ books(orderBy: RATING_DESC){ id } } }'],
    ['wrong enum on reviews', '{ book(id:"a1-b1"){ reviews(orderBy: YEAR_DESC){ id } } }'],
  ])('%s: 200, no data, all errors GRAPHQL_VALIDATION_FAILED, 0 calls', async (_n, q) => {
    const { status, body } = await post(gwB, q);
    expect(status).toBe(200);
    expect(body.data).toBeUndefined();
    expect(body.errors?.length ?? 0).toBeGreaterThanOrEqual(1);
    for (const e of body.errors!) expect(e.extensions?.code).toBe('GRAPHQL_VALIDATION_FAILED');
    expectCalls(body, 0);
  });

  const VQ = 'query($o: BookOrder){ author(id:"a1"){ books(orderBy:$o){ id } } }';

  it('variable {o:"NEWEST"}: HTTP 400, BAD_USER_INPUT, 0 calls', async () => {
    const { status, body } = await post(gwB, VQ, { o: 'NEWEST' });
    expect(status).toBe(400);
    expect(body.errors?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(body.errors![0]!.extensions?.code).toBe('BAD_USER_INPUT');
    expectCalls(body, 0);
  });

  it('variable {o:"YEAR_DESC"}: 200 with [a1-b3, a1-b2, a1-b1]', async () => {
    const b = await ok(VQ, gwB, { o: 'YEAR_DESC' });
    expect(b.data!.author.books.map((x: { id: string }) => x.id)).toEqual(['a1-b3', 'a1-b2', 'a1-b1']);
    expectCalls(b, 2);
  });
});

// ---------- EB12 ----------
describe('EB12 - documented where clients read', () => {
  const PARA = (() => {
    const m = /\*\*Nested lists[^\n]*/.exec(README);
    return m ? m[0] : '';
  })();

  it('README §7 nested-list paragraph names orderBy, the 4 values, sort-before-first, not pushed down, unchanged counts/cost', () => {
    expect(PARA.length).toBeGreaterThan(0);
    expect(PARA).toMatch(/`orderBy`/);
    for (const v of ['YEAR_ASC', 'YEAR_DESC', 'RATING_DESC', 'RATING_ASC']) expect(PARA).toContain(v);
    expect(PARA).toMatch(/sorts?[^.]*before `first`/);
    expect(PARA).toMatch(/only the rows the backend returned/);
    expect(PARA).toMatch(/not pushed down/);
    expect(PARA).toMatch(/downstream call count[^.]*admission cost[^.]*unchanged/);
  });

  it.each([
    ['Author', 'books'],
    ['Book', 'reviews'],
  ])('introspected description of %s.%s mentions orderBy', async (type, field) => {
    const b = await ok(`{ __type(name:"${type}"){ fields{ name description } } }`);
    const f = b.data!.__type.fields.find((x: { name: string }) => x.name === field);
    expect(f.description ?? '').toMatch(/orderBy/);
  });

  it('README no-orderBy claims stay true: books(first: 2) is backend order; first:1000 costs 102', async () => {
    expect(PARA).toContain('author(id: "a1") { books(first: 2) { id } }');
    const b = await ok('{ author(id: "a1") { books(first: 2) { id } } }');
    expect(b.data!.author.books).toEqual([{ id: 'a1-b1' }, { id: 'a1-b2' }]);
    expectCalls(b, 2);
    expect(PARA).toMatch(/books\(first: 1000\) \{ id \} \}` costs the same 102/);
    const c = await ok('{ author(id: "a1") { books(first: 1000) { id } } }');
    expect(c.extensions!.queryComplexity!.cost).toBe(102);
  });
});
