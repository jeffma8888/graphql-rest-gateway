import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lib from '../src/lib';
import { createGateway, buildBackend } from '../src/lib';

/**
 * iter-68: one fragment-memoised cost+depth walk. Repeated-spread fragment
 * chains (2^n / 3^n expansions under the 2000-token cap) are answered or
 * refused in milliseconds, and every {cost, depth} number stays what HEAD
 * (9080f3c) reports.
 *
 * Black-box: the bundled backend runs in-process on port 0. The gateway is
 * driven through createGateway(...).fetch. "Calls" are the backend /__stats
 * delta across one gateway request. Timing bounds are the spec's 250 ms on a
 * single fetch. HEAD needs ~550 ms for CHAIN(20,2) and never finishes CHAIN(150,2).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

type Gateway = ReturnType<typeof createGateway>;
type Stats = { total: number };
type GqlError = { message: string; extensions?: Record<string, unknown> };
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
  extensions?: Record<string, unknown>;
};
type Sent = { status: number; body: GqlResult; calls: number; ms: number };

const TOO_COMPLEX = 'QUERY_TOO_COMPLEX';
const TOO_DEEP = 'QUERY_TOO_DEEP';
const BOUND_MS = 250;

let app: FastifyInstance;
let base: string;
let gw: Gateway;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * CHAIN(n, fan, leaf): `query Q { ...F0 }`, then for i = 0..n-1
 * `fragment Fi on Query { ...F(i+1) x fan }`, then `fragment Fn on Query { leaf }`.
 * A leaf using `$n` gets the header `query Q($n: Int) { ...F0 }`.
 */
function chain(n: number, fan: number, leaf: string): string {
  const header = leaf.includes('$n') ? 'query Q($n: Int) { ...F0 }' : 'query Q { ...F0 }';
  const parts = [header];
  for (let i = 0; i < n; i++) {
    parts.push(`fragment F${i} on Query { ${`...F${i + 1} `.repeat(fan)}}`);
  }
  parts.push(`fragment F${n} on Query { ${leaf} }`);
  return parts.join('\n');
}

/** Rough lexical token count (names, punctuators, `...`), used to prove docs sit under the cap. */
function tokenCount(doc: string): number {
  return (doc.match(/\.\.\.|[A-Za-z_][A-Za-z0-9_]*|-?\d+|[{}():$!=@\[\],|&]/g) ?? []).length;
}

async function resetStats(): Promise<void> {
  const r = await fetch(`${base}/__stats/reset`, { method: 'POST' });
  expect(r.ok).toBe(true);
}

async function readStats(): Promise<Stats> {
  const r = await fetch(`${base}/__stats`);
  return (await r.json()) as Stats;
}

/** One POST through the gateway; measures wall-clock of the single fetch and the downstream delta. */
async function post(g: Gateway, query: string, variables?: Record<string, unknown>): Promise<Sent> {
  await resetStats();
  const t0 = performance.now();
  const res = await g.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(variables === undefined ? { query } : { query, variables }),
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  await sleep(30);
  const stats = await readStats();
  const body = JSON.parse(text) as GqlResult;
  expect(Array.isArray(body)).toBe(false);
  expect(typeof body).toBe('object');
  expect(body).not.toBeNull();
  return { status: res.status, body, calls: stats.total, ms };
}

function codes(r: GqlResult): unknown[] {
  return (r.errors ?? []).map((e) => e.extensions?.code);
}

function complexity(r: GqlResult): unknown {
  return r.extensions?.queryComplexity;
}

/** Data has no field values: absent, null, or an object whose values are all null. */
function expectNoDataValues(r: GqlResult): void {
  if (r.data === undefined || r.data === null) return;
  expect(typeof r.data).toBe('object');
  for (const v of Object.values(r.data)) expect(v).toBeNull();
}

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  gw = createGateway({ restBaseUrl: base });
  // Warm-up so the first timed request does not pay JIT / module init cost.
  const warm = await post(gw, chain(5, 2, '__typename'));
  expect(warm.status).toBe(200);
});

afterAll(async () => {
  await app.close();
});

// ---------- EB1 ----------
describe('EB1 - large repeated-spread chain is answered fast', () => {
  const doc = chain(150, 2, '__typename');

  it('the document is under the 2000-token cap (~1512 tokens)', () => {
    const t = tokenCount(doc);
    expect(t).toBeGreaterThan(1400);
    expect(t).toBeLessThanOrEqual(2000);
  });

  it('CHAIN(150,2,__typename): 200, data {__typename:Query}, {cost:0,depth:0}, 0 calls, < 250 ms', async () => {
    const s = await post(gw, doc);
    expect(s.status).toBe(200);
    expect(s.body.errors).toBeUndefined();
    expect(s.body.data).toEqual({ __typename: 'Query' });
    expect(complexity(s.body)).toEqual({ cost: 0, depth: 0 });
    expect(s.calls).toBe(0);
    expect(s.ms).toBeLessThan(BOUND_MS);
  });

  it('a small neighbour sent right after the hostile chain is served, both within the bound', async () => {
    const send = (q: string): Promise<GqlResult> =>
      gw
        .fetch('http://gateway.local/graphql', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: q }),
        })
        .then((r) => r.json() as Promise<GqlResult>);
    const t0 = performance.now();
    const hostile = send(doc);
    await sleep(1);
    const small = send('{ author(id:"a1"){ name } }');
    const [h, sm] = await Promise.all([hostile, small]);
    const ms = performance.now() - t0;
    expect(h.data).toEqual({ __typename: 'Query' });
    expect(sm.errors).toBeUndefined();
    expect((sm.data as { author: { name: string } }).author.name).toBe('Ada Lovelace');
    expect(ms).toBeLessThan(BOUND_MS * 2);
  });
});

// ---------- EB2 ----------
describe('EB2 - 3-way fan chain is answered fast', () => {
  it('CHAIN(120,3,__typename): same results as EB1 in < 250 ms', async () => {
    const doc = chain(120, 3, '__typename');
    expect(tokenCount(doc)).toBeLessThanOrEqual(2000);
    const s = await post(gw, doc);
    expect(s.status).toBe(200);
    expect(s.body.errors).toBeUndefined();
    expect(s.body.data).toEqual({ __typename: 'Query' });
    expect(complexity(s.body)).toEqual({ cost: 0, depth: 0 });
    expect(s.calls).toBe(0);
    expect(s.ms).toBeLessThan(BOUND_MS);
  });
});

// ---------- EB3 ----------
describe('EB3 - literal-cost chain is refused fast', () => {
  it('CHAIN(150,2,authors(first:1){totalCount}): one QUERY_TOO_COMPLEX, finite cost > 1000, no data, 0 calls, < 250 ms', async () => {
    const doc = chain(150, 2, 'authors(first: 1) { totalCount }');
    expect(tokenCount(doc)).toBeLessThanOrEqual(2000);
    const s = await post(gw, doc);
    expect(s.status).toBe(200);
    expect(s.body.errors).toHaveLength(1);
    const e = s.body.errors![0]!;
    expect(e.extensions?.code).toBe(TOO_COMPLEX);
    expect(e.extensions?.cost).toBeTypeOf('number');
    const cost = e.extensions!.cost as number;
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBeGreaterThan(1000);
    expect(e.extensions?.maxComplexity).toBe(1000);
    expect(e.message).toMatch(/^Query is too complex: cost .+ exceeds the maximum of 1000\.$/);
    expect(s.body.data ?? null).toBeNull();
    expect(s.calls).toBe(0);
    expect(s.ms).toBeLessThan(BOUND_MS);
  });
});

// ---------- EB4 ----------
describe('EB4 - variable-cost chain is refused fast', () => {
  it('CHAIN(150,2,authors(first:$n){totalCount}) with {n:0}: one QUERY_TOO_COMPLEX, 0 calls, < 250 ms', async () => {
    const doc = chain(150, 2, 'authors(first: $n) { totalCount }');
    expect(tokenCount(doc)).toBeLessThanOrEqual(2000);
    const s = await post(gw, doc, { n: 0 });
    expect(s.status).toBe(200);
    expect(codes(s.body)).toEqual([TOO_COMPLEX]);
    const cost = s.body.errors![0]!.extensions?.cost;
    expect(cost).toBeTypeOf('number');
    expect(cost as number).toBeGreaterThan(1000);
    expect(s.body.data ?? null).toBeNull();
    expect(s.calls).toBe(0);
    expect(s.ms).toBeLessThan(BOUND_MS);
  });
});

// ---------- EB5 ----------
describe('EB5 - small chains keep their exact numbers', () => {
  it('CHAIN(12,2,authors(first:$n){totalCount}) with {n:1}: QUERY_TOO_COMPLEX cost exactly 8192, 0 calls', async () => {
    const s = await post(gw, chain(12, 2, 'authors(first: $n) { totalCount }'), { n: 1 });
    expect(s.status).toBe(200);
    expect(codes(s.body)).toEqual([TOO_COMPLEX]);
    expect(s.body.errors![0]!.extensions?.cost).toBe(8192);
    expect(s.body.errors![0]!.message).toBe('Query is too complex: cost 8192 exceeds the maximum of 1000.');
    expect(s.calls).toBe(0);
  });

  it('CHAIN(20,2,__typename): 200 with {cost:0,depth:0} (HEAD ~550 ms; now < 250 ms)', async () => {
    const s = await post(gw, chain(20, 2, '__typename'));
    expect(s.status).toBe(200);
    expect(s.body.errors).toBeUndefined();
    expect(s.body.data).toEqual({ __typename: 'Query' });
    expect(complexity(s.body)).toEqual({ cost: 0, depth: 0 });
    expect(s.calls).toBe(0);
    expect(s.ms).toBeLessThan(BOUND_MS);
  });
});

// ---------- EB6 ----------
const S5 =
  'query Q($n: Int) { ...A } fragment A on Query { authors(first: $n) { edges { node { ...B ...B } } } } fragment B on Author { books { title } }';

const TABLE: Array<{
  id: string;
  query: string;
  variables?: Record<string, unknown>;
  cost: number;
  depth: number;
  calls: number;
}> = [
  { id: 'S1', query: '{ authors(first: 2) { edges { node { name books { title } } } } }', cost: 19, depth: 5, calls: 2 },
  {
    id: 'S2',
    query: '{ authors(first: 2) { edges { node { ... on Author { name books { title reviews { rating } } } } } } }',
    cost: 79,
    depth: 6,
    calls: 3,
  },
  {
    id: 'S3',
    query: 'query { ...A ...A } fragment A on Query { authors(first: 2) { edges { node { name books { title } } } } }',
    cost: 38,
    depth: 5,
    calls: 2,
  },
  {
    id: 'S4',
    query:
      'query { ...A } fragment A on Query { authors(first: 3) { edges { node { ...B ...B } } } } fragment B on Author { name books { ...C ...C } } fragment C on Book { title reviews { rating } }',
    cost: 439,
    depth: 6,
    calls: 3,
  },
  { id: 'S5', query: S5, variables: { n: 4 }, cost: 57, depth: 5, calls: 2 },
  {
    id: 'S6',
    query: 'query Q($n: Int = 2) { ...A ...A } fragment A on Query { authors(first: $n) { totalCount } }',
    cost: 6,
    depth: 2,
    calls: 1,
  },
];

describe('EB6 - equality table: {cost, depth} unchanged on normal shapes', () => {
  for (const row of TABLE) {
    it(`${row.id}: 200, no errors, cost ${row.cost}, depth ${row.depth}, ${row.calls} call(s)`, async () => {
      const s = await post(gw, row.query, row.variables);
      expect(s.status).toBe(200);
      expect(s.body.errors).toBeUndefined();
      expect(s.body.data).toBeTypeOf('object');
      expect(s.body.data).not.toBeNull();
      expect(complexity(s.body)).toEqual({ cost: row.cost, depth: row.depth });
      expect(s.calls).toBe(row.calls);
    });
  }

  it('S3 is exactly twice S1 (repeats still add; no spread dedupe)', async () => {
    const s1 = await post(gw, TABLE[0]!.query);
    const s3 = await post(gw, TABLE[2]!.query);
    const c1 = (complexity(s1.body) as { cost: number }).cost;
    const c3 = (complexity(s3.body) as { cost: number }).cost;
    expect(c1).toBe(19);
    expect(c3).toBe(2 * c1);
  });
});

// ---------- EB7 ----------
describe('EB7 - same document, different variables, same walk rules', () => {
  // Frozen from a HEAD 9080f3c run (state/iter-68/probe_test.mts): S5 with {n:1} => cost 15, depth 5.
  const S5_N1_HEAD = { cost: 15, depth: 5 };

  it('S5 with {n:4} then {n:1} on one gateway: 57, then the HEAD value 15 (memo never leaks)', async () => {
    const g = createGateway({ restBaseUrl: base });
    const a = await post(g, S5, { n: 4 });
    expect(a.body.errors).toBeUndefined();
    expect(complexity(a.body)).toEqual({ cost: 57, depth: 5 });
    const b = await post(g, S5, { n: 1 });
    expect(b.body.errors).toBeUndefined();
    expect(complexity(b.body)).toEqual(S5_N1_HEAD);
    expect((complexity(b.body) as { cost: number }).cost).not.toBe(57);
    expect(b.calls).toBe(2);
  });

  it('reverse order ({n:1} then {n:4}) and a third repeat also give the per-variable values', async () => {
    const g = createGateway({ restBaseUrl: base });
    const a = await post(g, S5, { n: 1 });
    const b = await post(g, S5, { n: 4 });
    const c = await post(g, S5, { n: 1 });
    expect(complexity(a.body)).toEqual(S5_N1_HEAD);
    expect(complexity(b.body)).toEqual({ cost: 57, depth: 5 });
    expect(complexity(c.body)).toEqual(S5_N1_HEAD);
  });

  it('a variable chain refused for {n:1} is still refused with the exact cost after an accepted request', async () => {
    const g = createGateway({ restBaseUrl: base });
    const doc = chain(12, 2, 'authors(first: $n) { totalCount }');
    const first = await post(g, doc, { n: 1 });
    expect(first.body.errors![0]!.extensions?.cost).toBe(8192);
    await post(g, S5, { n: 4 });
    const again = await post(g, doc, { n: 1 });
    expect(codes(again.body)).toEqual([TOO_COMPLEX]);
    expect(again.body.errors![0]!.extensions?.cost).toBe(8192);
    expect(again.calls).toBe(0);
  });
});

// ---------- EB8 ----------
const DEEP_A11 =
  'authors(first: 1) { edges { node { books { author { books { author { books { author { books { title } } } } } } } } } }';
const DEEP_A10 =
  'authors(first: 1) { edges { node { books { author { books { author { books { author { name } } } } } } } } }';
const DEEP11 = `query { ...A ...A } fragment A on Query { ${DEEP_A11} }`;
const DEEP10 = `query { ...A ...A } fragment A on Query { ${DEEP_A10} }`;

describe('EB8 - depth limit still fires through fragments', () => {
  it('depth 11 reached only via a twice-used spread: QUERY_TOO_DEEP depth 11 / maxDepth 10, 0 calls', async () => {
    const s = await post(gw, DEEP11);
    expect(s.status).toBe(200);
    const deep = (s.body.errors ?? []).find((e) => e.extensions?.code === TOO_DEEP);
    expect(deep).toBeDefined();
    expect(deep!.extensions?.depth).toBe(11);
    expect(deep!.extensions?.maxDepth).toBe(10);
    expect(deep!.message).toBe('Query is too deep: depth 11 exceeds the maximum of 10.');
    expectNoDataValues(s.body);
    expect(s.calls).toBe(0);
  });

  it('with a high maxComplexity the same doc reports QUERY_TOO_DEEP alone', async () => {
    const g = createGateway({ restBaseUrl: base, maxComplexity: 1_000_000 });
    const s = await post(g, DEEP11);
    expect(codes(s.body)).toEqual([TOO_DEEP]);
    expect(s.body.errors![0]!.extensions?.depth).toBe(11);
    expect(s.calls).toBe(0);
  });

  it('control: the depth-10 sibling is served with depth 10', async () => {
    const s = await post(gw, DEEP10);
    expect(s.status).toBe(200);
    expect(s.body.errors).toBeUndefined();
    expect((complexity(s.body) as { depth: number }).depth).toBe(10);
    expect(s.calls).toBeGreaterThan(0);
  });
});

// ---------- EB9 ----------
describe('EB9 - cyclic fragments are still refused', () => {
  it('A -> B -> A: at least one error, no data values, 0 calls, < 250 ms', async () => {
    const s = await post(gw, 'query { ...A } fragment A on Query { ...B } fragment B on Query { ...A __typename }');
    expect(s.status).toBeLessThan(500);
    expect((s.body.errors ?? []).length).toBeGreaterThanOrEqual(1);
    expectNoDataValues(s.body);
    expect(s.calls).toBe(0);
    expect(s.ms).toBeLessThan(BOUND_MS);
  });

  it('a cyclic doc that also exceeds maxDepth is refused without a hang', async () => {
    const s = await post(
      gw,
      `query { ...A } fragment A on Query { ...B ${DEEP_A11} } fragment B on Query { ...A __typename }`,
    );
    expect((s.body.errors ?? []).length).toBeGreaterThanOrEqual(1);
    expectNoDataValues(s.body);
    expect(s.calls).toBe(0);
    expect(s.ms).toBeLessThan(BOUND_MS);
  });

  it('a cyclic doc that also exceeds maxComplexity is refused without a hang', async () => {
    const s = await post(
      gw,
      'query { ...A } fragment A on Query { ...B authors(first: 2000) { totalCount } } fragment B on Query { ...A __typename }',
    );
    expect((s.body.errors ?? []).length).toBeGreaterThanOrEqual(1);
    expectNoDataValues(s.body);
    expect(s.calls).toBe(0);
    expect(s.ms).toBeLessThan(BOUND_MS);
  });

  it('a cyclic chain fanned out 2x per level is refused without a hang', async () => {
    const doc = chain(100, 2, '...F0 __typename');
    expect(tokenCount(doc)).toBeLessThanOrEqual(2000);
    const s = await post(gw, doc);
    expect((s.body.errors ?? []).length).toBeGreaterThanOrEqual(1);
    expectNoDataValues(s.body);
    expect(s.calls).toBe(0);
    expect(s.ms).toBeLessThan(BOUND_MS);
  });
});

// ---------- EB10 ----------
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...tsFiles(p));
    else if (ent.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('EB10 - static guard: one walker', () => {
  it('Kind.FRAGMENT_SPREAD is referenced in exactly ONE .ts file under src/gateway/security/', () => {
    const files = tsFiles(resolve(root, 'src/gateway/security'));
    expect(files.length).toBeGreaterThan(0);
    const hits = files.filter((f) => /Kind\.FRAGMENT_SPREAD\b/.test(stripComments(readFileSync(f, 'utf8'))));
    expect(hits).toHaveLength(1);
  });

  it('measureDepth no longer appears anywhere in src/', () => {
    const files = tsFiles(resolve(root, 'src'));
    expect(files.length).toBeGreaterThan(5);
    const hits = files.filter((f) => readFileSync(f, 'utf8').includes('measureDepth'));
    expect(hits).toEqual([]);
  });

  it('src/lib.ts export list is unchanged', () => {
    expect(Object.keys(lib).sort()).toEqual(
      ['BATCHED', 'NAIVE', 'buildBackend', 'createContext', 'createGateway', 'parseAuth', 'schema'].sort(),
    );
  });
});

// ---------- EB11 ----------
describe('EB11 - no downstream or loader change', () => {
  it('loaders, resolvers, datasources and schema.graphql are unmodified relative to HEAD', () => {
    const paths = ['src/gateway/loaders.ts', 'src/gateway/resolvers.ts', 'src/gateway/datasources', 'schema.graphql'];
    let out: string;
    try {
      out = execFileSync('git', ['status', '--porcelain', '--', ...paths], { cwd: root, encoding: 'utf8' });
    } catch {
      // Not a git checkout (e.g. a tarball); nothing to compare against.
      return;
    }
    expect(out.trim()).toBe('');
  });

  it('the N+1 regression test file is present and unmodified', () => {
    const file = resolve(root, 'test/n-plus-1.test.ts');
    expect(readFileSync(file, 'utf8').length).toBeGreaterThan(0);
    let out: string;
    try {
      out = execFileSync('git', ['status', '--porcelain', '--', 'test/n-plus-1.test.ts'], {
        cwd: root,
        encoding: 'utf8',
      });
    } catch {
      return;
    }
    expect(out.trim()).toBe('');
  });
});
