import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway } from '../src/gateway/server';

const SIMPLE_QUERY = /* GraphQL */ `
  query { authors(first: 1) { edges { node { id name } } } }
`;

let app: FastifyInstance;
let baseUrl: string;
let slowApp: FastifyInstance;
let slowBaseUrl: string;

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  slowApp = buildBackend({ latencyMs: 300 }).app;
  slowBaseUrl = await slowApp.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
  await slowApp.close();
});

// EB1 — Health endpoint returns 200
describe('EB1 — GET /healthz returns 200 with { "status": "ok" }', () => {
  it('returns HTTP 200 with JSON body { status: "ok" }', async () => {
    const gateway = createGateway({ restBaseUrl: baseUrl });
    const res = await gateway.fetch('http://gateway.local/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({ status: 'ok' });
    await gateway.close();
  });

  it('responds with content-type application/json', async () => {
    const gateway = createGateway({ restBaseUrl: baseUrl });
    const res = await gateway.fetch('http://gateway.local/healthz');
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    await gateway.close();
  });
});

// EB2 — Health endpoint is independent of GraphQL parsing
describe('EB2 — health check bypasses GraphQL pipeline', () => {
  it('/healthz succeeds even when downstream would timeout a GraphQL query', async () => {
    const gateway = createGateway({
      restBaseUrl: slowBaseUrl,
      downstreamTimeoutMs: 1,
    });
    const healthRes = await gateway.fetch('http://gateway.local/healthz');
    expect(healthRes.status).toBe(200);
    const body = (await healthRes.json()) as any;
    expect(body).toEqual({ status: 'ok' });

    const gqlRes = await gateway.fetch('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: SIMPLE_QUERY }),
    });
    const gqlBody = (await gqlRes.json()) as any;
    expect(gqlBody.errors).toBeDefined();
    expect(
      gqlBody.errors.some(
        (e: any) => e.extensions?.code === 'DOWNSTREAM_TIMEOUT',
      ),
    ).toBe(true);
    await gateway.close();
  });
});

// EB3 — Programmatic close()
describe('EB3 — createGateway() returns object with close() method', () => {
  it('close is a function on the returned gateway object', () => {
    const gateway = createGateway({ restBaseUrl: baseUrl });
    expect(typeof gateway.close).toBe('function');
  });

  it('close() returns a promise that resolves', async () => {
    const gateway = createGateway({ restBaseUrl: baseUrl });
    const result = gateway.close();
    expect(result).toBeInstanceOf(Promise);
    await result;
  });
});

// EB4 — New requests rejected after shutdown initiated
describe('EB4 — post-shutdown requests receive HTTP 503', () => {
  it('GraphQL POST after close() returns 503', async () => {
    const gateway = createGateway({ restBaseUrl: baseUrl });
    await gateway.close();
    const res = await gateway.fetch('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: SIMPLE_QUERY }),
    });
    expect(res.status).toBe(503);
  });

  it('/healthz after close() also returns 503', async () => {
    const gateway = createGateway({ restBaseUrl: baseUrl });
    await gateway.close();
    const res = await gateway.fetch('http://gateway.local/healthz');
    expect(res.status).toBe(503);
  });
});

// EB5 — In-flight requests complete during drain
describe('EB5 — in-flight request completes during drain window', () => {
  it('request started before close() completes successfully', async () => {
    const gateway = createGateway({ restBaseUrl: slowBaseUrl });
    const inflight = gateway.fetch('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: SIMPLE_QUERY }),
    });
    await new Promise((r) => setTimeout(r, 10));
    const closePromise = gateway.close();
    const res = await inflight;
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toBeDefined();
    expect(body.data.authors.edges).toHaveLength(1);
    await closePromise;
  });
});

// EB6 — Standalone entrypoint wires SIGTERM
// The signal-wiring itself is a standalone-mode concern (src/index.ts).
// We verify the programmatic lifecycle contract that the signal handlers depend on:
// gateway works → close() → 503 on new requests.
describe('EB6 — shutdown lifecycle (programmatic contract for SIGTERM wiring)', () => {
  it('gateway serves normally, then rejects after close()', async () => {
    const gateway = createGateway({ restBaseUrl: baseUrl });
    const pre = await gateway.fetch('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: SIMPLE_QUERY }),
    });
    expect(pre.status).toBe(200);
    const preBody = (await pre.json()) as any;
    expect(preBody.data.authors.edges).toHaveLength(1);

    await gateway.close();

    const post = await gateway.fetch('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: SIMPLE_QUERY }),
    });
    expect(post.status).toBe(503);
  });
});

// EB7 — Existing quality-check suite passes
// Verified by running the full suite: npm test --silent && npm run typecheck --silent
