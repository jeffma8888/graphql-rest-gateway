import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server, type ServerResponse, type IncomingHttpHeaders } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway, type GatewayOptions } from '../src/lib';
import { checkBackend, runCheckBackend } from '../src/check-backend';

/**
 * iter-74: `GET /readyz` downstream readiness probe + typed
 * `DOWNSTREAM_UNREACHABLE` for connection failures (PRODUCT row 56).
 *
 * Black-box: one node:http stub on 127.0.0.1 sits in front of the bundled
 * Fastify backend. A `mode` switch makes it forward, answer a fixed status or
 * body, delay, or accept and never answer. It records every request it sees
 * (method, path, query, headers): that list is the "downstream calls" count.
 * A "closed port" is a port bound and then released.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

type Mode =
  | { kind: 'forward' }
  | { kind: 'delay'; ms: number }
  | { kind: 'status'; status: number }
  | { kind: 'raw'; status: number; contentType: string; body: string }
  | { kind: 'hang' };
type Seen = { method: string; path: string; query: Record<string, string>; headers: IncomingHttpHeaders };

let backend: FastifyInstance;
let realUrl: string;
let stub: Server;
let stubUrl: string;
let mode: Mode = { kind: 'forward' };
let seen: Seen[] = [];
const hung: ServerResponse[] = [];

async function forward(url: string, res: ServerResponse): Promise<void> {
  try {
    const r = await fetch(realUrl + url);
    const text = await r.text();
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
    res.end(text);
  } catch {
    res.writeHead(502);
    res.end();
  }
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
  stub = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://stub.local');
    seen.push({
      method: req.method ?? '',
      path: u.pathname,
      query: Object.fromEntries(u.searchParams.entries()),
      headers: req.headers,
    });
    const m = mode;
    switch (m.kind) {
      case 'forward':
        void forward(req.url ?? '/', res);
        return;
      case 'delay':
        setTimeout(() => void forward(req.url ?? '/', res), m.ms);
        return;
      case 'status':
        res.writeHead(m.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'nope' }));
        return;
      case 'raw':
        res.writeHead(m.status, { 'content-type': m.contentType });
        res.end(m.body);
        return;
      case 'hang':
        hung.push(res);
        return;
    }
  });
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
  mode = { kind: 'forward' };
  seen = [];
});

type Resp = { status: number; ct: string; text: string };

async function hit(
  gw: { fetch: (input: string, init?: RequestInit) => Response | Promise<Response> },
  path: string,
  init?: RequestInit,
): Promise<Resp> {
  const res = await gw.fetch(`http://localhost${path}`, init);
  return { status: res.status, ct: res.headers.get('content-type') ?? '', text: await res.text() };
}

async function withGw<T>(
  opts: Partial<GatewayOptions> & { restBaseUrl: string },
  fn: (gw: ReturnType<typeof createGateway>) => Promise<T>,
): Promise<T> {
  const gw = createGateway(opts as GatewayOptions);
  try {
    return await fn(gw);
  } finally {
    await gw.close();
  }
}

const READY = '{"status":"ready"}';
const unready = (code: string) => JSON.stringify({ status: 'unready', code });
const OK = '{"status":"ok"}';

async function gql(gw: ReturnType<typeof createGateway>, query: string, headers: Record<string, string> = {}) {
  const res = await gw.fetch('http://localhost/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
  return (await res.json()) as {
    data?: any;
    errors?: Array<{ message: string; path?: unknown[]; extensions?: Record<string, unknown> }>;
    extensions?: any;
  };
}

const SAMPLE = `query Sample {
  authors(first: 5) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges {
      cursor
      node {
        id
        name
        books {
          id
          title
          reviews { id rating reviewer }
        }
      }
    }
  }
}`;

// ---------- EB1 ----------
describe('EB1 - ready', () => {
  it('200 application/json {"status":"ready"} after exactly 1 GET /authors?offset=0&limit=1', async () => {
    await withGw({ restBaseUrl: stubUrl }, async (gw) => {
      const r = await hit(gw, '/readyz');
      expect(r.status).toBe(200);
      expect(r.ct).toContain('application/json');
      expect(r.text).toBe(READY);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.method).toBe('GET');
      expect(seen[0]?.path).toBe('/authors');
      expect(seen[0]?.query).toEqual({ offset: '0', limit: '1' });
    });
  });

  it('cross-check against the bundled backend /__stats counter: exactly 1 call', async () => {
    await fetch(`${realUrl}/__stats/reset`, { method: 'POST' });
    await withGw({ restBaseUrl: realUrl }, async (gw) => {
      const r = await hit(gw, '/readyz');
      expect(r.status).toBe(200);
      expect(r.text).toBe(READY);
    });
    const stats = (await (await fetch(`${realUrl}/__stats`)).json()) as { total: number };
    expect(stats.total).toBe(1);
  });
});

// ---------- EB2 ----------
describe('EB2 - no result caching', () => {
  it('3 sequential probes -> 3 downstream calls, all 200', async () => {
    await withGw({ restBaseUrl: stubUrl }, async (gw) => {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await hit(gw, '/readyz')).status);
      expect(statuses).toEqual([200, 200, 200]);
      expect(seen).toHaveLength(3);
    });
  });
});

// ---------- EB3 ----------
describe('EB3 - unreachable', () => {
  it('closed port -> 503 application/json {"status":"unready","code":"DOWNSTREAM_UNREACHABLE"}', async () => {
    const port = await closedPort();
    await withGw({ restBaseUrl: `http://127.0.0.1:${port}` }, async (gw) => {
      const r = await hit(gw, '/readyz');
      expect(r.status).toBe(503);
      expect(r.ct).toContain('application/json');
      expect(r.text).toBe(unready('DOWNSTREAM_UNREACHABLE'));
    });
  });
});

// ---------- EB4 ----------
describe('EB4 - non-2xx', () => {
  it.each([500, 401])('stub answers %i -> 503 DOWNSTREAM_ERROR', async (status) => {
    mode = { kind: 'status', status };
    await withGw({ restBaseUrl: stubUrl }, async (gw) => {
      const r = await hit(gw, '/readyz');
      expect(r.status).toBe(503);
      expect(r.ct).toContain('application/json');
      expect(r.text).toBe(unready('DOWNSTREAM_ERROR'));
      expect(seen).toHaveLength(1);
    });
  });
});

// ---------- EB5 ----------
describe('EB5 - bad body', () => {
  it.each([
    ['html maintenance page', 'text/html', '<html>maintenance</html>'],
    ['JSON [] (not a {items,total} page)', 'application/json', '[]'],
  ])('200 %s -> 503 DOWNSTREAM_BAD_RESPONSE, body never echoed', async (_name, contentType, body) => {
    mode = { kind: 'raw', status: 200, contentType, body };
    await withGw({ restBaseUrl: stubUrl }, async (gw) => {
      const r = await hit(gw, '/readyz');
      expect(r.status).toBe(503);
      expect(r.text).toBe(unready('DOWNSTREAM_BAD_RESPONSE'));
      expect(r.text).not.toContain('maintenance');
    });
  });
});

// ---------- EB6 ----------
describe('EB6 - timeout', () => {
  it('downstreamTimeoutMs 100 + stub that never sends headers -> 503 DOWNSTREAM_TIMEOUT in < 2000 ms', async () => {
    mode = { kind: 'hang' };
    await withGw({ restBaseUrl: stubUrl, downstreamTimeoutMs: 100 }, async (gw) => {
      const t0 = Date.now();
      const r = await hit(gw, '/readyz');
      const ms = Date.now() - t0;
      expect(r.status).toBe(503);
      expect(r.text).toBe(unready('DOWNSTREAM_TIMEOUT'));
      expect(ms).toBeLessThan(2000);
      expect(seen).toHaveLength(1);
    });
  });
});

// ---------- EB7 ----------
describe('EB7 - coalescing', () => {
  it('10 concurrent probes over a 150 ms backend -> 1 call, identical answers; a later probe -> 2nd call', async () => {
    mode = { kind: 'delay', ms: 150 };
    await withGw({ restBaseUrl: stubUrl }, async (gw) => {
      const all = await Promise.all(Array.from({ length: 10 }, () => hit(gw, '/readyz')));
      expect(seen).toHaveLength(1);
      expect(new Set(all.map((r) => r.status)).size).toBe(1);
      expect(new Set(all.map((r) => r.text)).size).toBe(1);
      expect(all[0]?.status).toBe(200);
      expect(all[0]?.text).toBe(READY);
      const again = await hit(gw, '/readyz');
      expect(again.status).toBe(200);
      expect(seen).toHaveLength(2);
    });
  });

  it('concurrent failing probes also coalesce to 1 call with the same 503 body', async () => {
    mode = { kind: 'hang' };
    await withGw({ restBaseUrl: stubUrl, downstreamTimeoutMs: 150 }, async (gw) => {
      const all = await Promise.all(Array.from({ length: 10 }, () => hit(gw, '/readyz')));
      expect(seen).toHaveLength(1);
      for (const r of all) {
        expect(r.status).toBe(503);
        expect(r.text).toBe(unready('DOWNSTREAM_TIMEOUT'));
      }
    });
  });
});

// ---------- EB8 ----------
describe('EB8 - recovery, no sticky failure', () => {
  it('500 -> 503 DOWNSTREAM_ERROR, then forwarding -> next probe 200 ready', async () => {
    mode = { kind: 'status', status: 500 };
    await withGw({ restBaseUrl: stubUrl }, async (gw) => {
      const a = await hit(gw, '/readyz');
      expect(a.status).toBe(503);
      expect(a.text).toBe(unready('DOWNSTREAM_ERROR'));
      mode = { kind: 'forward' };
      const b = await hit(gw, '/readyz');
      expect(b.status).toBe(200);
      expect(b.text).toBe(READY);
      expect(seen).toHaveLength(2);
    });
  });
});

// ---------- EB9 ----------
describe('EB9 - path match like /healthz', () => {
  it('/readyz?probe=1 behaves exactly like /readyz (ready and unready)', async () => {
    await withGw({ restBaseUrl: stubUrl }, async (gw) => {
      const r = await hit(gw, '/readyz?probe=1');
      expect(r.status).toBe(200);
      expect(r.ct).toContain('application/json');
      expect(r.text).toBe(READY);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.query).toEqual({ offset: '0', limit: '1' });
      mode = { kind: 'status', status: 500 };
      const u = await hit(gw, '/readyz?probe=1');
      expect(u.status).toBe(503);
      expect(u.text).toBe(unready('DOWNSTREAM_ERROR'));
    });
  });

  it.each(['HEAD', 'POST'])('%s /readyz runs the check with the same status code', async (method) => {
    await withGw({ restBaseUrl: stubUrl }, async (gw) => {
      const ok = await hit(gw, '/readyz', { method });
      expect(ok.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.path).toBe('/authors');
      mode = { kind: 'status', status: 500 };
      const bad = await hit(gw, '/readyz', { method });
      expect(bad.status).toBe(503);
      expect(seen).toHaveLength(2);
    });
  });

  it('/readyz/x is not the probe: no downstream call, no readiness body (ready or unready backend)', async () => {
    await withGw({ restBaseUrl: stubUrl }, async (gw) => {
      const a = await hit(gw, '/readyz/x');
      expect(a.text).not.toBe(READY);
      expect(a.status).not.toBe(200);
      mode = { kind: 'status', status: 500 };
      const b = await hit(gw, '/readyz/x');
      expect(b.text).not.toBe(unready('DOWNSTREAM_ERROR'));
      expect(b.status).not.toBe(503);
      expect(seen).toHaveLength(0);
    });
  });
});

// ---------- EB10 ----------
describe('EB10 - after close', () => {
  it('once close() resolved, /readyz -> 503 with 0 downstream calls', async () => {
    const gw = createGateway({ restBaseUrl: stubUrl });
    await gw.close();
    const r = await hit(gw, '/readyz');
    expect(r.status).toBe(503);
    expect(r.text).not.toBe(READY);
    expect(seen).toHaveLength(0);
  });
});

// ---------- EB11 ----------
describe('EB11 - /healthz unchanged', () => {
  const states: Array<[string, () => Promise<{ base: string; opts?: Partial<GatewayOptions> }>]> = [
    ['closed port', async () => ({ base: `http://127.0.0.1:${await closedPort()}` })],
    ['500', async () => ((mode = { kind: 'status', status: 500 }), { base: stubUrl })],
    ['401', async () => ((mode = { kind: 'status', status: 401 }), { base: stubUrl })],
    [
      'html',
      async () => (
        (mode = { kind: 'raw', status: 200, contentType: 'text/html', body: '<html>maintenance</html>' }), { base: stubUrl }
      ),
    ],
    ['[]', async () => ((mode = { kind: 'raw', status: 200, contentType: 'application/json', body: '[]' }), { base: stubUrl })],
    ['hang', async () => ((mode = { kind: 'hang' }), { base: stubUrl, opts: { downstreamTimeoutMs: 100 } })],
    ['ready', async () => ({ base: stubUrl })],
  ];

  it.each(states)('%s: /healthz 200 {"status":"ok"}, 0 downstream calls (also after a /readyz)', async (_n, setup) => {
    const { base, opts } = await setup();
    await withGw({ restBaseUrl: base, ...opts }, async (gw) => {
      const h1 = await hit(gw, '/healthz');
      expect(h1.status).toBe(200);
      expect(h1.text).toBe(OK);
      expect(seen).toHaveLength(0);
      await hit(gw, '/readyz');
      const before = seen.length;
      const h2 = await hit(gw, '/healthz');
      expect(h2.status).toBe(200);
      expect(h2.text).toBe(OK);
      expect(seen).toHaveLength(before);
    });
  });

  it('/healthz during an in-flight coalesced probe: 200 ok, no extra call', async () => {
    mode = { kind: 'delay', ms: 150 };
    await withGw({ restBaseUrl: stubUrl }, async (gw) => {
      const p = hit(gw, '/readyz');
      const h = await hit(gw, '/healthz');
      expect(h.status).toBe(200);
      expect(h.text).toBe(OK);
      await p;
      expect(seen).toHaveLength(1);
    });
  });

  it('after close: /healthz is 503 (as on HEAD), 0 calls', async () => {
    const gw = createGateway({ restBaseUrl: stubUrl });
    await gw.close();
    const h = await hit(gw, '/healthz');
    expect(h.status).toBe(503);
    expect(seen).toHaveLength(0);
  });
});

// ---------- EB12 ----------
describe('EB12 - the probe is isolated from callers', () => {
  it('(a) forwardHeaders authorization + x-request-id are NOT carried by the probe call', async () => {
    await withGw({ restBaseUrl: stubUrl, forwardHeaders: ['authorization', 'x-request-id'] }, async (gw) => {
      const r = await hit(gw, '/readyz', {
        headers: { authorization: 'Bearer user:42:pii', 'x-request-id': 'req-74' },
      });
      expect(r.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.headers.authorization).toBeUndefined();
      expect(seen[0]?.headers['x-request-id']).toBeUndefined();
      // control: the same gateway DOES forward them on a GraphQL call
      seen = [];
      await gql(gw, '{ authors(first: 1) { totalCount } }', {
        authorization: 'Bearer user:42:pii',
        'x-request-id': 'req-74',
      });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]?.headers.authorization).toBe('Bearer user:42:pii');
      expect(seen[0]?.headers['x-request-id']).toBe('req-74');
    });
  });

  it('(b) maxDownstreamCalls 1 -> /readyz still 200 (repeatedly)', async () => {
    await withGw({ restBaseUrl: stubUrl, maxDownstreamCalls: 1 }, async (gw) => {
      for (let i = 0; i < 3; i++) {
        const r = await hit(gw, '/readyz');
        expect(r.status).toBe(200);
        expect(r.text).toBe(READY);
      }
    });
  });

  it('(c) sample query concurrent with 5 probes still reports downstreamCalls.total === 3', async () => {
    mode = { kind: 'delay', ms: 30 };
    await withGw({ restBaseUrl: stubUrl }, async (gw) => {
      const [body, ...probes] = await Promise.all([
        gql(gw, SAMPLE),
        ...Array.from({ length: 5 }, () => hit(gw, '/readyz')),
      ]);
      expect(body.errors).toBeUndefined();
      expect(body.data.authors.edges).toHaveLength(5);
      expect(body.extensions.downstreamCalls.total).toBe(3);
      for (const p of probes) expect((p as Resp).status).toBe(200);
    });
  });
});

// ---------- EB13 ----------
describe('EB13 - typed client error against a closed port', () => {
  function expectNoLeak(errs: unknown, port: number) {
    const s = JSON.stringify(errs);
    for (const bad of ['ECONNREFUSED', 'fetch failed', '127.0.0.1', String(port)]) {
      expect(s, `errors leak ${bad}`).not.toContain(bad);
    }
  }

  it('authors list -> DOWNSTREAM_UNREACHABLE, exact message naming /authors, 1 call, no leak', async () => {
    const port = await closedPort();
    await withGw({ restBaseUrl: `http://127.0.0.1:${port}` }, async (gw) => {
      const b = await gql(gw, '{ authors(first: 1) { totalCount } }');
      expect(b.errors).toHaveLength(1);
      expect(b.errors?.[0]?.extensions?.code).toBe('DOWNSTREAM_UNREACHABLE');
      expect(b.errors?.[0]?.message).toBe('Downstream request to /authors failed: backend unreachable');
      expect(b.extensions.downstreamCalls.total).toBe(1);
      expectNoLeak(b.errors, port);
    });
  });

  it('author by id -> DOWNSTREAM_UNREACHABLE naming /authors/by-ids, 1 call, no leak', async () => {
    const port = await closedPort();
    await withGw({ restBaseUrl: `http://127.0.0.1:${port}` }, async (gw) => {
      const b = await gql(gw, '{ author(id: "1") { name } }');
      expect(b.errors).toHaveLength(1);
      expect(b.errors?.[0]?.extensions?.code).toBe('DOWNSTREAM_UNREACHABLE');
      expect(b.errors?.[0]?.message).toBe('Downstream request to /authors/by-ids failed: backend unreachable');
      expect(b.extensions.downstreamCalls.total).toBe(1);
      expectNoLeak(b.errors, port);
    });
  });

  it('two root fields (by-id + list): every reported error is DOWNSTREAM_UNREACHABLE, none INTERNAL_SERVER_ERROR', async () => {
    // Spec ambiguity: `authors` is non-null (AuthorConnection!), so its failure
    // nulls `data` and graphql-js reports only the errors collected before the
    // abort. The observable contract is: both calls were attempted, every
    // reported error is typed, and no untyped error appears.
    const port = await closedPort();
    await withGw({ restBaseUrl: `http://127.0.0.1:${port}` }, async (gw) => {
      const b = await gql(gw, '{ author(id: "1") { name } authors(first: 1) { totalCount } }');
      expect(b.errors?.length ?? 0).toBeGreaterThanOrEqual(1);
      for (const e of b.errors ?? []) {
        expect(e.extensions?.code).toBe('DOWNSTREAM_UNREACHABLE');
        expect(e.message).not.toBe('Unexpected error.');
        expect(e.message).toMatch(/^Downstream request to \/authors(\/by-ids)? failed: backend unreachable$/);
      }
      expect(b.extensions.downstreamCalls.total).toBe(2);
      expectNoLeak(b.errors, port);
    });
  });

  it('two NULLABLE root fields on different routes (author + book) -> each error typed with its own route', async () => {
    const port = await closedPort();
    await withGw({ restBaseUrl: `http://127.0.0.1:${port}` }, async (gw) => {
      const b = await gql(gw, '{ author(id: "1") { name } book(id: "1") { title } }');
      expect(b.data).toEqual({ author: null, book: null });
      expect(b.errors).toHaveLength(2);
      const byPath = Object.fromEntries((b.errors ?? []).map((e) => [String(e.path?.[0]), e]));
      expect(Object.keys(byPath).sort()).toEqual(['author', 'book']);
      for (const e of b.errors ?? []) expect(e.extensions?.code).toBe('DOWNSTREAM_UNREACHABLE');
      expect(byPath.author?.message).toBe('Downstream request to /authors/by-ids failed: backend unreachable');
      expect(byPath.book?.message).toBe('Downstream request to /books/by-ids failed: backend unreachable');
      expect(b.extensions.downstreamCalls.total).toBe(2);
      expectNoLeak(b.errors, port);
    });
  });
});

// ---------- EB14 ----------
describe('EB14 - operator tooling unchanged', () => {
  // Frozen from HEAD (1664d6a) by running checkBackend/runCheckBackend in a
  // `git archive HEAD` copy against a closed port; the port is normalised.
  const SKIP = 'skipped: needs a passing /authors';
  const HEAD_REPORT = {
    baseUrl: 'http://127.0.0.1:PORT',
    ok: false,
    routes: [
      { route: '/authors', ok: false, problem: 'request failed: fetch failed (ECONNREFUSED)' },
      { route: '/authors/by-ids', ok: false, problem: SKIP },
      { route: '/books/by-author', ok: false, problem: SKIP },
      { route: '/books/by-ids', ok: false, problem: SKIP },
      { route: '/reviews/by-book', ok: false, problem: SKIP },
    ],
  };
  const HEAD_LINES = [
    'Checking http://127.0.0.1:PORT -- REST_BASE_URL',
    'FAIL /authors -- request failed: fetch failed (ECONNREFUSED)',
    'FAIL /authors/by-ids -- skipped: needs a passing /authors',
    'FAIL /books/by-author -- skipped: needs a passing /authors',
    'FAIL /books/by-ids -- skipped: needs a passing /authors',
    'FAIL /reviews/by-book -- skipped: needs a passing /authors',
    '0/5 routes match the REST contract',
  ];

  it('checkBackend(closed port) report is byte-identical to HEAD', async () => {
    const port = await closedPort();
    const rep = await checkBackend(`http://127.0.0.1:${port}`);
    expect(JSON.stringify(rep).replaceAll(String(port), 'PORT')).toBe(JSON.stringify(HEAD_REPORT));
  });

  it('runCheckBackend CLI text and --json output are byte-identical to HEAD, exit 1', async () => {
    const port = await closedPort();
    const url = `http://127.0.0.1:${port}`;
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    await expect(runCheckBackend([], { REST_BASE_URL: url }, io)).resolves.toBe(1);
    expect(out.map((l) => l.replaceAll(String(port), 'PORT'))).toEqual(HEAD_LINES);
    expect(err).toEqual([]);
    const jout: string[] = [];
    await expect(
      runCheckBackend(['--json'], { REST_BASE_URL: url }, { out: (l) => jout.push(l), err: (l) => err.push(l) }),
    ).resolves.toBe(1);
    expect(jout).toHaveLength(1);
    expect(jout[0]?.replaceAll(String(port), 'PORT')).toBe(
      JSON.stringify({ baseUrl: HEAD_REPORT.baseUrl, backend: 'external', ok: false, routes: HEAD_REPORT.routes }, null, 2),
    );
  });

  it('no existing test file is deleted and only iteration behavior files are edited (git guard; skipped outside a repo)', () => {
    let changed: string;
    try {
      changed = execFileSync('git', ['diff', '--name-status', 'HEAD', '--', 'test/'], { cwd: root, encoding: 'utf8' });
    } catch {
      return; // not a git checkout (e.g. a published tarball)
    }
    // Later iterations may deliberately re-pin an older iteration's behavior file; never n-plus-1/lib-entry, never a deletion.
    for (const line of changed.split('\n').filter(Boolean)) {
      expect(line).toMatch(/^M\ttest\/test_iter\d+_behavior\.test\.ts$/);
    }
  });
});

// ---------- EB15 ----------
type Running = { url: string; close(): Promise<void> };
type StartFromEnv = (env: Record<string, string | undefined>, log?: (line: string) => void) => Promise<Running>;

describe('EB15 - CLI and docs', () => {
  it('startFromEnv with a closed-port REST_BASE_URL: real HTTP /readyz 503 UNREACHABLE, /healthz 200', async () => {
    const mod = (await import('../src/cli')) as { startFromEnv: StartFromEnv };
    const port = await closedPort();
    const running = await mod.startFromEnv({ REST_BASE_URL: `http://127.0.0.1:${port}`, PORT: '0' }, () => {});
    try {
      const origin = new URL(running.url).origin;
      const r = await fetch(`${origin}/readyz`);
      expect(r.status).toBe(503);
      expect(await r.text()).toBe(unready('DOWNSTREAM_UNREACHABLE'));
      const h = await fetch(`${origin}/healthz`);
      expect(h.status).toBe(200);
      expect(await h.text()).toBe(OK);
    } finally {
      await running.close();
    }
  });

  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  /** The markdown section starting at the first line matching `startHeading`, up to the next heading of the same or higher level (code fences skipped). */
  function section(startHeading: RegExp): string {
    const lines = readme.split('\n');
    const i = lines.findIndex((l) => startHeading.test(l));
    expect(i, `heading ${startHeading}`).toBeGreaterThanOrEqual(0);
    const level = lines[i]?.match(/^#+/)?.[0].length ?? 2;
    let fence = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j] ?? '';
      if (l.startsWith('```')) fence = !fence;
      if (fence) continue;
      const h = l.match(/^(#+) /);
      if (h && (h[1]?.length ?? 9) <= level) break;
    }
    return lines.slice(i, j).join('\n');
  }

  it('README §3 names /readyz in the programmatic snippet and in the npm start section', () => {
    const s3 = section(/^## 3\. /);
    const start = section(/^### Front your own REST service/);
    const prog = section(/^### Programmatic usage/);
    expect(s3).toContain('/readyz');
    expect(start).toContain('/readyz');
    const code = prog.match(/```ts\n([\s\S]*?)```/)?.[1] ?? '';
    expect(code).toContain("gateway.fetch('http://localhost/readyz')");
  });

  it('README §7 "Readiness probe" states route, 4 codes, coalescing, no cache, no headers/budget, liveness split', () => {
    const s7 = section(/^## 7\. /);
    expect(s7).toMatch(/^### (<a [^>]*><\/a>)?Readiness probe/m);
    const rp = section(/^### Readiness probe/);
    expect(rp).toContain('/authors?offset=0&limit=1');
    for (const c of ['DOWNSTREAM_UNREACHABLE', 'DOWNSTREAM_ERROR', 'DOWNSTREAM_BAD_RESPONSE', 'DOWNSTREAM_TIMEOUT']) {
      expect(rp).toContain(c);
    }
    expect(rp).toMatch(/coalesc|share one in-flight/i);
    expect(rp).toMatch(/never cached|not cached/i);
    expect(rp).toMatch(/forwarded headers/i);
    expect(rp).toMatch(/budget/i);
    expect(rp).toMatch(/auth[\s\S]*DOWNSTREAM_ERROR/);
    expect(rp).toMatch(/liveness/i);
    expect(rp).toContain('/healthz');
  });

  it('README §7 "Downstream error" documents DOWNSTREAM_UNREACHABLE and its exact message', () => {
    const de = section(/^### Downstream error\s*$/);
    expect(de).toContain('DOWNSTREAM_UNREACHABLE');
    expect(de).toContain('Downstream request to /authors failed: backend unreachable');
  });
});
