import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import http, { createServer, type Server, type RequestListener } from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway, type GatewayServer } from '../src/lib';

/**
 * iter-92: `gateway.nodeListener` (PRODUCT row 91).
 *
 * Black-box: the bundled Fastify backend behind a gateway mounted on a plain
 * `http.createServer(gw.nodeListener)`. close() must drain the listener's
 * in-flight requests, refuse new work with 503 + `connection: close` at 0
 * downstream calls, wait for response writes (no truncation after
 * closeAllConnections()), and keep ONE 5 s cap across both phases.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const Q1 = '{ author(id:"a1"){ name } }';
const SAMPLE = `{ authors(first:5){ edges{ node{ id books{ id reviews{ id } } } } } }`;
const BIG = '{ authors(first: 50) { edges { node { name books { title reviews { reviewer } } } } } }';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// EB1 type-level pin: the property is declared on the exported interface.
type _NodeListenerIsRequestListener = GatewayServer['nodeListener'] extends RequestListener ? true : never;
const _typePin: _NodeListenerIsRequestListener = true;
void _typePin;

type Resp = { status: number; headers: http.IncomingHttpHeaders; text: string; json: any; at: number };

/**
 * One request; on a FRESH connection (agent: false, which itself sends
 * `connection: close`) unless a keep-alive agent is given.
 */
function req(url: string, method: 'GET' | 'POST', path: string, body?: unknown, agent?: http.Agent): Promise<Resp> {
  return new Promise((res, rej) => {
    const u = new URL(path, url);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method,
        agent: agent ?? false,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
      },
      (m) => {
        const chunks: Buffer[] = [];
        m.on('data', (c: Buffer) => chunks.push(c));
        m.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          res({ status: m.statusCode ?? 0, headers: m.headers, text, json, at: performance.now() });
        });
        m.on('error', rej);
      },
    );
    r.on('error', rej);
    if (payload) r.write(payload);
    r.end();
  });
}

const gql = (url: string, query: string, agent?: http.Agent) => req(url, 'POST', '/graphql', { query }, agent);

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}
async function shut(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}

type Backend = { app: FastifyInstance; url: string };
async function startBackend(latencyMs: number): Promise<Backend> {
  const app = buildBackend({ latencyMs }).app;
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, url };
}
async function total(b: Backend): Promise<number> {
  const r = await fetch(`${b.url}/__stats`);
  return ((await r.json()) as { total: number }).total;
}

let b0: Backend; // latencyMs 0
let b300: Backend; // latencyMs 300
let b200: Backend; // latencyMs 200

beforeAll(async () => {
  [b0, b300, b200] = await Promise.all([startBackend(0), startBackend(300), startBackend(200)]);
});
afterAll(async () => {
  await Promise.all([b0.app.close(), b300.app.close(), b200.app.close()]);
});

describe('EB1: stable public property', () => {
  it('is a function, identity-stable, distinct per gateway; yoga/fetch/close still exist', async () => {
    const gw = createGateway({ restBaseUrl: b0.url });
    const gw2 = createGateway({ restBaseUrl: b0.url });
    expect(typeof gw.nodeListener).toBe('function');
    expect(gw.nodeListener).toBe(gw.nodeListener);
    expect(gw.nodeListener).not.toBe(gw2.nodeListener);
    const l: RequestListener = gw.nodeListener;
    expect(typeof l).toBe('function');
    expect(gw.yoga).toBeDefined();
    expect(typeof gw.fetch).toBe('function');
    expect(typeof gw.close).toBe('function');
    await Promise.all([gw.close(), gw2.close()]);
  });
});

describe('EB2: serves like gw.fetch before close (latencyMs 0)', () => {
  let gw: GatewayServer;
  let server: Server;
  let url: string;
  const ka = new http.Agent({ keepAlive: true });
  beforeAll(async () => {
    gw = createGateway({ restBaseUrl: b0.url });
    server = createServer(gw.nodeListener);
    url = await listen(server);
  });
  afterAll(async () => {
    ka.destroy();
    await gw.close();
    await shut(server);
  });

  it('SAMPLE answers 200, data equals gw.fetch, 3 downstream calls, no connection: close', async () => {
    const before = await total(b0);
    const r = await gql(url, SAMPLE, ka);
    const after = await total(b0);
    expect(r.status).toBe(200);
    expect(r.json.errors).toBeUndefined();
    expect(r.json.extensions.downstreamCalls.total).toBe(3);
    expect(after - before).toBe(3);
    expect(r.headers.connection).not.toBe('close');
    const viaFetch = await gw.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: SAMPLE }),
    });
    const fj = (await viaFetch.json()) as { data: unknown };
    expect(r.json.data).toEqual(fj.data);
    expect(r.json.data.authors.edges.length).toBe(5);
  });

  it('/healthz and /readyz answer 200 without connection: close', async () => {
    const h = await req(url, 'GET', '/healthz', undefined, ka);
    expect(h.status).toBe(200);
    expect(h.json).toEqual({ status: 'ok' });
    expect(h.headers.connection).not.toBe('close');
    const rd = await req(url, 'GET', '/readyz', undefined, ka);
    expect(rd.status).toBe(200);
    expect(rd.json).toEqual({ status: 'ready' });
    expect(rd.headers.connection).not.toBe('close');
  });
});

describe('EB3/EB4: in-flight request drains; new work refused at 0 downstream calls (latencyMs 300)', () => {
  let inflight: Resp;
  let tSent = 0;
  let tClosed = 0;
  let during: Resp[] = [];
  let afterR: Resp[] = [];
  let totalBefore = 0;
  let totalAfter = 0;
  let gw: GatewayServer;
  let server: Server;

  beforeAll(async () => {
    gw = createGateway({ restBaseUrl: b300.url });
    server = createServer(gw.nodeListener);
    const url = await listen(server);
    tSent = performance.now();
    const p = gql(url, Q1);
    await sleep(50);
    const closing = gw.close().then(() => {
      tClosed = performance.now();
    });
    await sleep(20);
    totalBefore = await total(b300);
    during = await Promise.all([gql(url, Q1), req(url, 'GET', '/healthz')]);
    expect(tClosed).toBe(0); // still draining when the "during" requests were answered
    inflight = await p;
    await closing;
    afterR = await Promise.all([gql(url, Q1), req(url, 'GET', '/healthz')]);
    await sleep(350); // any (wrongly) dispatched downstream call would have landed by now
    totalAfter = await total(b300);
    await shut(server);
  }, 10000);

  it('EB3: in-flight Q1 answers 200 with Ada Lovelace and connection: close', () => {
    expect(inflight.status).toBe(200);
    expect(inflight.json.errors).toBeUndefined();
    expect(inflight.json.data.author.name).toBe('Ada Lovelace');
    expect(inflight.headers.connection).toBe('close');
  });

  it('EB3: close() resolves no earlier than 200 ms after Q1 was sent, within 2000 ms', () => {
    expect(tClosed).toBeGreaterThan(0);
    expect(tClosed - tSent).toBeGreaterThanOrEqual(200);
    expect(tClosed - tSent).toBeLessThanOrEqual(2000);
  });

  it('EB4: requests during and after close() answer 503 with connection: close', () => {
    expect(during).toHaveLength(2);
    expect(afterR).toHaveLength(2);
    for (const r of [...during, ...afterR]) {
      expect(r.status).toBe(503);
      expect(r.headers.connection).toBe('close');
    }
  });

  it('EB4: refused requests cause 0 downstream calls', () => {
    // totalBefore already includes the in-flight Q1's single call (sent 70 ms earlier).
    expect(totalAfter).toBe(totalBefore);
  });
});

describe('EB5: no truncation when closeAllConnections() follows await close()', () => {
  it('a 20-op batched POST in flight still arrives whole (>= 20000 bytes, 20 results)', async () => {
    const gw = createGateway({ restBaseUrl: b200.url, maxComplexity: 100000, maxBatchSize: 20 });
    const server = createServer(gw.nodeListener);
    const url = await listen(server);
    const p = req(url, 'POST', '/graphql', Array.from({ length: 20 }, () => ({ query: BIG })));
    await sleep(50);
    await gw.close();
    server.closeAllConnections();
    const r = await p;
    await new Promise<void>((done) => server.close(() => done()));
    expect(r.status).toBe(200);
    expect(Buffer.byteLength(r.text)).toBeGreaterThanOrEqual(20000);
    const arr = JSON.parse(r.text) as Array<{ data: unknown; errors?: unknown }>;
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toHaveLength(20);
    for (const item of arr) {
      expect(item.data).not.toBeNull();
      expect(item.data).toBeDefined();
      expect(item.errors).toBeUndefined();
    }
  }, 10000);
});

describe('EB6: idle and idempotent paths keep the iter-91 contract', () => {
  it('(a) after served requests completed, close() resolves within 100 ms', async () => {
    const gw = createGateway({ restBaseUrl: b0.url });
    const server = createServer(gw.nodeListener);
    const url = await listen(server);
    expect((await gql(url, Q1)).status).toBe(200);
    expect((await req(url, 'GET', '/healthz')).status).toBe(200);
    const t = performance.now();
    await gw.close();
    expect(performance.now() - t).toBeLessThanOrEqual(100);
    await shut(server);
  });

  it('(b) two same-tick close() calls both wait for the in-flight request; (c) a third is fast', async () => {
    const gw = createGateway({ restBaseUrl: b300.url });
    const server = createServer(gw.nodeListener);
    const url = await listen(server);
    const tSent = performance.now();
    const p = gql(url, Q1);
    await sleep(50);
    let tA = 0;
    let tB = 0;
    const a = gw.close().then(() => (tA = performance.now()));
    const b = gw.close().then(() => (tB = performance.now()));
    await Promise.all([a, b]);
    expect(tA - tSent).toBeGreaterThanOrEqual(200);
    expect(tB - tSent).toBeGreaterThanOrEqual(200);
    expect(tA - tSent).toBeLessThanOrEqual(2000);
    expect(tB - tSent).toBeLessThanOrEqual(2000);
    const r = await p;
    expect(r.status).toBe(200);
    const t3 = performance.now();
    await gw.close();
    expect(performance.now() - t3).toBeLessThanOrEqual(50);
    await shut(server);
  }, 10000);
});

describe('EB7: one shared 5 s cap across fetch and flush phases', () => {
  it('close() resolves between 4500 and 7000 ms with a never-answering downstream', async () => {
    const stubSockets: Socket[] = [];
    const stub = net.createServer((s) => {
      stubSockets.push(s);
      s.on('error', () => {});
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    const gw = createGateway({ restBaseUrl: stubUrl, downstreamTimeoutMs: 20000 });
    const server = createServer(gw.nodeListener);
    const url = await listen(server);
    const p = gql(url, Q1).catch((e: unknown) => e);
    const deadline = performance.now() + 3000;
    while (stubSockets.length === 0 && performance.now() < deadline) await sleep(10);
    expect(stubSockets.length).toBeGreaterThan(0);
    const t = performance.now();
    await gw.close();
    const dt = performance.now() - t;
    // teardown: release the stuck downstream and the client
    for (const s of stubSockets) s.destroy();
    server.closeAllConnections();
    await p;
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => stub.close(() => r()));
    expect(dt).toBeGreaterThanOrEqual(4500);
    expect(dt).toBeLessThanOrEqual(7000);
  }, 15000);
});

describe('EB8: unchanged surfaces', () => {
  it('lib runtime keys are exactly the pinned set', async () => {
    const lib = await import('../src/lib');
    expect(Object.keys(lib).sort()).toEqual(
      ['BATCHED', 'NAIVE', 'buildBackend', 'createContext', 'createGateway', 'parseAuth', 'schema'].sort(),
    );
  });

  it('package.json exports equal HEAD', () => {
    const head = JSON.parse(execFileSync('git', ['show', 'HEAD:package.json'], { cwd: root, encoding: 'utf8' }));
    const now = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(now.exports).toEqual(head.exports);
    expect(JSON.stringify(now.exports)).not.toContain('http-adapter');
  });

  it('gw.fetch still answers 503 after close()', async () => {
    const gw = createGateway({ restBaseUrl: b0.url });
    await gw.close();
    const r = await gw.fetch('http://localhost/healthz');
    expect(r.status).toBe(503);
  });

  // Spec names test_iter25/61/91; no test_iter25 file exists in the repo, so the two that exist are pinned.
  it('test_iter61/91 carry no edits', () => {
    for (const f of ['test_iter61_behavior.test.ts', 'test_iter91_behavior.test.ts']) {
      const out = execFileSync('git', ['status', '--porcelain', '--', `test/${f}`], { cwd: root, encoding: 'utf8' });
      expect(out, f).toBe('');
      const head = execFileSync('git', ['show', `HEAD:test/${f}`], { cwd: root, encoding: 'utf8' });
      expect(readFileSync(resolve(root, 'test', f), 'utf8')).toBe(head);
    }
  });
});

describe('EB9: README Programmatic usage', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  const start = readme.indexOf('### Programmatic usage');
  const end = readme.indexOf('#### Options reference', start);
  const section = readme.slice(start, end);
  const snippet = /```ts\n([\s\S]*?)```/.exec(section)?.[1] ?? '';
  const prose = section.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ');
  const sentences = prose.split(/(?<=\.)\s+(?=[A-Z`])/);

  it('section and ts snippet exist; snippet mounts createServer(gateway.nodeListener)', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(snippet).toContain('createServer(gateway.nodeListener)');
  });

  it('no longer advises a raw yoga mount', () => {
    expect(section).not.toContain('mount gateway.yoga on any Node HTTP server');
  });

  it('one sentence says a raw gateway.yoga mount bypasses the drain (answers after close(), no 503)', () => {
    const s = sentences.find((x) => x.includes('gateway.yoga') && /bypass/i.test(x));
    expect(s).toBeDefined();
    expect(s).toContain('close()');
    expect(s).toMatch(/503/);
  });

  it('one sentence says close() waits for nodeListener writes under the same 5 s cap so closeAllConnections() truncates nothing', () => {
    const s = sentences.find((x) => x.includes('nodeListener') && x.includes('closeAllConnections()'));
    expect(s).toBeDefined();
    expect(s).toMatch(/5 s cap/);
    expect(s).toMatch(/truncates nothing/);
    expect(s).toMatch(/finish writing/);
  });

  it("iter-91's close() paragraph sentences stay byte-identical", () => {
    const head = execFileSync('git', ['show', 'HEAD:README.md'], { cwd: root, encoding: 'utf8' });
    const para = head.split('\n').find((l) => l.startsWith('`close()` is idempotent:'));
    expect(para).toBeDefined();
    expect(para!).toContain('5 s cap');
    expect(para!).toContain('downstreamTimeoutMs');
    expect(section).toContain(para!);
  });
});
