import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildBackend } from '../src/rest-backend/server';
import { RestClient } from '../src/gateway/datasources/rest-client';
import { buildDataSources } from '../src/gateway/datasources';
import { buildLoaders, BATCHED, NAIVE } from '../src/gateway/loaders';

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await app.close();
});

describe('request-scoped DataLoaders', () => {
  it('batches many booksByAuthorId loads into a single downstream call', async () => {
    const client = new RestClient(baseUrl);
    const loaders = buildLoaders(buildDataSources(client), BATCHED);

    const [a1Books, a2Books, a3Books] = await Promise.all([
      loaders.booksByAuthorId.load('a1'),
      loaders.booksByAuthorId.load('a2'),
      loaders.booksByAuthorId.load('a3'),
    ]);

    expect(client.stats.byPath['/books/by-author']).toBe(1); // ONE call for 3 keys
    expect(a1Books).toHaveLength(3);
    expect(a2Books).toHaveLength(3);
    expect(a3Books).toHaveLength(3);
    // grouping correctness: every returned book belongs to the requested author
    expect(a1Books.every((b) => b.authorId === 'a1')).toBe(true);
    expect(a2Books.every((b) => b.authorId === 'a2')).toBe(true);
  });

  it('returns keys with no matches as empty arrays, in key order', async () => {
    const client = new RestClient(baseUrl);
    const loaders = buildLoaders(buildDataSources(client), BATCHED);
    const results = await loaders.booksByAuthorId.loadMany(['a1', 'does-not-exist', 'a2']);
    expect(results[0]).toHaveLength(3);
    expect(results[1]).toEqual([]);
    expect(results[2]).toHaveLength(3);
  });

  it('per-request cache dedupes repeated loads of the same key', async () => {
    const client = new RestClient(baseUrl);
    const loaders = buildLoaders(buildDataSources(client), BATCHED);
    await loaders.authorById.load('a1');
    await loaders.authorById.load('a1');
    await loaders.authorById.load('a1');
    expect(client.stats.byPath['/authors/by-ids']).toBe(1);
  });

  it('NAIVE config reproduces the N+1 blowup (one call per key)', async () => {
    const client = new RestClient(baseUrl);
    const loaders = buildLoaders(buildDataSources(client), NAIVE);
    await Promise.all([
      loaders.booksByAuthorId.load('a1'),
      loaders.booksByAuthorId.load('a2'),
      loaders.booksByAuthorId.load('a3'),
    ]);
    expect(client.stats.byPath['/books/by-author']).toBe(3); // one call PER key
  });

  it('resolves a null for a missing single-entity key', async () => {
    const client = new RestClient(baseUrl);
    const loaders = buildLoaders(buildDataSources(client), BATCHED);
    const author = await loaders.authorById.load('nope');
    expect(author).toBeNull();
  });
});
