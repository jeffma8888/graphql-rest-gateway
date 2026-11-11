import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, buildBackend } from '../src/lib';

/**
 * iter-86: request errors raised while coercing VARIABLES carry
 * `extensions.code = "BAD_USER_INPUT"` (PRODUCT row 85).
 *
 * Black-box: the bundled backend runs in-process on port 0 behind a node:http
 * counting proxy. Downstream calls are agreed two ways (proxy hits and
 * `onDownstreamCall` events) plus `extensions.downstreamCalls.total` when present.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = readFileSync(path.join(REPO, 'README.md'), 'utf8');

type Gateway = ReturnType<typeof createGateway>;
type GqlError = {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
};
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
  extensions?: { downstreamCalls?: { total: number }; queryComplexity?: { cost: number; depth: number } };
};

const EB1_Q = 'query($n:Int){ authors(first:$n){ totalCount } }';
const EB1_BODY = { query: EB1_Q, variables: { n: 'x' } };
const SAMPLE = (() => {
  const m = /```graphql\n(query Sample[\s\S]*?)```/.exec(README);
  return m ? m[1]! : '';
})();

let backend: FastifyInstance;
let realUrl = '';
let proxy: Server;
let proxyUrl = '';
let hits: string[] = [];
let events: Array<{ route: string }> = [];
const gateways: Gateway[] = [];

function handle(req: IncomingMessage, res: ServerResponse): void {
  hits.push(req.url ?? '/');
  fetch(realUrl + (req.url ?? '/'))
    .then(async (r) => {
      const text = await r.text();
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
      res.end(text);
    })
    .catch(() => {
      res.writeHead(502);
      res.end();
    });
}

function gw(extra: Record<string, unknown> = {}, base?: string): Gateway {
  const g = createGateway({
    restBaseUrl: base ?? proxyUrl,
    onDownstreamCall: (e: { route: string }) => {
      events.push(e);
    },
    ...extra,
  } as Parameters<typeof createGateway>[0]);
  gateways.push(g);
  return g;
}

let gwDefault: Gateway;
let gwBatch: Gateway;
let gwTight: Gateway;

beforeAll(async () => {
  backend = buildBackend({ latencyMs: 0 }).app;
  realUrl = (await backend.listen({ port: 0, host: '127.0.0.1' })).replace(/\/$/, '');
  proxy = createServer(handle);
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  gwDefault = gw();
  gwBatch = gw({ maxBatchSize: 5 });
  gwTight = gw({ maxComplexity: 50 });
});

afterAll(async () => {
  await Promise.all(gateways.map((g) => g?.close?.()));
  await new Promise<void>((r) => proxy?.close(() => r()));
  await backend?.close();
});

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20)); // let late hook events settle
}

async function post(g: Gateway, body: unknown): Promise<{ status: number; body: unknown }> {
  hits = [];
  events = [];
  const res = await g.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const out = (await res.json()) as unknown;
  await settle();
  return { status: res.status, body: out };
}

async function get(g: Gateway, query: string, variables: unknown): Promise<{ status: number; body: GqlResult }> {
  hits = [];
  events = [];
  const qs = `query=${encodeURIComponent(query)}&variables=${encodeURIComponent(JSON.stringify(variables))}`;
  const res = await g.fetch(`http://gateway.local/graphql?${qs}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  const out = (await res.json()) as GqlResult;
  await settle();
  return { status: res.status, body: out };
}

/** Exact downstream call count: proxy hits, hook events and (when present) downstreamCalls.total. */
function expectCalls(n: number, body?: GqlResult): void {
  expect(hits).toHaveLength(n);
  expect(events).toHaveLength(n);
  const total = body?.extensions?.downstreamCalls?.total;
  if (body && n > 0) expect(total).toBe(n);
  else if (body) expect(total ?? 0).toBe(0);
}

const codes = (b: GqlResult) => (b.errors ?? []).map((e) => e.extensions?.code);

// ---------- EB1 ----------
describe('EB1 - bad scalar variable', () => {
  it('Int "x" -> 400, no data, 1 error with exact message/locations, extensions {code:BAD_USER_INPUT}, 0 calls', async () => {
    const r = await post(gwDefault, EB1_BODY);
    expect(r.status).toBe(400);
    const b = r.body as GqlResult;
    expect('data' in (b as object)).toBe(false);
    expect(b.errors).toHaveLength(1);
    const e = b.errors![0]!;
    expect(e.message).toBe('Variable "$n" got invalid value "x"; Int cannot represent non-integer value: "x"');
    expect(e.locations).toEqual([{ line: 1, column: 7 }]);
    expect(e.extensions).toEqual({ code: 'BAD_USER_INPUT' });
    expect(e.path).toBeUndefined();
    expectCalls(0, b);
  });
});

// ---------- EB2 ----------
describe('EB2 - missing required variable', () => {
  it('$id:ID! not provided -> 400, no data, exact message, BAD_USER_INPUT, 0 calls', async () => {
    const r = await post(gwDefault, { query: 'query($id:ID!){ author(id:$id){ id } }', variables: {} });
    expect(r.status).toBe(400);
    const b = r.body as GqlResult;
    expect('data' in (b as object)).toBe(false);
    expect(b.errors).toHaveLength(1);
    expect(b.errors![0]!.message).toBe('Variable "$id" of required type "ID!" was not provided.');
    expect(b.errors![0]!.extensions?.code).toBe('BAD_USER_INPUT');
    expectCalls(0, b);
  });

  it('variables key omitted entirely is coded the same way', async () => {
    const r = await post(gwDefault, { query: 'query($id:ID!){ author(id:$id){ id } }' });
    expect(r.status).toBe(400);
    const b = r.body as GqlResult;
    expect(codes(b)).toEqual(['BAD_USER_INPUT']);
    expectCalls(0, b);
  });
});

// ---------- EB3 ----------
describe('EB3 - null inside a non-null list', () => {
  it('ids:[null] -> 400, no data, 1 error mentioning ID! non-null, BAD_USER_INPUT, 0 calls', async () => {
    const r = await post(gwDefault, { query: 'query($ids:[ID!]!){ books(ids:$ids){ id } }', variables: { ids: [null] } });
    expect(r.status).toBe(400);
    const b = r.body as GqlResult;
    expect('data' in (b as object)).toBe(false);
    expect(b.errors).toHaveLength(1);
    expect(b.errors![0]!.message).toContain('Expected non-nullable type "ID!" not to be null');
    expect(b.errors![0]!.extensions?.code).toBe('BAD_USER_INPUT');
    expectCalls(0, b);
  });
});

// ---------- EB4 ----------
describe('EB4 - two bad variables', () => {
  it('bad $n and missing $id -> 400, exactly 2 errors both BAD_USER_INPUT, 0 calls', async () => {
    const r = await post(gwDefault, {
      query: 'query($n:Int,$id:ID!){ authors(first:$n){ totalCount } author(id:$id){ id } }',
      variables: { n: 'x' },
    });
    expect(r.status).toBe(400);
    const b = r.body as GqlResult;
    expect('data' in (b as object)).toBe(false);
    expect(b.errors).toHaveLength(2);
    expect(codes(b)).toEqual(['BAD_USER_INPUT', 'BAD_USER_INPUT']);
    expectCalls(0, b);
  });
});

// ---------- EB5 ----------
describe('EB5 - GET form', () => {
  it('GET with variables {"n":"x"} -> 400, errors[0].extensions.code BAD_USER_INPUT, 0 calls', async () => {
    const r = await get(gwDefault, EB1_Q, { n: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect('data' in (r.body as object)).toBe(false);
    expectCalls(0, r.body);
  });
});

// ---------- EB6 ----------
describe('EB6 - batch element', () => {
  it('[bad, ok] under maxBatchSize 5 -> 200 array; element 0 coded, element 1 data; 1 call total', async () => {
    const r = await post(gwBatch, [EB1_BODY, { query: '{ authors(first:1){ totalCount } }' }]);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    const arr = r.body as GqlResult[];
    expect(arr).toHaveLength(2);
    expect('data' in (arr[0] as object)).toBe(false);
    expect(arr[0]!.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(typeof (arr[1]!.data?.authors as { totalCount: unknown } | undefined)?.totalCount).toBe('number');
    expect(arr[1]!.errors).toBeUndefined();
    expectCalls(1);
  });
});

// ---------- EB7 ----------
describe('EB7 - top-level extensions unchanged', () => {
  it('EB1 response top-level extensions deep-equal the HEAD shape', async () => {
    const r = await post(gwDefault, EB1_BODY);
    expect((r.body as GqlResult).extensions).toEqual({
      queryComplexity: { cost: 2, depth: 2 },
      downstreamCalls: { total: 0 },
    });
  });
});

// ---------- EB8 ----------
describe('EB8 - already-coded classes unchanged', () => {
  const ABS = '{ authors{ totalCount } }';
  const noBadUserInput = (body: unknown) => expect(JSON.stringify(body)).not.toContain('BAD_USER_INPUT');

  it.each([
    ['unknown id', { query: '{ author(id:"nope"){ id } }' }, 200, 'NOT_FOUND'],
    ['parse failure', { query: '{ authors { ' }, 200, 'GRAPHQL_PARSE_FAILED'],
    ['validation failure', { query: '{ nope }' }, 200, 'GRAPHQL_VALIDATION_FAILED'],
    [
      'unknown operationName',
      { query: `query A${ABS}`, operationName: 'B' },
      400,
      'OPERATION_RESOLUTION_FAILURE',
    ],
    [
      'two operations, no name',
      { query: `query A${ABS} query B${ABS}` },
      400,
      'OPERATION_RESOLUTION_FAILURE',
    ],
  ] as const)('%s -> %i %s, never BAD_USER_INPUT', async (_n, body, status, code) => {
    const r = await post(gwDefault, body);
    expect(r.status).toBe(status);
    const b = r.body as GqlResult;
    expect(codes(b)).toContain(code);
    noBadUserInput(r.body);
    if (code === 'NOT_FOUND') {
      expect(b.errors![0]!.path).toEqual(['author']);
    } else {
      expectCalls(0);
    }
  });

  it('variable-driven QUERY_TOO_COMPLEX under maxComplexity 50 -> 200, 0 calls, no BAD_USER_INPUT', async () => {
    const r = await post(gwTight, {
      query: 'query($n:Int){ authors(first:$n){ edges{ node{ books{ id } } } } }',
      variables: { n: 100 },
    });
    expect(r.status).toBe(200);
    expect(codes(r.body as GqlResult)).toContain('QUERY_TOO_COMPLEX');
    noBadUserInput(r.body);
    expectCalls(0);
  });

  it('books(ids:$ids) with 101 ids -> 200 BAD_ARGUMENT, no BAD_USER_INPUT', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `a${i + 1}-b1`);
    const r = await post(gwDefault, { query: 'query($ids:[ID!]!){ books(ids:$ids){ id } }', variables: { ids } });
    expect(r.status).toBe(200);
    expect(codes(r.body as GqlResult)).toContain('BAD_ARGUMENT');
    noBadUserInput(r.body);
  });

  it('closed local port -> DOWNSTREAM_UNREACHABLE with a path, no BAD_USER_INPUT', async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const closed = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    await new Promise<void>((r) => s.close(() => r()));
    const g = gw({}, closed);
    const r = await post(g, { query: '{ authors(first:1){ totalCount } }' });
    const b = r.body as GqlResult;
    const e = (b.errors ?? []).find((x) => x.extensions?.code === 'DOWNSTREAM_UNREACHABLE');
    expect(e).toBeDefined();
    expect(Array.isArray(e!.path) && e!.path.length > 0).toBe(true);
    noBadUserInput(r.body);
  });

  it('valid variables still succeed with data and no errors', async () => {
    const r = await post(gwDefault, { query: EB1_Q, variables: { n: 2 } });
    expect(r.status).toBe(200);
    const b = r.body as GqlResult;
    expect(b.errors).toBeUndefined();
    expect(typeof (b.data?.authors as { totalCount: unknown }).totalCount).toBe('number');
    expectCalls(1, b);
  });
});

// ---------- EB9 ----------
describe('EB9 - success path and N+1 unchanged', () => {
  it('README §3 sample query returns data and no errors in 3 calls', async () => {
    expect(SAMPLE).toContain('query Sample');
    const r = await post(gwDefault, { query: SAMPLE });
    expect(r.status).toBe(200);
    const b = r.body as GqlResult;
    expect(b.errors).toBeUndefined();
    expect(b.data?.authors).toBeTruthy();
    expectCalls(3, b);
  });

  it('test/n-plus-1.test.ts is byte-unchanged and still pins 3 batched / 21 naive', () => {
    const now = readFileSync(path.join(REPO, 'test', 'n-plus-1.test.ts'), 'utf8');
    expect(now).toMatch(/toBe\(21\)/);
    expect(now).toMatch(/toBe\(3\)/);
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    let base: string;
    try {
      const sha = git(['log', '--format=%H', '-1', '--grep', 'foundry iter 86)']).trim();
      base = sha ? `${sha}~1` : 'HEAD';
      git(['rev-parse', '--verify', `${base}^{commit}`]);
    } catch {
      return; // not a git checkout (or shallow): the textual 3/21 pins above still hold
    }
    expect(now).toBe(git(['show', `${base}:test/n-plus-1.test.ts`]));
  });
});

// ---------- EB10 ----------
describe('EB10 - README §7 documents the code', () => {
  const section = (() => {
    const start = README.indexOf('### Partial errors & null propagation');
    const end = README.indexOf('\n### ', start + 5);
    return start >= 0 ? README.slice(start, end > start ? end : undefined) : '';
  })();

  it('§7 Partial errors names BAD_USER_INPUT, HTTP 400, 0 downstream calls, and the other request-level codes', () => {
    expect(section.length).toBeGreaterThan(0);
    const para = section.split('\n').find((l) => l.includes('BAD_USER_INPUT')) ?? '';
    expect(para).toContain('BAD_USER_INPUT');
    expect(para).toMatch(/HTTP 400/);
    expect(para).toMatch(/0 downstream calls/);
    expect(para).toMatch(/variable/i);
    for (const c of ['GRAPHQL_PARSE_FAILED', 'GRAPHQL_VALIDATION_FAILED', 'OPERATION_RESOLUTION_FAILURE']) {
      expect(section).toContain(c);
    }
  });
});
