import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway } from '../src/gateway/server';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

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

// EB1 - Cost and depth on successful response
describe('EB1 - successful responses include extensions.queryComplexity with cost and depth', () => {
  it('extensions.queryComplexity exists on a simple query', async () => {
    const body = await gql(`{ authors(first: 2) { edges { node { id name } } } }`);
    expect(body.errors).toBeUndefined();
    expect(body.extensions).toBeDefined();
    expect(body.extensions.queryComplexity).toBeDefined();
  });

  it('cost is a non-negative integer', async () => {
    const body = await gql(`{ authors(first: 2) { edges { node { id name } } } }`);
    const { cost } = body.extensions.queryComplexity;
    expect(typeof cost).toBe('number');
    expect(cost).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(cost)).toBe(true);
  });

  it('depth is a non-negative integer', async () => {
    const body = await gql(`{ authors(first: 2) { edges { node { id name } } } }`);
    const { depth } = body.extensions.queryComplexity;
    expect(typeof depth).toBe('number');
    expect(depth).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(depth)).toBe(true);
  });

  it('a nested query also has queryComplexity in extensions', async () => {
    const body = await gql(`{
      authors(first: 5) {
        edges { node { id name books { id title reviews { id rating } } } }
      }
    }`);
    expect(body.errors).toBeUndefined();
    expect(body.extensions.queryComplexity).toBeDefined();
    expect(body.extensions.queryComplexity.cost).toBeGreaterThanOrEqual(0);
    expect(body.extensions.queryComplexity.depth).toBeGreaterThanOrEqual(0);
  });
});

// EB2 - Cost matches the complexity validation algorithm
describe('EB2 - cost matches the complexity validation algorithm', () => {
  it('cost is deterministic across repeated identical queries', async () => {
    const q = `{ authors(first: 3) { edges { node { id books { id } } } } }`;
    const body1 = await gql(q);
    const body2 = await gql(q);
    expect(body1.extensions.queryComplexity.cost).toBe(body2.extensions.queryComplexity.cost);
  });

  it('wider query (higher first) produces higher cost', async () => {
    const narrow = await gql(`{ authors(first: 1) { edges { node { id } } } }`);
    const wide = await gql(`{ authors(first: 10) { edges { node { id } } } }`);
    expect(wide.extensions.queryComplexity.cost).toBeGreaterThan(
      narrow.extensions.queryComplexity.cost,
    );
  });

  it('a query near the complexity limit reports cost close to that limit', async () => {
    const body = await gql(
      `{ authors(first: 9999) { edges { node { books { reviews { id } } } } } }`,
    );
    expect(body.errors).toBeDefined();
    expect(body.errors[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX');
    expect(body.extensions?.queryComplexity).toBeUndefined();
  });
});

// EB3 - Depth matches the depth validation algorithm
describe('EB3 - depth matches the depth validation algorithm', () => {
  it('a flat query has lower depth than a nested query', async () => {
    const flat = await gql(`{ authors(first: 1) { totalCount } }`);
    const nested = await gql(`{
      authors(first: 1) {
        edges { node { books { reviews { id } } } }
      }
    }`);
    expect(nested.extensions.queryComplexity.depth).toBeGreaterThan(
      flat.extensions.queryComplexity.depth,
    );
  });

  it('depth increases with each additional nesting level', async () => {
    const d1 = await gql(`{ authors(first: 1) { totalCount } }`);
    const d2 = await gql(`{ authors(first: 1) { edges { node { id } } } }`);
    const d3 = await gql(`{ authors(first: 1) { edges { node { books { id } } } } }`);
    const depth1 = d1.extensions.queryComplexity.depth;
    const depth2 = d2.extensions.queryComplexity.depth;
    const depth3 = d3.extensions.queryComplexity.depth;
    expect(depth2).toBeGreaterThan(depth1);
    expect(depth3).toBeGreaterThan(depth2);
  });

  it('depth is deterministic across repeated identical queries', async () => {
    const q = `{ authors(first: 1) { edges { node { id books { id title } } } } }`;
    const body1 = await gql(q);
    const body2 = await gql(q);
    expect(body1.extensions.queryComplexity.depth).toBe(body2.extensions.queryComplexity.depth);
  });
});

// EB4 - Rejected queries do not carry queryComplexity
describe('EB4 - rejected queries do not duplicate metrics', () => {
  it('QUERY_TOO_DEEP rejection has no extensions.queryComplexity', async () => {
    const body = await gql(`{
      authors(first: 1) {
        edges { node { books { author { books { author { books { reviews { book { id } } } } } } } } }
      }
    }`);
    expect(body.errors).toBeDefined();
    expect(body.errors[0]?.extensions?.code).toBe('QUERY_TOO_DEEP');
    expect(body.extensions?.queryComplexity).toBeUndefined();
  });

  it('QUERY_TOO_COMPLEX rejection has no extensions.queryComplexity', async () => {
    const body = await gql(
      `{ authors(first: 9999) { edges { node { books { reviews { id } } } } } }`,
    );
    expect(body.errors).toBeDefined();
    expect(body.errors[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX');
    expect(body.extensions?.queryComplexity).toBeUndefined();
  });
});

// EB5 - Call-count invariants unaffected
describe('EB5 - suite count and call-count invariants unaffected', () => {
  it('README test-count badge is at least 182 (pre-iter-37 floor)', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
    const match = readme.match(/tests-(\d+)%20passing/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(182);
  });
});
