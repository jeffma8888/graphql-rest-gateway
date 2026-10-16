import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { graphql } from 'graphql';
import type { FastifyInstance } from 'fastify';
import { buildBackend } from '../src/rest-backend/server';
import { schema } from '../src/gateway/schema';
import { createContext } from '../src/gateway/context';
import { RestClient } from '../src/gateway/datasources/rest-client';
import { BATCHED, NAIVE } from '../src/gateway/loaders';

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
});

const AUTHOR_BACK_EDGE_QUERY = /* GraphQL */ `
  query {
    authors(first: 5) {
      edges {
        node {
          books {
            author {
              id
              name
            }
          }
        }
      }
    }
  }
`;

const BOOK_BACK_EDGE_QUERY = /* GraphQL */ `
  query {
    authors(first: 5) {
      edges {
        node {
          books {
            reviews {
              book {
                id
                title
              }
            }
          }
        }
      }
    }
  }
`;

async function run(query: string, mode: 'naive' | 'batched') {
  const client = new RestClient(baseUrl);
  const contextValue = createContext({
    restClient: client,
    loaderOptions: mode === 'naive' ? NAIVE : BATCHED,
  });
  const result = await graphql({ schema, source: query, contextValue });
  expect(result.errors, JSON.stringify(result.errors)).toBeUndefined();
  return { total: client.stats.total, byPath: client.stats.byPath, data: result.data };
}

// EB1: Author back-edge priming — 2 downstream calls, not 3
describe('EB1 — author back-edge priming eliminates redundant author fetch', () => {
  it('authors→books→author makes exactly 2 downstream REST calls', async () => {
    const { total, byPath } = await run(AUTHOR_BACK_EDGE_QUERY, 'batched');
    expect(byPath['/authors']).toBe(1);
    expect(byPath['/books/by-author']).toBe(1);
    expect(byPath['/authors/by-ids']).toBeUndefined();
    expect(total).toBe(2);
  });
});

// EB2: Book back-edge priming — 3 downstream calls, not 4
describe('EB2 — book back-edge priming eliminates redundant book fetch', () => {
  it('authors→books→reviews→book makes exactly 3 downstream REST calls', async () => {
    const { total, byPath } = await run(BOOK_BACK_EDGE_QUERY, 'batched');
    expect(byPath['/authors']).toBe(1);
    expect(byPath['/books/by-author']).toBe(1);
    expect(byPath['/reviews/by-book']).toBe(1);
    expect(byPath['/books/by-ids']).toBeUndefined();
    expect(total).toBe(3);
  });
});

// EB3: Existing N+1 regression test is unchanged (forward path: 3 batched / 21 naive)
describe('EB3 — forward-path N+1 counts are unaffected by priming', () => {
  const FORWARD_QUERY = /* GraphQL */ `
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

  it('naive forward path still makes 21 downstream calls', async () => {
    const { total, byPath } = await run(FORWARD_QUERY, 'naive');
    expect(byPath['/authors']).toBe(1);
    expect(byPath['/books/by-author']).toBe(5);
    expect(byPath['/reviews/by-book']).toBe(15);
    expect(total).toBe(21);
  });

  it('batched forward path still makes exactly 3 downstream calls', async () => {
    const { total, byPath } = await run(FORWARD_QUERY, 'batched');
    expect(byPath['/authors']).toBe(1);
    expect(byPath['/books/by-author']).toBe(1);
    expect(byPath['/reviews/by-book']).toBe(1);
    expect(total).toBe(3);
  });
});

// EB4: Data correctness on author back-edge — same data with and without priming
describe('EB4 — author back-edge data is correct (matches naive)', () => {
  it('batched author back-edge returns identical data to naive', async () => {
    const naive = await run(AUTHOR_BACK_EDGE_QUERY, 'naive');
    const batched = await run(AUTHOR_BACK_EDGE_QUERY, 'batched');
    expect(batched.data).toEqual(naive.data);
  });

  it('every author back-edge resolves to a valid author object', async () => {
    const { data } = await run(AUTHOR_BACK_EDGE_QUERY, 'batched');
    const edges = (data as any).authors.edges;
    for (const edge of edges) {
      for (const book of edge.node.books) {
        expect(book.author).toBeDefined();
        expect(book.author.id).toBeTruthy();
        expect(book.author.name).toBeTruthy();
      }
    }
  });
});

// EB5: Data correctness on book back-edge — same data with and without priming
describe('EB5 — book back-edge data is correct (matches naive)', () => {
  it('batched book back-edge returns identical data to naive', async () => {
    const naive = await run(BOOK_BACK_EDGE_QUERY, 'naive');
    const batched = await run(BOOK_BACK_EDGE_QUERY, 'batched');
    expect(batched.data).toEqual(naive.data);
  });

  it('every book back-edge resolves to a valid book object', async () => {
    const { data } = await run(BOOK_BACK_EDGE_QUERY, 'batched');
    const edges = (data as any).authors.edges;
    for (const edge of edges) {
      for (const book of edge.node.books) {
        for (const review of book.reviews) {
          expect(review.book).toBeDefined();
          expect(review.book.id).toBeTruthy();
          expect(review.book.title).toBeTruthy();
        }
      }
    }
  });
});

// EB6: Priming is scoped to request — no cross-request caching
describe('EB6 — priming is request-scoped (no leakage across requests)', () => {
  it('two sequential author back-edge queries each make the same call count', async () => {
    const first = await run(AUTHOR_BACK_EDGE_QUERY, 'batched');
    const second = await run(AUTHOR_BACK_EDGE_QUERY, 'batched');
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
  });

  it('two sequential book back-edge queries each make the same call count', async () => {
    const first = await run(BOOK_BACK_EDGE_QUERY, 'batched');
    const second = await run(BOOK_BACK_EDGE_QUERY, 'batched');
    expect(first.total).toBe(3);
    expect(second.total).toBe(3);
  });
});
