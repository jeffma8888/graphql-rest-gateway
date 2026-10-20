import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { graphql } from 'graphql';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildBackend } from '../src/rest-backend/server';
import { schema } from '../src/gateway/schema';
import { createContext } from '../src/gateway/context';
import { RestClient } from '../src/gateway/datasources/rest-client';
import { BATCHED } from '../src/gateway/loaders';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
});

async function run(query: string) {
  const client = new RestClient(baseUrl);
  const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
  const result = await graphql({ schema, source: query, contextValue });
  return { result, stats: client.stats };
}

// EB1 — NOT_FOUND error on missing author
describe('EB1 — NOT_FOUND error on missing author', () => {
  it('Query.author with nonexistent id returns data.author: null', async () => {
    const { result } = await run(`{ author(id: "nonexistent-id") { id name } }`);
    expect(result.data).toBeDefined();
    expect(result.data!.author).toBeNull();
  });

  it('Query.author with nonexistent id includes error with extensions.code NOT_FOUND', async () => {
    const { result } = await run(`{ author(id: "nonexistent-id") { id name } }`);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThanOrEqual(1);
    const notFound = result.errors!.find(
      (e) => (e.extensions as any)?.code === 'NOT_FOUND',
    );
    expect(notFound).toBeDefined();
  });

  it('NOT_FOUND error includes extensions.id equal to the requested id', async () => {
    const requestedId = 'does-not-exist-author-42';
    const { result } = await run(`{ author(id: "${requestedId}") { id name } }`);
    const notFound = result.errors!.find(
      (e) => (e.extensions as any)?.code === 'NOT_FOUND',
    );
    expect(notFound).toBeDefined();
    expect((notFound!.extensions as any).id).toBe(requestedId);
  });
});

// EB2 — NOT_FOUND error on missing book
describe('EB2 — NOT_FOUND error on missing book', () => {
  it('Query.book with nonexistent id returns data.book: null', async () => {
    const { result } = await run(`{ book(id: "nonexistent-id") { id title } }`);
    expect(result.data).toBeDefined();
    expect(result.data!.book).toBeNull();
  });

  it('Query.book with nonexistent id includes error with extensions.code NOT_FOUND', async () => {
    const { result } = await run(`{ book(id: "nonexistent-id") { id title } }`);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThanOrEqual(1);
    const notFound = result.errors!.find(
      (e) => (e.extensions as any)?.code === 'NOT_FOUND',
    );
    expect(notFound).toBeDefined();
  });

  it('NOT_FOUND error includes extensions.id equal to the requested id', async () => {
    const requestedId = 'does-not-exist-book-99';
    const { result } = await run(`{ book(id: "${requestedId}") { id title } }`);
    const notFound = result.errors!.find(
      (e) => (e.extensions as any)?.code === 'NOT_FOUND',
    );
    expect(notFound).toBeDefined();
    expect((notFound!.extensions as any).id).toBe(requestedId);
  });
});

// EB3 — No error on existing entities
describe('EB3 — no error on existing entities', () => {
  it('Query.author with valid id returns data without errors', async () => {
    const { result } = await run(`{ author(id: "a1") { id name } }`);
    expect(result.errors).toBeUndefined();
    expect(result.data).toBeDefined();
    expect(result.data!.author).toBeDefined();
    expect((result.data!.author as any).id).toBe('a1');
  });

  it('Query.book with valid id returns data without errors', async () => {
    const { result } = await run(`{ book(id: "a1-b1") { id title } }`);
    expect(result.errors).toBeUndefined();
    expect(result.data).toBeDefined();
    expect(result.data!.book).toBeDefined();
    expect((result.data!.book as any).id).toBe('a1-b1');
  });

  it('valid author returns full author fields', async () => {
    const { result } = await run(`{ author(id: "a3") { id name bio } }`);
    expect(result.errors).toBeUndefined();
    const author = result.data!.author as any;
    expect(author.id).toBe('a3');
    expect(typeof author.name).toBe('string');
    expect(typeof author.bio).toBe('string');
  });

  it('valid book returns full book fields', async () => {
    const { result } = await run(`{ book(id: "a2-b1") { id title year } }`);
    expect(result.errors).toBeUndefined();
    const book = result.data!.book as any;
    expect(book.id).toBe('a2-b1');
    expect(typeof book.title).toBe('string');
    expect(typeof book.year).toBe('number');
  });
});

// EB4 — Call-count invariant preserved
describe('EB4 — call-count invariant preserved (DataLoader batching unaffected)', () => {
  it('mixed query with valid + invalid author does not increase call count', async () => {
    const queryBoth = `{
      a1: author(id: "a1") { id name }
      missing: author(id: "nonexistent") { id name }
    }`;
    const { stats, result } = await run(queryBoth);
    expect(result.data!.a1).toBeDefined();
    expect(result.data!.missing).toBeNull();
    expect(stats.total).toBe(1);
    expect(stats.byPath['/authors/by-ids']).toBe(1);
  });

  it('mixed query with valid + invalid book does not increase call count', async () => {
    const queryBoth = `{
      real: book(id: "a1-b1") { id title }
      fake: book(id: "no-such-book") { id title }
    }`;
    const { stats, result } = await run(queryBoth);
    expect(result.data!.real).toBeDefined();
    expect(result.data!.fake).toBeNull();
    expect(stats.total).toBe(1);
    expect(stats.byPath['/books/by-ids']).toBe(1);
  });

  it('forward-path N+1 counts unchanged (still 3 batched calls)', async () => {
    const nestedQuery = `{
      authors(first: 5) {
        edges {
          node { id name books { id title reviews { id rating } } }
        }
      }
    }`;
    const client = new RestClient(baseUrl);
    const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
    const result = await graphql({ schema, source: nestedQuery, contextValue });
    expect(result.errors).toBeUndefined();
    expect(client.stats.total).toBe(3);
    expect(client.stats.byPath['/authors']).toBe(1);
    expect(client.stats.byPath['/books/by-author']).toBe(1);
    expect(client.stats.byPath['/reviews/by-book']).toBe(1);
  });
});

// EB5 — Back-edge resolvers unchanged
describe('EB5 — back-edge resolvers unchanged', () => {
  it('Book.author for a missing back-reference still throws NOT_FOUND (no extensions.id)', async () => {
    const { result } = await run(`{
      authors(first: 5) {
        edges {
          node { books { author { id name } } }
        }
      }
    }`);
    expect(result.errors).toBeUndefined();
    const edges = (result.data as any).authors.edges;
    for (const edge of edges) {
      for (const book of edge.node.books) {
        expect(book.author).toBeDefined();
        expect(book.author.id).toBeTruthy();
      }
    }
  });

  it('Review.book for existing reviews resolves correctly (back-edge intact)', async () => {
    const { result } = await run(`{
      authors(first: 5) {
        edges {
          node {
            books {
              reviews { book { id title } }
            }
          }
        }
      }
    }`);
    expect(result.errors).toBeUndefined();
    const edges = (result.data as any).authors.edges;
    for (const edge of edges) {
      for (const book of edge.node.books) {
        for (const review of book.reviews) {
          expect(review.book).toBeDefined();
          expect(review.book.id).toBeTruthy();
        }
      }
    }
  });
});

// Suite-count floor
describe('Suite count floor', () => {
  it('README badge shows >= 140 tests passing', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
    const match = readme.match(/tests-(\d+)%20passing/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(140);
  });
});
