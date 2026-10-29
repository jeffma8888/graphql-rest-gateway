import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway } from '../src/gateway/server';

/**
 * iter-54: the query-complexity limit and `extensions.queryComplexity.cost`
 * resolve `first` supplied as a GraphQL variable (request value, then the
 * operation default), and the cost multiplier is clamped at >= 0.
 * Black-box: drive createGateway(...).fetch against the bundled backend and
 * cross-check admission against the backend's own /__stats counter.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const SEL = `{ edges { node { id name books { id title reviews { id rating book { id } } } } } }`;
const VQ = `query Q($n: Int) { authors(first: $n) ${SEL} }`;
const NESTED_QUERY = `{ authors(first: 5) { edges { node { id name books { id title reviews { id rating } } } } } }`;
const cost = (first: number) => 1 + 120 * first;

type Gw = ReturnType<typeof createGateway>;

let app: FastifyInstance;
let baseUrl: string;
let gw: Gw;
let gw300: Gw;

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  gw = createGateway({ restBaseUrl: baseUrl });
  gw300 = createGateway({ restBaseUrl: baseUrl, maxComplexity: 300 });
});

afterAll(async () => {
  await gw.close();
  await gw300.close();
  await app.close();
});

async function gqlRaw(g: Gw, query: string, variables?: Record<string, unknown>) {
  const payload: Record<string, unknown> = { query };
  if (variables !== undefined) payload.variables = variables;
  const res = await g.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function gql(g: Gw, query: string, variables?: Record<string, unknown>) {
  return (await gqlRaw(g, query, variables)).body;
}

async function resetStats() {
  const res = await fetch(`${baseUrl}/__stats/reset`, { method: 'POST' });
  expect(res.ok).toBe(true);
}

async function backendTotal(): Promise<number> {
  const res = await fetch(`${baseUrl}/__stats`);
  const body = (await res.json()) as any;
  expect(typeof body.total).toBe('number');
  return body.total as number;
}

function expectTooComplex(body: any, expectedCost: number | null, max = 1000) {
  expect(Array.isArray(body.errors)).toBe(true);
  expect(body.errors[0].extensions.code).toBe('QUERY_TOO_COMPLEX');
  if (expectedCost !== null) expect(body.errors[0].extensions.cost).toBe(expectedCost);
  expect(body.errors[0].extensions.maxComplexity).toBe(max);
  expect(body.data == null).toBe(true);
}

function expectAdmitted(body: any): number {
  expect(body.errors).toBeUndefined();
  expect(body.data).toBeTruthy();
  const c = body.extensions?.queryComplexity?.cost;
  expect(typeof c).toBe('number');
  return c as number;
}

describe('EB1 - variable over the limit is rejected', () => {
  it('VQ {n:100} -> QUERY_TOO_COMPLEX cost 12001 max 1000, no data, backend total 0', async () => {
    await resetStats();
    const body = await gql(gw, VQ, { n: 100 });
    expectTooComplex(body, 12001);
    expect(await backendTotal()).toBe(0);
  });

  it('variable cost equals the literal first:100 rejection cost', async () => {
    const lit = await gql(gw, `{ authors(first: 100) ${SEL} }`);
    const v = await gql(gw, VQ, { n: 100 });
    expect(lit.errors[0].extensions.code).toBe('QUERY_TOO_COMPLEX');
    expect(v.errors[0].extensions.cost).toBe(lit.errors[0].extensions.cost);
    expect(v.errors[0].extensions.cost).toBe(cost(100));
  });
});

describe('EB2 - rejection shape matches the literal rejection', () => {
  it('same HTTP status, message format, and no queryComplexity/downstreamCalls extensions', async () => {
    const lit = await gqlRaw(gw, `{ authors(first: 100) ${SEL} }`);
    const v = await gqlRaw(gw, VQ, { n: 100 });
    expect(v.status).toBe(lit.status);
    expect(v.body.errors[0].message).toMatch(/cost 12001 exceeds the maximum of 1000/);
    expect(lit.body.errors[0].message).toMatch(/cost 12001 exceeds the maximum of 1000/);
    expect(v.body.extensions?.queryComplexity).toBeUndefined();
    expect(v.body.extensions?.downstreamCalls).toBeUndefined();
  });
});

describe('EB3 - variable under the limit is admitted with the exact cost', () => {
  it('VQ {n:2} -> 2 edges, cost 241, downstreamCalls 3, backend total 3', async () => {
    await resetStats();
    const body = await gql(gw, VQ, { n: 2 });
    expect(expectAdmitted(body)).toBe(241);
    expect(body.data.authors.edges).toHaveLength(2);
    expect(body.extensions.downstreamCalls.total).toBe(3);
    expect(await backendTotal()).toBe(3);
  });

  it('variable cost equals the literal first:2 cost', async () => {
    const lit = await gql(gw, `{ authors(first: 2) ${SEL} }`);
    const v = await gql(gw, VQ, { n: 2 });
    expect(expectAdmitted(v)).toBe(expectAdmitted(lit));
  });
});

describe('EB4 - operation-level variable default is honoured', () => {
  const DQ = `query Q($n: Int = 100) { authors(first: $n) ${SEL} }`;

  it('default 100 with no variables -> rejected at 12001, backend total 0', async () => {
    await resetStats();
    const body = await gql(gw, DQ);
    expectTooComplex(body, 12001);
    expect(await backendTotal()).toBe(0);
  });

  it('same document with {n:2} -> admitted at 241', async () => {
    const body = await gql(gw, DQ, { n: 2 });
    expect(expectAdmitted(body)).toBe(241);
  });
});

describe('EB5 - omitted or null variable equals an omitted argument', () => {
  it('no variables and {n:null} both report the cost of { authors SEL }', async () => {
    const bare = await gql(gw, `{ authors ${SEL} }`);
    const bareCost = expectAdmitted(bare);
    expect(bareCost).toBe(121);
    const omitted = await gql(gw, VQ);
    const nulled = await gql(gw, VQ, { n: null });
    expect(expectAdmitted(omitted)).toBe(bareCost);
    expect(expectAdmitted(nulled)).toBe(bareCost);
  });
});

describe('EB6 - no cross-request cost reuse', () => {
  it('sequential {n:2},{n:100},{n:2} on one gateway -> 241, rejected 12001, 241', async () => {
    const a = await gql(gw, VQ, { n: 2 });
    const b = await gql(gw, VQ, { n: 100 });
    const c = await gql(gw, VQ, { n: 2 });
    expect(expectAdmitted(a)).toBe(241);
    expectTooComplex(b, 12001);
    expect(expectAdmitted(c)).toBe(241);
  });

  it('sequential {n:100} first, then {n:2} is still admitted (no stale rejection)', async () => {
    const fresh = createGateway({ restBaseUrl: baseUrl });
    try {
      const a = await gql(fresh, VQ, { n: 100 });
      const b = await gql(fresh, VQ, { n: 2 });
      expectTooComplex(a, 12001);
      expect(expectAdmitted(b)).toBe(241);
    } finally {
      await fresh.close();
    }
  });

  it('concurrent {n:2} and {n:100} split admitted/rejected', async () => {
    const [a, b] = await Promise.all([gql(gw, VQ, { n: 2 }), gql(gw, VQ, { n: 100 })]);
    expect(expectAdmitted(a)).toBe(241);
    expectTooComplex(b, 12001);
  });
});

describe('EB7 - custom maxComplexity applies to the variable path', () => {
  it('maxComplexity 300: {n:2} admitted at 241', async () => {
    const body = await gql(gw300, VQ, { n: 2 });
    expect(expectAdmitted(body)).toBe(241);
  });

  it('maxComplexity 300: {n:3} rejected at 361 with maxComplexity 300, backend total 0', async () => {
    await resetStats();
    const body = await gql(gw300, VQ, { n: 3 });
    expectTooComplex(body, 361, 300);
    expect(await backendTotal()).toBe(0);
  });
});

describe('EB8 - cost is never negative (literal or variable)', () => {
  it('literal negative alias does not offset a large alias: rejected, cost >= 1201, backend 0', async () => {
    await resetStats();
    const body = await gql(gw, `{ a: authors(first: 10) ${SEL} b: authors(first: -1000) ${SEL} }`);
    expectTooComplex(body, null);
    expect(body.errors[0].extensions.cost).toBeGreaterThanOrEqual(1201);
    expect(await backendTotal()).toBe(0);
  });

  it('variable negative alias ($m = -1000) is also rejected, backend 0', async () => {
    await resetStats();
    const q = `query Q($m: Int) { a: authors(first: 10) ${SEL} b: authors(first: $m) ${SEL} }`;
    const body = await gql(gw, q, { m: -1000 });
    expectTooComplex(body, null);
    expect(body.errors[0].extensions.cost).toBeGreaterThanOrEqual(1201);
    expect(await backendTotal()).toBe(0);
  });

  for (const first of [-1000, -1, 0]) {
    it(`literal first:${first} reports cost >= 1`, async () => {
      const body = await gql(gw, `{ authors(first: ${first}) ${SEL} }`);
      const c = body.extensions?.queryComplexity?.cost ?? body.errors?.[0]?.extensions?.cost;
      expect(typeof c).toBe('number');
      expect(c).toBeGreaterThanOrEqual(1);
    });

    it(`variable first=${first} reports cost >= 1`, async () => {
      const body = await gql(gw, VQ, { n: first });
      const c = body.extensions?.queryComplexity?.cost ?? body.errors?.[0]?.extensions?.cost;
      expect(typeof c).toBe('number');
      expect(c).toBeGreaterThanOrEqual(1);
    });
  }
});

describe('EB9 - literal non-negative paths unchanged', () => {
  for (const first of [1, 2, 5, 8]) {
    it(`literal first:${first} reports cost ${cost(first)}`, async () => {
      const body = await gql(gw, `{ authors(first: ${first}) ${SEL} }`);
      expect(expectAdmitted(body)).toBe(cost(first));
    });
  }

  it('literal first:10 is still rejected at cost 1201', async () => {
    await resetStats();
    const body = await gql(gw, `{ authors(first: 10) ${SEL} }`);
    expectTooComplex(body, 1201);
    expect(await backendTotal()).toBe(0);
  });

  it('nested sample query still batches to downstreamCalls.total 3', async () => {
    await resetStats();
    const body = await gql(gw, NESTED_QUERY);
    expect(body.errors).toBeUndefined();
    expect(body.extensions.downstreamCalls.total).toBe(3);
    expect(await backendTotal()).toBe(3);
  });

  it('N+1 regression test file is present and still asserts batching', () => {
    const src = readFileSync(resolve(root, 'test/n-plus-1.test.ts'), 'utf8');
    expect(src).toMatch(/expect\(/);
    expect(src.length).toBeGreaterThan(200);
  });
});

describe('README documents the variable-aware complexity rule', () => {
  it('README mentions variables and negative values in the complexity docs', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
    // The complexity bullet plus its indented sub-bullets (until the next blank line).
    const start = readme.indexOf('**Complexity/cost limit**');
    expect(start).toBeGreaterThan(-1);
    const end = readme.indexOf('\n\n', start);
    const block = readme.slice(start, end === -1 ? undefined : end);
    expect(block).toMatch(/variable/i);
    expect(block).toMatch(/runtime value/i);
    expect(block).toMatch(/negative[\s\S]*count[^\n]*\b0\b/i);
  });
});
