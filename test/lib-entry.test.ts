import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createGateway, buildBackend } from '../src/lib';

describe('library entry point (barrel re-exports)', () => {
  let app: FastifyInstance;
  let yoga: ReturnType<typeof createGateway>;

  beforeAll(async () => {
    app = buildBackend({ latencyMs: 0 }).app;
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    yoga = createGateway({ restBaseUrl: baseUrl });
  });
  afterAll(async () => {
    await app.close();
  });

  it('produces a working gateway from barrel imports', async () => {
    const res = await yoga.fetch('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: '{ authors(first: 1) { edges { node { id } } } }',
      }),
    });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data.authors.edges).toHaveLength(1);
    expect(body.data.authors.edges[0].node.id).toBeTruthy();
  });
});
