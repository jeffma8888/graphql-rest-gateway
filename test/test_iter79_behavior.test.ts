import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, buildBackend, NAIVE } from '../src/lib';
import { BENCHMARK_QUERY } from '../benchmark/benchmark';

/**
 * iter-79: admission pricing clamps `first`/`last` to 0..100 (row 74), the
 * same clamp the list resolvers apply, so a query is never refused for rows
 * the gateway would never fetch.
 * Black-box: the bundled backend runs in-process on port 0 and the gateway is
 * driven through createGateway(...).fetch. Every admitted query asserts
 * extensions.downstreamCalls.total and cross-checks it against the backend's
 * own /__stats counter. Refused queries assert 0 backend requests.
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
type Ided = { id: string };

const AUTHORS = ['a1', 'a2', 'a3', 'a4', 'a5'];
const authorsQ = (arg: string): string => `{ authors(${arg}) { edges { node { id } } } }`;
const AUTHORS_VAR = 'query($n: Int) { authors(first: $n) { edges { node { id } } } }';
const BOOKS_VAR = 'query($n: Int) { author(id: "a1") { books(first: $n) { id } } }';
const nestedQ = (n: number): string =>
  `{ authors(first: 5) { edges { node { id books(first: ${n}) { id } } } } }`;
const WIDE_5000 = '{ authors(first: 5000) { edges { node { id books { id reviews { id } } } } } }';
const WIDE_10000 = '{ authors(first: 10000) { edges { node { id books { id reviews { id } } } } } }';
const WIDE_9999 = '{ authors(first: 9999) { edges { node { books { reviews { id } } } } } }';
const BENCH_FIRST1 =
  '{ authors(first: 5) { edges { node { id books(first: 1) { id title reviews(first: 1) { id rating } } } } } }';

let app: FastifyInstance;
let base: string;
let gw: Gateway;
let naive: Gateway;

async function post(g: Gateway, payload: unknown): Promise<{ status: number; body: GqlResult }> {
  const res = await g.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as GqlResult };
}

async function resetStats(): Promise<void> {
  const r = await fetch(`${base}/__stats/reset`, { method: 'POST' });
  expect(r.ok).toBe(true);
}
async function readStats(): Promise<Stats> {
  return (await (await fetch(`${base}/__stats`)).json()) as Stats;
}

/** Serialised measurement: one request, backend counter read before and after. */
let chain: Promise<unknown> = Promise.resolve();
function measured(
  query: string,
  variables?: Record<string, unknown>,
  g: Gateway = gw,
): Promise<{ status: number; body: GqlResult; stats: Stats }> {
  const run = async (): Promise<{ status: number; body: GqlResult; stats: Stats }> => {
    await resetStats();
    const r = await post(g, variables ? { query, variables } : { query });
    await new Promise((res) => setTimeout(res, 20)); // let any orphaned call land
    const stats = await readStats();
    return { ...r, stats };
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}

/** Admitted query: no errors, a cost, and extensions total == backend counter. */
async function admitted(
  query: string,
  variables?: Record<string, unknown>,
  g: Gateway = gw,
): Promise<{ body: GqlResult; cost: number; calls: number; data: Record<string, unknown> }> {
  const { status, body, stats } = await measured(query, variables, g);
  expect(status).toBe(200);
  expect(body.errors).toBeUndefined();
  const calls = body.extensions?.downstreamCalls?.total;
  expect(calls).toBe(stats.total);
  const cost = body.extensions?.queryComplexity?.cost;
  expect(typeof cost).toBe('number');
  return { body, cost: cost as number, calls: calls as number, data: body.data as Record<string, unknown> };
}

const edgeIds = (data: Record<string, unknown>): string[] =>
  ((data.authors as { edges: Array<{ node: Ided }> }).edges ?? []).map((e) => e.node.id);
const ids = (xs: unknown): string[] => (xs as Ided[]).map((x) => x.id);

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  gw = createGateway({ restBaseUrl: base });
  naive = createGateway({ restBaseUrl: base, loaderOptions: NAIVE });
});

afterAll(async () => {
  await app.close();
});

describe('iter-79 EB1: authors(first) above 100 prices as 100', () => {
  for (const n of [100, 101, 1000]) {
    it(`authors(first: ${n}) succeeds with cost 301, 1 downstream call, a1..a5`, async () => {
      const r = await admitted(authorsQ(`first: ${n}`));
      expect(r.cost).toBe(301);
      expect(r.calls).toBe(1);
      expect(edgeIds(r.data)).toEqual(AUTHORS);
    });
  }
});

describe('iter-79 EB2: last is clamped like first', () => {
  it('authors(last: 1000) succeeds with cost 301 and the same 5 authors', async () => {
    const r = await admitted(authorsQ('last: 1000'));
    expect(r.cost).toBe(301);
    expect(edgeIds(r.data)).toEqual(AUTHORS);
    expect(r.calls).toBeGreaterThanOrEqual(1);
    const ref = await admitted(authorsQ('last: 100'));
    expect(r.cost).toBe(ref.cost);
    expect(r.calls).toBe(ref.calls);
    expect(edgeIds(ref.data)).toEqual(AUTHORS);
  });
});

describe('iter-79 EB3: nested books(first: 1000) is admitted under defaults', () => {
  it('cost 102, same books and same 2 calls as books with no argument', async () => {
    const big = await admitted('{ author(id: "a1") { books(first: 1000) { id } } }');
    const plain = await admitted('{ author(id: "a1") { books { id } } }');
    expect(big.cost).toBe(102);
    const bigBooks = ids((big.data.author as { books: Ided[] }).books);
    const plainBooks = ids((plain.data.author as { books: Ided[] }).books);
    expect(bigBooks).toEqual(plainBooks);
    expect(bigBooks.length).toBeGreaterThan(0);
    expect(bigBooks.every((id) => id.startsWith('a1-'))).toBe(true);
    expect(big.calls).toBe(2);
    expect(plain.calls).toBe(2);
  });
});

describe('iter-79 EB4: nested reviews(first: 100000)', () => {
  it('cost 102, equal to reviews(first: 100), same reviews as no argument', async () => {
    const big = await admitted('{ book(id: "a1-b1") { reviews(first: 100000) { id } } }');
    const hundred = await admitted('{ book(id: "a1-b1") { reviews(first: 100) { id } } }');
    const plain = await admitted('{ book(id: "a1-b1") { reviews { id } } }');
    expect(big.cost).toBe(102);
    expect(big.cost).toBe(hundred.cost);
    const r = (x: { data: Record<string, unknown> }): string[] => ids((x.data.book as { reviews: Ided[] }).reviews);
    expect(r(big)).toEqual(r(plain));
    expect(r(big).length).toBeGreaterThan(0);
    expect(big.calls).toBe(plain.calls);
    expect(big.calls).toBe(hundred.calls);
    expect(big.calls).toBeGreaterThanOrEqual(1);
  });
});

describe('iter-79 EB5: variables are clamped identically', () => {
  it('books(first: $n) with n=1000 costs 102, equal to the literal first: 100', async () => {
    const v = await admitted(BOOKS_VAR, { n: 1000 });
    const lit = await admitted('{ author(id: "a1") { books(first: 100) { id } } }');
    expect(v.cost).toBe(102);
    expect(v.cost).toBe(lit.cost);
    expect(v.calls).toBe(lit.calls);
    expect(v.data).toEqual(lit.data);
  });
  it('authors(first: $n) with n=1000 costs 301, equal to the literal first: 100', async () => {
    const v = await admitted(AUTHORS_VAR, { n: 1000 });
    const lit = await admitted(authorsQ('first: 100'));
    expect(v.cost).toBe(301);
    expect(v.cost).toBe(lit.cost);
    expect(v.calls).toBe(1);
    expect(edgeIds(v.data)).toEqual(AUTHORS);
  });
});

describe('iter-79 EB6: nested multipliers use the clamp', () => {
  it('authors(first:5) × books(first:500) costs 521, equal to books(first:100)', async () => {
    const big = await admitted(nestedQ(500));
    const hundred = await admitted(nestedQ(100));
    expect(big.cost).toBe(521);
    expect(big.cost).toBe(hundred.cost);
    expect(big.data).toEqual(hundred.data);
    expect(big.calls).toBe(hundred.calls);
    expect(big.calls).toBe(2);
    expect(edgeIds(big.data)).toEqual(AUTHORS);
  });
});

describe('iter-79 EB7: wide queries are still refused before any downstream call', () => {
  for (const [name, q] of [
    ['first: 5000', WIDE_5000],
    ['first: 10000', WIDE_10000],
    ['first: 9999 (books { reviews })', WIDE_9999],
  ] as const) {
    it(`${name} gets QUERY_TOO_COMPLEX, no data, 0 backend requests`, async () => {
      const { body, stats } = await measured(q);
      expect(body.data).toBeUndefined();
      expect((body.errors ?? []).map((e) => e.extensions?.code)).toEqual(['QUERY_TOO_COMPLEX']);
      expect(stats.total).toBe(0);
      expect(body.extensions?.downstreamCalls?.total ?? 0).toBe(0);
    });
  }
  it('first: 5000 refusal re-prices to 3901 with exact extensions and message', async () => {
    const { body, stats } = await measured(WIDE_5000);
    expect(stats.total).toBe(0);
    expect(body.errors).toHaveLength(1);
    const e = body.errors![0]!;
    expect(e.extensions).toEqual({ code: 'QUERY_TOO_COMPLEX', cost: 3901, maxComplexity: 1000 });
    expect(e.message).toBe('Query is too complex: cost 3901 exceeds the maximum of 1000.');
  });
  it('first: 10000 re-prices to the same 3901', async () => {
    const { body } = await measured(WIDE_10000);
    expect(body.errors?.[0]?.extensions?.cost).toBe(3901);
  });
});

describe('iter-79 EB8: the negative clamp is unchanged', () => {
  it('authors(first: -5) costs 1 with edges []', async () => {
    const r = await admitted(authorsQ('first: -5'));
    expect(r.cost).toBe(1);
    expect((r.data.authors as { edges: unknown[] }).edges).toEqual([]);
    expect(r.calls).toBeLessThanOrEqual(1);
  });
  it('alias pair with first: -1000 costs the same as with first: 0', async () => {
    const neg = await admitted('{ author(id: "a1") { a: books(first: -1000) { id } b: books(first: 2) { id } } }');
    const zero = await admitted('{ author(id: "a1") { a: books(first: 0) { id } b: books(first: 2) { id } } }');
    expect(neg.cost).toBe(zero.cost);
    expect(neg.data).toEqual(zero.data);
    expect((neg.data.author as { a: unknown[] }).a).toEqual([]);
    expect(ids((neg.data.author as { b: Ided[] }).b)).toHaveLength(2);
    expect(neg.calls).toBe(zero.calls);
    expect(neg.calls).toBe(2);
  });
});

describe('iter-79 EB9: pricing below the clamp is unchanged', () => {
  it('authors(first: n) costs 1 + 3n for every n in 0..100 (literal and variable)', async () => {
    for (const n of [0, 1, 2, 3, 50, 99, 100]) {
      const lit = await admitted(authorsQ(`first: ${n}`));
      expect(lit.cost, `literal first: ${n}`).toBe(1 + 3 * n);
      expect(lit.calls).toBeLessThanOrEqual(1);
      const v = await admitted(AUTHORS_VAR, { n });
      expect(v.cost, `variable n=${n}`).toBe(1 + 3 * n);
    }
  });
  it('authors(first: 2) costs 7 and returns a1, a2 in 1 call', async () => {
    const r = await admitted(authorsQ('first: 2'));
    expect(r.cost).toBe(7);
    expect(edgeIds(r.data)).toEqual(['a1', 'a2']);
    expect(r.calls).toBe(1);
  });
  it('books(first: 1) and reviews(first: 1) cost 3 each', async () => {
    const b = await admitted('{ author(id: "a1") { books(first: 1) { id } } }');
    expect(b.cost).toBe(3);
    expect(b.calls).toBe(2);
    const r = await admitted('{ book(id: "a1-b1") { reviews(first: 1) { id } } }');
    expect(r.cost).toBe(3);
    expect(r.calls).toBeGreaterThanOrEqual(1);
  });
  it('nested books(first: n) under authors(first: 5) costs 21 + 5n for n in 0..100', async () => {
    for (const n of [0, 1, 7, 100]) {
      const r = await admitted(nestedQ(n));
      expect(r.cost, `books(first: ${n})`).toBe(21 + 5 * n);
    }
  });
  it('the benchmark-shaped first:1/first:1 query still costs 46', async () => {
    const r = await admitted(BENCH_FIRST1);
    expect(r.cost).toBe(46);
    expect(r.calls).toBe(3);
  });
  it('omitted first/last prices exactly as at HEAD (connection 4, nested default 5)', async () => {
    // Measured at HEAD dc1322e: a connection with no first/last prices its
    // subtree once (cost 4); nested plain lists use the default fan-out of 5.
    const a = await admitted('{ authors { edges { node { id } } } }');
    expect(a.cost).toBe(4);
    expect(a.calls).toBe(1);
    const b = await admitted('{ author(id: "a1") { books { id } } }');
    expect(b.cost).toBe(7);
    const shape = await admitted('{ authors(first: 5) { edges { node { id books { id title reviews { id rating } } } } } }');
    expect(shape.cost).toBe(346);
    expect(shape.calls).toBe(3);
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('iter-79 EB10: the clamp bound is a single source', () => {
  const srcDir = resolve(root, 'src');
  const files = walk(srcDir).filter((f) => !relative(srcDir, f).startsWith('generated'));
  const text = new Map(files.map((f) => [relative(srcDir, f), readFileSync(f, 'utf8')]));

  it('exactly one exported MAX_PAGE_SIZE = 100 in src/', () => {
    const defs = [...text].filter(([, t]) => /export\s+const\s+MAX_PAGE_SIZE\b\s*(:\s*\w+\s*)?=\s*100\b/.test(t));
    expect(defs.map(([f]) => f)).toHaveLength(1);
  });

  it('the complexity rule and services.ts both use MAX_PAGE_SIZE', () => {
    expect(text.get(join('gateway', 'security', 'complexity.ts'))).toMatch(/\bMAX_PAGE_SIZE\b/);
    expect(text.get(join('gateway', 'services.ts'))).toMatch(/\bMAX_PAGE_SIZE\b/);
  });

  it('no second literal 100 is used as a clamp in src/ (excluding src/generated)', () => {
    const hits: string[] = [];
    for (const [f, t] of text) {
      t.split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/^\s*(\*|\/\*)/.test(code)) return;
        if (/export\s+const\s+MAX_PAGE_SIZE\b/.test(code)) return;
        if (/\b100\b/.test(code) && /Math\.(min|max)|clamp/i.test(code)) hits.push(`${f}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('introspection: only authors(first,last), Author.books(first), Book.reviews(first) take first/last', async () => {
    const { status, body } = await post(gw, {
      query: '{ __schema { types { name kind fields { name args { name } } } } }',
    });
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const types = (body.data as { __schema: { types: Array<{ name: string; fields: Array<{ name: string; args: Ided[] | Array<{ name: string }> }> | null }> } }).__schema.types;
    const found: string[] = [];
    for (const t of types) {
      if (t.name.startsWith('__')) continue;
      for (const f of t.fields ?? []) {
        for (const a of f.args as Array<{ name: string }>) {
          if (a.name === 'first' || a.name === 'last') found.push(`${t.name}.${f.name}(${a.name})`);
        }
      }
    }
    expect(found.sort()).toEqual(
      ['Author.books(first)', 'Book.reviews(first)', 'Query.authors(first)', 'Query.authors(last)'].sort(),
    );
  });
});

describe('iter-79 EB11: the N+1 regression oracle is unchanged', () => {
  it('the benchmark query is 3 calls batched and 21 naive', async () => {
    const b = await admitted(BENCHMARK_QUERY);
    expect(b.calls).toBe(3);
    const n = await admitted(BENCHMARK_QUERY, undefined, naive);
    expect(n.calls).toBe(21);
    expect(n.data).toEqual(b.data);
  });
  it('test/n-plus-1.test.ts matches the committed HEAD copy', () => {
    const committed = execFileSync('git', ['show', 'HEAD:test/n-plus-1.test.ts'], { cwd: root, encoding: 'utf8' });
    expect(readFileSync(resolve(root, 'test/n-plus-1.test.ts'), 'utf8')).toBe(committed);
  });
});

/** Split README into blank-line paragraphs (ignoring ``` fences for headings is unnecessary here). */
const paragraphs = README.split(/\n\s*\n/);

describe('iter-79 EB12: docs are updated', () => {
  it('no README paragraph still says books(first: 1000) costs 1002 / is refused', () => {
    expect(README).not.toMatch(/1002/);
    const nested = paragraphs.filter((p) => p.includes('books(first: 1000)'));
    expect(nested.length).toBeGreaterThan(0);
    for (const p of nested) expect(p).not.toMatch(/is refused/);
  });
  it('§7 nested-list paragraph states the 0..100 clamp and the 102 cost', () => {
    const p = paragraphs.find((x) => x.includes('**Nested lists') && x.includes('books(first: 1000)'));
    expect(p).toBeDefined();
    expect(p!).toMatch(/0\.\.100 clamp/);
    expect(p!).toMatch(/books\(first: 1000\)[^.]*102/);
    expect(p!).toMatch(/books\(first: 100\)/);
  });
  it('Complexity/cost bullet says list fan-out is first/last clamped to 0..100', () => {
    const p = paragraphs.find((x) => x.includes('**Complexity/cost limit**'));
    expect(p).toBeDefined();
    const bullet = p!.slice(p!.indexOf('**Complexity/cost limit**')).split('\n')[0]!;
    expect(bullet).toMatch(/`first`\/`last`[^.]*clamped to 0\.\.100/);
  });
  it('the complexity rule code comment mentions the clamp', () => {
    const t = readFileSync(resolve(root, 'src/gateway/security/complexity.ts'), 'utf8');
    const comments = (t.match(/\/\*[\s\S]*?\*\/|\/\/.*$/gm) ?? []).join('\n');
    expect(comments).toMatch(/clamp/i);
    expect(comments).toMatch(/0\.\.100|MAX_PAGE_SIZE|0\.\.MAX_PAGE_SIZE/);
  });
});
