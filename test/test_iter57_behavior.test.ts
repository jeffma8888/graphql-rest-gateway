import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, buildBackend } from '../src/lib';
import { RestClient } from '../src/gateway/datasources/rest-client';

/**
 * iter-57: the downstream REST base URL keeps its path prefix, and the CLI
 * rejects a REST_BASE_URL with a query string or fragment.
 * Black-box: the bundled backend runs on port 0 behind an in-process
 * recording proxy (also port 0). Every downstream figure is cross-checked
 * against the proxy log and the backend's own /__stats counter.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const NESTED = `{ authors(first: 2) { edges { node { name books { title } } } } }`;

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

type Proxy = { server: Server; origin: string; urls: string[] };

/**
 * mode 'prefix': forwards /api/v1/<rest> to the backend as /<rest> and answers
 * 404 for anything else. mode 'pass': forwards every path unchanged.
 */
async function startProxy(target: string, mode: 'prefix' | 'pass'): Promise<Proxy> {
  const t = new URL(target);
  const urls: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    urls.push(url);
    let path = url;
    if (mode === 'prefix') {
      if (!url.startsWith('/api/v1/')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      path = url.slice('/api/v1'.length);
    }
    const up = httpRequest(
      {
        host: t.hostname,
        port: Number(t.port),
        method: req.method,
        path,
        headers: { ...req.headers, host: t.host },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    up.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no proxy address');
  return { server, origin: `http://127.0.0.1:${addr.port}`, urls };
}

function closeServer(s: Server): Promise<void> {
  return new Promise((r) => s.close(() => r()));
}

let app: FastifyInstance;
let backendOrigin: string;
let prefixProxy: Proxy;
let passProxy: Proxy;

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  backendOrigin = await app.listen({ port: 0, host: '127.0.0.1' });
  prefixProxy = await startProxy(backendOrigin, 'prefix');
  passProxy = await startProxy(backendOrigin, 'pass');
});

afterAll(async () => {
  await closeServer(prefixProxy.server);
  await closeServer(passProxy.server);
  await app.close();
});

const open: Running[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function gql(restBaseUrl: string, query = NESTED) {
  const yoga = createGateway({ restBaseUrl });
  const res = await yoga.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

async function resetStats() {
  const res = await fetch(`${backendOrigin}/__stats/reset`, { method: 'POST' });
  expect(res.ok).toBe(true);
}

async function statsTotal(): Promise<number> {
  const res = await fetch(`${backendOrigin}/__stats`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(typeof body.total).toBe('number');
  return body.total as number;
}

/** Runs the nested query through one base, returning body + URLs recorded by `proxy`. */
async function recorded(proxy: Proxy, restBaseUrl: string) {
  proxy.urls.length = 0;
  const body = await gql(restBaseUrl);
  return { body, urls: [...proxy.urls] };
}

function expectNestedOk(body: any) {
  expect(body.errors).toBeUndefined();
  const edges = body.data.authors.edges;
  expect(edges).toHaveLength(2);
  for (const e of edges) {
    expect(typeof e.node.name).toBe('string');
    expect(Array.isArray(e.node.books)).toBe(true);
  }
}

describe('EB1: library, prefixed base', () => {
  it('nested query succeeds and every downstream URL carries /api/v1/', async () => {
    const { body, urls } = await recorded(prefixProxy, `${prefixProxy.origin}/api/v1`);
    expectNestedOk(body);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u.startsWith('/api/v1/')).toBe(true);
    expect(urls.some((u) => u.startsWith('/api/v1/authors?'))).toBe(true);
    expect(urls.some((u) => u.startsWith('/api/v1/books/by-author?'))).toBe(true);
  });
});

describe('EB2: trailing slash is equivalent', () => {
  it('records the same URL set and returns deep-equal data', async () => {
    const a = await recorded(prefixProxy, `${prefixProxy.origin}/api/v1`);
    const b = await recorded(prefixProxy, `${prefixProxy.origin}/api/v1/`);
    expectNestedOk(b.body);
    expect([...b.urls].sort()).toEqual([...a.urls].sort());
    expect(b.body.data).toEqual(a.body.data);
  });
});

describe('EB3: multiple trailing slashes collapse', () => {
  it('paths start with /api/v1/authors and none contains //', async () => {
    const { body, urls } = await recorded(prefixProxy, `${prefixProxy.origin}/api/v1//`);
    expectNestedOk(body);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((u) => u.startsWith('/api/v1/authors'))).toBe(true);
    for (const u of urls) {
      expect(u.startsWith('/api/v1/')).toBe(true);
      expect(u.split('?')[0]).not.toContain('//');
      expect(u).not.toContain('//');
    }
  });
});

describe('EB4: origin-only bases are unchanged', () => {
  it.each([
    ['no trailing slash', ''],
    ['trailing slash', '/'],
  ])('direct backend (%s) returns data deep-equal to the prefixed run', async (_l, suffix) => {
    const prefixed = await recorded(prefixProxy, `${prefixProxy.origin}/api/v1`);
    const direct = await gql(`${backendOrigin}${suffix}`);
    expectNestedOk(direct);
    expect(direct.data).toEqual(prefixed.body.data);
  });

  it.each([
    ['no trailing slash', ''],
    ['trailing slash', '/'],
  ])('pass-through proxy (%s) records unprefixed paths', async (_l, suffix) => {
    const { body, urls } = await recorded(passProxy, `${passProxy.origin}${suffix}`);
    expectNestedOk(body);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((u) => u.startsWith('/authors?'))).toBe(true);
    expect(urls.some((u) => u.startsWith('/books/by-author?'))).toBe(true);
    for (const u of urls) {
      expect(u.startsWith('/api/')).toBe(false);
      expect(u.startsWith('//')).toBe(false);
    }
  });
});

describe('EB5: call-count parity (N+1 oracle)', () => {
  it('prefixed and origin-only give identical totals, equal to /__stats and the proxy log', async () => {
    await resetStats();
    const pre = await recorded(prefixProxy, `${prefixProxy.origin}/api/v1`);
    const preStats = await statsTotal();
    expectNestedOk(pre.body);
    const preTotal = pre.body.extensions.downstreamCalls.total;
    expect(typeof preTotal).toBe('number');
    expect(preTotal).toBeGreaterThan(0);
    expect(preStats).toBe(preTotal);
    expect(pre.urls.length).toBe(preTotal);

    await resetStats();
    const orig = await recorded(passProxy, passProxy.origin);
    const origStats = await statsTotal();
    expectNestedOk(orig.body);
    const origTotal = orig.body.extensions.downstreamCalls.total;
    expect(origStats).toBe(origTotal);
    expect(orig.urls.length).toBe(origTotal);

    await resetStats();
    const direct = await gql(backendOrigin);
    expect(await statsTotal()).toBe(direct.extensions.downstreamCalls.total);

    // the prefix adds zero downstream calls
    expect(preTotal).toBe(origTotal);
    expect(preTotal).toBe(direct.extensions.downstreamCalls.total);
    // batched: authors page + one books batch, not one per author
    expect(preTotal).toBe(2);
  });
});

describe('EB6: counter and error keys stay route paths', () => {
  it('RestClient with a prefixed base keys stats by the route path', async () => {
    prefixProxy.urls.length = 0;
    const client = new RestClient(`${prefixProxy.origin}/api/v1`);
    await client.get('/authors', { offset: 0, limit: 1 } as any);
    expect(client.stats.byPath['/authors']).toBe(1);
    expect(client.stats.byPath['/api/v1/authors']).toBeUndefined();
    expect(prefixProxy.urls).toHaveLength(1);
    expect(prefixProxy.urls[0]?.startsWith('/api/v1/authors?')).toBe(true);
  });

  it('a 404 from the prefixed service is DOWNSTREAM_ERROR ending "for /authors"', async () => {
    prefixProxy.urls.length = 0;
    const body = await gql(`${prefixProxy.origin}/wrong`);
    expect(body.errors?.length).toBeGreaterThan(0);
    const err = body.errors[0];
    expect(err.extensions.code).toBe('DOWNSTREAM_ERROR');
    expect(err.message).toMatch(/for \/authors$/);
    expect(err.message).not.toContain('/wrong');
    expect(prefixProxy.urls.some((u) => u.startsWith('/wrong/authors'))).toBe(true);
  });
});

describe('EB7: CLI, prefixed base', () => {
  it('startFromEnv with a prefixed REST_BASE_URL serves the nested query via the prefix', async () => {
    const startFromEnv = await loadStart();
    const base = `${prefixProxy.origin}/api/v1`;
    const lines: string[] = [];
    const running = await startFromEnv({ REST_BASE_URL: base, PORT: '0' }, (l) => lines.push(l));
    open.push(running);
    expect(running.restBaseUrl).toBe(base);

    prefixProxy.urls.length = 0;
    const res = await fetch(running.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: NESTED }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expectNestedOk(body);
    expect(prefixProxy.urls.length).toBeGreaterThan(0);
    for (const u of prefixProxy.urls) expect(u.startsWith('/api/v1/')).toBe(true);
    expect(prefixProxy.urls.length).toBe(body.extensions.downstreamCalls.total);
  });
});

async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const addr = srv.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  await new Promise<void>((r) => srv.close(() => r()));
  return addr.port;
}

describe('EB8: CLI rejects query/fragment in REST_BASE_URL', () => {
  const BAD = [
    'http://127.0.0.1:4001/api?x=1',
    'http://127.0.0.1:4001/api#frag',
    'http://127.0.0.1:4001/?',
  ];

  it.each(BAD)('rejects %s naming REST_BASE_URL without logging', async (bad) => {
    const startFromEnv = await loadStart();
    const lines: string[] = [];
    let err: unknown;
    try {
      const r = await startFromEnv({ REST_BASE_URL: bad, PORT: '0' }, (l) => lines.push(l));
      open.push(r);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('REST_BASE_URL');
    expect(lines).toEqual([]);
  });

  it('nothing listens: a later start on the same explicit PORT succeeds', async () => {
    const startFromEnv = await loadStart();
    const port = await freePort();
    const lines: string[] = [];
    for (const bad of BAD) {
      await expect(
        startFromEnv({ REST_BASE_URL: bad, PORT: String(port) }, (l) => lines.push(l)),
      ).rejects.toThrow(/REST_BASE_URL/);
    }
    expect(lines).toEqual([]);
    const running = await startFromEnv(
      { REST_BASE_URL: backendOrigin, PORT: String(port) },
      (l) => lines.push(l),
    );
    open.push(running);
    expect(Number(new URL(running.url).port)).toBe(port);
  });
});

describe('EB9: existing REST_BASE_URL validation unchanged', () => {
  it.each(['localhost:4001', 'not a url', 'ftp://example.test'])(
    'still rejects %s naming REST_BASE_URL',
    async (bad) => {
      const startFromEnv = await loadStart();
      const lines: string[] = [];
      await expect(
        startFromEnv({ REST_BASE_URL: bad, PORT: '0' }, (l) => lines.push(l)),
      ).rejects.toThrow(/REST_BASE_URL/);
      expect(lines).toEqual([]);
    },
  );
});

describe('EB10: README is corrected', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

  it('drops the old limitation wording', () => {
    expect(readme).not.toContain('is dropped');
    expect(readme).not.toContain('Use an origin-only URL');
  });

  it('a REST_BASE_URL paragraph says the prefix is honoured and query/fragment rejected', () => {
    const paras = readme.split(/\n\s*\n/);
    const para = paras.find(
      (p) => p.includes('REST_BASE_URL') && /path prefix/i.test(p) && p.includes('/api/v1'),
    );
    expect(para, 'no REST_BASE_URL paragraph mentioning a /api/v1 path prefix').toBeDefined();
    expect(para!).toMatch(/honou?red/i);
    expect(para!).toMatch(/query string/i);
    expect(para!).toMatch(/fragment/i);
    expect(para!).toMatch(/reject/i);
  });
});
