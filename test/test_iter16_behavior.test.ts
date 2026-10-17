import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildBackend } from '../src/rest-backend/server';
import { AUTHORS, BOOKS, REVIEWS } from '../src/rest-backend/data';

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
});

async function fetchJson(path: string): Promise<any> {
  const res = await fetch(`${baseUrl}${path}`);
  expect(res.status).toBe(200);
  return res.json();
}

// EB1: authors by-ids correctness
describe('EB1 — authors by-ids returns correct AuthorRow objects', () => {
  it('GET /authors/by-ids?ids=a1,a3,a5 returns exactly 3 matching authors', async () => {
    const data = await fetchJson('/authors/by-ids?ids=a1,a3,a5');
    expect(data).toHaveLength(3);
    const ids = data.map((a: any) => a.id).sort();
    expect(ids).toEqual(['a1', 'a3', 'a5']);
  });

  it('returned fields match the AUTHORS dataset constant', async () => {
    const data = await fetchJson('/authors/by-ids?ids=a1,a3,a5');
    for (const row of data) {
      const expected = AUTHORS.find((a) => a.id === row.id);
      expect(expected).toBeDefined();
      expect(row.name).toBe(expected!.name);
      expect(row.bio).toBe(expected!.bio);
    }
  });
});

// EB2: books by-author correctness
describe('EB2 — books by-author returns correct BookRow objects', () => {
  it('GET /books/by-author?authorIds=a2,a4 returns exactly 6 books (3 per author)', async () => {
    const data = await fetchJson('/books/by-author?authorIds=a2,a4');
    expect(data).toHaveLength(6);
  });

  it('returned fields match the BOOKS dataset constant', async () => {
    const data = await fetchJson('/books/by-author?authorIds=a2,a4');
    for (const row of data) {
      const expected = BOOKS.find((b) => b.id === row.id);
      expect(expected).toBeDefined();
      expect(row.authorId).toBe(expected!.authorId);
      expect(row.title).toBe(expected!.title);
      expect(row.year).toBe(expected!.year);
    }
    const authorIds = new Set(data.map((b: any) => b.authorId));
    expect(authorIds).toEqual(new Set(['a2', 'a4']));
  });
});

// EB3: books by-ids correctness
describe('EB3 — books by-ids returns correct BookRow objects', () => {
  it('GET /books/by-ids?ids=a1-b1,a2-b3,a5-b2 returns exactly 3 books', async () => {
    const data = await fetchJson('/books/by-ids?ids=a1-b1,a2-b3,a5-b2');
    expect(data).toHaveLength(3);
    const ids = data.map((b: any) => b.id).sort();
    expect(ids).toEqual(['a1-b1', 'a2-b3', 'a5-b2']);
  });

  it('returned fields match the BOOKS dataset constant', async () => {
    const data = await fetchJson('/books/by-ids?ids=a1-b1,a2-b3,a5-b2');
    for (const row of data) {
      const expected = BOOKS.find((b) => b.id === row.id);
      expect(expected).toBeDefined();
      expect(row.authorId).toBe(expected!.authorId);
      expect(row.title).toBe(expected!.title);
      expect(row.year).toBe(expected!.year);
    }
  });
});

// EB4: reviews by-book correctness
describe('EB4 — reviews by-book returns correct ReviewRow objects', () => {
  it('GET /reviews/by-book?bookIds=a1-b2,a3-b1 returns exactly 4 reviews (2 per book)', async () => {
    const data = await fetchJson('/reviews/by-book?bookIds=a1-b2,a3-b1');
    expect(data).toHaveLength(4);
  });

  it('returned fields match the REVIEWS dataset constant', async () => {
    const data = await fetchJson('/reviews/by-book?bookIds=a1-b2,a3-b1');
    for (const row of data) {
      const expected = REVIEWS.find((r) => r.id === row.id);
      expect(expected).toBeDefined();
      expect(row.bookId).toBe(expected!.bookId);
      expect(row.rating).toBe(expected!.rating);
      expect(row.body).toBe(expected!.body);
      expect(row.reviewer).toBe(expected!.reviewer);
    }
    const bookIds = new Set(data.map((r: any) => r.bookId));
    expect(bookIds).toEqual(new Set(['a1-b2', 'a3-b1']));
  });
});

// EB5: empty result for absent IDs
describe('EB5 — absent IDs return empty arrays', () => {
  it('/authors/by-ids with non-existent ID returns []', async () => {
    const data = await fetchJson('/authors/by-ids?ids=z99');
    expect(data).toEqual([]);
  });

  it('/books/by-ids with non-existent ID returns []', async () => {
    const data = await fetchJson('/books/by-ids?ids=z99');
    expect(data).toEqual([]);
  });

  it('/books/by-author with non-existent author ID returns []', async () => {
    const data = await fetchJson('/books/by-author?authorIds=z99');
    expect(data).toEqual([]);
  });

  it('/reviews/by-book with non-existent book ID returns []', async () => {
    const data = await fetchJson('/reviews/by-book?bookIds=z99');
    expect(data).toEqual([]);
  });
});

// EB6: N+1 regression safety — existing test still passes (validated by running full suite)
describe('EB6 — N+1 regression safety', () => {
  it('existing N+1 regression test assertions are not weakened (verified via full suite)', async () => {
    // This EB is validated by the full suite run: n-plus-1.test.ts asserts
    // 21 naive calls, 3 batched calls, and deepEqual data between modes.
    // Here we do a smoke check that the batched gateway still works correctly
    // after the index-based refactor by running a lightweight end-to-end query.
    const { graphql } = await import('graphql');
    const { schema } = await import('../src/gateway/schema');
    const { createContext } = await import('../src/gateway/context');
    const { RestClient } = await import('../src/gateway/datasources/rest-client');
    const { BATCHED } = await import('../src/gateway/loaders');

    const client = new RestClient(baseUrl);
    const contextValue = createContext({
      restClient: client,
      loaderOptions: BATCHED,
    });
    const result = await graphql({
      schema,
      source: `{ authors(first: 5) { edges { node { id books { id reviews { id } } } } } }`,
      contextValue,
    });
    expect(result.errors, JSON.stringify(result.errors)).toBeUndefined();
    expect(client.stats.total).toBe(3);
    expect((result.data as any).authors.edges).toHaveLength(5);
  });
});
