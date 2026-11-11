import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, buildBackend, NAIVE } from '../src/lib';

/**
 * iter-83: bulk lookup `Query.books(ids: [ID!]!): [Book]!` (PRODUCT row 81).
 *
 * Black-box: the bundled backend runs in-process on port 0 behind a node:http
 * recording proxy that logs every downstream request as `{ route, ids }`
 * (`ids` = the comma-split `ids` query param). Call counts are checked three
 * ways: proxy hits, `onDownstreamCall` events and
 * `extensions.downstreamCalls.total`. Book titles are read from the backend's
 * own REST route, never from source.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_MODULES = path.join(REPO, 'node_modules');
const CODEGEN = path.join(NODE_MODULES, '@graphql-codegen', 'cli', 'cjs', 'bin.js');
const README = readFileSync(path.join(REPO, 'README.md'), 'utf8');

type Gateway = ReturnType<typeof createGateway>;
type GqlError = { message: string; path?: Array<string | number>; extensions?: Record<string, unknown> };
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
  extensions?: { downstreamCalls?: { total: number }; queryComplexity?: { cost: number; depth: number } };
};
type Hit = { route: string; ids: string[]; raw: string };
type BookRow = { id: string; title: string; authorId: string };

const IDS15: string[] = [];
for (let a = 1; a <= 5; a++) for (let b = 1; b <= 3; b++) IDS15.push(`a${a}-b${b}`);
const Q = 'query($ids:[ID!]!){ books(ids:$ids){ id title } }';
const Q_ID = 'query($ids:[ID!]!){ books(ids:$ids){ id } }';
const Q_NESTED = 'query($ids:[ID!]!){ books(ids:$ids){ id reviews{ id } author{ name } } }';
const IDS101 = Array.from({ length: 101 }, (_, i) => `x${i}`);
const IDS100 = Array.from({ length: 100 }, (_, i) => IDS15[i % 15]!);

let backend: FastifyInstance;
let realUrl = '';
let proxy: Server;
let proxyUrl = '';
let hits: Hit[] = [];
let events: Array<{ route: string }> = [];
let gwB: Gateway;
let gwN: Gateway;
let gw30: Gateway;
const rows = new Map<string, BookRow>();

function handle(req: IncomingMessage, res: ServerResponse): void {
  const u = new URL(req.url ?? '/', 'http://proxy.local');
  // key list = every `ids` / `*Ids` param (e.g. `bookIds` on /reviews/by-book), comma-split
  const ids = [...u.searchParams.entries()]
    .filter(([k]) => k === 'ids' || /Ids$/.test(k))
    .flatMap(([, v]) => v.split(','))
    .filter(Boolean);
  hits.push({ route: u.pathname, ids, raw: u.search });
  fetch(realUrl + u.pathname + u.search)
    .then(async (r) => {
      const text = await r.text();
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
      res.end(text);
    })
    .catch(() => {
      res.writeHead(502);
      res.end();
    });
}

beforeAll(async () => {
  backend = buildBackend({ latencyMs: 0 }).app;
  realUrl = (await backend.listen({ port: 0, host: '127.0.0.1' })).replace(/\/$/, '');
  proxy = createServer(handle);
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const onDownstreamCall = (e: { route: string }) => {
    events.push(e);
  };
  gwB = createGateway({ restBaseUrl: proxyUrl, onDownstreamCall });
  gwN = createGateway({ restBaseUrl: proxyUrl, loaderOptions: { batch: false, cache: false }, onDownstreamCall });
  gw30 = createGateway({ restBaseUrl: proxyUrl, maxComplexity: 30, onDownstreamCall });
  const r = await fetch(`${realUrl}/books/by-ids?ids=${IDS15.join(',')}`);
  for (const row of (await r.json()) as BookRow[]) rows.set(row.id, row);
});

afterAll(async () => {
  await Promise.all([gwB?.close?.(), gwN?.close?.(), gw30?.close?.()]);
  await new Promise<void>((r) => proxy?.close(() => r()));
  await backend?.close();
});

async function gql(gw: Gateway, query: string, variables?: Record<string, unknown>): Promise<GqlResult> {
  hits = [];
  events = [];
  const res = await gw.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as GqlResult;
  await new Promise((r) => setTimeout(r, 20)); // let late hook events settle
  return body;
}

/** Exact call count, agreed by proxy hits, hook events and (when present) downstreamCalls.total. */
function expectCalls(body: GqlResult, n: number): void {
  expect(hits).toHaveLength(n);
  expect(events).toHaveLength(n);
  const total = body.extensions?.downstreamCalls?.total;
  if (n > 0) expect(total).toBe(n);
  else expect(total ?? 0).toBe(0);
}

const cost = (b: GqlResult) => b.extensions?.queryComplexity?.cost;
const row = (id: string) => ({ id, title: rows.get(id)!.title });
const sorted = (a: string[]) => [...a].sort();

// ---------- EB1 ----------
describe('EB1 - SDL contract', () => {
  it('introspection: Query.books is [Book]! with exactly one arg ids: [ID!]!, description names 100 and NOT_FOUND', async () => {
    const b = await gql(
      gwB,
      '{ __type(name:"Query"){ fields{ name description type{ kind name ofType{ kind name } } args{ name type{ kind ofType{ kind ofType{ kind name } } } } } } }',
    );
    expect(b.errors).toBeUndefined();
    const fields = (b.data!.__type as { fields: any[] }).fields;
    const f = fields.find((x) => x.name === 'books');
    expect(f).toBeDefined();
    expect(f.type).toEqual({ kind: 'NON_NULL', name: null, ofType: { kind: 'LIST', name: null } });
    expect(f.args).toHaveLength(1);
    expect(f.args[0].name).toBe('ids');
    expect(f.args[0].type).toEqual({ kind: 'NON_NULL', ofType: { kind: 'LIST', ofType: { kind: 'NON_NULL', name: null } } });
    expect(typeof f.description).toBe('string');
    expect(f.description.trim().length).toBeGreaterThan(0);
    expect(f.description).toContain('100');
    expect(f.description).toContain('NOT_FOUND');
    const inner = await gql(gwB, '{ __type(name:"Query"){ fields{ name type{ ofType{ ofType{ name } } } args{ type{ ofType{ ofType{ ofType{ name } } } } } } } }');
    const g = (inner.data!.__type as { fields: any[] }).fields.find((x) => x.name === 'books');
    expect(g.type.ofType.ofType.name).toBe('Book');
    expect(g.args[0].type.ofType.ofType.ofType.name).toBe('ID');
  });

  it('schema.graphql declares books(ids: [ID!]!): [Book]! and generated types export QueryBooksArgs', () => {
    const sdl = readFileSync(path.join(REPO, 'schema.graphql'), 'utf8');
    expect(sdl).toMatch(/\bbooks\s*\(\s*ids\s*:\s*\[\s*ID\s*!\s*\]\s*!\s*\)\s*:\s*\[\s*Book\s*\]\s*!/);
    const gen = readFileSync(path.join(REPO, 'src', 'generated', 'graphql.ts'), 'utf8');
    expect(gen).toMatch(/export type QueryBooksArgs\b/);
  });

  it('src/generated/graphql.ts is byte-identical to a fresh `npm run codegen` of the current SDL', { timeout: 60_000 }, async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'gw-iter83-'));
    try {
      cpSync(path.join(REPO, 'codegen.ts'), path.join(tmp, 'codegen.ts'));
      cpSync(path.join(REPO, 'schema.graphql'), path.join(tmp, 'schema.graphql'));
      cpSync(path.join(REPO, 'package.json'), path.join(tmp, 'package.json'));
      symlinkSync(NODE_MODULES, path.join(tmp, 'node_modules'), 'dir');
      mkdirSync(path.join(tmp, 'src', 'generated'), { recursive: true });
      const code = await new Promise<number>((resolveRun) => {
        execFile(
          process.execPath,
          [CODEGEN, '--config', 'codegen.ts'],
          { cwd: tmp, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 50_000 },
          (err) => resolveRun(err ? 1 : 0),
        );
      });
      expect(code).toBe(0);
      const fresh = path.join(tmp, 'src', 'generated', 'graphql.ts');
      expect(existsSync(fresh)).toBe(true);
      expect(readFileSync(fresh, 'utf8')).toBe(readFileSync(path.join(REPO, 'src', 'generated', 'graphql.ts'), 'utf8'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------- EB2 ----------
describe('EB2 - batched and ordered', () => {
  it('15 ids return 15 rows in ids order with backend titles, no errors', async () => {
    expect(rows.size).toBe(15);
    expect(rows.get('a1-b1')!.title).toBe("Ada's Volume 1");
    const b = await gql(gwB, Q, { ids: IDS15 });
    expect(b.errors).toBeUndefined();
    expect(b.data).toEqual({ books: IDS15.map(row) });
  });

  it('exactly 1 call, to /books/by-ids, holding all 15 ids; cost 31', async () => {
    const b = await gql(gwB, Q, { ids: IDS15 });
    expectCalls(b, 1);
    expect(hits[0]!.route).toBe('/books/by-ids');
    expect(sorted(hits[0]!.ids)).toEqual(sorted(IDS15));
    expect(cost(b)).toBe(31);
  });
});

// ---------- EB3 ----------
describe('EB3 - BATCHED vs NAIVE contrast', () => {
  it('NAIVE returns identical data in 15 single-id /books/by-ids calls; BATCHED in 1', async () => {
    const batched = await gql(gwB, Q, { ids: IDS15 });
    expectCalls(batched, 1);
    const naive = await gql(gwN, Q, { ids: IDS15 });
    expect(naive.errors).toBeUndefined();
    expect(naive.data).toEqual(batched.data);
    expectCalls(naive, 15);
    for (const h of hits) {
      expect(h.route).toBe('/books/by-ids');
      expect(h.ids).toHaveLength(1);
    }
    expect(sorted(hits.map((h) => h.ids[0]!))).toEqual(sorted(IDS15));
  });

  it('the exported NAIVE preset agrees: 15 calls', async () => {
    const gw = createGateway({ restBaseUrl: proxyUrl, loaderOptions: NAIVE });
    try {
      const b = await gql(gw, Q, { ids: IDS15 });
      expect(b.errors).toBeUndefined();
      expect(hits).toHaveLength(15);
    } finally {
      await gw.close?.();
    }
  });
});

// ---------- EB4 ----------
describe('EB4 - order, duplicates and missing ids', () => {
  const IDS = ['a2-b1', 'a1-b1', 'nope', 'a2-b1'];
  it('data keeps order, repeats the duplicate, null at the unknown index', async () => {
    const b = await gql(gwB, Q, { ids: IDS });
    expect(b.data).toEqual({ books: [row('a2-b1'), row('a1-b1'), null, row('a2-b1')] });
  });

  it('exactly one NOT_FOUND error with id and path ["books", 2]', async () => {
    const b = await gql(gwB, Q, { ids: IDS });
    expect(b.errors).toHaveLength(1);
    const e = b.errors![0]!;
    expect(e.extensions?.code).toBe('NOT_FOUND');
    expect(e.extensions?.id).toBe('nope');
    expect(e.path).toEqual(['books', 2]);
    expect(e.message).toBe('Book nope not found');
  });

  it('exactly 1 call whose ids param lists the 3 distinct ids once each', async () => {
    const b = await gql(gwB, Q, { ids: IDS });
    expectCalls(b, 1);
    expect(hits[0]!.route).toBe('/books/by-ids');
    expect(sorted(hits[0]!.ids)).toEqual(sorted(['a2-b1', 'a1-b1', 'nope']));
  });
});

// ---------- EB5 ----------
describe('EB5 - empty list', () => {
  it('ids: [] gives { books: [] }, no errors, 0 calls, cost 1', async () => {
    const b = await gql(gwB, Q, { ids: [] });
    expect(b.errors).toBeUndefined();
    expect(b.data).toEqual({ books: [] });
    expectCalls(b, 0);
    expect(cost(b)).toBe(1);
  });
});

// ---------- EB6 ----------
describe('EB6 - literal list', () => {
  it('literal ["a1-b1","a1-b2"] returns both rows in order, 1 call, cost 5', async () => {
    const b = await gql(gwB, '{ books(ids: ["a1-b1", "a1-b2"]) { id title } }');
    expect(b.errors).toBeUndefined();
    expect(b.data).toEqual({ books: [row('a1-b1'), row('a1-b2')] });
    expectCalls(b, 1);
    expect(hits[0]!.route).toBe('/books/by-ids');
    expect(cost(b)).toBe(5);
  });
});

// ---------- EB7 ----------
describe('EB7 - cap of 100', () => {
  function expectBadArgument(b: GqlResult): void {
    expect(b.data).toBeNull();
    expect(b.errors).toHaveLength(1);
    const e = b.errors![0]!;
    expect(e.extensions?.code).toBe('BAD_ARGUMENT');
    expect(e.extensions?.argument).toBe('ids');
    expect(e.extensions?.max).toBe(100);
    expect(e.extensions?.received).toBe(101);
    expect(e.path).toEqual(['books']);
    expect(e.message).toContain('ids');
    expect(e.message).toContain('100');
    expect(e.message).toContain('101');
  }

  it('101 ids under BATCHED: data null, one BAD_ARGUMENT error, 0 calls', async () => {
    const b = await gql(gwB, Q_ID, { ids: IDS101 });
    expectBadArgument(b);
    expectCalls(b, 0);
  });

  it('101 ids under NAIVE: same error, 0 calls', async () => {
    const b = await gql(gwN, Q_ID, { ids: IDS101 });
    expectBadArgument(b);
    expectCalls(b, 0);
  });

  it('101 real ids (IDS15 cycled) are refused the same way at 0 calls', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => IDS15[i % 15]!);
    const b = await gql(gwB, Q_ID, { ids });
    expectBadArgument(b);
    expectCalls(b, 0);
  });

  it('exactly 100 ids of { id }: 100 items, no errors, 1 call with 15 distinct ids, cost 101', async () => {
    const b = await gql(gwB, Q_ID, { ids: IDS100 });
    expect(b.errors).toBeUndefined();
    const books = b.data!.books as Array<{ id: string }>;
    expect(books).toHaveLength(100);
    expect(books.map((x) => x.id)).toEqual(IDS100);
    expectCalls(b, 1);
    expect(sorted(hits[0]!.ids)).toEqual(sorted(IDS15));
    expect(cost(b)).toBe(101);
  });
});

// ---------- EB8 ----------
describe('EB8 - pricing 1 + n x subtree', () => {
  it('same document text: 2 ids cost 5, then 15 ids cost 31, then 2 ids cost 5 again (per request)', async () => {
    expect(cost(await gql(gwB, Q, { ids: ['a1-b1', 'a1-b2'] }))).toBe(5);
    expect(cost(await gql(gwB, Q, { ids: IDS15 }))).toBe(31);
    expect(cost(await gql(gwB, Q, { ids: ['a1-b1', 'a1-b2'] }))).toBe(5);
  });

  it('grid: { id title } for n in 0..20 costs 1 + 2n', async () => {
    for (let n = 0; n <= 20; n++) {
      const ids = Array.from({ length: n }, (_, i) => IDS15[i % 15]!);
      expect(cost(await gql(gwB, Q, { ids }))).toBe(1 + 2 * n);
    }
  });

  it('101 ids of { id } report cost 101 (clamped) and are still refused BAD_ARGUMENT', async () => {
    const b = await gql(gwB, Q_ID, { ids: IDS101 });
    expect(cost(b)).toBe(101);
    expect(b.errors?.[0]?.extensions?.code).toBe('BAD_ARGUMENT');
  });

  it('single non-list value ids: "a1-b1" is coerced to one item, 1 call, cost 3', async () => {
    const b = await gql(gwB, Q, { ids: 'a1-b1' });
    expect(b.errors).toBeUndefined();
    expect(b.data).toEqual({ books: [row('a1-b1')] });
    expectCalls(b, 1);
    expect(cost(b)).toBe(3);
  });

  it('nested lists keep their pricing: 15 ids of { id reviews{ id } author{ name } } cost 136', async () => {
    const b = await gql(gwB, Q_NESTED, { ids: IDS15 });
    expect(b.errors).toBeUndefined();
    expect(cost(b)).toBe(136);
  });

  it('first-based pricing is unchanged: authors(first:n){edges{node{id}}} = 1 + 3n', async () => {
    for (const n of [0, 1, 5, 10]) {
      const b = await gql(gwB, `{ authors(first: ${n}) { edges { node { id } } } }`);
      expect(cost(b)).toBe(1 + 3 * n);
    }
  });
});

// ---------- EB9 ----------
describe('EB9 - complexity refusals use QUERY_TOO_COMPLEX', () => {
  it('100 ids of { id reviews { id body } } refused by default limit: cost 1201, max 1000, 0 calls', async () => {
    const b = await gql(gwB, 'query($ids:[ID!]!){ books(ids:$ids){ id reviews { id body } } }', { ids: IDS100 });
    expect(b.errors).toHaveLength(1);
    const e = b.errors![0]!;
    expect(e.extensions?.code).toBe('QUERY_TOO_COMPLEX');
    expect(e.extensions?.cost).toBe(1201);
    expect(e.extensions?.maxComplexity).toBe(1000);
    expect(b.data ?? null).toBeNull();
    expectCalls(b, 0);
  });

  it('maxComplexity 30: 15 ids (cost 31) refused at 0 calls, 14 ids (cost 29) admitted', async () => {
    const refused = await gql(gw30, Q, { ids: IDS15 });
    expect(refused.errors?.[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX');
    expect(refused.errors?.[0]?.extensions?.cost).toBe(31);
    expectCalls(refused, 0);
    const ok = await gql(gw30, Q, { ids: IDS15.slice(0, 14) });
    expect(ok.errors).toBeUndefined();
    expect(ok.data).toEqual({ books: IDS15.slice(0, 14).map(row) });
    expect(cost(ok)).toBe(29);
    expectCalls(ok, 1);
  });
});

// ---------- EB10 ----------
describe('EB10 - children stay batched', () => {
  it('15 ids of { id reviews{ id } author{ name } }: 3 calls, one per route, keys deduped', async () => {
    const b = await gql(gwB, Q_NESTED, { ids: IDS15 });
    expect(b.errors).toBeUndefined();
    const books = b.data!.books as Array<{ id: string; reviews: Array<{ id: string }>; author: { name: string } }>;
    expect(books.map((x) => x.id)).toEqual(IDS15);
    for (const bk of books) {
      expect(bk.reviews).toHaveLength(2);
      expect(typeof bk.author.name).toBe('string');
      expect(bk.author.name.length).toBeGreaterThan(0);
    }
    expect(books[0]!.author.name.startsWith('Ada')).toBe(true);
    expectCalls(b, 3);
    const by = new Map(hits.map((h) => [h.route, h]));
    expect(sorted([...by.keys()])).toEqual(['/authors/by-ids', '/books/by-ids', '/reviews/by-book']);
    expect(sorted(by.get('/books/by-ids')!.ids)).toEqual(sorted(IDS15));
    expect(sorted(by.get('/reviews/by-book')!.ids)).toEqual(sorted(IDS15));
    expect(sorted(by.get('/authors/by-ids')!.ids)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });

  it('NAIVE contrast for the nested shape makes more calls than BATCHED (15 + 15 + 15)', async () => {
    const b = await gql(gwN, Q_NESTED, { ids: IDS15 });
    expect(b.errors).toBeUndefined();
    expect(hits).toHaveLength(45);
  });
});

// ---------- EB11 ----------
describe('EB11 - mixing with a by-id root never splits a batch', () => {
  const MIX = '{ one: book(id:"a3-b1"){ id reviews{ id } } books(ids:["a1-b1","a2-b2"]){ id reviews{ id } } }';
  it('both shapes, no errors, exactly 2 calls each holding all 3 book ids', async () => {
    const b = await gql(gwB, MIX);
    expect(b.errors).toBeUndefined();
    const one = b.data!.one as { id: string; reviews: unknown[] };
    const books = b.data!.books as Array<{ id: string; reviews: unknown[] }>;
    expect(one.id).toBe('a3-b1');
    expect(one.reviews).toHaveLength(2);
    expect(books.map((x) => x.id)).toEqual(['a1-b1', 'a2-b2']);
    for (const bk of books) expect(bk.reviews).toHaveLength(2);
    expectCalls(b, 2);
    const by = new Map(hits.map((h) => [h.route, h]));
    expect(sorted([...by.keys()])).toEqual(['/books/by-ids', '/reviews/by-book']);
    const three = ['a1-b1', 'a2-b2', 'a3-b1'];
    expect(sorted(by.get('/books/by-ids')!.ids)).toEqual(three);
    expect(sorted(by.get('/reviews/by-book')!.ids)).toEqual(three);
  });

  it('control: the by-id root alone still makes 2 calls (prefetch path unchanged)', async () => {
    const b = await gql(gwB, '{ one: book(id:"a3-b1"){ id reviews{ id } } }');
    expect(b.errors).toBeUndefined();
    expectCalls(b, 2);
  });
});

// ---------- EB12 ----------
function gitAt(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** The iter-83 commit once it exists; null before commit (then the working tree vs HEAD is checked). */
function iter83Commit(): string | null {
  const out = gitAt(['log', '--format=%H', '-1', '--grep=foundry iter 83)']);
  return out && out.trim() ? out.trim() : null;
}

function section7(): string {
  const start = README.search(/^##\s*7\b/m);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = README.slice(start + 3);
  const end = rest.search(/^##\s*\d+\b/m);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('EB12 - docs and nothing else moves', () => {
  it('README §7 has a Bulk lookup paragraph with the required claims', () => {
    const s7 = section7();
    const para = s7.split(/\n\s*\n/).find((p) => p.includes('Bulk lookup'));
    expect(para).toBeDefined();
    const p = para!;
    expect(p).toContain('books(ids:');
    expect(p).toMatch(/order/i);
    expect(p).toMatch(/duplicates? (are|is) repeated/i);
    expect(p).toContain('null');
    expect(p).toContain('NOT_FOUND');
    expect(p).toContain('BAD_ARGUMENT');
    expect(p).toContain('100');
    expect(p).toMatch(/0 downstream calls/);
    expect(p).toContain('1 + n × subtree');
    expect(p).toContain('1 downstream call');
    expect(p).toMatch(/15 under NAIVE/);
  });

  // Deliberate re-pin (iter 87, PRODUCT row 86): the bulk root now joins the
  // lookahead, so the paragraph must say it prefetches, not that it turns it off.
  it('README lookahead paragraph says a books(ids:) root prefetches (iter-87 re-pin)', () => {
    const para = README.split(/\n\s*\n/).find((p) => p.includes('**Lookahead prefetch on by-id roots.**'));
    expect(para).toBeDefined();
    expect(para!).not.toMatch(/`books\(ids:\)`[^.]*turns the prefetch off/);
    expect(para!).toMatch(/`books\(ids:\)`[^.]*prefetches/);
  });

  it('README mentions BAD_ARGUMENT', () => {
    expect(README).toContain('BAD_ARGUMENT');
  });

  it('test/n-plus-1.test.ts is byte-identical to its pre-iteration version', () => {
    const c = iter83Commit();
    const now = readFileSync(path.join(REPO, 'test', 'n-plus-1.test.ts'), 'utf8');
    const before = gitAt(['show', `${c ? `${c}~1` : 'HEAD'}:test/n-plus-1.test.ts`]);
    if (before === null) {
      // outside a git checkout: the file must at least still exist and assert batching
      expect(now.length).toBeGreaterThan(0);
      return;
    }
    const after = c ? gitAt(['show', `${c}:test/n-plus-1.test.ts`]) : now;
    expect(after).toBe(before);
  });

  it('only test_iter82 (re-pinned, see tester.md) is modified among existing test files', () => {
    const c = iter83Commit();
    const out = c
      ? gitAt(['diff', '--name-only', '--diff-filter=a', `${c}~1`, c, '--', 'test/'])
      : gitAt(['diff', '--name-only', '--diff-filter=a', 'HEAD', '--', 'test/']);
    if (out === null) {
      expect(existsSync(path.join(REPO, 'test', 'n-plus-1.test.ts'))).toBe(true);
      return;
    }
    const changed = out.split('\n').filter(Boolean);
    expect(changed.filter((f) => f !== 'test/test_iter82_behavior.test.ts')).toEqual([]);
  });
});
