import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import http, { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway, type GatewayServer } from '../src/lib';
import { createDrainAwareListener, type DrainAwareListener } from '../src/http-adapter';

/**
 * iter-94: `gateway.nodeListener` writes Yoga's response body straight to the
 * ServerResponse with backpressure (PRODUCT row 92, re-landed from iter-93).
 *
 * Black-box: the bundled Fastify backend behind `createServer(gw.nodeListener)`.
 * Every answer must be byte-identical to the in-process `gw.fetch` reference.
 * No throughput number is asserted here: a same-process req/s ratio is not
 * load-invariant in the parallel suite, so the 0.80 floor lives in the serial
 * `npm run bench:listener` script, which is only exercised at extreme thresholds.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const TYPENAME = '{ __typename }';
const QB = '{ authors(first: 5) { edges { node { id name books { id title reviews { id rating } } } } } }';
const BATCH = Array.from({ length: 20 }, () => ({ query: QB }));
const BIG_OPTS = { maxComplexity: 100000, maxBatchSize: 20 };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// EB7 type-level pin: the public signature stays (fetch, isClosing) => DrainAwareListener.
type _Arity = Parameters<typeof createDrainAwareListener>['length'] extends 2 ? true : never;
type _Returns = ReturnType<typeof createDrainAwareListener> extends DrainAwareListener ? true : never;
const _arity: _Arity = true;
const _returns: _Returns = true;
void _arity;
void _returns;

type Raw = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

/** One request; `payload` is sent verbatim (string) so malformed bodies are possible. */
function send(
  url: string,
  method: 'GET' | 'POST',
  path: string,
  payload?: string,
  agent?: http.Agent,
  pauseMs = 0,
): Promise<Raw> {
  return new Promise((res, rej) => {
    const u = new URL(path, url);
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        agent: agent ?? false,
        headers:
          payload !== undefined
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {},
      },
      (m) => {
        const chunks: Buffer[] = [];
        if (pauseMs > 0) {
          m.pause();
          setTimeout(() => m.resume(), pauseMs);
        }
        m.on('data', (c: Buffer) => chunks.push(c));
        m.on('end', () => res({ status: m.statusCode ?? 0, headers: m.headers, body: Buffer.concat(chunks) }));
        m.on('error', rej);
      },
    );
    r.on('error', rej);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

type Ref = { status: number; contentType: string | null; body: Buffer };
async function reference(gw: GatewayServer, method: 'GET' | 'POST', path: string, payload?: string): Promise<Ref> {
  // A WHATWG Request object, as a Node bridge hands Yoga. (Passing a URL + init
  // instead changes V8's JSON SyntaxError text for request (f); that is
  // request-side behaviour, out of scope for this slice.)
  const r = await gw.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: payload !== undefined ? { 'content-type': 'application/json' } : {},
      body: payload,
    }),
  );
  return { status: r.status, contentType: r.headers.get('content-type'), body: Buffer.from(await r.arrayBuffer()) };
}

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

/** Collect process-level hazards for the duration of a test. */
function watchProcess() {
  const warnings: Error[] = [];
  const rejections: unknown[] = [];
  const exceptions: unknown[] = [];
  const onW = (w: Error) => warnings.push(w);
  const onR = (e: unknown) => rejections.push(e);
  const onE = (e: unknown) => exceptions.push(e);
  process.on('warning', onW);
  process.on('unhandledRejection', onR);
  process.on('uncaughtException', onE);
  return {
    warnings,
    rejections,
    exceptions,
    stop() {
      process.off('warning', onW);
      process.off('unhandledRejection', onR);
      process.off('uncaughtException', onE);
    },
  };
}

/** The ship commit for this iteration if it exists, else null (pre-commit working tree). */
function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
function shipCommit(): string | null {
  const out = git(['log', '--fixed-strings', '--grep=(foundry iter 94)', '--format=%H', '-n', '1']).trim();
  return out === '' ? null : out;
}
/** Files under `test/` changed by this iteration (ship commit, or working tree + untracked vs HEAD). */
function changedTestFiles(): string[] {
  const c = shipCommit();
  const names = c
    ? git(['diff', '--name-only', `${c}~1`, c, '--', 'test/'])
    : git(['diff', '--name-only', 'HEAD', '--', 'test/']) +
      '\n' +
      git(['ls-files', '--others', '--exclude-standard', '--', 'test/']);
  return names
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}
/** `git diff --exit-code` on the given paths for this iteration; true when empty. */
function unchanged(paths: string[]): boolean {
  const c = shipCommit();
  const args = c ? ['diff', '--exit-code', `${c}~1`, c, '--', ...paths] : ['diff', '--exit-code', 'HEAD', '--', ...paths];
  try {
    execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

let b0: Backend;
let b200: Backend;

beforeAll(async () => {
  [b0, b200] = await Promise.all([startBackend(0), startBackend(200)]);
});
afterAll(async () => {
  await Promise.all([b0.app.close(), b200.app.close()]);
});

describe('EB1/EB2: byte-identical to gw.fetch, call count unchanged', () => {
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
    await shut(server);
    await gw.close();
  });

  const cases: Array<{ name: string; method: 'GET' | 'POST'; path: string; payload?: string; status?: number }> = [
    { name: '(a) POST { __typename }', method: 'POST', path: '/graphql', payload: JSON.stringify({ query: TYPENAME }), status: 200 },
    { name: '(b) POST nested authors/books/reviews', method: 'POST', path: '/graphql', payload: JSON.stringify({ query: QB }), status: 200 },
    { name: '(c) GET /graphql?query={__typename}', method: 'GET', path: '/graphql?query=%7B__typename%7D', status: 200 },
    { name: '(d) GET /healthz', method: 'GET', path: '/healthz', status: 200 },
    { name: '(e) GET /readyz', method: 'GET', path: '/readyz', status: 200 },
    { name: '(f) POST malformed body `{` -> 400', method: 'POST', path: '/graphql', payload: '{', status: 400 },
    { name: '(g) POST unknown author -> 200 NOT_FOUND', method: 'POST', path: '/graphql', payload: JSON.stringify({ query: '{ author(id: "nope") { id } }' }), status: 200 },
  ];

  for (const c of cases) {
    it(`EB1 ${c.name}: same status, content-type, body bytes; content-length = byte length`, async () => {
      const got = await send(url, c.method, c.path, c.payload, ka);
      const ref = await reference(gw, c.method, c.path, c.payload);
      expect(got.status).toBe(c.status);
      expect(got.status).toBe(ref.status);
      expect(got.headers['content-type']).toBe(ref.contentType);
      expect(got.headers['content-length']).toBe(String(got.body.length));
      expect(got.body.length).toBeGreaterThan(0);
      expect(got.body.equals(ref.body)).toBe(true);
    });
  }

  it('EB1 (g) carries a NOT_FOUND error code', async () => {
    const got = await send(url, 'POST', '/graphql', JSON.stringify({ query: '{ author(id: "nope") { id } }' }), ka);
    const j = JSON.parse(got.body.toString('utf8')) as { errors?: Array<{ extensions?: { code?: string } }> };
    expect(got.status).toBe(200);
    expect(j.errors?.map((e) => e.extensions?.code)).toContain('NOT_FOUND');
  });

  it('EB2 (b): downstreamCalls.total === 3, equal to the reference, and /__stats delta is 3', async () => {
    const before = await total(b0);
    const got = await send(url, 'POST', '/graphql', JSON.stringify({ query: QB }), ka);
    const after = await total(b0);
    const j = JSON.parse(got.body.toString('utf8')) as { data: { authors: { edges: unknown[] } }; extensions: { downstreamCalls: { total: number } } };
    expect(got.status).toBe(200);
    expect(j.data.authors.edges).toHaveLength(5);
    expect(j.extensions.downstreamCalls.total).toBe(3);
    expect(after - before).toBe(3);
    const ref = await reference(gw, 'POST', '/graphql', JSON.stringify({ query: QB }));
    const rj = JSON.parse(ref.body.toString('utf8')) as { extensions: { downstreamCalls: { total: number } } };
    expect(rj.extensions.downstreamCalls.total).toBe(j.extensions.downstreamCalls.total);
  });
});

describe('EB3: backpressure keeps a large body whole for a paused client', () => {
  it('20-query batch, client paused 200 ms: >= 20000 bytes, 20 clean results, equals reference', async () => {
    const gw = createGateway({ restBaseUrl: b0.url, ...BIG_OPTS });
    const server = createServer(gw.nodeListener);
    const url = await listen(server);
    try {
      const payload = JSON.stringify(BATCH);
      const got = await send(url, 'POST', '/graphql', payload, undefined, 200);
      const ref = await reference(gw, 'POST', '/graphql', payload);
      expect(got.status).toBe(200);
      expect(got.body.length).toBeGreaterThanOrEqual(20000);
      const arr = JSON.parse(got.body.toString('utf8')) as Array<{ data: { authors: { edges: unknown[] } }; errors?: unknown }>;
      expect(Array.isArray(arr)).toBe(true);
      expect(arr).toHaveLength(20);
      for (const item of arr) {
        expect(item.errors).toBeUndefined();
        expect(item.data.authors.edges).toHaveLength(5);
      }
      expect(got.body.equals(ref.body)).toBe(true);
    } finally {
      await shut(server);
      await gw.close();
    }
  }, 10000);
});

describe('EB4: no listener leak or stray warnings over one keep-alive socket', () => {
  it('200 sequential alternating requests: all 200, no MaxListenersExceededWarning, listener counts flat', async () => {
    const gw = createGateway({ restBaseUrl: b0.url, ...BIG_OPTS });
    const server = createServer(gw.nodeListener);
    const sockets: Socket[] = [];
    server.on('connection', (s: Socket) => sockets.push(s));
    const url = await listen(server);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const watch = watchProcess();
    const small = JSON.stringify({ query: TYPENAME });
    const big = JSON.stringify(BATCH);
    const counts = (s: Socket) => s.listenerCount('close') + s.listenerCount('drain') + s.listenerCount('end') + s.listenerCount('error');
    let early = -1;
    try {
      let ok = 0;
      for (let i = 0; i < 200; i++) {
        const r = await send(url, 'POST', '/graphql', i % 2 === 0 ? small : big, agent);
        if (r.status === 200 && r.body.length > 0) ok++;
        if (i === 9) early = counts(sockets[0]!);
      }
      await sleep(20);
      expect(ok).toBe(200);
      expect(sockets).toHaveLength(1); // one keep-alive socket carried every request
      const late = counts(sockets[0]!);
      expect(early).toBeGreaterThanOrEqual(0);
      expect(late).toBeLessThanOrEqual(early);
      expect(watch.warnings.filter((w) => w.name === 'MaxListenersExceededWarning')).toEqual([]);
      expect(watch.rejections).toEqual([]);
      expect(watch.exceptions).toEqual([]);
    } finally {
      watch.stop();
      agent.destroy();
      await shut(server);
      await gw.close();
    }
  }, 15000);
});

describe('EB5: client abort mid-response is contained', () => {
  it('no unhandled rejection; next request answers 200 correctly; close() resolves well under the 5 s cap', async () => {
    const gw = createGateway({ restBaseUrl: b200.url });
    const server = createServer(gw.nodeListener);
    const url = await listen(server);
    const watch = watchProcess();
    try {
      const u = new URL('/graphql', url);
      const payload = JSON.stringify({ query: QB });
      let gotResponse = false;
      await new Promise<void>((done) => {
        const r = http.request(
          {
            host: u.hostname,
            port: u.port,
            path: '/graphql',
            method: 'POST',
            agent: false,
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
          },
          () => {
            gotResponse = true;
          },
        );
        r.on('error', () => undefined);
        r.on('finish', () => {
          setTimeout(() => {
            r.destroy();
            done();
          }, 50);
        });
        r.end(payload);
      });
      expect(gotResponse).toBe(false); // aborted before the (>= 200 ms) response arrived

      const next = await send(url, 'POST', '/graphql', payload);
      expect(next.status).toBe(200);
      const j = JSON.parse(next.body.toString('utf8')) as { data: { authors: { edges: unknown[] } }; errors?: unknown };
      expect(j.errors).toBeUndefined();
      expect(j.data.authors.edges).toHaveLength(5);
      const ref = await reference(gw, 'POST', '/graphql', payload);
      expect(next.body.equals(ref.body)).toBe(true);

      // The aborted request's downstream work has settled by now (the follow-up took as long).
      const t = performance.now();
      await gw.close();
      expect(performance.now() - t).toBeLessThan(1000);
      await sleep(20);
      expect(watch.rejections).toEqual([]);
      expect(watch.exceptions).toEqual([]);
    } finally {
      watch.stop();
      await shut(server);
      await gw.close();
    }
  }, 15000);
});

describe('EB6: drain contract unchanged', () => {
  it('after close() starts a new request gets 503 + connection: close at 0 downstream calls', async () => {
    const gw = createGateway({ restBaseUrl: b200.url });
    const server = createServer(gw.nodeListener);
    const url = await listen(server);
    try {
      const inflight = send(url, 'POST', '/graphql', JSON.stringify({ query: QB }));
      await sleep(50);
      const closing = gw.close();
      const before = await total(b200);
      const r = await send(url, 'POST', '/graphql', JSON.stringify({ query: TYPENAME }));
      const after = await total(b200);
      expect(r.status).toBe(503);
      expect(r.headers.connection).toBe('close');
      expect(after - before).toBe(0);
      const first = await inflight;
      expect(first.status).toBe(200);
      await closing;
    } finally {
      await shut(server);
    }
  }, 10000);

  it('a 20-query batch in flight at close() arrives whole after closeAllConnections()', async () => {
    const gw = createGateway({ restBaseUrl: b200.url, ...BIG_OPTS });
    const server = createServer(gw.nodeListener);
    const url = await listen(server);
    const p = send(url, 'POST', '/graphql', JSON.stringify(BATCH));
    await sleep(50);
    await gw.close();
    server.closeAllConnections();
    const r = await p;
    await new Promise<void>((done) => server.close(() => done()));
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThanOrEqual(20000);
    const arr = JSON.parse(r.body.toString('utf8')) as Array<{ data: { authors: { edges: unknown[] } }; errors?: unknown }>;
    expect(arr).toHaveLength(20);
    for (const item of arr) {
      expect(item.errors).toBeUndefined();
      expect(item.data.authors.edges).toHaveLength(5);
    }
  }, 10000);

  it('iter-91, iter-92 and iter-61 test files are unmodified by this iteration', () => {
    expect(
      unchanged(['test/test_iter92_behavior.test.ts', 'test/test_iter91_behavior.test.ts', 'test/test_iter61_behavior.test.ts']),
    ).toBe(true);
  });
});

describe('EB7: the Readable.from + pipeline wrapper is gone, public surface unchanged', () => {
  const src = readFileSync(resolve(root, 'src/http-adapter.ts'), 'utf8');

  it('src/http-adapter.ts neither imports pipeline nor calls pipeline( or Readable.from(', () => {
    expect(src).not.toMatch(/from\s+['"]node:stream\/promises['"]/);
    expect(src).not.toMatch(/\bpipeline\b/);
    expect(src).not.toMatch(/\bReadable\.from\s*\(/);
  });

  it('createDrainAwareListener still takes (fetch, isClosing) and returns a DrainAwareListener object', async () => {
    expect(typeof createDrainAwareListener).toBe('function');
    expect(createDrainAwareListener.length).toBe(2);
    const gw = createGateway({ restBaseUrl: b0.url });
    try {
      const l = createDrainAwareListener(gw.fetch as Parameters<typeof createDrainAwareListener>[0], () => false);
      expect(typeof l).toBe('object');
      expect(l).not.toBeNull();
      expect(Object.values(l as object).some((v) => typeof v === 'function')).toBe(true);
    } finally {
      await gw.close();
    }
  });

  it('only the new iter-94 test file changes under test/; n-plus-1 test is byte-identical', () => {
    expect(changedTestFiles()).toEqual(['test/test_iter94_behavior.test.ts']);
    expect(unchanged(['test/n-plus-1.test.ts'])).toBe(true);
  });

  it('schema.graphql and generated types are untouched', () => {
    const c = shipCommit();
    const files = (c ? git(['diff', '--name-only', `${c}~1`, c]) : git(['diff', '--name-only', 'HEAD']))
      .split('\n')
      .filter(Boolean);
    expect(files.filter((f) => /schema\.graphql$|generated/.test(f))).toEqual([]);
  });
});

describe('EB8: no timing floor in the suite', () => {
  it('no test file asserts a nodeListener/yoga throughput ratio or a req/s bound', () => {
    const dir = resolve(root, 'test');
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && f !== 'test_iter94_behavior.test.ts') // self is checked below
      .filter((f) => {
        const t = readFileSync(resolve(dir, f), 'utf8');
        // A measured listener-vs-yoga ratio compared against a floor, as iter-93's EB1 did.
        return /fastest-round ratio|Math\.max\(\.\.\.node\)\s*\/\s*Math\.max\(\.\.\.yoga\)/.test(t);
      });
    expect(offenders).toEqual([]);
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(self).not.toMatch(/ratio\)\.toBeGreaterThan(OrEqual)?\(0\.8/);
  });
});

describe('EB9: serial bench:listener script exists and gates', () => {
  it('package.json wires bench:listener to tsx benchmark/listener.ts', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['bench:listener']).toBe('tsx benchmark/listener.ts');
  });

  it('main() passes at --threshold 0 and fails (exitCode 1) at --threshold 99, printing one result line each', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const before = process.exitCode;
    const t0 = performance.now();
    try {
      const { main } = await import('../benchmark/listener');
      expect(lines).toEqual([]); // importing ran nothing
      const ok = await main(['--rounds', '1', '--round-ms', '50', '--threshold', '0']);
      expect(ok.pass).toBe(true);
      expect(ok.ratio).toBeGreaterThan(0);
      expect(ok.threshold).toBe(0);
      expect(process.exitCode).toBe(before);
      const bad = await main(['--rounds', '1', '--round-ms', '50', '--threshold', '99']);
      expect(bad.pass).toBe(false);
      expect(bad.threshold).toBe(99);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = before;
      spy.mockRestore();
    }
    expect(performance.now() - t0).toBeLessThan(3000);
    const re = /^listener\/yoga ratio: \d+\.\d{3} \(threshold \d+\.\d{2}\) (PASS|FAIL)$/;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(re);
    expect(lines[0]).toMatch(/PASS$/);
    expect(lines[1]).toMatch(re);
    expect(lines[1]).toMatch(/FAIL$/);
  }, 10000);

  it('--threshold defaults to 0.80 and the result line prints it as 0.80', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const before = process.exitCode;
    try {
      const { main } = await import('../benchmark/listener');
      const r = await main(['--rounds', '1', '--round-ms', '50']);
      expect(r.threshold).toBe(0.8);
      expect(r.pass).toBe(r.ratio >= 0.8);
    } finally {
      process.exitCode = before;
      spy.mockRestore();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^listener\/yoga ratio: \d+\.\d{3} \(threshold 0\.80\) (PASS|FAIL)$/);
  }, 10000);

  it('main() closes every server and the backend before it resolves (no new TCP handles left)', async () => {
    const tcp = () => process.getActiveResourcesInfo().filter((n) => /^TCP/.test(n)).length;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const before = process.exitCode;
    const n0 = tcp();
    try {
      const { main } = await import('../benchmark/listener');
      await main(['--rounds', '1', '--round-ms', '50', '--threshold', '0']);
      await sleep(20);
      expect(tcp()).toBeLessThanOrEqual(n0);
    } finally {
      process.exitCode = before;
      spy.mockRestore();
    }
  }, 10000);

  it('run directly with a failing threshold, the script prints FAIL and exits 1 by itself', async () => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const res = await new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'benchmark/listener.ts', '--rounds', '1', '--round-ms', '50', '--threshold', '99'],
        { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
      const kill = setTimeout(() => child.kill('SIGKILL'), 8000);
      child.on('exit', (code) => {
        clearTimeout(kill);
        done({ code, out });
      });
    });
    expect(res.code).toBe(1);
    const lines = res.out.split('\n').filter((l) => l.startsWith('listener/yoga ratio:'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^listener\/yoga ratio: \d+\.\d{3} \(threshold 99\.00\) FAIL$/);
  }, 10000);

  it('an invalid --threshold rejects with an error naming the flag', async () => {
    const { main } = await import('../benchmark/listener');
    await expect(main(['--threshold', 'abc'])).rejects.toThrow(/--threshold/);
  });
});

describe('EB10: README records it', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

  it('test list has a Fast drain-aware listener bullet after the iter-92 bullet naming byte-identity and bench:listener', () => {
    const i92 = readme.indexOf('(`test_iter92_behavior.test.ts`)');
    const i94 = readme.indexOf('- **Fast drain-aware listener** (`test_iter94_behavior.test.ts`)');
    expect(i92).toBeGreaterThan(-1);
    expect(i94).toBeGreaterThan(i92);
    const line = readme.slice(i94, readme.indexOf('\n', i94));
    expect(line).toContain('0.80');
    expect(line).toMatch(/byte-identical/i);
    expect(line).toContain('npm run bench:listener');
    expect(line).toMatch(/not by `npm test`/);
  });

  it('Programmatic usage says nodeListener writes straight to the socket and bench:listener checks >= 0.80x gateway.yoga', () => {
    const start = readme.indexOf('### Programmatic usage');
    const end = readme.indexOf('#### Options reference', start);
    expect(start).toBeGreaterThan(-1);
    const section = readme.slice(start, end).replace(/\s+/g, ' ');
    const sentence = section.split(/(?<=\.)\s+(?=[A-Z`])/).find((s) => s.includes('nodeListener') && /straight to the socket/.test(s));
    expect(sentence).toBeDefined();
    expect(sentence).toContain('npm run bench:listener');
    expect(sentence).toContain('0.80');
    expect(sentence).toContain('gateway.yoga');
  });

  it('§8 says same-process throughput ratios live in serial bench scripts', () => {
    const start = readme.indexOf('## 8. Testing');
    const end = readme.indexOf('\n## 9', start);
    const section = readme.slice(start, end === -1 ? undefined : end).replace(/\s+/g, ' ');
    expect(section).toMatch(/throughput ratios are not load-invariant[^.]*parallel suite[^.]*serial bench scripts/);
  });

  it('badge and "N tests across M files" agree with each other', () => {
    const badge = /tests-(\d+)%20passing/.exec(readme);
    const line = /`npm test` — (\d+) tests across (\d+) files/.exec(readme);
    expect(badge).not.toBeNull();
    expect(line).not.toBeNull();
    expect(badge![1]).toBe(line![1]);
    const files = readdirSync(resolve(root, 'test')).filter((f) => f.endsWith('.test.ts')).length;
    expect(Number(line![2])).toBe(files);
  });

  it('contains no machine paths and no absolute req/s numbers', () => {
    expect(readme).not.toMatch(/\/Users\/|\/home\/[a-z]|[A-Z]:\\\\/);
    const i94 = readme.indexOf('- **Fast drain-aware listener**');
    const line = readme.slice(i94, readme.indexOf('\n', i94));
    expect(line).not.toMatch(/\d[\d.,]*\s*k?\s*req\/s/);
  });
});
