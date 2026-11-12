import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend } from '../src/rest-backend/server';
import {
  createGateway,
  NAIVE,
  BATCHED,
  type GatewayOptions,
  type DownstreamCallEvent,
} from '../src/lib';

/**
 * iter-77: `createGateway({ onDownstreamCall })` operator hook (PRODUCT row 71).
 *
 * Black-box: one node:http stub on 127.0.0.1 forwards to the bundled Fastify
 * backend, optionally under an `/api/v1` prefix, and can fail exactly ONE route
 * (500, 2xx html, hang, or reset mid-body after a 2xx status line). It counts
 * every request per route path: that is the third, independent call count the
 * hook events are checked against, next to `extensions.downstreamCalls.total`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const ROUTES = ['/authors', '/authors/by-ids', '/books/by-author', '/books/by-ids', '/reviews/by-book'];
const PREFIX = '/api/v1';

type FailKind = '500' | 'html' | 'hang' | 'reset';
let fail: { route: string; kind: FailKind } | null = null;
let hits: string[] = [];
let seenAuth: string[] = [];
const hung: ServerResponse[] = [];

let backend: FastifyInstance;
let realUrl: string;
let stub: Server;
let stubUrl: string;

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
  let path = u.pathname;
  if (path.startsWith(PREFIX + '/')) path = path.slice(PREFIX.length);
  hits.push(path);
  const auth = req.headers.authorization;
  if (typeof auth === 'string') seenAuth.push(auth);
  if (fail && fail.route === path) {
    switch (fail.kind) {
      case '500':
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      case 'html':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body>maintenance</body></html>');
        return;
      case 'hang':
        hung.push(res);
        return;
      case 'reset':
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
        res.write('{"items":[');
        setTimeout(() => res.socket?.destroy(), 10);
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
  stubUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  for (const r of hung) r.destroy();
  stub.closeAllConnections();
  await new Promise<void>((ok) => stub.close(() => ok()));
  await backend.close();
});

beforeEach(() => {
  fail = null;
  hits = [];
  seenAuth = [];
});

type Gql = {
  data?: any;
  errors?: Array<{ message: string; path?: unknown[]; extensions?: Record<string, unknown> }>;
  extensions?: any;
};
type Gw = ReturnType<typeof createGateway>;

async function post(gw: Gw, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await gw.fetch('http://localhost/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function gql(gw: Gw, query: string, headers: Record<string, string> = {}): Promise<Gql> {
  return (await post(gw, { query }, headers)).json as Gql;
}

async function withGw<T>(opts: Partial<GatewayOptions> & { restBaseUrl: string }, fn: (gw: Gw) => Promise<T>): Promise<T> {
  const gw = createGateway(opts as GatewayOptions);
  try {
    return await fn(gw);
  } finally {
    await gw.close();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** "Settled": wait until events.length === total, capped at 1 s. */
async function settle(events: unknown[], total: number): Promise<void> {
  const until = Date.now() + 1000;
  while (events.length < total && Date.now() < until) await sleep(5);
  // small grace window so an EXTRA event would also be seen
  await sleep(20);
}

function recorder(): { events: DownstreamCallEvent[]; hook: (e: DownstreamCallEvent) => void } {
  const events: DownstreamCallEvent[] = [];
  return { events, hook: (e) => void events.push(e) };
}

const NESTED = '{ authors(first:5){ edges{ node{ id books{ id reviews{ id } } } } } }';
const AUTHOR = '{ author(id:"a1"){ id books{ id reviews{ id } } } }';
const BOOK_AUTHOR = '{ book(id:"a1-b1"){ author{ books{ id } } } }';

function totalOf(r: Gql): number {
  const t = r.extensions?.downstreamCalls?.total;
  if (typeof t !== 'number') throw new Error(`no downstreamCalls.total in ${JSON.stringify(r)}`);
  return t;
}

// ---------- EB1 ----------
describe('EB1 - option accepted, default off', () => {
  it('createGateway with onDownstreamCall: fn does not throw', async () => {
    const gw = createGateway({ restBaseUrl: stubUrl, onDownstreamCall: () => {} });
    expect(typeof gw.fetch).toBe('function');
    await gw.close();
  });

  it('omitted vs explicit undefined: identical status, data, errors, extensions', async () => {
    for (const q of [NESTED, AUTHOR, BOOK_AUTHOR, '{ author(id:"nope"){ id } }']) {
      const a = await withGw({ restBaseUrl: stubUrl }, (gw) => post(gw, { query: q }));
      const b = await withGw({ restBaseUrl: stubUrl, onDownstreamCall: undefined }, (gw) => post(gw, { query: q }));
      expect(b.status).toBe(a.status);
      expect(b.json).toEqual(a.json);
    }
  });

  it('default-off response is the unchanged contract (no new extension keys, 3 calls)', async () => {
    const r = await withGw({ restBaseUrl: stubUrl }, (gw) => gql(gw, NESTED));
    expect(r.errors).toBeUndefined();
    expect(r.data.authors.edges).toHaveLength(5);
    expect(r.extensions.downstreamCalls).toEqual({ total: 3 });
    expect(hits).toHaveLength(3);
  });
});

// ---------- EB2 ----------
describe('EB2 - validated like the other options', () => {
  it.each([
    [null, 'null'],
    ['fn', '"fn"'],
    [42, '42'],
    [{}, null],
  ] as Array<[unknown, string | null]>)('onDownstreamCall = %j throws TypeError', (bad, rendered) => {
    let err: unknown;
    try {
      createGateway({ restBaseUrl: stubUrl, onDownstreamCall: bad } as unknown as GatewayOptions);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).constructor).toBe(TypeError);
    expect((err as Error).message).toContain('onDownstreamCall must be a function');
    if (rendered !== null) expect((err as Error).message).toContain(rendered);
  });

  it('typo key onDownstreamcall gets the unknown-key TypeError with a suggestion', () => {
    let err: unknown;
    try {
      createGateway({ restBaseUrl: stubUrl, onDownstreamcall: () => {} } as unknown as GatewayOptions);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toContain('(did you mean onDownstreamCall?)');
  });
});

// ---------- EB3 ----------
describe('EB3 - one event per sent call', () => {
  it('BATCHED nested: 3 events, routes /authors, /books/by-author, /reviews/by-book in order', async () => {
    const { events, hook } = recorder();
    const r = await withGw({ restBaseUrl: stubUrl, onDownstreamCall: hook }, (gw) => gql(gw, NESTED));
    await settle(events, totalOf(r));
    expect(totalOf(r)).toBe(3);
    expect(events).toHaveLength(3);
    expect(hits).toHaveLength(3);
    expect(events.map((e) => e.route)).toEqual(['/authors', '/books/by-author', '/reviews/by-book']);
  });

  it('NAIVE nested: 21 events == total == stub hits', async () => {
    const { events, hook } = recorder();
    const r = await withGw({ restBaseUrl: stubUrl, loaderOptions: NAIVE, onDownstreamCall: hook }, (gw) => gql(gw, NESTED));
    await settle(events, totalOf(r));
    expect(totalOf(r)).toBe(21);
    expect(events).toHaveLength(21);
    expect(hits).toHaveLength(21);
    const count = (p: string) => events.filter((e) => e.route === p).length;
    expect([count('/authors'), count('/books/by-author'), count('/reviews/by-book')]).toEqual([1, 5, 15]);
  });

  it.each([
    ['author(id) nested', AUTHOR],
    ['book(id) -> author -> books', BOOK_AUTHOR],
  ])('%s: 3 events == total', async (_n, q) => {
    const { events, hook } = recorder();
    const r = await withGw({ restBaseUrl: stubUrl, loaderOptions: BATCHED, onDownstreamCall: hook }, (gw) => gql(gw, q));
    await settle(events, totalOf(r));
    expect(r.errors).toBeUndefined();
    expect(totalOf(r)).toBe(3);
    expect(events).toHaveLength(3);
    expect(hits).toHaveLength(3);
  });

  it('maxDownstreamCalls: 2 on book->author->books: total 2 and exactly 2 events after settling', async () => {
    const { events, hook } = recorder();
    const r = await withGw({ restBaseUrl: stubUrl, maxDownstreamCalls: 2, onDownstreamCall: hook }, (gw) =>
      gql(gw, BOOK_AUTHOR),
    );
    await settle(events, totalOf(r));
    await sleep(100);
    expect(totalOf(r)).toBe(2);
    expect(events).toHaveLength(2);
    expect(hits).toHaveLength(2);
  });
});

// ---------- EB4 ----------
describe('EB4 - budget-refused calls never fire', () => {
  it('maxDownstreamCalls: 1 on a 3-call query: BUDGET error, total 1, 1 event', async () => {
    const { events, hook } = recorder();
    const r = await withGw({ restBaseUrl: stubUrl, maxDownstreamCalls: 1, onDownstreamCall: hook }, (gw) =>
      gql(gw, AUTHOR),
    );
    await settle(events, totalOf(r));
    await sleep(100);
    expect(r.errors?.some((e) => e.extensions?.code === 'DOWNSTREAM_BUDGET_EXCEEDED')).toBe(true);
    expect(totalOf(r)).toBe(1);
    expect(events).toHaveLength(1);
    expect(hits).toHaveLength(1);
  });
});

// ---------- EB5 ----------
describe('EB5 - event shape', () => {
  it('own keys are exactly route/status/durationMs/outcome/errorCode; route is a template', async () => {
    const { events, hook } = recorder();
    const queries = [NESTED, AUTHOR, BOOK_AUTHOR, '{ book(id:"a1-b1"){ id reviews{ id } } }', '{ authors(first:2){ edges{ node{ books{ author{ id } } } } } }'];
    await withGw({ restBaseUrl: stubUrl, onDownstreamCall: hook }, async (gw) => {
      for (const q of queries) {
        const before = events.length;
        const r = await gql(gw, q);
        await settle(events, before + totalOf(r));
      }
    });
    expect(events.length).toBeGreaterThanOrEqual(10);
    for (const e of events) {
      expect(Object.getPrototypeOf(e) === Object.prototype || Object.getPrototypeOf(e) === null).toBe(true);
      expect(Object.keys(e).sort()).toEqual(['durationMs', 'errorCode', 'outcome', 'route', 'status']);
      expect(ROUTES).toContain(e.route);
      expect(e.route).not.toMatch(/[?]|a1|127\.0\.0\.1|localhost|:\d/);
    }
    const s = JSON.stringify(events);
    expect(s).not.toContain(stubUrl);
    expect(s).not.toContain('127.0.0.1');
    expect(s).not.toContain('a1');
  });

  it('base URL with /api/v1 prefix: route is still the template', async () => {
    const { events, hook } = recorder();
    const r = await withGw({ restBaseUrl: stubUrl + PREFIX, onDownstreamCall: hook }, (gw) => gql(gw, NESTED));
    await settle(events, totalOf(r));
    expect(r.errors).toBeUndefined();
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.route)).toEqual(['/authors', '/books/by-author', '/reviews/by-book']);
    expect(JSON.stringify(events)).not.toContain('/api');
  });

  it('forwarded authorization value never appears in any event', async () => {
    const { events, hook } = recorder();
    const r = await withGw(
      { restBaseUrl: stubUrl, forwardHeaders: ['authorization'], onDownstreamCall: hook },
      (gw) => gql(gw, NESTED, { authorization: 'Bearer secret-token' }),
    );
    await settle(events, totalOf(r));
    expect(seenAuth).toEqual(['Bearer secret-token', 'Bearer secret-token', 'Bearer secret-token']);
    expect(events).toHaveLength(3);
    for (const e of events) expect(JSON.stringify(e)).not.toContain('secret-token');
  });
});

// ---------- EB6 ----------
describe('EB6 - success', () => {
  it('2xx on-contract: outcome ok, status 200, errorCode null, finite durationMs >= 0', async () => {
    const { events, hook } = recorder();
    const r = await withGw({ restBaseUrl: stubUrl, onDownstreamCall: hook }, (gw) => gql(gw, NESTED));
    await settle(events, totalOf(r));
    expect(events).toHaveLength(3);
    for (const e of events) {
      expect(e.outcome).toBe('ok');
      expect(e.status).toBe(200);
      expect(e.errorCode).toBeNull();
      expect(Number.isFinite(e.durationMs)).toBe(true);
      expect(e.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('latencyMs: 50 backend: every event of author(id){id} has durationMs >= 40', async () => {
    const slow = buildBackend({ latencyMs: 50 }).app;
    const url = await slow.listen({ port: 0, host: '127.0.0.1' });
    try {
      const { events, hook } = recorder();
      const r = await withGw({ restBaseUrl: url, onDownstreamCall: hook }, (gw) => gql(gw, '{ author(id:"a1"){ id } }'));
      await settle(events, totalOf(r));
      expect(r.data.author.id).toBe('a1');
      expect(events.length).toBe(totalOf(r));
      expect(events.length).toBeGreaterThanOrEqual(1);
      for (const e of events) {
        expect(e.outcome).toBe('ok');
        expect(e.durationMs).toBeGreaterThanOrEqual(40);
      }
    } finally {
      await slow.close();
    }
  });
});

// ---------- EB7 ----------
function codesOf(r: Gql): unknown[] {
  return (r.errors ?? []).map((e) => e.extensions?.code);
}

describe('EB7 - failure outcomes match what the client sees', () => {
  it.each([
    ['500', 'http_error', 500, 'DOWNSTREAM_ERROR'],
    ['html', 'bad_response', 200, 'DOWNSTREAM_BAD_RESPONSE'],
  ] as Array<[FailKind, string, number, string]>)(
    '/books/by-author %s -> outcome %s, status %s, errorCode %s; other routes ok',
    async (kind, outcome, status, code) => {
      fail = { route: '/books/by-author', kind };
      const { events, hook } = recorder();
      const r = await withGw({ restBaseUrl: stubUrl, onDownstreamCall: hook }, (gw) =>
        gql(gw, '{ author(id:"a1"){ id books{ id } } book(id:"a2-b1"){ id reviews{ id } } }'),
      );
      await settle(events, totalOf(r));
      expect(events.length).toBe(totalOf(r));
      expect(events.length).toBe(hits.length);
      const bad = events.filter((e) => e.route === '/books/by-author');
      expect(bad).toHaveLength(1);
      expect(bad[0]).toEqual({ route: '/books/by-author', status, durationMs: bad[0]!.durationMs, outcome, errorCode: code });
      expect(codesOf(r)).toContain(code);
      expect(new Set(codesOf(r))).toEqual(new Set([bad[0]!.errorCode]));
      const others = events.filter((e) => e.route !== '/books/by-author');
      expect(others.length).toBeGreaterThanOrEqual(1);
      for (const e of others) expect(e).toMatchObject({ outcome: 'ok', status: 200, errorCode: null });
    },
  );

  it('connection refused -> unreachable, status null, DOWNSTREAM_UNREACHABLE', async () => {
    const port = await closedPort();
    const { events, hook } = recorder();
    const r = await withGw({ restBaseUrl: `http://127.0.0.1:${port}`, onDownstreamCall: hook }, (gw) =>
      gql(gw, '{ author(id:"a1"){ id } }'),
    );
    await settle(events, totalOf(r));
    expect(totalOf(r)).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: null, outcome: 'unreachable', errorCode: 'DOWNSTREAM_UNREACHABLE' });
    expect(codesOf(r)).toEqual([events[0]!.errorCode]);
  });

  it('no headers within downstreamTimeoutMs: 50 -> timeout, status null, DOWNSTREAM_TIMEOUT; others ok', async () => {
    fail = { route: '/reviews/by-book', kind: 'hang' };
    const { events, hook } = recorder();
    const r = await withGw({ restBaseUrl: stubUrl, downstreamTimeoutMs: 50, onDownstreamCall: hook }, (gw) =>
      gql(gw, '{ author(id:"a1"){ id books{ id } } book(id:"a2-b1"){ id reviews{ id } } }'),
    );
    await settle(events, totalOf(r));
    expect(events.length).toBe(totalOf(r));
    const bad = events.filter((e) => e.route === '/reviews/by-book');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ status: null, outcome: 'timeout', errorCode: 'DOWNSTREAM_TIMEOUT' });
    expect(bad[0]!.durationMs).toBeGreaterThanOrEqual(40);
    expect(new Set(codesOf(r))).toEqual(new Set(['DOWNSTREAM_TIMEOUT']));
    const others = events.filter((e) => e.route !== '/reviews/by-book');
    expect(others.length).toBeGreaterThanOrEqual(1);
    for (const e of others) expect(e).toMatchObject({ outcome: 'ok', status: 200, errorCode: null });
  });
});

// ---------- EB8 ----------
describe('EB8 - any other failure fires exactly once', () => {
  it('body reset after a 2xx status line: one event, outcome unreachable, errorCode DOWNSTREAM_UNREACHABLE, status 200 (re-pinned iter-90, row 89)', async () => {
    fail = { route: '/books/by-author', kind: 'reset' };
    const { events, hook } = recorder();
    const r = await withGw({ restBaseUrl: stubUrl, onDownstreamCall: hook }, (gw) =>
      gql(gw, '{ author(id:"a1"){ id books{ id } } }'),
    );
    await settle(events, totalOf(r));
    await sleep(50);
    expect(r.errors?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(events.length).toBe(totalOf(r));
    expect(events.length).toBe(hits.length);
    const bad = events.filter((e) => e.route === '/books/by-author');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ outcome: 'unreachable', errorCode: 'DOWNSTREAM_UNREACHABLE', status: 200 });
  });
});

// ---------- EB9 ----------
describe('EB9 - the hook can never change a response', () => {
  it.each([
    ['sync throw', () => {
      throw new Error('hook boom');
    }],
    ['async reject', async () => {
      throw new Error('hook async boom');
    }],
    ['never-settling promise', () => new Promise<void>(() => {})],
  ] as Array<[string, (e: DownstreamCallEvent) => unknown]>)('%s: status + body deep-equal to no-hook run', async (_n, bad) => {
    const base = await withGw({ restBaseUrl: stubUrl }, (gw) => post(gw, { query: NESTED }));
    const rejections: unknown[] = [];
    const onRej = (r: unknown) => void rejections.push(r);
    process.on('unhandledRejection', onRej);
    let calls = 0;
    try {
      const hook = (e: DownstreamCallEvent) => {
        calls++;
        return bad(e);
      };
      const got = await withGw({ restBaseUrl: stubUrl, onDownstreamCall: hook as (e: DownstreamCallEvent) => void }, (gw) =>
        post(gw, { query: NESTED }),
      );
      const until = Date.now() + 1000;
      while (calls < 3 && Date.now() < until) await sleep(5);
      await sleep(50);
      expect(got.status).toBe(base.status);
      expect(got.json).toEqual(base.json);
      expect(got.json.extensions.downstreamCalls.total).toBe(3);
      expect(calls).toBe(3);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRej);
    }
  });

  it('hook is not awaited: a never-settling hook still lets the response resolve promptly', async () => {
    let calls = 0;
    const t0 = Date.now();
    const got = await withGw(
      { restBaseUrl: stubUrl, onDownstreamCall: (() => { calls++; return new Promise(() => {}); }) as () => void },
      (gw) => post(gw, { query: NESTED }),
    );
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(got.status).toBe(200);
    expect(got.json.data.authors.edges).toHaveLength(5);
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});

// ---------- EB10 ----------
describe('EB10 - per-request isolation and batching', () => {
  it('two concurrent requests on one hook: events == sum of totals', async () => {
    const { events, hook } = recorder();
    await withGw({ restBaseUrl: stubUrl, onDownstreamCall: hook }, async (gw) => {
      const [a, b] = await Promise.all([gql(gw, NESTED), gql(gw, AUTHOR)]);
      const sum = totalOf(a) + totalOf(b);
      await settle(events, sum);
      expect(totalOf(a)).toBe(3);
      expect(totalOf(b)).toBe(3);
      expect(events).toHaveLength(sum);
      expect(hits).toHaveLength(sum);
    });
  });

  it('maxBatchSize 5, batch of 2 identical ops: events == shared total, not the sum', async () => {
    const { events, hook } = recorder();
    const out = await withGw({ restBaseUrl: stubUrl, maxBatchSize: 5, onDownstreamCall: hook }, (gw) =>
      post(gw, [{ query: NESTED }, { query: NESTED }]),
    );
    expect(out.status).toBe(200);
    expect(Array.isArray(out.json)).toBe(true);
    const totals = (out.json as Gql[]).map(totalOf);
    const shared = Math.max(...totals);
    await settle(events, shared);
    await sleep(50);
    expect(shared).toBe(3);
    expect(totals).toEqual([3, 3]);
    expect(events).toHaveLength(shared);
    expect(events.length).not.toBe(totals[0]! + totals[1]!);
    expect(hits).toHaveLength(shared);
  });
});

// ---------- EB11 ----------
describe('EB11 - probes and validation-rejected queries fire nothing', () => {
  it('GET /readyz: 0 events (but the probe itself hit the backend once)', async () => {
    const { events, hook } = recorder();
    await withGw({ restBaseUrl: stubUrl, onDownstreamCall: hook }, async (gw) => {
      const res = await gw.fetch('http://localhost/readyz');
      expect(res.status).toBe(200);
      await res.text();
    });
    await sleep(50);
    expect(hits).toEqual(['/authors']);
    expect(events).toEqual([]);
  });

  it('GET /healthz: 0 events', async () => {
    const { events, hook } = recorder();
    await withGw({ restBaseUrl: stubUrl, onDownstreamCall: hook }, async (gw) => {
      const res = await gw.fetch('http://localhost/healthz');
      expect(res.status).toBe(200);
      await res.text();
    });
    await sleep(30);
    expect(events).toEqual([]);
    expect(hits).toEqual([]);
  });

  it('QUERY_TOO_DEEP and QUERY_TOO_COMPLEX rejections: 0 events', async () => {
    const { events, hook } = recorder();
    await withGw({ restBaseUrl: stubUrl, maxDepth: 2, onDownstreamCall: hook }, async (gw) => {
      const r = await gql(gw, NESTED);
      expect(codesOf(r)).toContain('QUERY_TOO_DEEP');
    });
    await withGw({ restBaseUrl: stubUrl, maxComplexity: 1, onDownstreamCall: hook }, async (gw) => {
      const r = await gql(gw, NESTED);
      expect(codesOf(r)).toContain('QUERY_TOO_COMPLEX');
    });
    await sleep(30);
    expect(events).toEqual([]);
    expect(hits).toEqual([]);
  });
});

// ---------- EB12 ----------
describe('EB12 - exported type and docs', () => {
  it('DownstreamCallEvent is exported and type-checks (enforced by tsc --noEmit)', () => {
    const e: DownstreamCallEvent = { route: '/authors', status: 200, durationMs: 1, outcome: 'ok', errorCode: null };
    const f: DownstreamCallEvent = {
      route: '/books/by-author',
      status: null,
      durationMs: 0,
      outcome: 'timeout',
      errorCode: 'DOWNSTREAM_TIMEOUT',
    };
    expect(e.outcome).toBe('ok');
    expect(f.status).toBeNull();
    const opts: GatewayOptions = { restBaseUrl: 'http://127.0.0.1:1', onDownstreamCall: (ev: DownstreamCallEvent) => void ev.route };
    expect(typeof opts.onDownstreamCall).toBe('function');
  });

  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

  it('README exported-symbols list names DownstreamCallEvent', () => {
    const line = readme.split('\n').find((l) => l.startsWith('Exported symbols:'));
    expect(line).toBeDefined();
    expect(line).toContain('DownstreamCallEvent');
  });

  it('README GatewayOptions table has an onDownstreamCall row', () => {
    expect(readme.split('\n').some((l) => l.startsWith('| `onDownstreamCall` |'))).toBe(true);
  });

  it('README §7 Observability describes the hook', () => {
    const lines = readme.split('\n');
    const start = lines.findIndex((l) => l.trim() === '### Observability');
    expect(start).toBeGreaterThan(-1);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^#{2,3} /.test(lines[i]!)) {
        end = i;
        break;
      }
    }
    const sec = lines.slice(start, end).join('\n');
    expect(sec).toContain('onDownstreamCall');
    for (const w of ['route', 'status', 'durationMs', 'outcome', 'errorCode']) expect(sec).toContain(w);
    for (const o of ['ok', 'http_error', 'bad_response', 'unreachable', 'timeout', 'other']) expect(sec).toContain(`\`${o}\``);
    expect(sec).toContain('maxDownstreamCalls');
    expect(sec).toContain('/readyz');
    expect(sec).toMatch(/once/);
    expect(sec).toMatch(/after its response|after the response/);
    expect(sec).toMatch(/swallowed/);
  });
});
