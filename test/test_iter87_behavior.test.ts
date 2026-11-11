import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, buildBackend, NAIVE } from '../src/lib';

/**
 * iter-87: the `books(ids:)` bulk root joins the lookahead prefetch (PRODUCT row 86).
 *
 * Black-box: the bundled backend runs in-process (latencyMs 50, never 0) and
 * records every request through its own Fastify `onRequest` / `onResponse`
 * hooks as an ordered event log of `{ kind, route, ids }`.
 *
 * "1 hop saved" is checked CAUSALLY, never by wall time: the child route's
 * request reaches the backend BEFORE the backend finishes the parent route's
 * response. Without the prefetch that is impossible, because the child key is
 * only known once the parent response has arrived.
 *
 * Call counts are checked as backend `onRequest` hits == `extensions.downstreamCalls.total`.
 * Data is compared with `toEqual` (the executor builds root maps in completion
 * order, so key order is not part of the contract) against oracles that never
 * prefetch: the NAIVE gateway (loader cache off) and the `book(id)` spelling.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = readFileSync(path.join(REPO, 'README.md'), 'utf8');
const L = 50;

type Gateway = ReturnType<typeof createGateway>;
type GqlError = { message: string; path?: Array<string | number>; extensions?: Record<string, unknown> };
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
  extensions?: { downstreamCalls?: { total: number } };
};
type Ev = { kind: 'req' | 'res'; route: string; ids: string[] };

let backend: FastifyInstance;
let base = '';
let ev: Ev[] = [];
let gwB: Gateway;
let gwN: Gateway;

function parse(url: string): { route: string; ids: string[] } {
  const u = new URL(url, 'http://backend.local');
  // key list = every `ids` / `*Ids` param (e.g. `bookIds` on /reviews/by-book), comma-split
  const ids = [...u.searchParams.entries()]
    .filter(([k]) => k === 'ids' || /Ids$/.test(k))
    .flatMap(([, v]) => v.split(','))
    .filter(Boolean);
  return { route: u.pathname, ids };
}

beforeAll(async () => {
  backend = buildBackend({ latencyMs: L }).app;
  backend.addHook('onRequest', async (req) => {
    ev.push({ kind: 'req', ...parse(req.url) });
  });
  backend.addHook('onResponse', async (req) => {
    ev.push({ kind: 'res', ...parse(req.url) });
  });
  base = (await backend.listen({ port: 0, host: '127.0.0.1' })).replace(/\/$/, '');
  gwB = createGateway({ restBaseUrl: base });
  gwN = createGateway({ restBaseUrl: base, loaderOptions: NAIVE });
});

afterAll(async () => {
  await Promise.all([gwB?.close?.(), gwN?.close?.()]);
  await backend?.close();
});

async function gql(gw: Gateway, query: string, variables?: Record<string, unknown>): Promise<GqlResult> {
  ev = [];
  const res = await gw.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as GqlResult;
  // let any late (speculative) request and every onResponse hook land
  await new Promise((r) => setTimeout(r, L + 40));
  return body;
}

const reqs = () => ev.filter((e) => e.kind === 'req');
const reqsTo = (route: string) => reqs().filter((e) => e.route === route);
const sorted = (a: string[]) => [...a].sort();

/** Exact call count, agreed by backend onRequest hits and extensions.downstreamCalls.total. */
function expectCalls(body: GqlResult, n: number): void {
  expect(reqs()).toHaveLength(n);
  const total = body.extensions?.downstreamCalls?.total;
  if (n > 0) expect(total).toBe(n);
  else expect(total ?? 0).toBe(0);
}

/** Causal hop oracle: the child's first request arrives before the parent's first response is sent. */
function childBeforeParentResponse(child: string, parent: string): boolean {
  const c = ev.findIndex((e) => e.kind === 'req' && e.route === child);
  const p = ev.findIndex((e) => e.kind === 'res' && e.route === parent);
  expect(c).toBeGreaterThanOrEqual(0);
  expect(p).toBeGreaterThanOrEqual(0);
  return c < p;
}

const routes = () => sorted(reqs().map((e) => e.route));

// ---------- EB1 ----------
describe('EB1 - single-id bulk root prefetches its reviews', () => {
  const Q = '{ books(ids:["a1-b1"]){ reviews{ id } } }';

  it('2 calls (/books/by-ids + /reviews/by-book), reviews request before the books response', async () => {
    const b = await gql(gwB, Q);
    expect(b.errors).toBeUndefined();
    expectCalls(b, 2);
    expect(routes()).toEqual(['/books/by-ids', '/reviews/by-book']);
    expect(childBeforeParentResponse('/reviews/by-book', '/books/by-ids')).toBe(true);
  });

  it('data equals the no-prefetch oracles (NAIVE and the book(id) spelling): 2 reviews for a1-b1', async () => {
    const b = await gql(gwB, Q);
    const n = await gql(gwN, Q);
    const one = await gql(gwB, '{ book(id:"a1-b1"){ reviews{ id } } }');
    expect(n.errors).toBeUndefined();
    expect(b.data).toEqual(n.data);
    expect(b.data).toEqual({ books: [one.data!.book] });
    const books = b.data!.books as Array<{ reviews: Array<{ id: string }> }>;
    expect(books).toHaveLength(1);
    expect(books[0]!.reviews).toHaveLength(2);
  });
});

// ---------- EB2 ----------
describe('EB2 - three ids, one reviews batch', () => {
  const Q = '{ books(ids:["a1-b1","a2-b1","a3-b1"]){ id reviews{ id rating } } }';
  const IDS = ['a1-b1', 'a2-b1', 'a3-b1'];

  it('2 calls; the single /reviews/by-book carries exactly the 3 ids and arrives before the books response', async () => {
    const b = await gql(gwB, Q);
    expect(b.errors).toBeUndefined();
    expectCalls(b, 2);
    const rv = reqsTo('/reviews/by-book');
    expect(rv).toHaveLength(1);
    expect(sorted(rv[0]!.ids)).toEqual(sorted(IDS));
    expect(reqsTo('/books/by-ids')).toHaveLength(1);
    expect(childBeforeParentResponse('/reviews/by-book', '/books/by-ids')).toBe(true);
  });

  it('data.books ids are in input order and equal the NAIVE oracle', async () => {
    const b = await gql(gwB, Q);
    const n = await gql(gwN, Q);
    expect((b.data!.books as Array<{ id: string }>).map((x) => x.id)).toEqual(IDS);
    expect(b.data).toEqual(n.data);
  });
});

// ---------- EB3 ----------
describe('EB3 - the prefetch follows the spelling', () => {
  it('ids from a variable: 2 calls, reviews before the books response', async () => {
    const b = await gql(gwB, 'query($ids:[ID!]!){ books(ids:$ids){ reviews{ id } } }', { ids: ['a1-b1'] });
    expect(b.errors).toBeUndefined();
    expectCalls(b, 2);
    expect(childBeforeParentResponse('/reviews/by-book', '/books/by-ids')).toBe(true);
    const lit = await gql(gwB, '{ books(ids:["a1-b1"]){ reviews{ id } } }');
    expect(b.data).toEqual(lit.data);
  });

  it('reviews selected through a named fragment: 2 calls, reviews before the books response', async () => {
    const b = await gql(gwB, '{ books(ids:["a1-b1"]){ ...R } } fragment R on Book { reviews{ id } }');
    expect(b.errors).toBeUndefined();
    expectCalls(b, 2);
    expect(childBeforeParentResponse('/reviews/by-book', '/books/by-ids')).toBe(true);
  });

  it('duplicate ids: 2 calls, /reviews/by-book carries a1-b1 once, both items share the same reviews', async () => {
    const b = await gql(gwB, '{ books(ids:["a1-b1","a1-b1"]){ id reviews{ id } } }');
    expect(b.errors).toBeUndefined();
    expectCalls(b, 2);
    const rv = reqsTo('/reviews/by-book');
    expect(rv).toHaveLength(1);
    expect(rv[0]!.ids).toEqual(['a1-b1']);
    expect(childBeforeParentResponse('/reviews/by-book', '/books/by-ids')).toBe(true);
    const books = b.data!.books as Array<{ id: string; reviews: Array<{ id: string }> }>;
    expect(books).toHaveLength(2);
    expect(books[0]!.id).toBe('a1-b1');
    expect(books[1]).toEqual(books[0]);
    expect(books[0]!.reviews.length).toBeGreaterThan(0);
  });
});

// ---------- EB4 ----------
describe('EB4 - author{ books } under a bulk root', () => {
  const Q = '{ books(ids:["a1-b1","a2-b1","a3-b1"]){ author{ books{ id } } } }';

  it('3 calls; /books/by-author arrives before the /authors/by-ids response (2 serial hops, not 3)', async () => {
    const b = await gql(gwB, Q);
    expect(b.errors).toBeUndefined();
    expectCalls(b, 3);
    expect(routes()).toEqual(['/authors/by-ids', '/books/by-author', '/books/by-ids']);
    expect(childBeforeParentResponse('/books/by-author', '/authors/by-ids')).toBe(true);
  });

  it('data equals the NAIVE oracle', async () => {
    const b = await gql(gwB, Q);
    const n = await gql(gwN, Q);
    expect(n.errors).toBeUndefined();
    expect(b.data).toEqual(n.data);
  });
});

// ---------- EB5 ----------
describe('EB5 - a bulk root no longer disables a sibling prefetch', () => {
  const Q = '{ books(ids:["a1-b1"]){ id } author(id:"a1"){ books{ id } } }';

  it('3 calls; /books/by-author arrives before the /authors/by-ids response', async () => {
    const b = await gql(gwB, Q);
    expect(b.errors).toBeUndefined();
    expectCalls(b, 3);
    expect(routes()).toEqual(['/authors/by-ids', '/books/by-author', '/books/by-ids']);
    expect(childBeforeParentResponse('/books/by-author', '/authors/by-ids')).toBe(true);
    const n = await gql(gwN, Q);
    expect(b.data).toEqual(n.data);
  });
});

// ---------- EB6 ----------
describe('EB6 - mixing never splits a batch (iter-83 MIX)', () => {
  const MIX = '{ one: book(id:"a3-b1"){ id reviews{ id } } books(ids:["a1-b1","a2-b2"]){ id reviews{ id } } }';
  const THREE = sorted(['a3-b1', 'a1-b1', 'a2-b2']);

  it('exactly 2 calls, each carrying all 3 book ids; reviews before the books response', async () => {
    const b = await gql(gwB, MIX);
    expect(b.errors).toBeUndefined();
    expectCalls(b, 2);
    const bk = reqsTo('/books/by-ids');
    const rv = reqsTo('/reviews/by-book');
    expect(bk).toHaveLength(1);
    expect(rv).toHaveLength(1);
    expect(sorted(bk[0]!.ids)).toEqual(THREE);
    expect(sorted(rv[0]!.ids)).toEqual(THREE);
    expect(childBeforeParentResponse('/reviews/by-book', '/books/by-ids')).toBe(true);
    const n = await gql(gwN, MIX);
    expect(b.data).toEqual(n.data);
  });
});

// ---------- EB7 ----------
describe('EB7 - the gate stays off where it must', () => {
  it('(a) a list sibling that reaches the loaders: 5 calls, reviews NOT requested before the books response', async () => {
    const Q = '{ books(ids:["a1-b1"]){ reviews{ id } } authors(first:2){ edges{ node{ books{ reviews{ id } } } } } }';
    const b = await gql(gwB, Q);
    expect(b.errors).toBeUndefined();
    expectCalls(b, 5);
    expect(childBeforeParentResponse('/reviews/by-book', '/books/by-ids')).toBe(false);
    const n = await gql(gwN, Q);
    expect(b.data).toEqual(n.data);
  });

  it('(b) reviews excluded by @skip(if:true): exactly 1 call, no reviews request', async () => {
    const b = await gql(gwB, 'query($s:Boolean!){ books(ids:["a1-b1"]){ id reviews @skip(if:$s){ id } } }', { s: true });
    expect(b.errors).toBeUndefined();
    expectCalls(b, 1);
    expect(reqsTo('/reviews/by-book')).toHaveLength(0);
    expect(b.data).toEqual({ books: [{ id: 'a1-b1' }] });
  });

  it('(b) control: @skip(if:false) selects reviews and prefetches (2 calls)', async () => {
    const b = await gql(gwB, 'query($s:Boolean!){ books(ids:["a1-b1"]){ id reviews @skip(if:$s){ id } } }', { s: false });
    expect(b.errors).toBeUndefined();
    expectCalls(b, 2);
    expect(childBeforeParentResponse('/reviews/by-book', '/books/by-ids')).toBe(true);
  });

  it('(c) NAIVE: 4 calls, reviews NOT requested before the books response', async () => {
    const b = await gql(gwN, '{ books(ids:["a1-b1","a2-b1"]){ reviews{ id } } }');
    expect(b.errors).toBeUndefined();
    expectCalls(b, 4);
    expect(childBeforeParentResponse('/reviews/by-book', '/books/by-ids')).toBe(false);
  });

  it('(d) a count-only list sibling keeps the prefetch: 3 calls, reviews before the books response', async () => {
    const Q = '{ books(ids:["a1-b1"]){ reviews{ id } } authors(first:2){ totalCount } }';
    const b = await gql(gwB, Q);
    expect(b.errors).toBeUndefined();
    expectCalls(b, 3);
    expect(childBeforeParentResponse('/reviews/by-book', '/books/by-ids')).toBe(true);
    const n = await gql(gwN, Q);
    expect(b.data).toEqual(n.data);
  });
});

// ---------- EB8 ----------
describe('EB8 - refusals stay free', () => {
  it('101 ids with reviews selected: BAD_ARGUMENT, data null, 0 calls', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `a1-b${(i % 3) + 1}`);
    const b = await gql(gwB, 'query($ids:[ID!]!){ books(ids:$ids){ reviews{ id } } }', { ids });
    expect(b.data).toBeNull();
    expect(b.errors?.map((e) => e.extensions?.code)).toContain('BAD_ARGUMENT');
    expectCalls(b, 0);
  });

  it('["a,b"] with reviews selected: one NOT_FOUND, 0 calls', async () => {
    const b = await gql(gwB, '{ books(ids:["a,b"]){ reviews{ id } } }');
    expect(b.errors).toHaveLength(1);
    expect(b.errors![0]!.extensions?.code).toBe('NOT_FOUND');
    expect(b.data).toEqual({ books: [null] });
    expectCalls(b, 0);
  });

  it('[] with reviews selected: { books: [] }, 0 calls', async () => {
    const b = await gql(gwB, '{ books(ids:[]){ reviews{ id } } }');
    expect(b.errors).toBeUndefined();
    expect(b.data).toEqual({ books: [] });
    expectCalls(b, 0);
  });
});

// ---------- EB9 ----------
describe('EB9 - the documented cost of an all-missing list', () => {
  it('["nope"]: exactly 2 calls, { books: [null] }, one NOT_FOUND at path ["books", 0]', async () => {
    const b = await gql(gwB, '{ books(ids:["nope"]){ reviews{ id } } }');
    expectCalls(b, 2);
    expect(routes()).toEqual(['/books/by-ids', '/reviews/by-book']);
    expect(b.data).toEqual({ books: [null] });
    expect(b.errors).toHaveLength(1);
    expect(b.errors![0]!.extensions?.code).toBe('NOT_FOUND');
    expect(b.errors![0]!.path).toEqual(['books', 0]);
  });

  it('["a1-b1","nope"]: stays at 2 calls; a1-b1 row with its reviews, null at index 1', async () => {
    const b = await gql(gwB, '{ books(ids:["a1-b1","nope"]){ id reviews{ id } } }');
    expectCalls(b, 2);
    const books = b.data!.books as Array<{ id: string; reviews: Array<{ id: string }> } | null>;
    expect(books).toHaveLength(2);
    expect(books[0]!.id).toBe('a1-b1');
    expect(books[0]!.reviews).toHaveLength(2);
    expect(books[1]).toBeNull();
    expect(b.errors).toHaveLength(1);
    expect(b.errors![0]!.extensions?.code).toBe('NOT_FOUND');
    expect(b.errors![0]!.path).toEqual(['books', 1]);
  });
});

// ---------- EB10 ----------
function gitAt(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** The iter-87 commit once it exists; null before commit (then the working tree vs HEAD is checked). */
function iter87Commit(): string | null {
  const out = gitAt(['log', '--format=%H', '-1', '--grep=foundry iter 87)']);
  return out && out.trim() ? out.trim() : null;
}

function lookaheadParagraph(): string {
  const para = README.split(/\n\s*\n/).find((p) => p.includes('**Lookahead prefetch on by-id roots.**'));
  expect(para).toBeDefined();
  return para!;
}

function section(n: number): string {
  const start = README.search(new RegExp(`^##\\s*${n}\\b`, 'm'));
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = README.slice(start + 3);
  const end = rest.search(/^##\s*\d+\b/m);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('EB10 - docs and nothing else moves', () => {
  // Spec ambiguity: EB10 says "README §7", but the paragraph lives in §6 (Architecture);
  // the most reasonable reading is "the paragraph headed **Lookahead prefetch on by-id roots.**".
  it('the lookahead paragraph exists exactly once in the README', () => {
    expect(README.split('**Lookahead prefetch on by-id roots.**')).toHaveLength(2);
  });

  it('no sentence says a books(ids:)/bulk root turns the prefetch off', () => {
    const sentences = lookaheadParagraph().split(/(?<=\.)\s+(?=[A-Z`*])/);
    for (const s of sentences) {
      if (/books\(ids|bulk/i.test(s)) {
        expect(s).not.toMatch(/turns? (the prefetch|it) off|disables? (the prefetch|it)/i);
      }
    }
  });

  it('says a books(ids:) root prefetches reviews and author{ books } for every id, with a 1-instead-of-2 example', () => {
    const p = lookaheadParagraph();
    const s = p.split(/(?<=\.)\s+(?=[A-Z`*])/).find((x) => /`books\(ids:\)`[^.]*prefetches/.test(x));
    expect(s).toBeDefined();
    expect(s!).toContain('reviews');
    expect(s!).toContain('author{ books }');
    expect(s!).toMatch(/every id in `ids`/);
    expect(s!).toMatch(/`books\(ids:\[[^`]*\]\)\{ reviews\{\.\.\.\} \}`/);
    expect(s!).toMatch(/1 serial round trip instead of 2/);
  });

  it('the 1-instead-of-2 README example holds live: 2 calls, reviews before the books response', async () => {
    const s = lookaheadParagraph()
      .split(/(?<=\.)\s+(?=[A-Z`*])/)
      .find((x) => /`books\(ids:\)`[^.]*prefetches/.test(x))!;
    const ex = /`(books\(ids:\[[^`]*\]\))\{ reviews\{\.\.\.\} \}`/.exec(s);
    expect(ex).not.toBeNull();
    const b = await gql(gwB, `{ ${ex![1]}{ reviews{ id } } }`);
    expect(b.errors).toBeUndefined();
    expectCalls(b, 2);
    expect(childBeforeParentResponse('/reviews/by-book', '/books/by-ids')).toBe(true);
  });

  it('states the all-missing cost verbatim', () => {
    expect(lookaheadParagraph()).toContain(
      '`books(ids:["nope"]){ reviews{...} }` makes 2 downstream calls instead of 1',
    );
  });

  it('README §8 has a bullet naming test_iter87_behavior.test.ts', () => {
    const bullet = section(8)
      .split('\n')
      .find((l) => /^\s*-\s/.test(l) && l.includes('test_iter87_behavior.test.ts'));
    expect(bullet).toBeDefined();
    expect(bullet!).toContain('books(ids:)');
  });

  it('test/n-plus-1.test.ts is byte-identical to its pre-iteration version', () => {
    const c = iter87Commit();
    const now = readFileSync(path.join(REPO, 'test', 'n-plus-1.test.ts'), 'utf8');
    expect(now).toMatch(/\b3\b/);
    expect(now).toMatch(/\b21\b/);
    const before = gitAt(['show', `${c ? `${c}~1` : 'HEAD'}:test/n-plus-1.test.ts`]);
    if (before === null) {
      // outside a git checkout: nothing to compare against
      expect(now.length).toBeGreaterThan(0);
      return;
    }
    const after = c ? gitAt(['show', `${c}:test/n-plus-1.test.ts`]) : now;
    expect(after).toBe(before);
  });

  it('among existing test files only the documented re-pins (test_iter70, test_iter83) are modified', () => {
    const c = iter87Commit();
    const out = c
      ? gitAt(['diff', '--name-only', '--diff-filter=a', `${c}~1`, c, '--', 'test/'])
      : gitAt(['diff', '--name-only', '--diff-filter=a', 'HEAD', '--', 'test/']);
    if (out === null) {
      expect(readFileSync(path.join(REPO, 'test', 'n-plus-1.test.ts'), 'utf8').length).toBeGreaterThan(0);
      return;
    }
    const allowed = ['test/test_iter70_behavior.test.ts', 'test/test_iter83_behavior.test.ts'];
    const changed = out.split('\n').filter(Boolean);
    expect(changed.filter((f) => !allowed.includes(f))).toEqual([]);
  });
});
