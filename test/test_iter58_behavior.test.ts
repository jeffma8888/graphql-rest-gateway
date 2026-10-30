import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createGateway, buildBackend } from '../src/lib';
import { NAIVE } from '../src/gateway/loaders';

/**
 * iter-58: root-by-id lookahead prefetch.
 * Black-box: the bundled backend runs in-process on port 0 and the gateway is
 * driven through createGateway(...).fetch. Every call count is read from the
 * backend's own /__stats counter (total + byRoute) and cross-checked against
 * the response's extensions.downstreamCalls.total.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

type Gateway = ReturnType<typeof createGateway>;
type Stats = { total: number; byRoute: Record<string, number> };
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  extensions?: { downstreamCalls?: { total: number } };
};

const DEEP_AUTHOR = `{ author(id:"a2"){ name books { title reviews { rating } } } }`;
const BOOK_REVIEWS = `{ book(id:"a1-b2"){ title reviews { rating } } }`;
const MULTI_ROOT = `{ author(id:"a1"){ books{ reviews{ rating } } } authors(first:2){ edges{ node{ books{ reviews{ rating } } } } } }`;
const ALIASED_ROOTS = `{ x: book(id:"a1-b2"){ reviews{ rating } } y: author(id:"a2"){ books{ reviews{ rating } } } }`;
const ROOT_FRAGMENT = `query { ...R } fragment R on Query { author(id:"a1"){ books{ reviews{ rating } } } authors(first:2){ edges{ node{ books{ reviews{ rating } } } } } }`;
const LIST_ROOT = `{ authors(first:5){ edges{ node{ name books{ title reviews{ rating } } } } } }`;
const NAMED_FRAG = `query { author(id:"a2"){ ...F } } fragment F on Author { name books { title } }`;
const INLINE_FRAG = `{ author(id:"a2"){ ... on Author { books { title } } } }`;
const PLAIN_NAMED_EQ = `{ author(id:"a2"){ name books { title } } }`;
const PLAIN_INLINE_EQ = `{ author(id:"a2"){ books { title } } }`;

async function gql(gw: Gateway, query: string, variables?: Record<string, unknown>): Promise<GqlResult> {
  const res = await gw.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as GqlResult;
}

async function resetStats(base: string): Promise<void> {
  const r = await fetch(`${base}/__stats/reset`, { method: 'POST' });
  expect(r.ok).toBe(true);
}

async function readStats(base: string): Promise<Stats> {
  const r = await fetch(`${base}/__stats`);
  return (await r.json()) as Stats;
}

/** Runs one request and returns its result plus the backend's measured stats. */
async function measured(
  gw: Gateway,
  base: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ body: GqlResult; stats: Stats }> {
  await resetStats(base);
  const body = await gql(gw, query, variables);
  const stats = await readStats(base);
  // The edge figure must always equal the backend's own ground truth.
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
let batched: Gateway;
let slow: Gateway;

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  slowApp = buildBackend({ latencyMs: 50 }).app;
  slowBase = await slowApp.listen({ port: 0, host: '127.0.0.1' });
  batched = createGateway({ restBaseUrl: base });
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

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('EB1 - deep author keeps the same call count and data', () => {
  it('returns Alan Turing with books and reviews in 3 calls, one per route', async () => {
    const { body, stats } = await measured(batched, base, DEEP_AUTHOR);
    expect(body.errors).toBeUndefined();
    const author = body.data?.author as { name: string; books: Array<{ title: string; reviews: Array<{ rating: number }> }> };
    expect(author.name).toBe('Alan Turing');
    expect(author.books.length).toBe(3);
    for (const b of author.books) expect(b.reviews.length).toBeGreaterThan(0);
    expect(stats.total).toBe(3);
    expect(stats.byRoute).toEqual({ '/authors/by-ids': 1, '/books/by-author': 1, '/reviews/by-book': 1 });
  });

  it('data is identical to the NAIVE (never-prefetching) resolution', async () => {
    const naive = createGateway({ restBaseUrl: base, loaderOptions: NAIVE });
    const a = await gql(batched, DEEP_AUTHOR);
    const b = await gql(naive, DEEP_AUTHOR);
    expect(a.data).toEqual(b.data);
    expect(a.data).toEqual({
      author: {
        name: 'Alan Turing',
        books: [
          { title: "Alan's Volume 1", reviews: [{ rating: 4 }, { rating: 5 }] },
          { title: "Alan's Volume 2", reviews: [{ rating: 5 }, { rating: 3 }] },
          { title: "Alan's Volume 3", reviews: [{ rating: 3 }, { rating: 4 }] },
        ],
      },
    });
  });
});

describe('EB2 - deep author is faster at latencyMs 50', () => {
  it('median of 5 runs is < 125 ms (HEAD needs >= 150 ms for 3 serial calls)', async () => {
    const { stats } = await measured(slow, slowBase, DEEP_AUTHOR);
    expect(stats.total).toBe(3);
    const median = await medianMs(slow, DEEP_AUTHOR);
    expect(median).toBeLessThan(125);
  });
});

describe('EB3 - book reviews: same count, faster', () => {
  it('returns the exact data in 2 calls, one per route', async () => {
    const { body, stats } = await measured(batched, base, BOOK_REVIEWS);
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({
      book: { title: "Ada's Volume 2", reviews: [{ rating: 4 }, { rating: 5 }] },
    });
    expect(stats.total).toBe(2);
    expect(stats.byRoute).toEqual({ '/books/by-ids': 1, '/reviews/by-book': 1 });
  });

  it('median of 5 runs at latencyMs 50 is < 80 ms', async () => {
    const median = await medianMs(slow, BOOK_REVIEWS);
    expect(median).toBeLessThan(80);
  });
});

describe('EB4 - fragments keep the speedup', () => {
  for (const [name, query, plain] of [
    ['named fragment', NAMED_FRAG, PLAIN_NAMED_EQ],
    ['inline fragment', INLINE_FRAG, PLAIN_INLINE_EQ],
  ] as const) {
    it(`${name}: 2 calls, same data as plain-field form, median < 80 ms`, async () => {
      const { body, stats } = await measured(batched, base, query);
      expect(body.errors).toBeUndefined();
      expect(stats.total).toBe(2);
      expect(stats.byRoute).toEqual({ '/authors/by-ids': 1, '/books/by-author': 1 });
      const plainBody = await gql(batched, plain);
      expect(body.data).toEqual(plainBody.data);
      const median = await medianMs(slow, query);
      expect(median).toBeLessThan(80);
    });
  }
});

describe('EB5 - no child selected, no prefetch', () => {
  it('author(id){ name } makes 1 call to /authors/by-ids only', async () => {
    const { body, stats } = await measured(batched, base, `{ author(id:"a2"){ name } }`);
    expect(body.data).toEqual({ author: { name: 'Alan Turing' } });
    expect(stats.total).toBe(1);
    expect(stats.byRoute).toEqual({ '/authors/by-ids': 1 });
  });

  it('book(id){ title } makes 1 call to /books/by-ids only', async () => {
    const { body, stats } = await measured(batched, base, `{ book(id:"a1-b2"){ title } }`);
    expect(body.data).toEqual({ book: { title: "Ada's Volume 2" } });
    expect(stats.total).toBe(1);
    expect(stats.byRoute).toEqual({ '/books/by-ids': 1 });
  });
});

describe('EB6 - skipped selections never prefetch', () => {
  const INCLUDE = `query($x:Boolean!){ author(id:"a2"){ name books @include(if:$x){ title } } }`;
  const SKIP = `query($x:Boolean!){ author(id:"a2"){ name books @skip(if:$x){ title } } }`;
  const SPREAD = `query($x:Boolean!){ author(id:"a2"){ name ...F @include(if:$x) } } fragment F on Author { books { title } }`;

  for (const [name, query, skipVars, keepVars] of [
    ['@include(if:false) on field', INCLUDE, { x: false }, { x: true }],
    ['@skip(if:true) on field', SKIP, { x: true }, { x: false }],
    ['@include(if:false) on fragment spread', SPREAD, { x: false }, { x: true }],
  ] as const) {
    it(`${name}: 1 call and no books key; flipped variable gives 2 calls`, async () => {
      const skipped = await measured(batched, base, query, skipVars);
      expect(skipped.body.errors).toBeUndefined();
      expect(skipped.stats.total).toBe(1);
      expect(skipped.stats.byRoute).toEqual({ '/authors/by-ids': 1 });
      const author = skipped.body.data?.author as Record<string, unknown>;
      expect(author.name).toBe('Alan Turing');
      expect(Object.prototype.hasOwnProperty.call(author, 'books')).toBe(false);

      const kept = await measured(batched, base, query, keepVars);
      expect(kept.body.errors).toBeUndefined();
      expect(kept.stats.total).toBe(2);
      expect(kept.stats.byRoute).toEqual({ '/authors/by-ids': 1, '/books/by-author': 1 });
      const keptAuthor = kept.body.data?.author as { books: unknown[] };
      expect(keptAuthor.books.length).toBe(3);
    });
  }

  it('skip-first then include on a fresh gateway: 1 then 2 calls (no stale state)', async () => {
    const fresh = createGateway({ restBaseUrl: base });
    expect((await measured(fresh, base, INCLUDE, { x: false })).stats.total).toBe(1);
    expect((await measured(fresh, base, INCLUDE, { x: true })).stats.total).toBe(2);
    expect((await measured(fresh, base, INCLUDE, { x: false })).stats.total).toBe(1);
  });
});

describe('EB7 - sibling root fields keep their batches', () => {
  it('author(id) + authors(first:2) makes exactly 4 calls, one per route', async () => {
    const { body, stats } = await measured(batched, base, MULTI_ROOT);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(4);
    expect(stats.byRoute).toEqual({
      '/authors/by-ids': 1,
      '/authors': 1,
      '/books/by-author': 1,
      '/reviews/by-book': 1,
    });
  });

  it('aliased book(id) + author(id) makes exactly 5 calls (same as HEAD)', async () => {
    const { body, stats } = await measured(batched, base, ALIASED_ROOTS);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(5);
    expect(stats.byRoute).toEqual({
      '/books/by-ids': 1,
      '/authors/by-ids': 1,
      '/books/by-author': 1,
      '/reviews/by-book': 2,
    });
  });
});

describe('EB8 - root fragment counts as multi-root', () => {
  it('query { ...R } makes exactly 4 calls, same routes and data as EB7', async () => {
    const { body, stats } = await measured(batched, base, ROOT_FRAGMENT);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(4);
    expect(stats.byRoute).toEqual({
      '/authors/by-ids': 1,
      '/authors': 1,
      '/books/by-author': 1,
      '/reviews/by-book': 1,
    });
    const plain = await gql(batched, MULTI_ROOT);
    expect(body.data).toEqual(plain.data);
  });

  it('a lone root-level fragment spread wrapping one by-id root still resolves correctly', async () => {
    const q = `query { ...R } fragment R on Query { author(id:"a2"){ name books { title } } }`;
    const { body, stats } = await measured(batched, base, q);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(2);
    expect(stats.byRoute).toEqual({ '/authors/by-ids': 1, '/books/by-author': 1 });
  });
});

describe('EB9 - missing ids cost one honest extra call; errors unchanged', () => {
  for (const [name, query, field, route] of [
    ['author', `{ author(id:"zz"){ books { title } } }`, 'author', '/books/by-author'],
    ['book', `{ book(id:"zz"){ reviews { rating } } }`, 'book', '/reviews/by-book'],
  ] as const) {
    it(`${name}(id:"zz") -> null + one NOT_FOUND, 2 calls, no unhandledRejection`, async () => {
      const { body, stats } = await measured(batched, base, query);
      expect(body.data).toEqual({ [field]: null });
      expect(body.errors?.length).toBe(1);
      expect(body.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
      expect(body.errors?.[0]?.extensions?.id).toBe('zz');
      expect(stats.total).toBe(2);
      const byIds = name === 'author' ? '/authors/by-ids' : '/books/by-ids';
      expect(stats.byRoute).toEqual({ [byIds]: 1, [route]: 1 });
      expect(body.extensions?.downstreamCalls?.total).toBe(2);
      await settle();
      expect(rejections).toEqual([]);
    });
  }
});

describe('EB10 - a failed prefetch surfaces exactly once', () => {
  type Proxy = { server: Server; origin: string; hits: Record<string, number> };
  let proxy: Proxy;
  let failDelayMs = 0;

  beforeAll(async () => {
    const t = new URL(base);
    const hits: Record<string, number> = {};
    const server = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0]!;
      hits[path] = (hits[path] ?? 0) + 1;
      if (path === '/books/by-author') {
        setTimeout(() => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'boom' }));
        }, failDelayMs);
        return;
      }
      const up = httpRequest(
        { host: t.hostname, port: Number(t.port), method: req.method, path: req.url, headers: { ...req.headers, host: t.host } },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      up.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(up);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no proxy address');
    proxy = { server, origin: `http://127.0.0.1:${addr.port}`, hits };
  });

  afterAll(async () => {
    await new Promise<void>((r) => proxy.server.close(() => r()));
  });

  for (const delay of [0, 20, 80]) {
    it(`/books/by-author 500 (delay ${delay} ms): author null, one DOWNSTREAM_ERROR, failing route hit once`, async () => {
      failDelayMs = delay;
      for (const k of Object.keys(proxy.hits)) delete proxy.hits[k];
      const gw = createGateway({ restBaseUrl: proxy.origin });
      const body = await gql(gw, `{ author(id:"a2"){ name books { title } } }`);
      expect(body.data).toEqual({ author: null });
      expect(body.errors?.length).toBe(1);
      expect(body.errors?.[0]?.extensions?.code).toBe('DOWNSTREAM_ERROR');
      expect(proxy.hits['/books/by-author']).toBe(1);
      expect(proxy.hits['/authors/by-ids']).toBe(1);
      expect(body.extensions?.downstreamCalls?.total).toBe(2);
      await settle(delay + 30);
      expect(rejections).toEqual([]);
    });
  }
});

describe('EB11 - no-cache modes never prefetch (figures measured on HEAD)', () => {
  // HEAD (e39c496) figures, measured by stashing the src/ changes and running
  // the same shapes: NAIVE 5 / 2 / 14, {batch:true, cache:false} 3 / 2 / 6.
  const HEAD = {
    naive: { deep: 5, book: 2, multi: 14 },
    nocache: { deep: 3, book: 2, multi: 6 },
  };
  for (const [mode, opts] of [
    ['naive', NAIVE],
    ['nocache', { batch: true, cache: false }],
  ] as const) {
    it(`${mode}: EB1/EB3/EB7 shapes match HEAD call counts`, async () => {
      const gw = createGateway({ restBaseUrl: base, loaderOptions: opts });
      const exp = HEAD[mode];
      const deep = await measured(gw, base, DEEP_AUTHOR);
      expect(deep.body.errors).toBeUndefined();
      expect(deep.stats.total).toBe(exp.deep);
      const book = await measured(gw, base, BOOK_REVIEWS);
      expect(book.body.errors).toBeUndefined();
      expect(book.stats.total).toBe(exp.book);
      const multi = await measured(gw, base, MULTI_ROOT);
      expect(multi.body.errors).toBeUndefined();
      expect(multi.stats.total).toBe(exp.multi);
    });
  }

  it('NAIVE per-route breakdown for EB1 matches HEAD (reviews fan out 3x)', async () => {
    const gw = createGateway({ restBaseUrl: base, loaderOptions: NAIVE });
    const { stats } = await measured(gw, base, DEEP_AUTHOR);
    expect(stats.byRoute).toEqual({ '/authors/by-ids': 1, '/books/by-author': 1, '/reviews/by-book': 3 });
  });

  it('test/n-plus-1.test.ts still pins the exact 21 vs 3 regression counts', () => {
    const src = readFileSync(resolve(root, 'test/n-plus-1.test.ts'), 'utf8');
    expect(src).toMatch(/21/);
    expect(src).toMatch(/NAIVE/);
    expect(src).toMatch(/BATCHED/);
  });
});

describe('EB12 - list roots are unaffected', () => {
  it('authors(first:5) nested makes 3 calls and data equals NAIVE resolution', async () => {
    const { body, stats } = await measured(batched, base, LIST_ROOT);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(3);
    expect(stats.byRoute).toEqual({ '/authors': 1, '/books/by-author': 1, '/reviews/by-book': 1 });
    const naive = createGateway({ restBaseUrl: base, loaderOptions: NAIVE });
    const n = await gql(naive, LIST_ROOT);
    expect(body.data).toEqual(n.data);
    const edges = (body.data?.authors as { edges: unknown[] }).edges;
    expect(edges.length).toBe(5);
  });
});
