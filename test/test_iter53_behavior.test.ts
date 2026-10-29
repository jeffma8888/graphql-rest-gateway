import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway } from '../src/gateway/server';
import { NAIVE } from '../src/gateway/loaders';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * iter-53: per-response `extensions.downstreamCalls.total`.
 * Black-box: drive createGateway(...).fetch against the bundled backend and
 * cross-check every figure against the backend's own /__stats counter.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const NESTED_QUERY = `{ authors(first: 5) { edges { node { id name books { id title reviews { id rating } } } } } }`;

let app: FastifyInstance;
let baseUrl: string;
let batched: ReturnType<typeof createGateway>;
let naive: ReturnType<typeof createGateway>;
let shallow: ReturnType<typeof createGateway>;

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  batched = createGateway({ restBaseUrl: baseUrl });
  naive = createGateway({ restBaseUrl: baseUrl, loaderOptions: NAIVE });
  shallow = createGateway({ restBaseUrl: baseUrl, maxDepth: 2 });
});

afterAll(async () => {
  await batched.close();
  await naive.close();
  await shallow.close();
  await app.close();
});

async function gql(gw: ReturnType<typeof createGateway>, query: string) {
  const res = await gw.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return (await res.json()) as any;
}

async function resetStats() {
  const res = await fetch(`${baseUrl}/__stats/reset`, { method: 'POST' });
  expect(res.ok).toBe(true);
}

async function backendTotal(): Promise<number> {
  const res = await fetch(`${baseUrl}/__stats`);
  const body = (await res.json()) as any;
  expect(typeof body.total).toBe('number');
  return body.total as number;
}

describe('EB1 - batched nested query reports 3', () => {
  it('extensions.downstreamCalls deep-equals { total: 3 } with no errors', async () => {
    await resetStats();
    const body = await gql(batched, NESTED_QUERY);
    expect(body.errors).toBeUndefined();
    expect(body.extensions.downstreamCalls).toEqual({ total: 3 });
    expect(await backendTotal()).toBe(3);
  });
});

describe('EB2 - naive loaders report 21', () => {
  it('extensions.downstreamCalls.total === 21 with NAIVE loaders', async () => {
    await resetStats();
    const body = await gql(naive, NESTED_QUERY);
    expect(body.errors).toBeUndefined();
    expect(body.extensions.downstreamCalls.total).toBe(21);
    expect(await backendTotal()).toBe(21);
  });
});

describe('EB3 - figure matches backend /__stats', () => {
  it('batched: reported total equals backend total after reset', async () => {
    await resetStats();
    const body = await gql(batched, NESTED_QUERY);
    expect(body.extensions.downstreamCalls.total).toBe(await backendTotal());
  });

  it('naive: reported total equals backend total after reset', async () => {
    await resetStats();
    const body = await gql(naive, NESTED_QUERY);
    expect(body.extensions.downstreamCalls.total).toBe(await backendTotal());
  });
});

describe('EB4 - counts are per request, not cumulative', () => {
  it('two sequential identical requests each report 3 (not 3 then 6)', async () => {
    await resetStats();
    const a = await gql(batched, NESTED_QUERY);
    const b = await gql(batched, NESTED_QUERY);
    expect(a.extensions.downstreamCalls.total).toBe(3);
    expect(b.extensions.downstreamCalls.total).toBe(3);
    expect(await backendTotal()).toBe(6);
  });

  it('two concurrent identical requests each report 3', async () => {
    await resetStats();
    const [a, b] = await Promise.all([gql(batched, NESTED_QUERY), gql(batched, NESTED_QUERY)]);
    expect(a.extensions.downstreamCalls.total).toBe(3);
    expect(b.extensions.downstreamCalls.total).toBe(3);
    expect(await backendTotal()).toBe(6);
  });

  it('mixed concurrent batched + naive requests report 3 and 21 respectively', async () => {
    await resetStats();
    const [a, b] = await Promise.all([gql(batched, NESTED_QUERY), gql(naive, NESTED_QUERY)]);
    expect(a.extensions.downstreamCalls.total).toBe(3);
    expect(b.extensions.downstreamCalls.total).toBe(21);
    expect(await backendTotal()).toBe(24);
  });
});

describe('EB5 - zero-call queries report 0', () => {
  it('{ __typename } reports { total: 0 }', async () => {
    await resetStats();
    const body = await gql(batched, `{ __typename }`);
    expect(body.data.__typename).toBe('Query');
    expect(body.extensions.downstreamCalls).toEqual({ total: 0 });
    expect(await backendTotal()).toBe(0);
  });
});

describe('EB6 - partial-error responses still report the count', () => {
  it('NOT_FOUND author lookup reports total 1, matching backend', async () => {
    await resetStats();
    const body = await gql(batched, `{ author(id: "does-not-exist") { id } }`);
    expect(body.errors[0].extensions.code).toBe('NOT_FOUND');
    expect(body.extensions.downstreamCalls.total).toBe(1);
    expect(await backendTotal()).toBe(1);
  });
});

describe('EB7 - validation-rejected queries carry no extension', () => {
  it('QUERY_TOO_DEEP response has no downstreamCalls and makes no backend calls', async () => {
    await resetStats();
    const body = await gql(shallow, NESTED_QUERY);
    expect(body.errors[0].extensions.code).toBe('QUERY_TOO_DEEP');
    expect(body.extensions?.downstreamCalls).toBeUndefined();
    expect(Object.keys(body.extensions ?? {})).not.toContain('downstreamCalls');
    expect(await backendTotal()).toBe(0);
  });

  it('QUERY_TOO_COMPLEX response has no downstreamCalls and makes no backend calls', async () => {
    await resetStats();
    const body = await gql(
      batched,
      `{ authors(first: 10000) { edges { node { id books { id reviews { id } } } } } }`,
    );
    expect(body.errors[0].extensions.code).toBe('QUERY_TOO_COMPLEX');
    expect(Object.keys(body.extensions ?? {})).not.toContain('downstreamCalls');
    expect(await backendTotal()).toBe(0);
  });
});

describe('EB8 - coexists with queryComplexity', () => {
  it('successful response carries both queryComplexity and downstreamCalls', async () => {
    await resetStats();
    const body = await gql(batched, NESTED_QUERY);
    expect(body.errors).toBeUndefined();
    const { queryComplexity, downstreamCalls } = body.extensions;
    expect(typeof queryComplexity.cost).toBe('number');
    expect(typeof queryComplexity.depth).toBe('number');
    expect(Object.keys(downstreamCalls)).toEqual(['total']);
    expect(Number.isInteger(downstreamCalls.total)).toBe(true);
    expect(downstreamCalls.total).toBeGreaterThanOrEqual(0);
    expect(downstreamCalls.total).toBe(await backendTotal());
  });

  it('queryComplexity values are identical between batched and naive gateways', async () => {
    const a = await gql(batched, NESTED_QUERY);
    const b = await gql(naive, NESTED_QUERY);
    expect(a.extensions.queryComplexity).toEqual(b.extensions.queryComplexity);
    expect(a.extensions.downstreamCalls.total).toBeLessThan(b.extensions.downstreamCalls.total);
  });
});

describe('EB9 - documented in README section 7', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  const s7Start = readme.indexOf('## 7.');
  const s8Start = readme.indexOf('## 8.');
  const section7 = readme.slice(s7Start, s8Start);

  it('section 7 has a Downstream call metrics subsection mentioning extensions.downstreamCalls', () => {
    expect(s7Start).toBeGreaterThanOrEqual(0);
    expect(s8Start).toBeGreaterThan(s7Start);
    const m = section7.match(/### Downstream call metrics\n([\s\S]*?)(?=\n### |$)/);
    expect(m).not.toBeNull();
    const sub = m![1];
    expect(sub).toContain('extensions.downstreamCalls');
    expect(sub).toMatch(/per request/i);
    expect(sub).toMatch(/QUERY_TOO_DEEP|QUERY_TOO_COMPLEX|validation/);
    expect(sub).toMatch(/not\*?\*? get the extension|not injected|no extension|not\b[\s\S]{0,40}extension/i);
  });
});
