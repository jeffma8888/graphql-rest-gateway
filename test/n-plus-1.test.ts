import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { graphql } from 'graphql';
import type { FastifyInstance } from 'fastify';
import { buildBackend } from '../src/rest-backend/server';
import { schema } from '../src/gateway/schema';
import { createContext } from '../src/gateway/context';
import { RestClient } from '../src/gateway/datasources/rest-client';
import { NAIVE, BATCHED } from '../src/gateway/loaders';

/**
 * THE N+1 REGRESSION TEST.
 *
 * Same query, same backend, two loader configs. We assert the exact number of
 * downstream REST calls each makes. If someone removes DataLoader batching or
 * moves fetch logic into a resolver, the batched count blows up and this fails.
 *
 * Dataset: 5 authors x 3 books each x 2 reviews each = 5 / 15 / 30.
 *   Naive  : 1 (authors) + 5 (books, one per author) + 15 (reviews, one per book) = 21
 *   Batched: 1 (authors) + 1 (books, batched) + 1 (reviews, batched)              = 3
 */
const NESTED_QUERY = /* GraphQL */ `
  query {
    authors(first: 5) {
      edges {
        node {
          id
          name
          books {
            id
            title
            reviews {
              id
              rating
            }
          }
        }
      }
    }
  }
`;

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  const backend = buildBackend({ latencyMs: 0 });
  app = backend.app;
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
});

async function run(mode: 'naive' | 'batched') {
  const client = new RestClient(baseUrl);
  const contextValue = createContext({
    restClient: client,
    loaderOptions: mode === 'naive' ? NAIVE : BATCHED,
  });
  const result = await graphql({ schema, source: NESTED_QUERY, contextValue });
  expect(result.errors, JSON.stringify(result.errors)).toBeUndefined();
  return { total: client.stats.total, byPath: client.stats.byPath, data: result.data };
}

describe('N+1 regression', () => {
  it('naive (no batching) makes 1 + N + M downstream calls', async () => {
    const { total, byPath } = await run('naive');
    expect(byPath['/authors']).toBe(1);
    expect(byPath['/books/by-author']).toBe(5);
    expect(byPath['/reviews/by-book']).toBe(15);
    expect(total).toBe(21);
  });

  it('batched (request-scoped DataLoader) makes exactly 3 downstream calls', async () => {
    const { total, byPath } = await run('batched');
    expect(byPath['/authors']).toBe(1);
    expect(byPath['/books/by-author']).toBe(1);
    expect(byPath['/reviews/by-book']).toBe(1);
    expect(total).toBe(3);
  });

  it('batching strictly reduces downstream load and returns identical data', async () => {
    const naive = await run('naive');
    const batched = await run('batched');
    expect(batched.total).toBeLessThan(naive.total);
    expect(batched.data).toEqual(naive.data);
  });
});
