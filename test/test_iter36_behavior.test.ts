import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { graphql } from 'graphql';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway } from '../src/gateway/server';
import { schema } from '../src/gateway/schema';
import { createContext } from '../src/gateway/context';
import { RestClient } from '../src/gateway/datasources/rest-client';
import { BATCHED } from '../src/gateway/loaders';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const SIMPLE_QUERY = /* GraphQL */ `
  query { authors(first: 1) { edges { node { id name } } } }
`;

let errorApp: FastifyInstance;
let errorBaseUrl: string;
let healthyApp: FastifyInstance;
let healthyBaseUrl: string;
let slowApp: FastifyInstance;
let slowBaseUrl: string;

beforeAll(async () => {
  errorApp = Fastify();
  errorApp.all('/*', (_req, reply) => {
    reply.status(500).send('Internal Server Error');
  });
  errorBaseUrl = await errorApp.listen({ port: 0, host: '127.0.0.1' });

  healthyApp = buildBackend({ latencyMs: 0 }).app;
  healthyBaseUrl = await healthyApp.listen({ port: 0, host: '127.0.0.1' });

  slowApp = buildBackend({ latencyMs: 200 }).app;
  slowBaseUrl = await slowApp.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await errorApp.close();
  await healthyApp.close();
  await slowApp.close();
});

// EB1 — non-OK HTTP status → DOWNSTREAM_ERROR with extensions.status
describe('EB1 — non-OK HTTP status produces DOWNSTREAM_ERROR with status', () => {
  it('returns errors with extensions.code === DOWNSTREAM_ERROR when backend returns 500', async () => {
    const client = new RestClient(errorBaseUrl);
    const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
    const result = await graphql({ schema, source: SIMPLE_QUERY, contextValue });
    expect(result.errors).toBeDefined();
    const downstreamError = result.errors!.find(
      (e) => (e.extensions as any)?.code === 'DOWNSTREAM_ERROR',
    );
    expect(downstreamError).toBeDefined();
  });

  it('extensions.status is the numeric HTTP status code (500)', async () => {
    const client = new RestClient(errorBaseUrl);
    const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
    const result = await graphql({ schema, source: SIMPLE_QUERY, contextValue });
    expect(result.errors).toBeDefined();
    const downstreamError = result.errors!.find(
      (e) => (e.extensions as any)?.code === 'DOWNSTREAM_ERROR',
    );
    expect(downstreamError).toBeDefined();
    expect((downstreamError!.extensions as any).status).toBe(500);
  });

  it('a 404 backend also produces DOWNSTREAM_ERROR with status 404', async () => {
    const notFoundApp = Fastify();
    notFoundApp.all('/*', (_req, reply) => {
      reply.status(404).send('Not Found');
    });
    const notFoundUrl = await notFoundApp.listen({ port: 0, host: '127.0.0.1' });

    const client = new RestClient(notFoundUrl);
    const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
    const result = await graphql({ schema, source: SIMPLE_QUERY, contextValue });
    expect(result.errors).toBeDefined();
    const downstreamError = result.errors!.find(
      (e) => (e.extensions as any)?.code === 'DOWNSTREAM_ERROR',
    );
    expect(downstreamError).toBeDefined();
    expect((downstreamError!.extensions as any).status).toBe(404);

    await notFoundApp.close();
  });
});

// EB2 — error message includes HTTP status, status text, and path
describe('EB2 — error message includes status, status text, and path', () => {
  it('message mentions the HTTP status code', async () => {
    const client = new RestClient(errorBaseUrl);
    const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
    const result = await graphql({ schema, source: SIMPLE_QUERY, contextValue });
    const downstreamError = result.errors!.find(
      (e) => (e.extensions as any)?.code === 'DOWNSTREAM_ERROR',
    );
    expect(downstreamError).toBeDefined();
    expect(downstreamError!.message).toContain('500');
  });

  it('message mentions a REST path (e.g. /authors)', async () => {
    const client = new RestClient(errorBaseUrl);
    const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
    const result = await graphql({ schema, source: SIMPLE_QUERY, contextValue });
    const downstreamError = result.errors!.find(
      (e) => (e.extensions as any)?.code === 'DOWNSTREAM_ERROR',
    );
    expect(downstreamError).toBeDefined();
    expect(downstreamError!.message).toMatch(/\/authors/);
  });

  it('message mentions status text (e.g. Internal Server Error)', async () => {
    const client = new RestClient(errorBaseUrl);
    const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
    const result = await graphql({ schema, source: SIMPLE_QUERY, contextValue });
    const downstreamError = result.errors!.find(
      (e) => (e.extensions as any)?.code === 'DOWNSTREAM_ERROR',
    );
    expect(downstreamError).toBeDefined();
    expect(downstreamError!.message).toMatch(/Internal Server Error/i);
  });
});

// EB3 — timeout behavior is unchanged (DOWNSTREAM_TIMEOUT, not DOWNSTREAM_ERROR)
describe('EB3 — timeout still produces DOWNSTREAM_TIMEOUT, not DOWNSTREAM_ERROR', () => {
  it('slow backend with 1ms timeout gives DOWNSTREAM_TIMEOUT (not DOWNSTREAM_ERROR)', async () => {
    const client = new RestClient(slowBaseUrl, 1);
    const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
    const result = await graphql({ schema, source: SIMPLE_QUERY, contextValue });
    expect(result.errors).toBeDefined();
    const timeoutError = result.errors!.find(
      (e) => (e.extensions as any)?.code === 'DOWNSTREAM_TIMEOUT',
    );
    expect(timeoutError).toBeDefined();
    const downstreamError = result.errors!.find(
      (e) => (e.extensions as any)?.code === 'DOWNSTREAM_ERROR',
    );
    expect(downstreamError).toBeUndefined();
  });
});

// EB4 — drift guard still passes; DOWNSTREAM_ERROR documented in README
describe('EB4 — drift guard consistency and README documentation', () => {
  it('README contains DOWNSTREAM_ERROR literal', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
    expect(readme).toContain('DOWNSTREAM_ERROR');
  });

  it('README has a "Downstream error" subsection', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
    expect(readme).toContain('Downstream error');
  });

  it('README downstream error section mentions extensions.status', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
    const idx = readme.indexOf('Downstream error');
    expect(idx).toBeGreaterThan(-1);
    const section = readme.slice(idx, readme.indexOf('###', idx + 1));
    expect(section).toContain('extensions.status');
  });
});

// EB5 — all existing tests pass with no modifications
describe('EB5 — healthy backend still works (no regression)', () => {
  it('healthy backend returns full data with no errors', async () => {
    const client = new RestClient(healthyBaseUrl);
    const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
    const result = await graphql({ schema, source: SIMPLE_QUERY, contextValue });
    expect(result.errors).toBeUndefined();
    expect((result.data as any).authors.edges).toHaveLength(1);
  });

  it('healthy backend through createGateway returns data with no errors', async () => {
    const gateway = createGateway({ restBaseUrl: healthyBaseUrl });
    const res = await gateway.fetch('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: SIMPLE_QUERY }),
    });
    const body = (await res.json()) as any;
    expect(body.errors).toBeUndefined();
    expect(body.data.authors.edges).toHaveLength(1);
    await gateway.close();
  });

  it('README test-count badge is at least 182 (pre-iter-36 baseline)', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
    const match = readme.match(/tests-(\d+)%20passing/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(182);
  });
});
