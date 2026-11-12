import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway, type GatewayOptions, type DownstreamCallEvent } from '../src/lib';

/**
 * iter-90: typed body-read failures (PRODUCT row 89).
 *
 * Black-box: one node:http stub on 127.0.0.1 that either fails EVERY route
 * (EB1-EB6: a 2xx body that stalls, or resets mid-body) or proxies to the
 * bundled Fastify backend and fails exactly ONE route (EB5 nested, EB7, EB8).
 * Client errors, `onDownstreamCall` events and `/readyz` must all carry the
 * same typed code instead of an untyped "Unexpected error.".
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

type Kind = 'stall' | 'reset' | 'header-stall' | '500' | 'html' | 'offcontract';
/** route === '*' fails every route; otherwise only that route fails and the rest is proxied. */
let fail: { route: string; kind: Kind } | null = null;
let hits: string[] = [];
const open: ServerResponse[] = [];

let backend: FastifyInstance;
let realUrl: string;
let stub: Server;
let stubUrl: string;
let stubPort: number;

async function forward(path: string, search: string, res: ServerResponse): Promise<void> {
  try {
    const r = await fetch(realUrl + path + search);
    const text = await r.text();
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
    res.end(text);
  } catch {
    res.writeHead(502);
    res.end();
  }
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const u = new URL(req.url ?? '/', 'http://stub.local');
  const path = u.pathname;
  hits.push(path);
  if (fail && (fail.route === '*' || fail.route === path)) {
    switch (fail.kind) {
      case 'stall':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"id":"a1",');
        open.push(res);
        return;
      case 'reset':
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
        res.write('{"id":"a1",');
        setTimeout(() => res.socket?.destroy(), 30);
        return;
      case 'header-stall':
        open.push(res);
        return;
      case '500':
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      case 'html':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body>maintenance</body></html>');
        return;
      case 'offcontract':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ nope: true }));
        return;
    }
  }
  void forward(path, u.search, res);
}

async function closedPort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const addr = srv.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  await new Promise<void>((r) => srv.close(() => r()));
  return addr.port;
}

beforeAll(async () => {
  backend = buildBackend({ latencyMs: 0 }).app;
  realUrl = await backend.listen({ port: 0, host: '127.0.0.1' });
  stub = createServer(handle);
  await new Promise<void>((ok) => stub.listen(0, '127.0.0.1', () => ok()));
  const addr = stub.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  stubPort = addr.port;
  stubUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  for (const r of open) r.destroy();
  stub.closeAllConnections();
  await new Promise<void>((ok) => stub.close(() => ok()));
  await backend.close();
});

beforeEach(() => {
  fail = null;
  hits = [];
});

type GqlErr = { message: string; path?: unknown[]; extensions?: Record<string, unknown> };
type Gql = { data?: any; errors?: GqlErr[]; extensions?: any };
type Gw = ReturnType<typeof createGateway>;

async function post(gw: Gw, query: string): Promise<{ status: number; json: Gql }> {
  const res = await gw.fetch('http://localhost/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { status: res.status, json: (await res.json()) as Gql };
}

async function withGw<T>(opts: Partial<GatewayOptions> & { restBaseUrl: string }, fn: (gw: Gw) => Promise<T>): Promise<T> {
  const gw = createGateway(opts as GatewayOptions);
  try {
    return await fn(gw);
  } finally {
    await gw.close();
  }
}

async function readyz(opts: Partial<GatewayOptions> & { restBaseUrl: string }): Promise<{ status: number; body: unknown }> {
  return withGw(opts, async (gw) => {
    const r = await gw.fetch('http://localhost/readyz');
    return { status: r.status, body: await r.json() };
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function recorder(): { events: DownstreamCallEvent[]; hook: (e: DownstreamCallEvent) => void } {
  const events: DownstreamCallEvent[] = [];
  return { events, hook: (e) => void events.push(e) };
}

async function settle(events: unknown[], total: number): Promise<void> {
  const until = Date.now() + 1500;
  while (events.length < total && Date.now() < until) await sleep(5);
  await sleep(40);
}

function totalOf(r: Gql): number {
  const t = r.extensions?.downstreamCalls?.total;
  if (typeof t !== 'number') throw new Error(`no downstreamCalls.total in ${JSON.stringify(r)}`);
  return t;
}

const AUTHOR = '{ author(id:"a1"){ id } }';
const TIMEOUT_MSG = 'Downstream request to /authors/by-ids timed out after 300ms';
const UNREACH_MSG = 'Downstream request to /authors/by-ids failed: backend unreachable';

async function stallRun(hook?: (e: DownstreamCallEvent) => void): Promise<{ status: number; json: Gql; ms: number }> {
  fail = { route: '*', kind: 'stall' };
  return withGw({ restBaseUrl: stubUrl, downstreamTimeoutMs: 300, onDownstreamCall: hook }, async (gw) => {
    const t0 = Date.now();
    const r = await post(gw, AUTHOR);
    return { ...r, ms: Date.now() - t0 };
  });
}

async function resetRun(hook?: (e: DownstreamCallEvent) => void): Promise<{ status: number; json: Gql }> {
  fail = { route: '*', kind: 'reset' };
  return withGw({ restBaseUrl: stubUrl, onDownstreamCall: hook }, (gw) => post(gw, AUTHOR));
}

// ---------- EB1 ----------
describe('EB1 - a 2xx body that stalls past downstreamTimeoutMs is DOWNSTREAM_TIMEOUT', () => {
  it('HTTP 200, data.author null, exactly 1 typed timeout error at path [author], 1 call', async () => {
    const r = await stallRun();
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ author: null });
    expect(r.json.errors).toHaveLength(1);
    const e = r.json.errors![0]!;
    expect(e.extensions?.code).toBe('DOWNSTREAM_TIMEOUT');
    expect(e.message).toBe(TIMEOUT_MSG);
    expect(e.path).toEqual(['author']);
    expect(totalOf(r.json)).toBe(1);
    expect(hits.filter((h) => h === '/authors/by-ids')).toHaveLength(1);
  });
});

// ---------- EB2 ----------
describe('EB2 - stall time bound', () => {
  it('settles no earlier than 300 ms, and the fastest of 3 runs settles under 1500 ms', async () => {
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await stallRun();
      expect(r.json.errors?.[0]?.extensions?.code).toBe('DOWNSTREAM_TIMEOUT');
      times.push(r.ms);
    }
    for (const t of times) expect(t).toBeGreaterThanOrEqual(295);
    expect(Math.min(...times)).toBeLessThan(1500);
  }, 15_000);
});

// ---------- EB3 ----------
describe('EB3 - a 2xx body whose connection resets mid-read is DOWNSTREAM_UNREACHABLE', () => {
  it('data.author null, exactly 1 typed unreachable error, 1 call', async () => {
    const r = await resetRun();
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ author: null });
    expect(r.json.errors).toHaveLength(1);
    const e = r.json.errors![0]!;
    expect(e.extensions?.code).toBe('DOWNSTREAM_UNREACHABLE');
    expect(e.message).toBe(UNREACH_MSG);
    expect(e.path).toEqual(['author']);
    expect(totalOf(r.json)).toBe(1);
  });
});

// ---------- EB4 ----------
describe('EB4 - no leaks, nothing untyped', () => {
  it.each([
    ['stall', stallRun],
    ['reset', resetRun],
  ] as const)('%s: no INTERNAL_SERVER_ERROR / Unexpected error, no topology or runtime error names', async (_n, run) => {
    const r = await run();
    const errs = r.json.errors ?? [];
    expect(errs.length).toBeGreaterThanOrEqual(1);
    for (const e of errs) {
      expect(e.extensions?.code).not.toBe('INTERNAL_SERVER_ERROR');
      expect(e.message).not.toBe('Unexpected error.');
    }
    const s = JSON.stringify(errs);
    for (const bad of [String(stubPort), '127.0.0.1', 'terminated', 'TimeoutError', 'AbortError', 'Unexpected error', 'INTERNAL_SERVER_ERROR']) {
      expect(s).not.toContain(bad);
    }
  });
});

// ---------- EB5 ----------
describe('EB5 - onDownstreamCall events carry the same typed outcome', () => {
  it('stall: one event per call; the /authors/by-ids event is timeout / DOWNSTREAM_TIMEOUT / 200', async () => {
    const { events, hook } = recorder();
    const r = await stallRun(hook);
    await settle(events, totalOf(r.json));
    expect(events.length).toBe(totalOf(r.json));
    const bad = events.filter((e) => e.route === '/authors/by-ids');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ route: '/authors/by-ids', outcome: 'timeout', errorCode: 'DOWNSTREAM_TIMEOUT', status: 200 });
  });

  it('reset: one event per call; the event is unreachable / DOWNSTREAM_UNREACHABLE / 200', async () => {
    const { events, hook } = recorder();
    const r = await resetRun(hook);
    await settle(events, totalOf(r.json));
    expect(events.length).toBe(totalOf(r.json));
    const bad = events.filter((e) => e.route === '/authors/by-ids');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ route: '/authors/by-ids', outcome: 'unreachable', errorCode: 'DOWNSTREAM_UNREACHABLE', status: 200 });
  });

  it('nested reset (only /books/by-author resets): that event is unreachable / 200, every other event ok', async () => {
    fail = { route: '/books/by-author', kind: 'reset' };
    const { events, hook } = recorder();
    const r = await withGw({ restBaseUrl: stubUrl, onDownstreamCall: hook }, (gw) => post(gw, '{ author(id:"a1"){ id books{ id } } }'));
    await settle(events, totalOf(r.json));
    expect(events.length).toBe(totalOf(r.json));
    expect(events.length).toBe(hits.length);
    const bad = events.filter((e) => e.route === '/books/by-author');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ outcome: 'unreachable', errorCode: 'DOWNSTREAM_UNREACHABLE', status: 200 });
    const rest = events.filter((e) => e.route !== '/books/by-author');
    expect(rest.length).toBeGreaterThanOrEqual(1);
    for (const e of rest) expect(e).toMatchObject({ outcome: 'ok', errorCode: null });
    const codes = (r.json.errors ?? []).map((e) => e.extensions?.code);
    expect(codes).toContain('DOWNSTREAM_UNREACHABLE');
    expect(codes).not.toContain('INTERNAL_SERVER_ERROR');
  });
});

// ---------- EB6 ----------
describe('EB6 - /readyz agrees with GraphQL clients', () => {
  it('stall stub, downstreamTimeoutMs 300: 503 DOWNSTREAM_TIMEOUT, same code as the client error', async () => {
    fail = { route: '*', kind: 'stall' };
    const p = await readyz({ restBaseUrl: stubUrl, downstreamTimeoutMs: 300 });
    expect(p.status).toBe(503);
    expect(p.body).toEqual({ status: 'unready', code: 'DOWNSTREAM_TIMEOUT' });
    const c = await stallRun();
    expect(c.json.errors?.[0]?.extensions?.code).toBe((p.body as { code: string }).code);
  });

  it('reset stub: 503 DOWNSTREAM_UNREACHABLE, same code as the client error', async () => {
    fail = { route: '*', kind: 'reset' };
    const p = await readyz({ restBaseUrl: stubUrl });
    expect(p.status).toBe(503);
    expect(p.body).toEqual({ status: 'unready', code: 'DOWNSTREAM_UNREACHABLE' });
    const c = await resetRun();
    expect(c.json.errors?.[0]?.extensions?.code).toBe((p.body as { code: string }).code);
  });
});

// ---------- EB7 ----------
describe('EB7 - sibling data survives a stalled body', () => {
  it('author served, book nulled by a DOWNSTREAM_TIMEOUT on /reviews/by-book', async () => {
    const healthy = await withGw({ restBaseUrl: realUrl }, (gw) => post(gw, '{ author(id:"a1"){ id name } }'));
    expect(healthy.json.errors).toBeUndefined();
    fail = { route: '/reviews/by-book', kind: 'stall' };
    const r = await withGw({ restBaseUrl: stubUrl, downstreamTimeoutMs: 300 }, (gw) =>
      post(gw, '{ author(id:"a1"){ id name } book(id:"a1-b1"){ id reviews{ id } } }'),
    );
    expect(r.status).toBe(200);
    expect(r.json.data?.author).toEqual(healthy.json.data.author);
    expect(r.json.data?.author).toMatchObject({ id: 'a1' });
    expect(r.json.data?.book).toBeNull();
    expect(r.json.errors).toHaveLength(1);
    const e = r.json.errors![0]!;
    expect(e.extensions?.code).toBe('DOWNSTREAM_TIMEOUT');
    expect(e.message).toContain('/reviews/by-book');
    expect(e.path?.[0]).toBe('book');
  });
});

// ---------- EB8 ----------
describe('EB8 - unchanged paths', () => {
  it('canonical nested query against the bundled backend: exactly 3 calls, no errors', async () => {
    const r = await withGw({ restBaseUrl: realUrl }, (gw) =>
      post(gw, '{ authors(first:5){ edges{ node{ id books{ id reviews{ id rating } } } } } }'),
    );
    expect(r.json.errors).toBeUndefined();
    expect(r.json.data.authors.edges).toHaveLength(5);
    expect(totalOf(r.json)).toBe(3);
  });

  it('header stall (no headers within the timeout) is still DOWNSTREAM_TIMEOUT with status null', async () => {
    fail = { route: '*', kind: 'header-stall' };
    const { events, hook } = recorder();
    const r = await withGw({ restBaseUrl: stubUrl, downstreamTimeoutMs: 300, onDownstreamCall: hook }, (gw) => post(gw, AUTHOR));
    expect(r.json.errors).toHaveLength(1);
    expect(r.json.errors![0]!.extensions?.code).toBe('DOWNSTREAM_TIMEOUT');
    expect(r.json.errors![0]!.message).toBe(TIMEOUT_MSG);
    await settle(events, 1);
    expect(events[0]).toMatchObject({ outcome: 'timeout', errorCode: 'DOWNSTREAM_TIMEOUT', status: null });
  });

  it('closed port is still DOWNSTREAM_UNREACHABLE with the exact message', async () => {
    const port = await closedPort();
    const r = await withGw({ restBaseUrl: `http://127.0.0.1:${port}` }, (gw) => post(gw, AUTHOR));
    expect(r.json.errors).toHaveLength(1);
    expect(r.json.errors![0]!.extensions?.code).toBe('DOWNSTREAM_UNREACHABLE');
    expect(r.json.errors![0]!.message).toBe(UNREACH_MSG);
    expect(JSON.stringify(r.json.errors)).not.toContain(String(port));
  });

  it.each([
    ['500', 'DOWNSTREAM_ERROR'],
    ['html', 'DOWNSTREAM_BAD_RESPONSE'],
    ['offcontract', 'DOWNSTREAM_BAD_RESPONSE'],
  ] as const)('a %s answer keeps code %s, untouched by the body-read mapping', async (kind, code) => {
    fail = { route: '*', kind };
    const r = await withGw({ restBaseUrl: stubUrl }, (gw) => post(gw, AUTHOR));
    expect(r.json.data).toEqual({ author: null });
    expect(r.json.errors).toHaveLength(1);
    expect(r.json.errors![0]!.extensions?.code).toBe(code);
    expect(r.json.errors![0]!.message).toContain('/authors/by-ids');
    expect(totalOf(r.json)).toBe(1);
  });

  it('the N+1 regression test is byte-identical to HEAD, and the only edited old test is test_iter77', () => {
    const diff = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'test/'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(diff).not.toContain('test/n-plus-1.test.ts');
    for (const f of diff) expect(['test/test_iter77_behavior.test.ts']).toContain(f);
  });
});

// ---------- EB9 ----------
describe('EB9 - docs truth', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  const norm = readme.replace(/\s+/g, ' ');

  it('README no longer carries the "one known gap" mid-read clause', () => {
    expect(readme).not.toContain('one known gap');
    expect(norm).not.toMatch(/clients still get an untyped `?INTERNAL_SERVER_ERROR/);
  });

  it('README §7 states stall -> DOWNSTREAM_TIMEOUT and mid-read failure -> DOWNSTREAM_UNREACHABLE for clients and /readyz alike', () => {
    const start = norm.indexOf('`GET /readyz` tells a load balancer');
    expect(start).toBeGreaterThan(-1);
    const para = norm.slice(start, start + 4000);
    expect(para).toMatch(/stalls past `downstreamTimeoutMs` is `DOWNSTREAM_TIMEOUT`/);
    expect(para).toMatch(/mid-read is `DOWNSTREAM_UNREACHABLE`/);
    expect(para).toContain('for clients and `/readyz` alike');
    // the outbound-guard section says the deadline covers the body too
    expect(/body stalls past `downstreamTimeoutMs` fails the same way, with `DOWNSTREAM_TIMEOUT`/.test(norm)).toBe(true);
  });

  it('the DownstreamCallOutcome doc comment no longer cites a stalled or reset body as `other`', () => {
    const src = readFileSync(resolve(root, 'src/gateway/datasources/rest-client.ts'), 'utf8');
    const at = src.search(/export type DownstreamCallOutcome\b/);
    expect(at).toBeGreaterThan(-1);
    const before = src.slice(0, at);
    const open = before.lastIndexOf('/**');
    expect(open).toBeGreaterThan(-1);
    const end = src.indexOf('\n\n', at);
    const comment = src.slice(open, end === -1 ? undefined : end);
    expect(comment).toContain('*/');
    expect(comment).toContain('other');
    expect(comment).not.toMatch(/stall/i);
    expect(comment).not.toMatch(/reset/i);
    expect(comment).not.toMatch(/mid-(read|body)/i);
  });
});
