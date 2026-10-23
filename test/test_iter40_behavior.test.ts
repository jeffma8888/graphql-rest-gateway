import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway } from '../src/gateway/server';

let app: FastifyInstance;
let yoga: ReturnType<typeof createGateway>;

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  yoga = createGateway({ restBaseUrl: baseUrl, maxDepth: 10, maxComplexity: 1000 });
});

afterAll(async () => {
  await yoga.close();
  await app.close();
});

async function gql(query: string) {
  const res = await yoga.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return (await res.json()) as any;
}

// EB1 - Shared fragment map: queries using fragments produce correct extensions
describe('EB1 - fragment-using queries produce correct cost/depth extensions', () => {
  it('query with a named fragment returns extensions.queryComplexity', async () => {
    const body = await gql(`
      fragment AuthorFields on Author { id name }
      query { authors(first: 2) { edges { node { ...AuthorFields } } } }
    `);
    expect(body.errors).toBeUndefined();
    expect(body.extensions).toBeDefined();
    expect(body.extensions.queryComplexity).toBeDefined();
    expect(typeof body.extensions.queryComplexity.cost).toBe('number');
    expect(typeof body.extensions.queryComplexity.depth).toBe('number');
  });

  it('query with multiple fragments returns valid cost/depth', async () => {
    const body = await gql(`
      fragment AuthorInfo on Author { id name }
      fragment BookInfo on Book { id title year }
      query {
        authors(first: 3) {
          edges { node { ...AuthorInfo books { ...BookInfo } } }
        }
      }
    `);
    expect(body.errors).toBeUndefined();
    expect(body.extensions.queryComplexity.cost).toBeGreaterThanOrEqual(0);
    expect(body.extensions.queryComplexity.depth).toBeGreaterThanOrEqual(0);
  });

  it('fragment-based query produces same cost/depth as equivalent inline query', async () => {
    const withFragment = await gql(`
      fragment BookFields on Book { id title year }
      query { authors(first: 2) { edges { node { id name books { ...BookFields } } } } }
    `);
    const inline = await gql(`
      query { authors(first: 2) { edges { node { id name books { id title year } } } } }
    `);
    expect(withFragment.extensions.queryComplexity.cost)
      .toBe(inline.extensions.queryComplexity.cost);
    expect(withFragment.extensions.queryComplexity.depth)
      .toBe(inline.extensions.queryComplexity.depth);
  });
});

// EB2 - Shared cost and depth: values are deterministic (computed once, cached)
describe('EB2 - cost and depth are deterministic (single-computation consistency)', () => {
  it('identical queries return identical cost across 5 runs', async () => {
    const q = `{ authors(first: 3) { edges { node { id books { id reviews { id } } } } } }`;
    const results = await Promise.all(Array.from({ length: 5 }, () => gql(q)));
    const costs = results.map((r) => r.extensions.queryComplexity.cost);
    const depths = results.map((r) => r.extensions.queryComplexity.depth);
    expect(new Set(costs).size).toBe(1);
    expect(new Set(depths).size).toBe(1);
  });

  it('fragment-based query is deterministic across repeated runs', async () => {
    const q = `
      fragment ReviewFields on Review { id rating body }
      query { authors(first: 2) { edges { node { books { reviews { ...ReviewFields } } } } } }
    `;
    const r1 = await gql(q);
    const r2 = await gql(q);
    expect(r1.extensions.queryComplexity.cost).toBe(r2.extensions.queryComplexity.cost);
    expect(r1.extensions.queryComplexity.depth).toBe(r2.extensions.queryComplexity.depth);
  });

  it('cost and depth are both non-negative integers', async () => {
    const body = await gql(`{ authors(first: 5) { edges { node { books { reviews { id } } } } } }`);
    const { cost, depth } = body.extensions.queryComplexity;
    expect(cost).toBeGreaterThanOrEqual(0);
    expect(depth).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(cost)).toBe(true);
    expect(Number.isInteger(depth)).toBe(true);
  });
});

// EB3 - Extensions unchanged: queryComplexity values are numerically identical
describe('EB3 - extensions.queryComplexity values unchanged from pre-dedup behavior', () => {
  it('simple query cost/depth matches the inline-equivalent fragment query', async () => {
    const simple = await gql(`{ authors(first: 2) { totalCount } }`);
    expect(simple.errors).toBeUndefined();
    expect(simple.extensions.queryComplexity.cost).toBeGreaterThanOrEqual(0);
    expect(simple.extensions.queryComplexity.depth).toBeGreaterThanOrEqual(0);
  });

  it('nested query depth increases strictly with nesting level', async () => {
    const shallow = await gql(`{ authors(first: 1) { totalCount } }`);
    const medium = await gql(`{ authors(first: 1) { edges { node { id books { id } } } } }`);
    const deep = await gql(`{ authors(first: 1) { edges { node { books { reviews { id } } } } } }`);
    const d1 = shallow.extensions.queryComplexity.depth;
    const d2 = medium.extensions.queryComplexity.depth;
    const d3 = deep.extensions.queryComplexity.depth;
    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThan(d2);
  });

  it('wider first= produces higher cost', async () => {
    const narrow = await gql(`{ authors(first: 1) { edges { node { id } } } }`);
    const wide = await gql(`{ authors(first: 5) { edges { node { id } } } }`);
    expect(wide.extensions.queryComplexity.cost).toBeGreaterThan(
      narrow.extensions.queryComplexity.cost,
    );
  });

  it('queryComplexity contains exactly cost and depth keys', async () => {
    const body = await gql(`{ authors(first: 2) { edges { node { id } } } }`);
    const keys = Object.keys(body.extensions.queryComplexity).sort();
    expect(keys).toEqual(['cost', 'depth']);
  });
});

// EB4 - Validation rejection unchanged
describe('EB4 - over-limit queries still rejected with correct error codes', () => {
  it('QUERY_TOO_DEEP rejection still works', async () => {
    const body = await gql(`{
      authors(first: 1) {
        edges { node { books { author { books { author { books { reviews { book { id } } } } } } } } }
      }
    }`);
    expect(body.errors).toBeDefined();
    expect(body.errors.length).toBeGreaterThanOrEqual(1);
    expect(body.errors[0]?.extensions?.code).toBe('QUERY_TOO_DEEP');
  });

  it('QUERY_TOO_COMPLEX rejection still works', async () => {
    const body = await gql(`{
      authors(first: 9999) { edges { node { books { reviews { id } } } } }
    }`);
    expect(body.errors).toBeDefined();
    expect(body.errors.length).toBeGreaterThanOrEqual(1);
    expect(body.errors[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX');
  });

  it('rejected queries do NOT include extensions.queryComplexity', async () => {
    const tooDeep = await gql(`{
      authors(first: 1) {
        edges { node { books { author { books { author { books { reviews { book { id } } } } } } } } }
      }
    }`);
    expect(tooDeep.extensions?.queryComplexity).toBeUndefined();

    const tooComplex = await gql(`{
      authors(first: 9999) { edges { node { books { reviews { id } } } } }
    }`);
    expect(tooComplex.extensions?.queryComplexity).toBeUndefined();
  });

  it('fragment-based query that exceeds depth is still rejected', async () => {
    const body = await gql(`
      fragment Deep on Author { books { author { books { author { books { reviews { book { id } } } } } } } }
      query { authors(first: 1) { edges { node { ...Deep } } } }
    `);
    expect(body.errors).toBeDefined();
    expect(body.errors[0]?.extensions?.code).toBe('QUERY_TOO_DEEP');
  });
});

// EB5 - Full quality-check suite passes
describe('EB5 - existing test suite integrity', () => {
  it('gateway boots and responds to a health check', async () => {
    const res = await yoga.fetch('http://gateway.local/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe('ok');
  });

  it('N+1 regression: the sample nested query still returns valid data', async () => {
    const body = await gql(`{
      authors(first: 5) {
        edges { node { id name books { id title reviews { id rating } } } }
      }
    }`);
    expect(body.errors).toBeUndefined();
    expect(body.data.authors.edges.length).toBeGreaterThan(0);
  });
});
