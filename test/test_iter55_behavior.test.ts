import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildBackend } from '../src/rest-backend/server';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * iter-55: `npm start` external-backend on-ramp via `startFromEnv(env, log)`.
 * Black-box: boot a "user" REST backend in-process on port 0, call
 * startFromEnv on PORT 0, POST over real HTTP to the returned url, and
 * cross-check downstream figures against the user backend /__stats counter.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

type Running = {
  url: string;
  restBaseUrl: string;
  backend: 'bundled' | 'external';
  close(): Promise<void>;
};
type StartFromEnv = (
  env: Record<string, string | undefined>,
  log?: (line: string) => void,
) => Promise<Running>;

async function loadStart(): Promise<StartFromEnv> {
  const mod = (await import('../src/cli')) as { startFromEnv: StartFromEnv };
  return mod.startFromEnv;
}

const AUTHOR_QUERY = `{ author(id:"a1") { id name } }`;
const AUTHORS5 = `{ authors(first: 5) { edges { node { id name } } } }`;
const DEEP = `{ authors(first: 1) { edges { node { books { id } } } } }`;

let userApp: FastifyInstance;
let userBase: string;
let slowApp: FastifyInstance;
let slowBase: string;

// Every started gateway is tracked and closed after each test.
const open: Running[] = [];

async function start(env: Record<string, string | undefined>) {
  const startFromEnv = await loadStart();
  const lines: string[] = [];
  const running = await startFromEnv(env, (line) => lines.push(line));
  open.push(running);
  return { running, lines };
}

async function closeTracked(r: Running) {
  const i = open.indexOf(r);
  if (i >= 0) open.splice(i, 1);
  await r.close();
}

beforeAll(async () => {
  userApp = buildBackend({ latencyMs: 0 }).app;
  userBase = await userApp.listen({ port: 0, host: '127.0.0.1' });
  slowApp = buildBackend({ latencyMs: 300 }).app;
  slowBase = await slowApp.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  while (open.length) {
    const r = open.pop()!;
    await r.close();
  }
});

afterAll(async () => {
  await userApp.close();
  await slowApp.close();
});

async function post(url: string, query: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function userTotal(base = userBase): Promise<number> {
  const res = await fetch(`${base}/__stats`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(typeof body.total).toBe('number');
  return body.total as number;
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

describe('EB1: external mode routes to the user backend', () => {
  it('resolves external with restBaseUrl === REST_BASE_URL', async () => {
    const { running } = await start({ REST_BASE_URL: userBase, PORT: '0' });
    expect(running.backend).toBe('external');
    expect(running.restBaseUrl).toBe(userBase);
    expect(running.url).toMatch(/^http:\/\/localhost:\d+\/graphql$/);
  });

  it('query hits the user backend exactly once, matching downstreamCalls.total', async () => {
    const { running } = await start({ REST_BASE_URL: userBase, PORT: '0' });
    const before = await userTotal();
    const { status, body } = await post(running.url, AUTHOR_QUERY);
    const after = await userTotal();
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data.author.name).toBe('Ada Lovelace');
    expect(body.extensions.downstreamCalls.total).toBe(1);
    expect(after - before).toBe(1);
    expect(after - before).toBe(body.extensions.downstreamCalls.total);
  });
});

describe('EB2: external mode boots no second backend and logs it', () => {
  it('logs exactly the external line and the gateway line', async () => {
    const { running, lines } = await start({ REST_BASE_URL: userBase, PORT: '0' });
    const port = portOf(running.url);
    expect(port).toBeGreaterThan(0);
    expect(lines).toEqual([
      `REST backend (external): ${userBase}`,
      `GraphQL gateway + GraphiQL: http://localhost:${port}/graphql`,
    ]);
    expect(lines.some((l) => l.includes('(bundled)'))).toBe(false);
  });
});

describe('EB3: bundled mode is unchanged', () => {
  it('resolves bundled with a 127.0.0.1 restBaseUrl and the default latency line', async () => {
    const { running, lines } = await start({ PORT: '0' });
    expect(running.backend).toBe('bundled');
    expect(running.restBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(running.restBaseUrl).not.toBe(userBase);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^REST backend \(bundled\): http:\/\/127\.0\.0\.1:\d+ \(latency 25ms\/request\)$/,
    );
    expect(lines[0]).toContain(running.restBaseUrl);
    expect(lines[1]).toBe(`GraphQL gateway + GraphiQL: http://localhost:${portOf(running.url)}/graphql`);

    const before = await userTotal();
    const { status, body } = await post(running.url, AUTHOR_QUERY);
    expect(status).toBe(200);
    expect(body.data.author.name).toBe('Ada Lovelace');
    expect(body.extensions.downstreamCalls.total).toBe(1);
    // the user backend is not involved in bundled mode
    expect((await userTotal()) - before).toBe(0);
  });

  it('REST_LATENCY_MS=0 is reflected in the bundled log line', async () => {
    const { lines } = await start({ PORT: '0', REST_LATENCY_MS: '0' });
    expect(lines[0]).toMatch(/\(latency 0ms\/request\)$/);
  });
});

describe('EB4: MAX_COMPLEXITY is applied', () => {
  it('rejects cost 21 > 10 with QUERY_TOO_COMPLEX and 0 user-backend calls', async () => {
    const { running } = await start({ REST_BASE_URL: userBase, PORT: '0', MAX_COMPLEXITY: '10' });
    const before = await userTotal();
    const { body } = await post(running.url, AUTHORS5);
    const after = await userTotal();
    expect(body.errors?.[0]?.extensions).toEqual({
      code: 'QUERY_TOO_COMPLEX',
      cost: 21,
      maxComplexity: 10,
    });
    expect(body.data).toBeUndefined();
    expect(after - before).toBe(0);
  });

  it('a cost-3 query still succeeds under MAX_COMPLEXITY=10', async () => {
    const { running } = await start({ REST_BASE_URL: userBase, PORT: '0', MAX_COMPLEXITY: '10' });
    const before = await userTotal();
    const { body } = await post(running.url, AUTHOR_QUERY);
    expect(body.errors).toBeUndefined();
    expect(body.data.author.name).toBe('Ada Lovelace');
    expect((await userTotal()) - before).toBe(1);
  });

  it.each([
    ['unset', undefined],
    ['empty string', ''],
  ])('MAX_COMPLEXITY %s -> default limit admits authors(first:5)', async (_label, value) => {
    const { running } = await start({ REST_BASE_URL: userBase, PORT: '0', MAX_COMPLEXITY: value });
    const before = await userTotal();
    const { body } = await post(running.url, AUTHORS5);
    expect(body.errors).toBeUndefined();
    expect(body.data.authors.edges).toHaveLength(5);
    expect((await userTotal()) - before).toBe(body.extensions.downstreamCalls.total);
  });
});

describe('EB5: MAX_DEPTH is applied', () => {
  it('rejects depth 5 > 2 with QUERY_TOO_DEEP and 0 user-backend calls', async () => {
    const { running } = await start({ REST_BASE_URL: userBase, PORT: '0', MAX_DEPTH: '2' });
    const before = await userTotal();
    const { body } = await post(running.url, DEEP);
    const after = await userTotal();
    expect(body.errors?.[0]?.extensions).toEqual({
      code: 'QUERY_TOO_DEEP',
      depth: 5,
      maxDepth: 2,
    });
    expect(body.data).toBeUndefined();
    expect(after - before).toBe(0);
  });

  it('without MAX_DEPTH the depth-5 query is admitted', async () => {
    const { running } = await start({ REST_BASE_URL: userBase, PORT: '0' });
    const { body } = await post(running.url, DEEP);
    expect(body.errors).toBeUndefined();
    expect(body.data.authors.edges).toHaveLength(1);
  });
});

describe('EB6: DOWNSTREAM_TIMEOUT_MS is applied', () => {
  it('50ms timeout against a 300ms backend -> DOWNSTREAM_TIMEOUT', async () => {
    const { running } = await start({ REST_BASE_URL: slowBase, PORT: '0', DOWNSTREAM_TIMEOUT_MS: '50' });
    const { body } = await post(running.url, AUTHOR_QUERY);
    expect(body.data.author).toBeNull();
    expect(body.errors?.[0]?.extensions?.code).toBe('DOWNSTREAM_TIMEOUT');
  });

  it('without the var the same query succeeds', async () => {
    const { running } = await start({ REST_BASE_URL: slowBase, PORT: '0' });
    const { body } = await post(running.url, AUTHOR_QUERY);
    expect(body.errors).toBeUndefined();
    expect(body.data.author.name).toBe('Ada Lovelace');
  });
});

async function expectRejects(env: Record<string, string | undefined>, varName: string) {
  const startFromEnv = await loadStart();
  const lines: string[] = [];
  let caught: unknown;
  try {
    const r = await startFromEnv(env, (l) => lines.push(l));
    open.push(r);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain(varName);
  expect(lines).toEqual([]);
}

describe('EB7: invalid REST_BASE_URL fails fast', () => {
  it.each(['localhost:4001', 'not a url', 'ftp://example.test'])(
    'REST_BASE_URL=%j rejects naming the variable, log never called',
    async (value) => {
      await expectRejects({ REST_BASE_URL: value, PORT: '0' }, 'REST_BASE_URL');
    },
  );
});

describe('EB8: invalid integers fail fast', () => {
  it.each([
    ['MAX_DEPTH', 'abc'],
    ['MAX_COMPLEXITY', '0'],
    ['MAX_COMPLEXITY', '1.5'],
    ['DOWNSTREAM_TIMEOUT_MS', '-5'],
  ])('external mode %s=%j rejects naming the variable', async (name, value) => {
    await expectRejects({ REST_BASE_URL: userBase, PORT: '0', [name]: value }, name);
  });

  it('PORT=abc rejects naming PORT', async () => {
    await expectRejects({ REST_BASE_URL: userBase, PORT: 'abc' }, 'PORT');
  });

  it('REST_LATENCY_MS=x rejects in bundled mode', async () => {
    await expectRejects({ PORT: '0', REST_LATENCY_MS: 'x' }, 'REST_LATENCY_MS');
  });

  it('REST_LATENCY_MS=x is ignored in external mode', async () => {
    const { running, lines } = await start({ REST_BASE_URL: userBase, PORT: '0', REST_LATENCY_MS: 'x' });
    expect(running.backend).toBe('external');
    expect(lines).toEqual([
      `REST backend (external): ${userBase}`,
      `GraphQL gateway + GraphiQL: http://localhost:${portOf(running.url)}/graphql`,
    ]);
  });

  it('rejection starts nothing: the PORT stays free for a later start', async () => {
    // Pick a free port by starting and closing a gateway, then reject on it.
    const first = await start({ REST_BASE_URL: userBase, PORT: '0' });
    const port = portOf(first.running.url);
    await closeTracked(first.running);
    await expectRejects({ REST_BASE_URL: userBase, PORT: String(port), MAX_DEPTH: 'abc' }, 'MAX_DEPTH');
    const again = await start({ REST_BASE_URL: userBase, PORT: String(port) });
    expect(portOf(again.running.url)).toBe(port);
  });
});

describe('EB9: close() releases only what it started', () => {
  it('external: gateway url refuses, user backend still serves /__stats', async () => {
    const { running } = await start({ REST_BASE_URL: userBase, PORT: '0' });
    const ok = await post(running.url, AUTHOR_QUERY);
    expect(ok.status).toBe(200);
    await closeTracked(running);
    await expect(post(running.url, AUTHOR_QUERY)).rejects.toThrow();
    const stats = await fetch(`${userBase}/__stats`);
    expect(stats.status).toBe(200);
  });

  it('bundled: both the gateway url and the bundled backend refuse', async () => {
    const { running } = await start({ PORT: '0' });
    const pre = await fetch(`${running.restBaseUrl}/__stats`);
    expect(pre.status).toBe(200);
    await pre.text();
    await closeTracked(running);
    await expect(post(running.url, AUTHOR_QUERY)).rejects.toThrow();
    await expect(fetch(`${running.restBaseUrl}/__stats`)).rejects.toThrow();
  });
});

describe('EB10: src/cli.ts is side-effect free', () => {
  it('importing, starting and closing leave SIGTERM/SIGINT listener counts unchanged', async () => {
    const term0 = process.listenerCount('SIGTERM');
    const int0 = process.listenerCount('SIGINT');
    vi.resetModules();
    const mod = (await import('../src/cli')) as { startFromEnv: StartFromEnv };
    expect(typeof mod.startFromEnv).toBe('function');
    expect(process.listenerCount('SIGTERM')).toBe(term0);
    expect(process.listenerCount('SIGINT')).toBe(int0);

    const ext = await mod.startFromEnv({ REST_BASE_URL: userBase, PORT: '0' }, () => {});
    expect(process.listenerCount('SIGTERM')).toBe(term0);
    expect(process.listenerCount('SIGINT')).toBe(int0);
    await ext.close();

    const bundled = await mod.startFromEnv({ PORT: '0' }, () => {});
    expect(process.listenerCount('SIGTERM')).toBe(term0);
    expect(process.listenerCount('SIGINT')).toBe(int0);
    await bundled.close();

    expect(process.listenerCount('SIGTERM')).toBe(term0);
    expect(process.listenerCount('SIGINT')).toBe(int0);
  });
});

describe('EB11: README documents the on-ramp', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  const start3 = readme.indexOf('\n## 3.');
  const end3 = readme.indexOf('\n## 4.');
  const section3 = readme.slice(start3, end3);

  it('section 3 exists', () => {
    expect(start3).toBeGreaterThanOrEqual(0);
    expect(end3).toBeGreaterThan(start3);
  });

  it.each(['REST_BASE_URL', 'PORT', 'REST_LATENCY_MS', 'MAX_DEPTH', 'MAX_COMPLEXITY', 'DOWNSTREAM_TIMEOUT_MS'])(
    'section 3 mentions %s',
    (name) => {
      expect(section3).toMatch(new RegExp(`\\b${name}\\b`));
    },
  );

  it('has a two-terminal example: npm run backend + REST_BASE_URL=http://127.0.0.1:4001 npm start', () => {
    const blocks = section3.split('```').filter((_, i) => i % 2 === 1);
    const example = blocks.find(
      (b) => b.includes('npm run backend') && b.includes('REST_BASE_URL=http://127.0.0.1:4001 npm start'),
    );
    expect(example).toBeDefined();
  });

  it('notes that an external backend must serve the same REST routes', () => {
    expect(section3).toMatch(/external backend must serve the same REST routes/i);
  });

  it('drift guard: every env.<NAME> read in src/cli.ts appears in README section 3', () => {
    const src = readFileSync(resolve(root, 'src/cli.ts'), 'utf8');
    const keys = [...new Set([...src.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1]))];
    // non-vacuous: the six spec'd variables are read via env.<NAME>
    expect(keys.length).toBeGreaterThanOrEqual(6);
    const missing = keys.filter((k) => !new RegExp(`\\b${k}\\b`).test(section3));
    expect(missing).toEqual([]);
  });
});
