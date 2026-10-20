import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { graphql } from 'graphql';
import type { FastifyInstance } from 'fastify';
import { buildBackend } from '../src/rest-backend/server';
import { schema } from '../src/gateway/schema';
import { createContext } from '../src/gateway/context';
import { RestClient } from '../src/gateway/datasources/rest-client';
import { createGateway } from '../src/gateway/server';
import { BATCHED } from '../src/gateway/loaders';

const SIMPLE_QUERY = /* GraphQL */ `
  query { authors(first: 2) { edges { node { id name } } } }
`;

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
            reviews { id rating }
          }
        }
      }
    }
  }
`;

let slowApp: FastifyInstance;
let slowBaseUrl: string;
let fastApp: FastifyInstance;
let fastBaseUrl: string;

beforeAll(async () => {
  slowApp = buildBackend({ latencyMs: 200, forceCloseConnections: true }).app;
  slowBaseUrl = await slowApp.listen({ port: 0, host: '127.0.0.1' });
  fastApp = buildBackend({ latencyMs: 0 }).app;
  fastBaseUrl = await fastApp.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await slowApp.close();
  await fastApp.close();
});

// EB1 — Timeout triggers typed error
describe('EB1 — timeout triggers typed DOWNSTREAM_TIMEOUT error', () => {
  it('returns GraphQLError with extensions.code DOWNSTREAM_TIMEOUT when deadline exceeded', async () => {
    const client = new RestClient(slowBaseUrl, 1);
    const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
    const result = await graphql({ schema, source: SIMPLE_QUERY, contextValue });
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThanOrEqual(1);
    const timeoutError = result.errors!.find(
      (e) => (e.extensions as any)?.code === 'DOWNSTREAM_TIMEOUT',
    );
    expect(timeoutError).toBeDefined();
  });

  it('does not hang — resolves within a bounded time', async () => {
    const client = new RestClient(slowBaseUrl, 10);
    const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
    const start = Date.now();
    await graphql({ schema, source: SIMPLE_QUERY, contextValue });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });
});

// EB2 — Error message identifies the path
describe('EB2 — timeout error message includes the downstream REST path', () => {
  it('error message contains the REST endpoint path that timed out', async () => {
    const client = new RestClient(slowBaseUrl, 1);
    const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
    const result = await graphql({ schema, source: SIMPLE_QUERY, contextValue });
    expect(result.errors).toBeDefined();
    const timeoutError = result.errors!.find(
      (e) => (e.extensions as any)?.code === 'DOWNSTREAM_TIMEOUT',
    );
    expect(timeoutError).toBeDefined();
    expect(timeoutError!.message).toMatch(/\/authors/);
  });
});

// EB3 — GatewayOptions threads timeout
describe('EB3 — GatewayOptions.downstreamTimeoutMs threads to RestClient', () => {
  it('gateway created with downstreamTimeoutMs produces timeout errors on slow backend', async () => {
    const yoga = createGateway({ restBaseUrl: slowBaseUrl, downstreamTimeoutMs: 1 });
    const res = await yoga.fetch('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: SIMPLE_QUERY }),
    });
    const body = (await res.json()) as any;
    expect(body.errors).toBeDefined();
    expect(body.errors.length).toBeGreaterThanOrEqual(1);
    const timeoutError = body.errors.find(
      (e: any) => e.extensions?.code === 'DOWNSTREAM_TIMEOUT',
    );
    expect(timeoutError).toBeDefined();
  });

  it('same gateway with fast backend returns data without timeout errors', async () => {
    const yoga = createGateway({ restBaseUrl: fastBaseUrl, downstreamTimeoutMs: 5000 });
    const res = await yoga.fetch('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: SIMPLE_QUERY }),
    });
    const body = (await res.json()) as any;
    expect(body.errors).toBeUndefined();
    expect(body.data.authors.edges).toHaveLength(2);
  });
});

// EB4 — Finite default when omitted
describe('EB4 — finite default timeout when downstreamTimeoutMs is not provided', () => {
  it('gateway without downstreamTimeoutMs still succeeds on fast backend (finite default is not zero)', async () => {
    const yoga = createGateway({ restBaseUrl: fastBaseUrl });
    const res = await yoga.fetch('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: SIMPLE_QUERY }),
    });
    const body = (await res.json()) as any;
    expect(body.errors).toBeUndefined();
    expect(body.data.authors.edges).toHaveLength(2);
  });

  it('RestClient without explicit timeout succeeds on fast backend', async () => {
    const client = new RestClient(fastBaseUrl);
    const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
    const result = await graphql({ schema, source: SIMPLE_QUERY, contextValue });
    expect(result.errors).toBeUndefined();
    expect((result.data as any).authors.edges).toHaveLength(2);
  });
});

// EB5 — Non-timeout errors unchanged
describe('EB5 — non-timeout errors are not affected by the timeout change', () => {
  it('fast backend returns normal data without DOWNSTREAM_TIMEOUT errors', async () => {
    const client = new RestClient(fastBaseUrl, 5000);
    const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
    const result = await graphql({ schema, source: NESTED_QUERY, contextValue });
    expect(result.errors).toBeUndefined();
    expect((result.data as any).authors.edges).toHaveLength(5);
  });

  it('a successful query does not contain any DOWNSTREAM_TIMEOUT in errors', async () => {
    const client = new RestClient(fastBaseUrl, 5000);
    const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
    const result = await graphql({ schema, source: NESTED_QUERY, contextValue });
    if (result.errors) {
      const hasTimeout = result.errors.some(
        (e) => (e.extensions as any)?.code === 'DOWNSTREAM_TIMEOUT',
      );
      expect(hasTimeout).toBe(false);
    }
  });
});

// EB6 — Stats count timed-out calls
describe('EB6 — stats.total and stats.byPath increment even for timed-out calls', () => {
  it('stats.total > 0 after a timed-out call', async () => {
    const client = new RestClient(slowBaseUrl, 1);
    const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
    await graphql({ schema, source: SIMPLE_QUERY, contextValue });
    expect(client.stats.total).toBeGreaterThan(0);
  });

  it('stats.byPath records the path of the timed-out call', async () => {
    const client = new RestClient(slowBaseUrl, 1);
    const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
    await graphql({ schema, source: SIMPLE_QUERY, contextValue });
    const paths = Object.keys(client.stats.byPath);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some((p) => p.startsWith('/authors'))).toBe(true);
  });
});

// EB7 — Partial data on mixed results
describe('EB7 — partial data alongside timeout errors', () => {
  it('GraphQL response includes both data and errors keys when timeout occurs', async () => {
    const client = new RestClient(slowBaseUrl, 1);
    const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
    const result = await graphql({ schema, source: SIMPLE_QUERY, contextValue });
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('errors');
    expect(result.errors!.length).toBeGreaterThanOrEqual(1);
  });

  it('successful query returns full data without errors (no false positives)', async () => {
    const client = new RestClient(fastBaseUrl, 5000);
    const contextValue = createContext({ restClient: client, loaderOptions: BATCHED });
    const result = await graphql({ schema, source: NESTED_QUERY, contextValue });
    expect(result.errors).toBeUndefined();
    expect((result.data as any).authors.edges).toHaveLength(5);
    for (const edge of (result.data as any).authors.edges) {
      expect(edge.node.books.length).toBeGreaterThan(0);
      for (const book of edge.node.books) {
        expect(book.reviews.length).toBeGreaterThan(0);
      }
    }
  });
});
