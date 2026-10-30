import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import http from 'node:http';
import net from 'node:net';
import { buildBackend, createGateway } from '../src/lib';

/**
 * iter-61: `npm start` (startFromEnv) serves every request through the
 * gateway drain-aware path. Black-box: boot startFromEnv in-process on
 * PORT=0, drive it with node:http keep-alive clients, and observe statuses,
 * the `connection` header, close() timing and downstream call counts
 * (cross-checked against a recording external backend).
 */

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

const SAMPLE = `{ authors(first:5){ edges{ node{ id books{ id reviews{ id } } } } } }`;
const REVIEWERS = `{ authors(first:1){ edges{ node{ books{ reviews{ reviewer } } } } } }`;

type Resp = {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
  /** Date.now() when the response head arrived at the client. */
  headersAt: number;
};
type Outcome =
  | { kind: 'response'; resp: Resp; at: number }
  | { kind: 'error'; code: string; message: string; at: number };

function keepAliveAgent(): http.Agent {
  return new http.Agent({ keepAlive: true, maxSockets: 1 });
}

const agents: http.Agent[] = [];
function trackedAgent(): http.Agent {
  const a = keepAliveAgent();
  agents.push(a);
  return a;
}

function request(
  target: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    agent?: http.Agent | false;
  } = {},
): Promise<Resp> {
  return new Promise((resolvePromise, reject) => {
    const u = new URL(target);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
        agent: opts.agent === undefined ? false : opts.agent,
      },
      (res) => {
        const headersAt = Date.now();
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any = undefined;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, text, json, headersAt });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function postGql(
  url: string,
  query: string,
  agent: http.Agent | false = false,
  headers: Record<string, string> = {},
): Promise<Resp> {
  return request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
    agent,
  });
}

function outcome(p: Promise<Resp>): Promise<Outcome> {
  return p.then(
    (resp) => ({ kind: 'response' as const, resp, at: Date.now() }),
    (err: NodeJS.ErrnoException) => ({
      kind: 'error' as const,
      code: String(err.code ?? ''),
      message: String(err.message),
      at: Date.now(),
    }),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tolerance for client/server callbacks interleaving in one event loop. */
const SCHED_MS = 25;

const CONN_ERRORS = /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up/i;

function assertNot200(o: Outcome): void {
  if (o.kind === 'response') {
    expect(o.resp.status).toBe(503);
    expect(o.resp.headers.connection).toBe('close');
  } else {
    expect(`${o.code} ${o.message}`).toMatch(CONN_ERRORS);
  }
}

function originOf(url: string): string {
  return new URL(url).origin;
}

function connectRefused(origin: string): Promise<string> {
  const u = new URL(origin);
  return new Promise((resolvePromise) => {
    const sock = net.connect({ host: u.hostname, port: Number(u.port) });
    sock.once('connect', () => {
      sock.destroy();
      resolvePromise('connected');
    });
    sock.once('error', (e: NodeJS.ErrnoException) => resolvePromise(String(e.code)));
  });
}

// Every started gateway is tracked and closed after each test.
const open: Running[] = [];
async function start(env: Record<string, string | undefined>, log?: (l: string) => void) {
  const startFromEnv = await loadStart();
  const lines: string[] = [];
  const running = await startFromEnv(env, log ?? ((line) => lines.push(line)));
  open.push(running);
  return { running, lines };
}

afterEach(async () => {
  while (open.length) {
    const r = open.pop()!;
    await r.close();
  }
  while (agents.length) agents.pop()!.destroy();
  vi.restoreAllMocks();
});

type Recorded = { url: string; headers: http.IncomingHttpHeaders };
function recordingBackend(latencyMs: number) {
  const app = buildBackend({ latencyMs }).app;
  const rec: Recorded[] = [];
  app.addHook('onRequest', (req, _reply, done) => {
    if (!req.url.startsWith('/__')) rec.push({ url: req.url, headers: { ...req.headers } });
    done();
  });
  return { app, rec };
}

/**
 * The EB2 sequence: warm A, (a) SAMPLE on A, +100 ms close(), +50 ms (c) on A.
 * When `inflightAgent` is given, (a) goes on that agent instead of A.
 */
async function eb2Sequence(running: Running, inflightAgent?: http.Agent) {
  const A = trackedAgent();
  const warm = await postGql(running.url, SAMPLE, A);
  expect(warm.status).toBe(200);
  const a = outcome(postGql(running.url, SAMPLE, inflightAgent ?? A));
  await sleep(100);
  const closeStart = Date.now();
  let closeEnd = 0;
  const closing = running.close().then(() => {
    closeEnd = Date.now();
  });
  await sleep(50);
  const c = outcome(postGql(running.url, SAMPLE, A));
  const [ra, rc] = await Promise.all([a, c, closing]);
  return { warm, ra, rc, closeStart, closeEnd: closeEnd as number, closeMs: closeEnd - closeStart };
}

function expectSample200(r: Resp): void {
  expect(r.status).toBe(200);
  expect(r.json?.errors).toBeUndefined();
  expect(r.json?.data?.authors?.edges).toHaveLength(5);
  expect(r.json?.extensions?.downstreamCalls?.total).toBe(3);
}

describe('EB1: normal serving unchanged', () => {
  it('SAMPLE 200 with 5 edges and 3 downstream calls; /healthz ok; GraphiQL html', async () => {
    const { running } = await start({ PORT: '0', REST_LATENCY_MS: '0' });
    const A = trackedAgent();
    expectSample200(await postGql(running.url, SAMPLE, A));

    const health = await request(`${originOf(running.url)}/healthz`, { agent: A });
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ status: 'ok' });

    const gi = await request(running.url, { headers: { accept: 'text/html' }, agent: A });
    expect(gi.status).toBe(200);
    expect(String(gi.headers['content-type'])).toContain('text/html');
  });
});

describe('EB2/EB5/EB6: queued request on the in-flight socket during close()', () => {
  it('(a) 200 with 3 calls, (c) never 200, close() after (a) and within 2500 ms', async () => {
    const { running } = await start({ PORT: '0', REST_LATENCY_MS: '300' });
    const { warm, ra, rc, closeMs, closeEnd } = await eb2Sequence(running);
    expectSample200(warm);
    // EB2 (a)
    expect(ra.kind).toBe('response');
    if (ra.kind === 'response') expectSample200(ra.resp);
    // EB2/EB3 (c)
    if (rc.kind === 'response') expect(rc.resp.status).not.toBe(200);
    assertNot200(rc);
    // EB5: close() does not resolve before (a) finished. (a) arrived complete
    // (200, full JSON, 3 calls) and its response head reached the client no
    // later than close() resolved (small tolerance for same-loop scheduling).
    if (ra.kind === 'response') expect(closeEnd).toBeGreaterThanOrEqual(ra.resp.headersAt - SCHED_MS);
    // (a) needs ~3 x 300 ms of downstream latency; close() began 100 ms in, so
    // a close() that did not wait for it would resolve well before that.
    expect(closeMs).toBeGreaterThan(400);
    // EB6
    expect(closeMs).toBeLessThan(2500);
  });

  it('EB6: in-flight (a) on client B, A holds an idle warmed socket: close() within 2500 ms', async () => {
    const { running } = await start({ PORT: '0', REST_LATENCY_MS: '300' });
    const B = trackedAgent();
    const { ra, rc, closeMs, closeEnd } = await eb2Sequence(running, B);
    expect(ra.kind).toBe('response');
    if (ra.kind === 'response') expectSample200(ra.resp);
    assertNot200(rc);
    if (ra.kind === 'response') expect(closeEnd).toBeGreaterThanOrEqual(ra.resp.headersAt - SCHED_MS);
    expect(closeMs).toBeGreaterThan(400);
    expect(closeMs).toBeLessThan(2500);
  });
});

describe('EB3: any post-close HTTP response is a 503 with connection: close', () => {
  it('POST /graphql and GET /healthz on new, idle and queued sockets are never 200', async () => {
    const { running } = await start({ PORT: '0', REST_LATENCY_MS: '300' });
    const origin = originOf(running.url);
    const A = trackedAgent();
    const idle = trackedAgent();
    expect((await postGql(running.url, SAMPLE, A)).status).toBe(200);
    expect((await request(`${origin}/healthz`, { agent: idle })).status).toBe(200);

    const inflight = outcome(postGql(running.url, SAMPLE, A));
    await sleep(100);
    const closing = running.close();
    await sleep(20);
    const after = await Promise.all([
      outcome(postGql(running.url, SAMPLE, A)),
      outcome(request(`${origin}/healthz`, { agent: A })),
      outcome(postGql(running.url, SAMPLE, idle)),
      outcome(request(`${origin}/healthz`, { agent: idle })),
      outcome(postGql(running.url, SAMPLE, false)),
      outcome(request(`${origin}/healthz`, { agent: false })),
    ]);
    const ia = await inflight;
    await closing;
    expect(ia.kind).toBe('response');
    if (ia.kind === 'response') expect(ia.resp.status).toBe(200);
    expect(after).toHaveLength(6);
    for (const o of after) assertNot200(o);
  });

  it('a request whose headers finish after close() began gets 503 + connection: close', async () => {
    const { running } = await start({ PORT: '0', REST_LATENCY_MS: '300' });
    // Keep the drain window open with one in-flight SAMPLE on its own socket.
    const inflight = outcome(postGql(running.url, SAMPLE, false));
    const u = new URL(running.url);
    const sock = net.connect({ host: u.hostname, port: Number(u.port) });
    await new Promise<void>((r, j) => {
      sock.once('connect', () => r());
      sock.once('error', j);
    });
    const chunks: Buffer[] = [];
    const ended = new Promise<string>((r) => {
      sock.on('data', (c: Buffer) => chunks.push(c));
      sock.on('close', () => r(Buffer.concat(chunks).toString('latin1')));
      sock.on('error', () => undefined);
    });
    // Partial request: request line + Host, no terminating blank line yet.
    sock.write(`GET /healthz HTTP/1.1\r\nHost: ${u.host}\r\n`);
    await sleep(50);
    const closing = running.close();
    await sleep(50);
    sock.write('\r\n');
    const raw = await ended;
    await closing;
    // While a request drains, a request completed after close() began must be
    // answered (not silently dropped) and the answer must be 503 + close.
    const statusLine = raw.split('\r\n')[0] ?? '';
    expect(statusLine).toMatch(/^HTTP\/1\.1 503\b/);
    expect(raw.toLowerCase()).toMatch(/\r\nconnection: close\r\n/);
    const ia = await inflight;
    expect(ia.kind).toBe('response');
    if (ia.kind === 'response') expectSample200(ia.resp);
  });
});

describe('EB4: post-close requests cost zero downstream calls', () => {
  let ext: ReturnType<typeof recordingBackend>;
  let extBase: string;
  beforeAll(async () => {
    ext = recordingBackend(300);
    extBase = await ext.app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await ext.app.close();
  });

  it('external backend records exactly 6 downstream requests (3 warm + 3 for (a))', async () => {
    ext.rec.length = 0;
    const { running } = await start({ PORT: '0', REST_BASE_URL: extBase });
    const { warm, ra, rc } = await eb2Sequence(running);
    expectSample200(warm);
    expect(ra.kind).toBe('response');
    if (ra.kind === 'response') expectSample200(ra.resp);
    assertNot200(rc);
    await sleep(400); // anything (c) could have started would have landed by now
    expect(ext.rec).toHaveLength(6);
    const stats = await request(`${extBase}/__stats`);
    expect(stats.json?.total).toBe(6);
  });
});

describe('EB7: idle-only shutdown is immediate', () => {
  it('a warmed idle keep-alive socket does not hold close() open (< 500 ms)', async () => {
    const { running } = await start({ PORT: '0', REST_LATENCY_MS: '0' });
    const A = trackedAgent();
    expect((await postGql(running.url, SAMPLE, A)).status).toBe(200);
    expect((await request(`${originOf(running.url)}/healthz`, { agent: A })).status).toBe(200);
    const t0 = Date.now();
    await running.close();
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('EB8: closed means closed', () => {
  it('gateway port and bundled backend port refuse new connections after close()', async () => {
    const { running } = await start({ PORT: '0', REST_LATENCY_MS: '0' });
    expect(running.backend).toBe('bundled');
    const A = trackedAgent();
    expect((await postGql(running.url, SAMPLE, A)).status).toBe(200);
    expect(await connectRefused(originOf(running.url))).toBe('connected');
    expect(await connectRefused(running.restBaseUrl)).toBe('connected');
    await running.close();
    expect(await connectRefused(originOf(running.url))).toBe('ECONNREFUSED');
    expect(await connectRefused(running.restBaseUrl)).toBe('ECONNREFUSED');
    const o = await outcome(request(`${originOf(running.url)}/healthz`));
    expect(o.kind).toBe('error');
  });
});

describe('EB9: idempotent close is preserved', () => {
  it('two concurrent close() calls both resolve without throwing', async () => {
    const { running } = await start({ PORT: '0', REST_LATENCY_MS: '0' });
    const A = trackedAgent();
    expect((await postGql(running.url, SAMPLE, A)).status).toBe(200);
    const results = await Promise.allSettled([running.close(), running.close()]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await connectRefused(originOf(running.url))).toBe('ECONNREFUSED');
  });
});

describe('EB10: request headers still reach the gateway', () => {
  let ext: ReturnType<typeof recordingBackend>;
  let extBase: string;
  beforeAll(async () => {
    ext = recordingBackend(0);
    extBase = await ext.app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await ext.app.close();
  });

  it('FORWARD_HEADERS=x-request-id forwards rid-61 on every downstream call', async () => {
    ext.rec.length = 0;
    const { running } = await start({
      PORT: '0',
      REST_BASE_URL: extBase,
      FORWARD_HEADERS: 'x-request-id',
    });
    const r = await postGql(running.url, SAMPLE, trackedAgent(), { 'x-request-id': 'rid-61' });
    expectSample200(r);
    expect(ext.rec).toHaveLength(3);
    for (const call of ext.rec) expect(call.headers['x-request-id']).toBe('rid-61');
  });

  it('edge auth context survives the adapter: pii token unredacts reviewers, none redacts', async () => {
    const { running } = await start({ PORT: '0', REST_BASE_URL: extBase });
    const reviewersOf = (r: Resp): unknown[] => {
      expect(r.status).toBe(200);
      expect(r.json?.errors).toBeUndefined();
      const out: unknown[] = [];
      for (const e of r.json.data.authors.edges)
        for (const b of e.node.books) for (const rv of b.reviews) out.push(rv.reviewer);
      return out;
    };
    const withAuth = reviewersOf(
      await postGql(running.url, REVIEWERS, false, { authorization: 'Bearer user:u1:pii' }),
    );
    const without = reviewersOf(await postGql(running.url, REVIEWERS, false));
    expect(withAuth.length).toBeGreaterThan(0);
    expect(without).toHaveLength(withAuth.length);
    for (const v of withAuth) {
      expect(typeof v).toBe('string');
      expect(v).not.toBe('REDACTED');
    }
    for (const v of without) expect(v).toBe('REDACTED');
  });
});

describe('EB11: no new log noise', () => {
  it('injected log: a full EB2 run logs exactly the 2 startup lines; console untouched', async () => {
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'info'),
    ];
    const lines: string[] = [];
    const { running } = await start({ PORT: '0', REST_LATENCY_MS: '300' }, (l) => lines.push(l));
    const { ra } = await eb2Sequence(running);
    expect(ra.kind).toBe('response');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^REST backend \(bundled\): http:\/\/127\.0\.0\.1:\d+ \(latency 300ms\/request\)$/);
    expect(lines[1]).toBe(`GraphQL gateway + GraphiQL: ${running.url.replace('127.0.0.1', 'localhost')}`);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe('EB12: library contract unchanged', () => {
  let app: FastifyInstance;
  let base: string;
  beforeAll(async () => {
    app = buildBackend({ latencyMs: 300 }).app;
    base = await app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('GatewayServer still exposes yoga, fetch and close', async () => {
    const gw = createGateway({ restBaseUrl: base });
    expect(gw.yoga).toBeDefined();
    expect(typeof gw.fetch).toBe('function');
    expect(typeof gw.close).toBe('function');
    await gw.close();
  });

  it('fetch: in-flight request completes 200; /graphql and /healthz are 503 after close()', async () => {
    const gw = createGateway({ restBaseUrl: base });
    const inflight = gw.fetch('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: SAMPLE }),
    });
    await sleep(50);
    const closing = gw.close();
    const res = await inflight;
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.extensions.downstreamCalls.total).toBe(3);
    await closing;
    const g = await gw.fetch('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
    });
    expect(g.status).toBe(503);
    const h = await gw.fetch('http://gateway.local/healthz');
    expect(h.status).toBe(503);
  });
});
