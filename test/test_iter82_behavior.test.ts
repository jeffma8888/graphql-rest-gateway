import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, buildBackend } from '../src/lib';

/**
 * iter-82 (row 79): the docs stop calling the cost model "a conservative upper
 * bound" and state the true rule: the estimate bounds the work only when every
 * list field carries `first`/`last`. The two measured counter-examples are
 * pinned as behaviour: a root `authors` with no bound is priced as one row
 * although the page fetches up to 10, and a nested `books` with no `first` is
 * priced at the default fan-out of 5 but returns the whole list.
 * Black-box: the bundled backend runs in-process on port 0, a local stub in
 * front of it serves 150 books per author, and gateways are driven through
 * createGateway(...).fetch. No network beyond 127.0.0.1.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const README = readFileSync(resolve(root, 'README.md'), 'utf8');
const COMPLEXITY_PATH = 'src/gateway/security/complexity.ts';
const COMPLEXITY = readFileSync(resolve(root, COMPLEXITY_PATH), 'utf8');
/** The iter-82 commit; its own diff is what EB4/EB8 pin (see the re-pin notes there). */
const ITER82 = 'e0d824f89760e3b05f13046c48e99b1c4f80145b';

/** `git <args>` output, or null when not a git checkout or the commit is absent (shallow clone). */
function gitAt(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

type Gateway = ReturnType<typeof createGateway>;
type GqlError = { message: string; extensions?: Record<string, unknown> };
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
  extensions?: {
    code?: string;
    downstreamCalls?: { total: number };
    queryComplexity?: { cost: number; depth: number };
  };
};
type Ided = { id: string };
type AuthorNode = { id: string; books?: Ided[] };

const PER_AUTHOR = 150;

let app: FastifyInstance;
let base: string;
let stub: FastifyInstance;
let stubBase: string;
let gw: Gateway; // bundled backend
let viaStub: Gateway; // 150-books stub
let capped: Gateway; // 150-books stub, maxComplexity: 100
const stubHits: string[] = [];

async function post(g: Gateway, query: string): Promise<{ status: number; body: GqlResult }> {
  const res = await g.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { status: res.status, body: (await res.json()) as GqlResult };
}

/** Serialised: one request at a time, stub hits recorded for that request only. */
let chain: Promise<unknown> = Promise.resolve();
function measured(g: Gateway, query: string): Promise<{ status: number; body: GqlResult; hits: string[] }> {
  const run = async (): Promise<{ status: number; body: GqlResult; hits: string[] }> => {
    stubHits.length = 0;
    const r = await post(g, query);
    await new Promise((res) => setTimeout(res, 20)); // let any orphaned call land
    return { ...r, hits: [...stubHits] };
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}

function bookRows(data: Record<string, unknown> | null | undefined): number {
  if (!data) return -1;
  if (data.author) return ((data.author as AuthorNode).books ?? []).length;
  const edges = (data.authors as { edges: Array<{ node: AuthorNode }> }).edges;
  return edges.reduce((n, e) => n + (e.node.books ?? []).length, 0);
}

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  base = await app.listen({ port: 0, host: '127.0.0.1' });

  stub = Fastify();
  stub.get('/*', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    stubHits.push(path);
    if (path === '/books/by-author') {
      const ids = String((req.query as Record<string, unknown>).authorIds ?? '')
        .split(',')
        .filter(Boolean);
      return ids.flatMap((a) =>
        Array.from({ length: PER_AUTHOR }, (_, i) => ({ id: `${a}-w${i + 1}`, authorId: a, title: `T-${a}-${i}`, year: 2000 })),
      );
    }
    const r = await fetch(base + req.url);
    reply.code(r.status);
    return r.json();
  });
  stubBase = await stub.listen({ port: 0, host: '127.0.0.1' });

  gw = createGateway({ restBaseUrl: base });
  viaStub = createGateway({ restBaseUrl: stubBase });
  capped = createGateway({ restBaseUrl: stubBase, maxComplexity: 100 });
}, 30_000);

afterAll(async () => {
  await stub.close();
  await app.close();
});

/** First line of the README paragraph holding the marker, starting at the marker. */
function lineFrom(marker: string): string {
  const i = README.indexOf(marker);
  expect(i).toBeGreaterThanOrEqual(0);
  return README.slice(i).split('\n')[0]!;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

// ---------- EB1 ----------
describe('EB1 - the phrase "conservative upper bound" is gone', () => {
  it('README.md has 0 case-insensitive occurrences', () => {
    expect(README.match(/conservative upper bound/gi) ?? []).toHaveLength(0);
  });
  it('src/gateway/security/complexity.ts has 0 case-insensitive occurrences', () => {
    expect(COMPLEXITY.match(/conservative upper bound/gi) ?? []).toHaveLength(0);
  });
});

// ---------- EB2 ----------
describe('EB2 - README §7 Complexity/cost bullet states the rule', () => {
  const line = lineFrom('**Complexity/cost limit**');
  it('(a) says upper bound only when every list carries `first`/`last`', () => {
    expect(line).toMatch(/upper bound only when/i);
    expect(line).toContain('`first`/`last`');
  });
  it('(b) names the nested case with the default fan-out 5', () => {
    expect(line.includes('`books`') || line.includes('`reviews`')).toBe(true);
    expect(line).toMatch(/\b5\b/);
  });
  it('(c) names the root case with the implicit page size 10', () => {
    expect(line).toContain('`authors`');
    expect(line).toMatch(/\b10\b/);
  });
  it('(d) iter-79 pins survive: clamp 0..100, 3301, cost the same 301', () => {
    expect(line).toMatch(/`first`\/`last`[^.]*clamped to 0\.\.100/);
    expect(line).toContain('3301');
    expect(line).toContain('cost the same 301');
  });
  it('(e) no longer says "exactly what you want for admission control"', () => {
    expect(line).not.toContain('exactly what you want for admission control');
  });
});

// ---------- EB3 ----------
describe('EB3 - README §9 decision bullet', () => {
  const marker = '**Custom depth/complexity rules (over a library).**';
  const line = README.split('\n').find((l) => l.includes(marker));
  it('exists, has no "conservative upper bound", says estimate, names `first`/`last`', () => {
    expect(line).toBeDefined();
    expect(line!).not.toMatch(/conservative upper bound/i);
    expect(line!).toMatch(/estimate/i);
    expect(line!).toContain('`first`/`last`');
  });
});

// ---------- EB4 ----------
describe('EB4 - complexity rule doc comment', () => {
  const block = (COMPLEXITY.match(/\/\*\*[\s\S]*?\*\//g) ?? []).find((b) =>
    /Query complexity \(cost\) validation rule\./.test(b),
  );
  it('the leading /** ... */ block of the rule exists', () => {
    expect(block).toBeDefined();
  });
  it('says the estimate is an upper bound only conditionally and names defaultListSize', () => {
    expect(block!).toMatch(/not an upper bound|only an upper bound|upper bound only/i);
    expect(block!).toContain('defaultListSize');
  });
  it('iter-79 pins hold: comments mention clamp and MAX_PAGE_SIZE or 0..100', () => {
    const comments = (COMPLEXITY.match(/\/\*[\s\S]*?\*\/|\/\/.*$/gm) ?? []).join('\n');
    expect(comments).toMatch(/clamp/i);
    expect(comments).toMatch(/0\.\.100|MAX_PAGE_SIZE/);
  });
  it('no non-comment line of the complexity rule uses a literal 100', () => {
    expect(stripComments(COMPLEXITY)).not.toMatch(/\b100\b/);
  });
  // Re-pinned 2026-11-10 (iter-83): this compared the WORKING TREE to HEAD, so
  // any later code change to complexity.ts (iter-83's `books(ids:)` list-length
  // pricing) turned it red. It now pins what it was written to prove -- the
  // iter-82 commit itself changed only comments in this file -- by comparing
  // that commit to its parent, which no later iteration can disturb.
  it('non-comment code is unchanged by the iter-82 commit versus its parent', () => {
    const after = gitAt(['show', `${ITER82}:${COMPLEXITY_PATH}`]);
    const before = gitAt(['show', `${ITER82}~1:${COMPLEXITY_PATH}`]);
    const norm = (s: string): string => stripComments(s).replace(/\s+/g, '');
    if (after !== null && before !== null) expect(norm(after)).toBe(norm(before));
  });
});

// ---------- EB5 ----------
describe('EB5 - root counter-example on the bundled backend (no stub)', () => {
  it('unbounded authors is priced 4, returns 5 nodes in 1 call; first: 10 is priced 31 for deep-equal data', async () => {
    const a = await post(gw, '{ authors{ edges{ node{ id } } } }');
    expect(a.status).toBe(200);
    expect(a.body.errors).toBeUndefined();
    expect(a.body.extensions?.queryComplexity?.cost).toBe(4);
    expect(a.body.extensions?.downstreamCalls?.total).toBe(1);
    const nodes = (a.body.data?.authors as { edges: Array<{ node: Ided }> }).edges;
    expect(nodes).toHaveLength(5);

    const b = await post(gw, '{ authors(first: 10){ edges{ node{ id } } } }');
    expect(b.status).toBe(200);
    expect(b.body.errors).toBeUndefined();
    expect(b.body.extensions?.queryComplexity?.cost).toBe(31);
    expect(b.body.data).toEqual(a.body.data);
  });
});

// ---------- EB6 ----------
describe('EB6 - nested counter-example on the 150-books stub', () => {
  it.each([
    ['{ author(id:"a1"){ id books{ id } } }', 8, 150],
    ['{ author(id:"a1"){ id books(first: 100){ id } } }', 103, 100],
    ['{ authors(first: 5){ edges{ node{ id books{ id } } } } }', 46, 750],
    ['{ authors(first: 5){ edges{ node{ id books(first: 100){ id } } } } }', 521, 500],
  ])('%s -> cost %i, %i book rows, 2 calls, 1 /books/by-author hit', async (query, cost, rows) => {
    const r = await measured(viaStub, query);
    expect(r.status).toBe(200);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.extensions?.queryComplexity?.cost).toBe(cost);
    expect(bookRows(r.body.data)).toBe(rows);
    expect(r.body.extensions?.downstreamCalls?.total).toBe(2);
    expect(r.hits.filter((p) => p === '/books/by-author')).toHaveLength(1);
    expect(r.hits).toHaveLength(2);
  });
  it('the stub really serves `<authorId>-w<i>` ids (rows are the stub, not the bundled data)', async () => {
    const r = await measured(viaStub, '{ author(id:"a1"){ id books{ id } } }');
    const ids = ((r.body.data?.author as AuthorNode).books ?? []).map((b) => b.id);
    expect(ids[0]).toBe('a1-w1');
    expect(ids[PER_AUTHOR - 1]).toBe(`a1-w${PER_AUTHOR}`);
  });
});

// ---------- EB7 ----------
describe('EB7 - admission consequence with maxComplexity: 100', () => {
  it('the unbounded nested books is ADMITTED with 150 rows', async () => {
    const r = await measured(capped, '{ author(id:"a1"){ id books{ id } } }');
    expect(r.status).toBe(200);
    expect(r.body.errors).toBeUndefined();
    expect(bookRows(r.body.data)).toBe(150);
  });
  it('books(first: 100) is REFUSED QUERY_TOO_COMPLEX with 0 downstream calls', async () => {
    const r = await measured(capped, '{ author(id:"a1"){ id books(first: 100){ id } } }');
    expect(r.body.errors?.length ?? 0).toBeGreaterThan(0);
    expect(r.body.errors![0]!.extensions?.code).toBe('QUERY_TOO_COMPLEX');
    expect(r.body.data ?? null).toBeNull();
    expect(r.hits).toHaveLength(0);
  });
});

// ---------- prose == oracle: the README's printed spellings ----------
describe('README §7 printed figures match runtime (same spelling as printed)', () => {
  const line = lineFrom('**Complexity/cost limit**');
  it.each([
    ['`author(id: "a1") { books { id } }`', '{ author(id: "a1") { books { id } } }', 7, 150, true],
    ['`books(first: 100)`', '{ author(id: "a1") { books(first: 100) { id } } }', 102, 100, true],
    ['`authors { edges { node { id } } }`', '{ authors { edges { node { id } } } }', 4, -1, false],
    ['`authors(first: 10) { edges { node { id } } }`', '{ authors(first: 10) { edges { node { id } } } }', 31, -1, false],
  ] as const)('README prints %s; the gateway prices %s at the printed cost %i', async (printed, query, cost, rows, stubbed) => {
    expect(line).toContain(`${printed} costs ${cost}`);
    const r = await measured(stubbed ? viaStub : gw, query);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.extensions?.queryComplexity?.cost).toBe(cost);
    if (rows >= 0) expect(bookRows(r.body.data)).toBe(rows);
  });
});

// ---------- EB8 ----------
describe('EB8 - nothing else moves', () => {
  // Re-pinned 2026-11-10 (iter-83), same reason as EB4: a working-tree-vs-HEAD
  // check reds as soon as a later iteration re-pins its EB4. The iter-82 commit
  // is checked instead: versus its parent it only ADDED its own test file.
  it('the iter-82 commit modified, renamed or deleted no tracked file under test/', () => {
    const out = gitAt(['diff', '--name-only', '--diff-filter=a', `${ITER82}~1`, ITER82, '--', 'test/']);
    if (out !== null) expect(out.trim()).toBe('');
  });
  it('test/n-plus-1.test.ts is byte-identical to HEAD', () => {
    const committed = execFileSync('git', ['show', 'HEAD:test/n-plus-1.test.ts'], { cwd: root, encoding: 'utf8' });
    expect(readFileSync(resolve(root, 'test/n-plus-1.test.ts'), 'utf8')).toBe(committed);
  });
});
