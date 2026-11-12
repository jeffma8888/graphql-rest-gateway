import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway, type DownstreamCallEvent } from '../src/lib';

/**
 * iter-91: idempotent `close()` (PRODUCT row 90).
 *
 * Black-box: the bundled Fastify backend (latencyMs 200) behind a gateway
 * driven only through `gateway.fetch` / `gateway.close()`. Repeated and
 * concurrent close() calls must share one drain (each resolves once the last
 * in-flight request settles, not at the 5 s cap), the cap must still bound a
 * stuck request, and a drained child process must exit by itself.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const Q = '{ authors(first: 1) { edges { node { id } } } }';
const Q2 = '{ authors(first: 2) { edges { node { id name } } } }';
const Q3 = '{ books(first: 1) { edges { node { id } } } }';

type Gql = {
  data?: { authors?: { edges: Array<{ node: { id: string } }> } } | null;
  errors?: unknown[];
  extensions?: { downstreamCalls?: unknown };
};

function post(gw: { fetch: (u: string, i?: RequestInit) => Promise<Response> }, query: string): Promise<Response> {
  return Promise.resolve(
    gw.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    }),
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let backend: FastifyInstance;
let baseUrl: string;

async function stats(): Promise<{ total: number; byRoute: Record<string, number> }> {
  const r = await fetch(`${baseUrl}/__stats`);
  return (await r.json()) as { total: number; byRoute: Record<string, number> };
}
async function resetStats(): Promise<void> {
  const r = await fetch(`${baseUrl}/__stats/reset`, { method: 'POST' });
  expect(r.ok).toBe(true);
}

beforeAll(async () => {
  backend = buildBackend({ latencyMs: 200 }).app;
  baseUrl = await backend.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await backend.close();
});

/** Runs Q, waits 20 ms, calls close() twice (A then B) without awaiting. */
async function closeTwiceDuringQ() {
  const gw = createGateway({ restBaseUrl: baseUrl });
  const t0 = performance.now();
  let tQ = -1;
  const q = post(gw, Q).then((r) => {
    tQ = performance.now();
    return r;
  });
  await sleep(20);
  const tCallA = performance.now();
  let tA = -1;
  const a = gw.close().then((v) => {
    tA = performance.now();
    return v;
  });
  const tCallB = performance.now();
  let tB = -1;
  const b = gw.close().then((v) => {
    tB = performance.now();
    return v;
  });
  const [res, va, vb] = await Promise.all([q, a, b]);
  return { gw, res, va, vb, t0, tQ, tA, tB, tCallA, tCallB };
}

describe('EB1/EB2: concurrent close() calls share one drain; the drained request is unaffected', () => {
  let r: Awaited<ReturnType<typeof closeTwiceDuringQ>>;
  let body: Gql;
  let freshBody: Gql;

  beforeAll(async () => {
    r = await closeTwiceDuringQ();
    body = (await r.res.json()) as Gql;
    const fresh = createGateway({ restBaseUrl: baseUrl });
    const fr = await post(fresh, Q);
    expect(fr.status).toBe(200);
    freshBody = (await fr.json()) as Gql;
    // fresh gateway is never closed on purpose (spec: "never closed"); nothing is in flight.
  }, 10000);

  it('EB1: both closes resolve to undefined', () => {
    expect(r.va).toBeUndefined();
    expect(r.vb).toBeUndefined();
  });

  it('EB1: neither close resolves earlier than 150 ms after Q started', () => {
    expect(r.tA - r.t0).toBeGreaterThanOrEqual(150);
    expect(r.tB - r.t0).toBeGreaterThanOrEqual(150);
  });

  it('EB1: each close resolves within 500 ms after Q settles', () => {
    expect(r.tQ).toBeGreaterThan(0);
    expect(r.tA - r.tQ).toBeLessThanOrEqual(500);
    expect(r.tB - r.tQ).toBeLessThanOrEqual(500);
  });

  it('EB1: each close resolves less than 2000 ms after it was called (not at the 5 s cap)', () => {
    expect(r.tA - r.tCallA).toBeLessThan(2000);
    expect(r.tB - r.tCallB).toBeLessThan(2000);
  });

  it('EB2: Q answers 200 with author a1 and no errors', () => {
    expect(r.res.status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data?.authors?.edges[0]?.node.id).toBe('a1');
  });

  it('EB2: Q carries the same extensions.downstreamCalls as on a never-closed gateway', () => {
    expect(body.extensions?.downstreamCalls).toBeDefined();
    expect(body.extensions?.downstreamCalls).toEqual(freshBody.extensions?.downstreamCalls);
  });

  it('EB4: a third close() after the first two resolved resolves within 100 ms', async () => {
    const t = performance.now();
    const v = await r.gw.close();
    expect(v).toBeUndefined();
    expect(performance.now() - t).toBeLessThan(100);
  });
});

describe('EB3: close waits for the last of several concurrent requests', () => {
  it('both closes resolve no earlier than 150 ms after start and within 500 ms of the last settle', async () => {
    const gw = createGateway({ restBaseUrl: baseUrl });
    const t0 = performance.now();
    let tLast = -1;
    const mark = (p: Promise<Response>) =>
      p.then((res) => {
        tLast = Math.max(tLast, performance.now());
        return res;
      });
    const reqs = [mark(post(gw, Q)), mark(post(gw, Q2)), mark(post(gw, Q3))];
    await sleep(20);
    let tA = -1;
    let tB = -1;
    const a = gw.close().then(() => {
      tA = performance.now();
    });
    const b = gw.close().then(() => {
      tB = performance.now();
    });
    const results = await Promise.all(reqs);
    await Promise.all([a, b]);
    for (const res of results) expect(res.status).toBe(200);
    expect(tA - t0).toBeGreaterThanOrEqual(150);
    expect(tB - t0).toBeGreaterThanOrEqual(150);
    expect(tA - tLast).toBeLessThanOrEqual(500);
    expect(tB - tLast).toBeLessThanOrEqual(500);
  });
});

describe('EB4: close() on an idle gateway resolves promptly, twice', () => {
  it('first and second close() each resolve within 100 ms', async () => {
    const gw = createGateway({ restBaseUrl: baseUrl });
    const t1 = performance.now();
    expect(await gw.close()).toBeUndefined();
    expect(performance.now() - t1).toBeLessThan(100);
    const t2 = performance.now();
    expect(await gw.close()).toBeUndefined();
    expect(performance.now() - t2).toBeLessThan(100);
  });

  it('two close() calls issued back to back on an idle gateway both resolve within 100 ms', async () => {
    const gw = createGateway({ restBaseUrl: baseUrl });
    const t = performance.now();
    await Promise.all([gw.close(), gw.close()]);
    expect(performance.now() - t).toBeLessThan(100);
  });
});

describe('EB5: the 5 s cap still bounds a stuck request', () => {
  let stub: Server;
  let stubUrl: string;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    stub = createServer(() => {
      /* accept the request, never send headers */
    });
    stub.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    const addr = stub.address();
    if (!addr || typeof addr === 'string') throw new Error('no stub address');
    stubUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => stub.close(() => r()));
  });

  it('both concurrent closes resolve between 4500 and 7000 ms after the first call', { timeout: 12000 }, async () => {
    const gw = createGateway({ restBaseUrl: stubUrl, downstreamTimeoutMs: 30000 });
    const q = post(gw, Q).catch(() => null);
    // wait until the downstream request has reached the stub
    const deadline = performance.now() + 2000;
    while (sockets.size === 0 && performance.now() < deadline) await sleep(5);
    expect(sockets.size).toBeGreaterThan(0);
    const t = performance.now();
    let tA = -1;
    let tB = -1;
    await Promise.all([
      gw.close().then(() => {
        tA = performance.now() - t;
      }),
      gw.close().then(() => {
        tB = performance.now() - t;
      }),
    ]);
    expect(tA).toBeGreaterThanOrEqual(4500);
    expect(tA).toBeLessThanOrEqual(7000);
    expect(tB).toBeGreaterThanOrEqual(4500);
    expect(tB).toBeLessThanOrEqual(7000);
    for (const s of sockets) s.destroy();
    await q;
  });
});

describe('EB6: a drained child process exits by itself', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'gw-iter91-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits with code 0 within 1500 ms after printing CLOSED', { timeout: 12000 }, async () => {
    const lib = pathToFileURL(join(root, 'src', 'lib.ts')).href;
    const script = join(dir, 'child.mts');
    writeFileSync(
      script,
      [
        `import { createGateway, buildBackend } from ${JSON.stringify(lib)};`,
        `const { app } = buildBackend({ latencyMs: 100 });`,
        `const restBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });`,
        `const gateway = createGateway({ restBaseUrl });`,
        `const q = gateway.fetch('http://localhost/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: ${JSON.stringify(Q)} }) });`,
        `await new Promise((r) => setTimeout(r, 20));`,
        `await gateway.close();`,
        `const res = await q;`,
        `const body = await res.json();`,
        `await app.close();`,
        `process.stdout.write('STATUS ' + res.status + ' ' + body.data.authors.edges[0].node.id + '\\n');`,
        `process.stdout.write('CLOSED\\n');`,
      ].join('\n'),
    );
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let tMarker = -1;
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (tMarker < 0 && out.includes('CLOSED')) tMarker = performance.now();
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), 10000);
    const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    const tExit = performance.now();
    clearTimeout(killer);
    expect(err.includes('Error') ? err : '').toBe('');
    expect(out).toContain('STATUS 200 a1');
    expect(tMarker).toBeGreaterThan(0);
    expect(code).toBe(0);
    expect(tExit - tMarker).toBeLessThan(1500);
  });
});

describe('EB7: shutdown semantics are unchanged', () => {
  it('after close(), /graphql, /healthz and /readyz answer 503 with 0 downstream calls', async () => {
    const events: DownstreamCallEvent[] = [];
    const gw = createGateway({ restBaseUrl: baseUrl, onDownstreamCall: (e) => events.push(e) });
    await gw.close();
    await resetStats();
    const g = await post(gw, Q);
    const h = await gw.fetch('http://localhost/healthz');
    const rz = await gw.fetch('http://localhost/readyz');
    expect([g.status, h.status, rz.status]).toEqual([503, 503, 503]);
    await sleep(250);
    expect((await stats()).total).toBe(0);
    expect(events).toEqual([]);
  });

  it('a request started after a pending close() also answers 503', async () => {
    const gw = createGateway({ restBaseUrl: baseUrl });
    const q = post(gw, Q);
    await sleep(20);
    const c = gw.close();
    const late = await post(gw, Q);
    expect(late.status).toBe(503);
    expect((await q).status).toBe(200);
    await c;
  });
});

describe('EB8: README documents the close() contract', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const start = readme.indexOf('### Programmatic usage');
  const end = readme.indexOf('\n## ', start);
  const section = readme.slice(start, end);
  const sentences = section.split(/(?<=\.)\s+/);
  const about = (needle: string) => sentences.filter((s) => s.includes(needle));

  it('Programmatic usage section is present', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it('a close() sentence says repeated calls share one drain', () => {
    const hits = about('share one drain');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((s) => s.includes('close()'))).toBe(true);
  });

  it('it says each call resolves when the last in-flight request settles, or at the 5 s cap', () => {
    const s = about('share one drain').join(' ');
    expect(s).toMatch(/last in-flight request settles/);
    expect(s).toMatch(/5 s cap/);
  });

  it('a close() sentence says no gateway timer keeps the process alive once the drain settles', () => {
    const hits = about('keeps the process alive');
    expect(hits.length).toBeGreaterThan(0);
    const s = hits.join(' ');
    expect(s).toMatch(/no gateway timer keeps the process alive/);
    expect(s).toMatch(/drain settles/);
    expect(s).toContain('close()');
  });
});
