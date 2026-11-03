import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createGateway, buildBackend, NAIVE } from '../src/lib';

/**
 * iter-70: `Book.author` -> `Author.books` lookahead.
 * Black-box: the bundled backend runs in-process on port 0 and the gateway is
 * driven through createGateway(...).fetch. Call counts come from the backend's
 * own /__stats counter (total + byRoute) and are cross-checked against the
 * response extensions.downstreamCalls.total. Orphan-book and failing-route
 * cases use a small in-process Fastify stub on 127.0.0.1.
 * HEAD figures quoted in comments are from the PM fa5fc8e measurements.
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
  extensions?: { downstreamCalls?: { total: number } };
};

const S1 = '{ book(id:"a1-b1"){ title author{ name books{ title } } } }';
const S2 = '{ a: book(id:"a1-b1"){ author{ books{ id } } } b: book(id:"a2-b1"){ author{ books{ id } } } }';
const S4 = '{ a: book(id:"a2-b1"){ author{ books{ title } } } b: author(id:"a1"){ books{ title } } }';
const S7 = '{ book(id:"a1-b1"){ author{ books{ id } } reviews{ book{ author{ books{ id } } } } } }';
const S20 = '{ book(id:"a1-b1"){ author{ books{ author{ books{ reviews{ rating } } } } } } }';

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

async function resetStats(base: string): Promise<void> {
  const r = await fetch(`${base}/__stats/reset`, { method: 'POST' });
  expect(r.ok).toBe(true);
}

async function readStats(base: string): Promise<Stats> {
  const r = await fetch(`${base}/__stats`);
  return (await r.json()) as Stats;
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One request; returns the body plus the backend measured stats. */
async function measured(
  gw: Gateway,
  base: string,
  query: string,
  variables?: Record<string, unknown>,
  settleMs = 0,
): Promise<{ body: GqlResult; stats: Stats }> {
  await resetStats(base);
  const body = await gql(gw, query, variables);
  if (settleMs) await settle(settleMs);
  const stats = await readStats(base);
  if (!settleMs && body.extensions?.downstreamCalls) {
    expect(body.extensions.downstreamCalls.total).toBe(stats.total);
  }
  return { body, stats };
}

async function medianMs(gw: Gateway, query: string, variables?: Record<string, unknown>): Promise<number> {
  await gql(gw, query, variables); // warm-up
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await gql(gw, query, variables);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[2]!;
}

const rejections: unknown[] = [];
const onRejection = (reason: unknown): void => {
  rejections.push(reason);
};

let app: FastifyInstance;
let base: string;
let slowApp: FastifyInstance;
let slowBase: string;
let gw: Gateway;
let naive: Gateway;
let slow: Gateway;

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  slowApp = buildBackend({ latencyMs: 50 }).app;
  slowBase = await slowApp.listen({ port: 0, host: '127.0.0.1' });
  gw = createGateway({ restBaseUrl: base });
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

// ---------- EB1 ----------
describe('EB1 - S1 call count unchanged', () => {
  it('S1 makes 3 calls, one per route, no errors', async () => {
    const { body, stats } = await measured(gw, base, S1);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(3);
    expect(stats.byRoute).toEqual({ '/books/by-ids': 1, '/authors/by-ids': 1, '/books/by-author': 1 });
    const book = body.data?.book as { title: string; author: { name: string; books: Array<{ title: string }> } };
    expect(book.author.books.length).toBeGreaterThan(0);
    expect(book.author.books.map((b) => b.title)).toContain(book.title);
  });

  it('S1 data deep-equals the NAIVE gateway', async () => {
    const a = await gql(gw, S1);
    const b = await gql(naive, S1);
    expect(b.errors).toBeUndefined();
    expect(a.data).toEqual(b.data);
  });
});

// ---------- EB2 ----------
describe('EB2 - one serial hop less at 50 ms latency', () => {
  const cases: Array<[string, string, number]> = [
    ['S1', S1, 135], // HEAD ~165
    ['S2', S2, 135], // HEAD ~164
    ['S4', S4, 135], // HEAD ~159
    ['S7', S7, 135], // HEAD ~160
    ['S20', S20, 185], // HEAD ~212
  ];
  for (const [name, q, bound] of cases) {
    it(`${name} median < ${bound} ms`, async () => {
      const ms = await medianMs(slow, q);
      expect(ms).toBeLessThan(bound);
    });
  }
});

// ---------- EB3 ----------
describe('EB3 - call-count table equals HEAD', () => {
  const R = { bi: '/books/by-ids', ai: '/authors/by-ids', ba: '/books/by-author', rb: '/reviews/by-book' };
  const table: Array<[string, string, number, Record<string, number> | null]> = [
    ['S2', S2, 3, { [R.bi]: 1, [R.ai]: 1, [R.ba]: 1 }],
    [
      'two books same author',
      '{ a: book(id:"a1-b1"){ author{ books{ id } } } b: book(id:"a1-b2"){ author{ books{ id } } } }',
      3,
      { [R.bi]: 1, [R.ai]: 1, [R.ba]: 1 },
    ],
    ['S4', S4, 5, { [R.bi]: 1, [R.ai]: 2, [R.ba]: 2 }],
    ['cross a1', '{ a: book(id:"a1-b1"){ author{ books{ title } } } b: author(id:"a1"){ books{ title } } }', 3, null],
    [
      'reviews->book->author->books',
      '{ book(id:"a1-b1"){ reviews{ book{ author{ books{ id } } } } } }',
      4,
      { [R.bi]: 1, [R.rb]: 1, [R.ai]: 1, [R.ba]: 1 },
    ],
    ['S7', S7, 4, null],
    ['author->books->author->books', '{ author(id:"a1"){ books{ author{ books{ id } } } } }', 2, { [R.ai]: 1, [R.ba]: 1 }],
    [
      'three books',
      '{ a: book(id:"a1-b1"){ author{ books{ id } } } b: book(id:"a2-b1"){ author{ books{ id } } } c: book(id:"a3-b1"){ author{ books{ id } } } }',
      3,
      null,
    ],
    ['alias merge', '{ book(id:"a1-b1"){ author{ name } author{ books{ id } } } }', 3, null],
    ['S20', S20, 4, { [R.bi]: 1, [R.ai]: 1, [R.ba]: 1, [R.rb]: 1 }],
  ];
  for (const [name, q, total, routes] of table) {
    it(`${name}: ${total} calls, data equals NAIVE, no errors`, async () => {
      const { body, stats } = await measured(gw, base, q);
      expect(body.errors).toBeUndefined();
      expect(stats.total).toBe(total);
      if (routes) expect(stats.byRoute).toEqual(routes);
      const n = await gql(naive, q);
      expect(n.errors).toBeUndefined();
      expect(body.data).toEqual(n.data);
    });
  }
});

// ---------- EB4 ----------
describe('EB4 - conservative gate unchanged', () => {
  const ROOT_FRAG = 'query { ...R } fragment R on Query { book(id:"a1-b1"){ author{ books{ id } } } }';
  const ROOT_TYPENAME = '{ __typename book(id:"a1-b1"){ author{ books{ id } } } }';
  for (const [name, q] of [
    ['root named fragment', ROOT_FRAG],
    ['root __typename', ROOT_TYPENAME],
  ] as const) {
    it(`${name}: 3 calls and median >= 145 ms (3 hops)`, async () => {
      const { body, stats } = await measured(gw, base, q);
      expect(body.errors).toBeUndefined();
      expect(stats.total).toBe(3);
      expect(stats.byRoute).toEqual({ '/books/by-ids': 1, '/authors/by-ids': 1, '/books/by-author': 1 });
      expect(await medianMs(slow, q)).toBeGreaterThanOrEqual(145);
    });
  }

  it('authors list root: 2 calls (/authors 1, books/by-author 1)', async () => {
    const { body, stats } = await measured(gw, base, '{ authors(first:2){ edges{ node{ books{ author{ books{ id } } } } } } }');
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(2);
    expect(stats.byRoute).toEqual({ '/authors': 1, '/books/by-author': 1 });
  });

  it('list root + book root: 3 calls, one per route', async () => {
    const { body, stats } = await measured(
      gw,
      base,
      '{ authors(first:1){ edges{ node{ id } } } book(id:"a1-b1"){ author{ books{ id } } } }',
    );
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(3);
    expect(stats.byRoute).toEqual({ '/authors': 1, '/books/by-ids': 1, '/books/by-author': 1 });
  });
});

// ---------- EB5 ----------
describe('EB5 - child selection is honoured', () => {
  const excluded: Array<[string, string, Record<string, unknown> | undefined]> = [
    ['@skip(if:true)', 'query($x:Boolean!){ book(id:"a1-b1"){ author{ name books @skip(if:$x){ id } } } }', { x: true }],
    ['@include(if:false)', 'query($x:Boolean!){ book(id:"a1-b1"){ author{ name books @include(if:$x){ id } } } }', { x: false }],
    ['no books selected', '{ book(id:"a1-b1"){ author{ name } } }', undefined],
  ];
  for (const [name, q, v] of excluded) {
    it(`${name}: 2 calls, no /books/by-author, data equals NAIVE`, async () => {
      const { body, stats } = await measured(gw, base, q, v, 100);
      expect(body.errors).toBeUndefined();
      expect(stats.total).toBe(2);
      expect(stats.byRoute).toEqual({ '/books/by-ids': 1, '/authors/by-ids': 1 });
      expect(body.extensions?.downstreamCalls?.total).toBe(2);
      const n = await gql(naive, q, v);
      expect(body.data).toEqual(n.data);
    });
  }

  const viaFragment: Array<[string, string]> = [
    ['named fragment on Author', 'query { book(id:"a1-b1"){ author{ ...F } } } fragment F on Author { books{ id } }'],
    ['inline fragment on Author', '{ book(id:"a1-b1"){ author{ ... on Author { books{ id } } } } }'],
  ];
  for (const [name, q] of viaFragment) {
    it(`${name}: 3 calls and median < 135 ms`, async () => {
      const { body, stats } = await measured(gw, base, q);
      expect(body.errors).toBeUndefined();
      expect(stats.total).toBe(3);
      expect(stats.byRoute).toEqual({ '/books/by-ids': 1, '/authors/by-ids': 1, '/books/by-author': 1 });
      expect(await medianMs(slow, q)).toBeLessThan(135);
    });
  }
});

// ---------- EB6 / EB7 (stub backend) ----------
describe('EB6/EB7 - orphan book and failing child route (stub backend)', () => {
  let stub: FastifyInstance;
  let stubBase: string;
  let failByAuthor = false;
  const counts: Record<string, number> = {};
  const stubTotal = (): number => Object.values(counts).reduce((a, b) => a + b, 0);
  const resetCounts = (): void => {
    for (const k of Object.keys(counts)) delete counts[k];
  };
  const allRejections: unknown[] = [];
  const track = (r: unknown): void => {
    allRejections.push(r);
  };

  beforeAll(async () => {
    process.on('unhandledRejection', track);
    stub = Fastify();
    stub.addHook('onRequest', async (req) => {
      const p = req.url.split('?')[0]!;
      counts[p] = (counts[p] ?? 0) + 1;
    });
    stub.get('/books/by-ids', async () => [
      { id: 'o-b1', title: 'Orphan', authorId: 'ghost', year: 2000 },
      { id: 'x-b1', title: 'X', authorId: 'x', year: 2001 },
    ]);
    stub.get('/authors/by-ids', async (req) => {
      const ids = String((req.query as Record<string, unknown>).ids ?? '').split(',');
      return ids.includes('x') ? [{ id: 'x', name: 'X', bio: '' }] : [];
    });
    stub.get('/books/by-author', async (_req, reply) => {
      if (failByAuthor) {
        reply.code(500);
        return { error: 'boom' };
      }
      return [];
    });
    stubBase = await stub.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await stub.close();
    process.off('unhandledRejection', track);
    expect(allRejections).toEqual([]);
  });

  async function stubRun(query: string): Promise<{ body: GqlResult; total: number; by: Record<string, number> }> {
    resetCounts();
    const g = createGateway({ restBaseUrl: stubBase });
    const body = await gql(g, query);
    await settle(100);
    return { body, total: stubTotal(), by: { ...counts } };
  }

  it('EB6: orphan book with books selected spends 3 calls, one per route, and fails NOT_FOUND at book.author', async () => {
    failByAuthor = false;
    const r = await stubRun('{ book(id:"o-b1"){ title author{ name books{ title } } } }');
    expect(r.total).toBe(3); // HEAD: 2
    expect(r.by).toEqual({ '/books/by-ids': 1, '/authors/by-ids': 1, '/books/by-author': 1 });
    expect(r.body.data?.book).toBeNull();
    expect(r.body.errors?.length).toBe(1);
    const e = r.body.errors![0]!;
    expect(e.extensions?.code).toBe('NOT_FOUND');
    expect(e.path).toEqual(['book', 'author']);
    expect(e.message).toBe('Author ghost not found for book o-b1');
  });

  it('EB6: orphan book without books makes 2 calls and the same error', async () => {
    failByAuthor = false;
    const r = await stubRun('{ book(id:"o-b1"){ title author{ name } } }');
    expect(r.total).toBe(2);
    expect(r.by).toEqual({ '/books/by-ids': 1, '/authors/by-ids': 1 });
    expect(r.body.data?.book).toBeNull();
    expect(r.body.errors?.length).toBe(1);
    const e = r.body.errors![0]!;
    expect(e.extensions?.code).toBe('NOT_FOUND');
    expect(e.path).toEqual(['book', 'author']);
    expect(e.message).toBe('Author ghost not found for book o-b1');
  });

  it('EB7: a 500 on /books/by-author is called once; one DOWNSTREAM_ERROR at book.author.books', async () => {
    failByAuthor = true;
    try {
      const r = await stubRun('{ book(id:"x-b1"){ author{ name books{ title } } } }');
      expect(r.by['/books/by-author']).toBe(1);
      expect(r.total).toBe(3);
      expect(r.body.data?.book).toBeNull();
      expect(r.body.errors?.length).toBe(1);
      const e = r.body.errors![0]!;
      expect(e.extensions?.code).toBe('DOWNSTREAM_ERROR');
      expect(e.path).toEqual(['book', 'author', 'books']);
      expect(e.message).toBe('Downstream REST error 500 Internal Server Error for /books/by-author');
      expect(allRejections).toEqual([]);
    } finally {
      failByAuthor = false;
    }
  });
});

// ---------- EB8 ----------
describe('EB8 - call budget (100 ms settle)', () => {
  it('maxDownstreamCalls 3: S1 succeeds in 3 calls', async () => {
    const g = createGateway({ restBaseUrl: base, maxDownstreamCalls: 3 });
    const { body, stats } = await measured(g, base, S1, undefined, 100);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(3);
    expect((body.data?.book as { author: { books: unknown[] } }).author.books.length).toBeGreaterThan(0);
  });

  it('maxDownstreamCalls 2: book null, one DOWNSTREAM_BUDGET_EXCEEDED (budget 2) at book.author, <= 2 calls', async () => {
    const g = createGateway({ restBaseUrl: base, maxDownstreamCalls: 2 });
    const { body, stats } = await measured(g, base, S1, undefined, 100);
    expect(body.data?.book).toBeNull();
    expect(body.errors?.length).toBe(1);
    const e = body.errors![0]!;
    expect(e.extensions?.code).toBe('DOWNSTREAM_BUDGET_EXCEEDED');
    expect(e.extensions?.budget).toBe(2);
    expect(e.path).toEqual(['book', 'author']);
    expect(stats.total).toBeLessThanOrEqual(2);
  });

  it('maxDownstreamCalls 1: one DOWNSTREAM_BUDGET_EXCEEDED at book.author after 1 call', async () => {
    const g = createGateway({ restBaseUrl: base, maxDownstreamCalls: 1 });
    const { body, stats } = await measured(g, base, S1, undefined, 100);
    expect(body.data?.book).toBeNull();
    expect(body.errors?.length).toBe(1);
    const e = body.errors![0]!;
    expect(e.extensions?.code).toBe('DOWNSTREAM_BUDGET_EXCEEDED');
    expect(e.extensions?.budget).toBe(1);
    expect(e.path).toEqual(['book', 'author']);
    expect(stats.total).toBe(1);
  });
});

// ---------- EB9 ----------
describe('EB9 - NAIVE and batching', () => {
  it('NAIVE: S1 makes 3 calls with a median >= 145 ms (no prefetch with the cache off)', async () => {
    const { body, stats } = await measured(naive, base, S1);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(3);
    const slowNaive = createGateway({ restBaseUrl: slowBase, loaderOptions: NAIVE });
    expect(await medianMs(slowNaive, S1)).toBeGreaterThanOrEqual(145);
  });

  it('maxBatchSize 5: [S1, S1, a2-b1 author books] -> 3 elements, no errors, 3 calls, data equals solo runs', async () => {
    const third = '{ book(id:"a2-b1"){ author{ books{ id } } } }';
    const g = createGateway({ restBaseUrl: base, maxBatchSize: 5 });
    await resetStats(base);
    const r = await post(g, [{ query: S1 }, { query: S1 }, { query: third }]);
    await settle(50);
    const stats = await readStats(base);
    expect(r.status).toBe(200);
    const arr = r.body as GqlResult[];
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBe(3);
    for (const el of arr) expect(el.errors).toBeUndefined();
    expect(stats.total).toBe(3);
    expect(Math.max(...arr.map((el) => el.extensions?.downstreamCalls?.total ?? 0))).toBe(3);
    const solo1 = await gql(gw, S1);
    const solo3 = await gql(gw, third);
    expect(arr[0]!.data).toEqual(solo1.data);
    expect(arr[1]!.data).toEqual(solo1.data);
    expect(arr[2]!.data).toEqual(solo3.data);
  });
});

// ---------- EB10 ----------
describe('EB10 - docs', () => {
  function paragraph(text: string): string {
    const start = text.indexOf('**Lookahead prefetch on by-id roots.**');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = text.indexOf('\n', start);
    return end === -1 ? text.slice(start) : text.slice(start, end);
  }

  it('the lookahead paragraph names Book.author, the shape, and the orphan-book speculative call', () => {
    const p = paragraph(README);
    expect(p).toContain('Book.author');
    expect(p).toContain('book(id){ author{ books } }');
    const orphan = p.split(/(?<=\.)\s+/).filter((s) => /orphan book/i.test(s));
    expect(orphan.length).toBeGreaterThan(0);
    expect(orphan.join(' ')).toMatch(/\/books\/by-author/);
    expect(orphan.join(' ')).toMatch(/3 downstream calls instead of 2/);
  });

  it('the section 6 Architecture resolvers.ts line is qualified with "lookahead"', () => {
    const lines = README.split('\n').filter((l) => /^\s*resolvers\.ts\b/.test(l));
    expect(lines.length).toBe(1);
    const line = lines[0]!;
    expect(line).toMatch(/lookahead/);
    expect(line.trimEnd().endsWith('one field -> one service call.')).toBe(false);
    expect(line.trimEnd().endsWith('one field -> one service call')).toBe(false);
  });

  it('every sentence of the HEAD lookahead paragraph is kept', () => {
    let headReadme: string;
    try {
      headReadme = execFileSync('git', ['show', 'HEAD:README.md'], { cwd: root, encoding: 'utf8' });
    } catch {
      return; // not a git checkout
    }
    const before = paragraph(headReadme);
    const now = paragraph(README);
    for (const s of before.split(/(?<=\.)\s+(?=[A-Z`*])/)) expect(now).toContain(s);
  });
});

// ---------- EB11 ----------
describe('EB11 - frozen surface', () => {
  function porcelain(paths: string[], extra: string[] = []): string | null {
    try {
      return execFileSync('git', ['status', '--porcelain', ...extra, '--', ...paths], { cwd: root, encoding: 'utf8' });
    } catch {
      return null; // not a git checkout
    }
  }

  // services, SDL and generated types dropped from the list at iter-71 (Relay `last`/`before`).
  it('loaders, datasources, lib.ts and n-plus-1 are unmodified', () => {
    const out = porcelain([
      'src/gateway/loaders.ts',
      'src/gateway/datasources',
      'src/lib.ts',
      'test/n-plus-1.test.ts',
    ]);
    if (out !== null) expect(out.trim()).toBe('');
  });

  it('only older behavior test files may be modified; nothing tracked under test/ is deleted', () => {
    const out = porcelain(['test'], ['--untracked-files=no']);
    if (out === null) return;
    const lines = out.split('\n').filter(Boolean);
    const bumpedBehaviorFile = /^(M | M|MM) test\/test_iter\d+_behavior\.test\.ts$/;
    expect(lines.filter((l) => !bumpedBehaviorFile.test(l))).toEqual([]);
    expect(lines.some((l) => /^ ?D|^.D/.test(l))).toBe(false);
  });

  it('the src/lib.ts export list is unchanged', async () => {
    const lib = await import('../src/lib');
    expect(Object.keys(lib).sort()).toEqual([
      'BATCHED',
      'NAIVE',
      'buildBackend',
      'createContext',
      'createGateway',
      'parseAuth',
      'schema',
    ]);
  });

  it('no unhandledRejection was recorded during this file', () => {
    expect(rejections).toEqual([]);
  });
});
