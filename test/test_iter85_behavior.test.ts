import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, buildBackend, NAIVE } from '../src/lib';

/**
 * iter-85: by-id keys the REST list syntax `?ids=a,b` cannot carry as exactly
 * one id never reach a URL (PRODUCT row 83, widened).
 *
 * Black-box: the bundled backend runs in-process on port 0 behind a node:http
 * recording proxy that logs every downstream request as `{ route, ids, raw }`
 * (`ids` = every `ids` / `*Ids` query param, comma-split). Call counts are
 * agreed three ways: proxy hits, `onDownstreamCall` events and
 * `extensions.downstreamCalls.total`.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = readFileSync(path.join(REPO, 'README.md'), 'utf8');

type Gateway = ReturnType<typeof createGateway>;
type GqlError = { message: string; path?: Array<string | number>; extensions?: Record<string, unknown> };
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
  extensions?: { downstreamCalls?: { total: number }; queryComplexity?: { cost: number; depth: number } };
};
type Hit = { route: string; ids: string[]; params: Record<string, string>; raw: string };

const Q_ID = 'query($ids:[ID!]!){ books(ids:$ids){ id } }';
const IDS150: string[] = [];
for (let a = 1; a <= 50; a++) for (let b = 1; b <= 3; b++) IDS150.push(`a${a}-b${b}`);
const S = IDS150.join(',');
const LONG_Z = 'z'.repeat(20000);
const LONG_Y = 'y'.repeat(20000);
const EB4_IDS = ['a1-b1', 'a2-b1', LONG_Z];
const NESTED =
  '{ authors(first:5){ edges{ node{ id name books{ id title reviews{ id rating } } } } } }';

let backend: FastifyInstance;
let realUrl = '';
let proxy: Server;
let proxyUrl = '';
let hits: Hit[] = [];
let events: Array<{ route: string }> = [];
let gwB: Gateway;
let gwN: Gateway;

function handle(req: IncomingMessage, res: ServerResponse): void {
  const u = new URL(req.url ?? '/', 'http://proxy.local');
  const ids = [...u.searchParams.entries()]
    .filter(([k]) => k === 'ids' || /Ids$/.test(k))
    .flatMap(([, v]) => v.split(','))
    .filter(Boolean);
  hits.push({ route: u.pathname, ids, params: Object.fromEntries(u.searchParams.entries()), raw: u.search });
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
  // a large maxHeaderSize lets an oversized URL reach (and be recorded by) the proxy
  proxy = createServer({ maxHeaderSize: 1 << 20 }, handle);
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const onDownstreamCall = (e: { route: string }) => {
    events.push(e);
  };
  gwB = createGateway({ restBaseUrl: proxyUrl, onDownstreamCall });
  gwN = createGateway({ restBaseUrl: proxyUrl, loaderOptions: NAIVE, onDownstreamCall });
});

afterAll(async () => {
  await Promise.all([gwB?.close?.(), gwN?.close?.()]);
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

/** Exactly one NOT_FOUND error at `p` whose extensions.id is `id` verbatim. */
function expectOneNotFound(body: GqlResult, p: Array<string | number>, id: string): void {
  expect(body.errors ?? []).toHaveLength(1);
  const e = body.errors![0]!;
  expect(e.extensions?.code).toBe('NOT_FOUND');
  expect(e.extensions?.id).toBe(id);
  expect(e.path).toEqual(p);
}

const cost = (b: GqlResult) => b.extensions?.queryComplexity?.cost;
const sorted = (a: string[]) => [...a].sort();

// ---------- EB1 ----------
describe('EB1 - comma-smuggled single root', () => {
  it('book(id:"<150 comma-joined ids>") is null + 1 NOT_FOUND (id verbatim, path [book]) at 0 calls, cost 2', async () => {
    expect(IDS150).toHaveLength(150);
    const b = await gql(gwB, `{ book(id:"${S}"){ id } }`);
    expect(b.data).toEqual({ book: null });
    expectOneNotFound(b, ['book'], S);
    expectCalls(b, 0);
    expect(cost(b)).toBe(2);
  });
});

// ---------- EB2 ----------
describe('EB2 - comma keys on the lookahead prefetch', () => {
  it('author(id:"a1,a2"){ id books{ id } } is null + 1 NOT_FOUND at 0 calls (no /books/by-author, no /authors/by-ids)', async () => {
    const b = await gql(gwB, '{ author(id:"a1,a2"){ id books{ id } } }');
    expect(b.data).toEqual({ author: null });
    expectOneNotFound(b, ['author'], 'a1,a2');
    expectCalls(b, 0);
    expect(hits.filter((h) => h.route === '/books/by-author' || h.route === '/authors/by-ids')).toEqual([]);
  });

  it('book(id:"a1-b1,a1-b2"){ id reviews{ id } } is null + 1 NOT_FOUND at 0 calls (no /reviews/by-book, no /books/by-ids)', async () => {
    const b = await gql(gwB, '{ book(id:"a1-b1,a1-b2"){ id reviews{ id } } }');
    expect(b.data).toEqual({ book: null });
    expectOneNotFound(b, ['book'], 'a1-b1,a1-b2');
    expectCalls(b, 0);
    expect(hits.filter((h) => h.route === '/reviews/by-book' || h.route === '/books/by-ids')).toEqual([]);
  });
});

// ---------- EB3 ----------
describe('EB3 - bulk list of comma strings', () => {
  const ids100 = Array.from({ length: 100 }, (_, i) => `a${(i % 50) + 1}-b1,a${(i % 50) + 1}-b2`);

  it('100 comma strings: 100 nulls + 100 NOT_FOUND at paths [books,i] with id verbatim, 0 calls, cost 101', async () => {
    const b = await gql(gwB, Q_ID, { ids: ids100 });
    const list = b.data!.books as unknown[];
    expect(list).toHaveLength(100);
    expect(list.every((x) => x === null)).toBe(true);
    const errs = b.errors ?? [];
    expect(errs).toHaveLength(100);
    expect(errs.every((e) => e.extensions?.code === 'NOT_FOUND')).toBe(true);
    const byIndex = new Map(errs.map((e) => [e.path![1] as number, e]));
    for (let i = 0; i < 100; i++) {
      expect(byIndex.get(i)?.path).toEqual(['books', i]);
      expect(byIndex.get(i)?.extensions?.id).toBe(ids100[i]);
    }
    expectCalls(b, 0);
    expect(cost(b)).toBe(101);
  });

  it('101 such ids are still refused with BAD_ARGUMENT, data null, 0 calls', async () => {
    const ids101 = [...ids100, 'a1-b1,a1-b2'];
    const b = await gql(gwB, Q_ID, { ids: ids101 });
    expect(b.data ?? null).toBeNull();
    expect((b.errors ?? []).some((e) => e.extensions?.code === 'BAD_ARGUMENT')).toBe(true);
    expectCalls(b, 0);
  });
});

// ---------- EB4 ----------
describe('EB4 - an oversized id does not poison its bulk siblings', () => {
  it('["a1-b1","a2-b1",<20k z>] → 2 rows + null, 1 NOT_FOUND at [books,2], 1 /books/by-ids call with ids=a1-b1,a2-b1', async () => {
    const b = await gql(gwB, Q_ID, { ids: EB4_IDS });
    expect(b.data!.books).toEqual([{ id: 'a1-b1' }, { id: 'a2-b1' }, null]);
    expectOneNotFound(b, ['books', 2], LONG_Z);
    expectCalls(b, 1);
    expect(hits[0]!.route).toBe('/books/by-ids');
    expect(hits[0]!.params.ids).toBe('a1-b1,a2-b1');
    expect(hits[0]!.raw.includes('zzz')).toBe(false);
  });
});

// ---------- EB5 ----------
describe('EB5 - an oversized id does not poison an aliased sibling root', () => {
  it('ok: author(id:"a1") keeps its name, bad: author(<20k y>) is null + 1 NOT_FOUND at [bad], 1 call ids=a1', async () => {
    const b = await gql(gwB, `{ ok: author(id:"a1"){ name } bad: author(id:"${LONG_Y}"){ name } }`);
    expect(b.data).toEqual({ ok: { name: 'Ada Lovelace' }, bad: null });
    expectOneNotFound(b, ['bad'], LONG_Y);
    expectCalls(b, 1);
    expect(hits[0]!.route).toBe('/authors/by-ids');
    expect(hits[0]!.params.ids).toBe('a1');
  });
});

// ---------- EB6 ----------
describe('EB6 - empty and padded ids', () => {
  it.each([
    ['author', ''],
    ['author', ' a1'],
    ['author', 'a1 '],
    ['book', ''],
  ])('%s(id:%j){ id } is null + 1 NOT_FOUND echoing the input verbatim at 0 calls', async (root, id) => {
    const b = await gql(gwB, `{ ${root}(id:${JSON.stringify(id)}){ id } }`);
    expect(b.data).toEqual({ [root]: null });
    expectOneNotFound(b, [root], id);
    expectCalls(b, 0);
  });

  it('the same padded/empty ids as variables also make 0 calls', async () => {
    for (const id of ['', ' a1', 'a1 ', '\ta1', 'a1\n']) {
      const b = await gql(gwB, 'query($id:ID!){ author(id:$id){ id } }', { id });
      expect(b.data).toEqual({ author: null });
      expectOneNotFound(b, ['author'], id);
      expectCalls(b, 0);
    }
  });
});

// ---------- EB7 ----------
describe('EB7 - length boundary', () => {
  const q256 = 'q'.repeat(256);
  const q257 = 'q'.repeat(257);

  it('a 256-char id is still sent: 1 /authors/by-ids call carrying it, NOT_FOUND', async () => {
    const b = await gql(gwB, `{ author(id:"${q256}"){ id } }`);
    expect(b.data).toEqual({ author: null });
    expectOneNotFound(b, ['author'], q256);
    expectCalls(b, 1);
    expect(hits[0]!.route).toBe('/authors/by-ids');
    expect(hits[0]!.params.ids).toBe(q256);
  });

  it('a 257-char id makes 0 calls and returns NOT_FOUND, as a literal', async () => {
    const b = await gql(gwB, `{ author(id:"${q257}"){ id } }`);
    expect(b.data).toEqual({ author: null });
    expectOneNotFound(b, ['author'], q257);
    expectCalls(b, 0);
  });

  it('a 257-char id makes 0 calls and returns NOT_FOUND, as a variable', async () => {
    const b = await gql(gwB, 'query($id:ID!){ author(id:$id){ id } }', { id: q257 });
    expect(b.data).toEqual({ author: null });
    expectOneNotFound(b, ['author'], q257);
    expectCalls(b, 0);
  });

  it('MAX_ID_LENGTH is exported from src/gateway/loaders.ts with value 256', async () => {
    const mod = (await import('../src/gateway/loaders')) as Record<string, unknown>;
    expect(mod.MAX_ID_LENGTH).toBe(256);
  });
});

// ---------- EB8 ----------
describe('EB8 - mixed tick', () => {
  it('a and c carry data, b (comma) is null + NOT_FOUND at [b]; 1 /books/by-ids call with {a1-b1,a3-b1}', async () => {
    const b = await gql(gwB, '{ a: book(id:"a1-b1"){ id } b: book(id:"a2-b1,a3-b1"){ id } c: book(id:"a3-b1"){ id } }');
    expect(b.data).toEqual({ a: { id: 'a1-b1' }, b: null, c: { id: 'a3-b1' } });
    expectOneNotFound(b, ['b'], 'a2-b1,a3-b1');
    expectCalls(b, 1);
    expect(hits[0]!.route).toBe('/books/by-ids');
    expect(sorted(hits[0]!.params.ids!.split(','))).toEqual(['a1-b1', 'a3-b1']);
  });
});

// ---------- EB9 ----------
describe('EB9 - NAIVE mode', () => {
  it("EB4's query under NAIVE: same data, same single NOT_FOUND, exactly 2 /books/by-ids calls", async () => {
    const b = await gql(gwN, Q_ID, { ids: EB4_IDS });
    expect(b.data!.books).toEqual([{ id: 'a1-b1' }, { id: 'a2-b1' }, null]);
    expectOneNotFound(b, ['books', 2], LONG_Z);
    expectCalls(b, 2);
    expect(hits.map((h) => h.route)).toEqual(['/books/by-ids', '/books/by-ids']);
    expect(sorted(hits.map((h) => h.params.ids!))).toEqual(['a1-b1', 'a2-b1']);
  });

  it("EB1's query under NAIVE makes 0 calls", async () => {
    const b = await gql(gwN, `{ book(id:"${S}"){ id } }`);
    expect(b.data).toEqual({ book: null });
    expectOneNotFound(b, ['book'], S);
    expectCalls(b, 0);
  });
});

// ---------- EB10 ----------
describe('EB10 - honest traffic is unchanged', () => {
  it('nested N+1 query: 3 calls BATCHED, 21 NAIVE, same data (5 authors x 3 books x 2 reviews)', async () => {
    const bb = await gql(gwB, NESTED);
    expect(bb.errors).toBeUndefined();
    expectCalls(bb, 3);
    const bn = await gql(gwN, NESTED);
    expect(bn.errors).toBeUndefined();
    expectCalls(bn, 21);
    expect(bn.data).toEqual(bb.data);
    const edges = (bb.data!.authors as { edges: Array<{ node: { books: Array<{ reviews: unknown[] }> } }> }).edges;
    expect(edges).toHaveLength(5);
    expect(edges.flatMap((e) => e.node.books)).toHaveLength(15);
    expect(edges.flatMap((e) => e.node.books.flatMap((x) => x.reviews))).toHaveLength(30);
  });

  it('test/n-plus-1.test.ts is byte-unchanged by this iteration', () => {
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    let base: string;
    try {
      const sha = git(['log', '--format=%H', '-1', '--grep', 'foundry iter 85)']).trim();
      base = sha ? `${sha}~1` : 'HEAD';
      git(['rev-parse', '--verify', `${base}^{commit}`]);
    } catch {
      return; // not a git checkout (or shallow): the behavioural 3/21 pin above still holds
    }
    const before = git(['show', `${base}:test/n-plus-1.test.ts`]);
    expect(readFileSync(path.join(REPO, 'test', 'n-plus-1.test.ts'), 'utf8')).toBe(before);
  });

  it('author(id:"a1"){ name books{ title reviews{ id } } } is 3 calls with data', async () => {
    const b = await gql(gwB, '{ author(id:"a1"){ name books{ title reviews{ id } } } }');
    expect(b.errors).toBeUndefined();
    expectCalls(b, 3);
    const a = b.data!.author as { name: string; books: Array<{ reviews: unknown[] }> };
    expect(a.name).toBe('Ada Lovelace');
    expect(a.books).toHaveLength(3);
    expect(a.books.flatMap((x) => x.reviews)).toHaveLength(6);
    const n = await gql(gwN, '{ author(id:"a1"){ name books{ title reviews{ id } } } }');
    expect(n.data).toEqual(b.data);
  });

  it('authors(first:10){ edges{ node{ name books{ title reviews{ id } } } } } is 3 calls', async () => {
    const q = '{ authors(first:10){ edges{ node{ name books{ title reviews{ id } } } } } }';
    const b = await gql(gwB, q);
    expect(b.errors).toBeUndefined();
    expectCalls(b, 3);
    const n = await gql(gwN, q);
    expect(n.data).toEqual(b.data);
  });

  it('books(ids:["a1-b1","a2-b1","a1-b1"]){ id author{ id } } is 2 calls, order and duplicates kept', async () => {
    const b = await gql(gwB, '{ books(ids:["a1-b1","a2-b1","a1-b1"]){ id author{ id } } }');
    expect(b.errors).toBeUndefined();
    expect(b.data!.books).toEqual([
      { id: 'a1-b1', author: { id: 'a1' } },
      { id: 'a2-b1', author: { id: 'a2' } },
      { id: 'a1-b1', author: { id: 'a1' } },
    ]);
    expectCalls(b, 2);
  });

  it('books(ids:["a1-b1","a2-b1","nope"]) is [row,row,null] + 1 NOT_FOUND at [books,2] in 1 call', async () => {
    const b = await gql(gwB, '{ books(ids:["a1-b1","a2-b1","nope"]){ id } }');
    expect(b.data!.books).toEqual([{ id: 'a1-b1' }, { id: 'a2-b1' }, null]);
    expectOneNotFound(b, ['books', 2], 'nope');
    expectCalls(b, 1);
    expect(sorted(hits[0]!.ids)).toEqual(['a1-b1', 'a2-b1', 'nope']);
  });

  it('a known id with an internal "-" is sent as-is: book(id:"a1-b1") 1 call with data', async () => {
    const b = await gql(gwB, '{ book(id:"a1-b1"){ id } }');
    expect(b.errors).toBeUndefined();
    expect(b.data).toEqual({ book: { id: 'a1-b1' } });
    expectCalls(b, 1);
    expect(hits[0]!.params.ids).toBe('a1-b1');
  });
});

// ---------- guard-derived fuzz ----------
describe('EB1-EB8 - seeded fuzz over books(ids:) mixes', () => {
  it('sent ids == dedup(sendable), calls == (any sendable ? 1 : 0), one NOT_FOUND per null with id verbatim', async () => {
    let seed = 0x85;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const honest = ['a1-b1', 'a2-b2', 'a3-b3', 'a4-b1', 'nope'];
    const bad = ['', ' a1-b1', 'a1-b1 ', 'a1-b1,a2-b1', ',', 'q'.repeat(257), 'w'.repeat(5000)];
    const sendable = (k: string) => k.length > 0 && k.length <= 256 && !k.includes(',') && k.trim() === k;
    for (let run = 0; run < 40; run++) {
      const n = 1 + Math.floor(rnd() * 8);
      const ids = Array.from({ length: n }, () => (rnd() < 0.5 ? pick(honest) : pick(bad)));
      const b = await gql(gwB, Q_ID, { ids });
      const want = [...new Set(ids.filter(sendable))];
      expectCalls(b, want.length > 0 ? 1 : 0);
      if (want.length > 0) expect(sorted(hits[0]!.params.ids!.split(','))).toEqual(sorted(want));
      const list = b.data!.books as Array<{ id: string } | null>;
      expect(list).toHaveLength(n);
      const errs = b.errors ?? [];
      for (let i = 0; i < n; i++) {
        const ok = sendable(ids[i]!) && ids[i] !== 'nope';
        if (ok) expect(list[i]).toEqual({ id: ids[i] });
        else {
          expect(list[i]).toBeNull();
          const e = errs.find((x) => x.path?.[1] === i);
          expect(e?.extensions?.code).toBe('NOT_FOUND');
          expect(e?.extensions?.id).toBe(ids[i]);
        }
      }
      expect(errs).toHaveLength(list.filter((x) => x === null).length);
    }
  });
});

// ---------- EB11 ----------
describe('EB11 - docs', () => {
  const s7 = README.slice(README.indexOf('## 7. '), README.indexOf('## 8. '));
  const s8 = README.slice(README.indexOf('## 8. '), README.indexOf('## 9. '));

  it('README §7 has a paragraph naming empty/comma/whitespace/256 ids, never sent downstream, NOT_FOUND at 0 calls, siblings unaffected', () => {
    expect(s7.length).toBeGreaterThan(0);
    const para = s7.split(/\n\s*\n/).find((p) => p.includes('256') && /comma/i.test(p));
    expect(para).toBeDefined();
    expect(para!).toMatch(/empty/i);
    expect(para!).toMatch(/whitespace/i);
    expect(para!).toMatch(/never sent downstream|never reach/i);
    expect(para!).toContain('NOT_FOUND');
    expect(para!).toMatch(/0 downstream calls/);
    expect(para!).toMatch(/other ids|siblings?/i);
  });

  it('README §8 lists test_iter85_behavior.test.ts in the bullet style of the iter-83 entry', () => {
    expect(s8).toMatch(/^- \*\*[^*]+\*\* \(`test_iter83_behavior\.test\.ts`\): /m);
    expect(s8).toMatch(/^- \*\*[^*]+\*\* \(`test_iter85_behavior\.test\.ts`\): .+/m);
  });
});
