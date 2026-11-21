import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFile, type ExecFileException } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { createGateway } from '../src/lib';
import { runCheckBackend } from '../src/check-backend';
import { buildBackend } from '../src/rest-backend/server';

/**
 * iter-109: a credentialed `restBaseUrl` / `REST_BASE_URL` (non-empty WHATWG
 * username or password) is refused at configuration time with the userinfo
 * redacted to `***` (PRODUCT row 112).
 *
 * Black-box: the library is driven through `createGateway`, `npm start` through
 * `startFromEnv(env, log)` in-process plus one spawned `tsx src/index.ts`, and
 * check-backend through `runCheckBackend(args, env, io)` plus one spawned
 * `tsx src/check-backend-main.ts`. "0 requests" is read from a raw node:http
 * stub that counts every request it receives and from the bundled backend's
 * own `GET /__stats` counter. No assertion here is a wall-clock bound.
 */

const SENTINEL = 's3cr3t-pw';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const TSX = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SPAWN_T = 30_000;

const libCred = (redacted: string) =>
  `restBaseUrl must not contain credentials (user:password@ is refused by Node's fetch), got "${redacted}"`;
const envCred = (redacted: string) =>
  `REST_BASE_URL must not contain credentials (user:password@ is refused by Node's fetch), got "${redacted}"`;

type Running = { url: string; restBaseUrl: string; close(): Promise<void> };
type StartFromEnv = (env: Record<string, string | undefined>, log?: (line: string) => void) => Promise<Running>;

async function loadStart(): Promise<StartFromEnv> {
  return ((await import('../src/cli')) as unknown as { startFromEnv: StartFromEnv }).startFromEnv;
}

function libError(restBaseUrl: string, extra: Record<string, unknown> = {}): unknown {
  try {
    const gw = createGateway({ restBaseUrl, ...extra } as Parameters<typeof createGateway>[0]);
    void gw.close();
  } catch (e) {
    return e;
  }
  return undefined;
}

async function envError(env: Record<string, string | undefined>, logs: string[] = []): Promise<unknown> {
  const startFromEnv = await loadStart();
  try {
    const r = await startFromEnv({ PORT: '0', ...env }, (l) => logs.push(l));
    await r.close();
  } catch (e) {
    return e;
  }
  return undefined;
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : `<no error: ${String(e)}>`;
}

// ---------- request-counting stub + bundled backend ----------
let stub: Server;
let stubPort = 0;
let stubHits = 0;
let backend: FastifyInstance;
let backendUrl = '';

beforeAll(async () => {
  stub = createServer((req, res) => {
    stubHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  await new Promise<void>((ok) => stub.listen(0, '127.0.0.1', () => ok()));
  stubPort = (stub.address() as AddressInfo).port;
  backend = buildBackend({ latencyMs: 0 }).app;
  backendUrl = await backend.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await new Promise<void>((ok) => stub.close(() => ok()));
  await backend.close();
});

async function backendTotal(): Promise<number> {
  const res = await fetch(`${backendUrl}/__stats`);
  return ((await res.json()) as { total: number }).total;
}

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createNetServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => ok(p));
    });
  });
}

/** True when nothing accepts a TCP connection on 127.0.0.1:port. */
function portIsClosed(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/graphql`).then(
    () => false,
    () => true,
  );
}

// ---------- spawn helpers (clean env, no vitest/npm vars) ----------
type Run = { code: number | null; stdout: string; stderr: string };

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '' };
  for (const k of Object.keys(env)) {
    if (k.startsWith('VITEST') || k.startsWith('npm_')) delete env[k];
    if (k === 'REST_BASE_URL' || k === 'PORT' || k === 'TEST' || k === 'NODE_ENV') delete env[k];
  }
  env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`;
  return { ...env, ...extra };
}

function runTsx(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((ok) => {
    execFile(
      process.execPath,
      [TSX, script, ...args],
      { cwd: root, env, timeout: 25_000, maxBuffer: 8 * 1024 * 1024 },
      (err: ExecFileException | null, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        ok({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

// =====================================================================
describe('B1 - library, password', () => {
  it('createGateway throws a TypeError with the exact redacted message', () => {
    const e = libError('http://svc:s3cr3t-pw@127.0.0.1:9/');
    expect(e).toBeInstanceOf(TypeError);
    expect(msgOf(e)).toBe(libCred('http://***@127.0.0.1:9/'));
  });

  it('the message contains neither the password nor the username', () => {
    const e = libError('http://svc:s3cr3t-pw@127.0.0.1:9/');
    expect(e).toBeInstanceOf(TypeError);
    const m = msgOf(e);
    expect(m).not.toContain(SENTINEL);
    expect(m).not.toContain('svc');
  });

  it('redacts up to the LAST @ of the authority (spec example http://a:b@c@h/)', () => {
    const e = libError('http://a:b@c@h/');
    expect(e).toBeInstanceOf(TypeError);
    expect(msgOf(e)).toBe(libCred('http://***@h/'));
  });

  it('https URLs are refused the same way', () => {
    const e = libError(`https://svc:${SENTINEL}@example.test/api`);
    expect(e).toBeInstanceOf(TypeError);
    expect(msgOf(e)).toBe(libCred('https://***@example.test/api'));
  });
});

describe('B2 - library, username only / password only', () => {
  it('username only: TypeError ending got "http://***@127.0.0.1:9/"', () => {
    const e = libError('http://svc@127.0.0.1:9/');
    expect(e).toBeInstanceOf(TypeError);
    expect(msgOf(e)).toBe(libCred('http://***@127.0.0.1:9/'));
    expect(msgOf(e).endsWith('got "http://***@127.0.0.1:9/"')).toBe(true);
    expect(msgOf(e)).not.toContain('svc');
  });

  it('password only (http://:pw@host/): TypeError without the password', () => {
    const e = libError(`http://:${SENTINEL}@127.0.0.1:9/`);
    expect(e).toBeInstanceOf(TypeError);
    expect(msgOf(e)).toContain('must not contain credentials');
    expect(msgOf(e)).not.toContain(SENTINEL);
    expect(msgOf(e)).toContain('***@');
  });
});

describe('B3 - library, 0 calls against a LIVE backend', () => {
  it('request-counting stub: throws at createGateway, 0 requests, 0 hook calls', async () => {
    const before = stubHits;
    const calls: unknown[] = [];
    const e = libError(`http://svc:${SENTINEL}@127.0.0.1:${stubPort}/`, { onDownstreamCall: (ev: unknown) => calls.push(ev) });
    expect(e).toBeInstanceOf(TypeError);
    expect(msgOf(e)).toBe(libCred(`http://***@127.0.0.1:${stubPort}/`));
    await new Promise((r) => setTimeout(r, 50));
    expect(stubHits - before).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('bundled backend /__stats: total unchanged after the refused construction', async () => {
    const port = new URL(backendUrl).port;
    const before = await backendTotal();
    const calls: unknown[] = [];
    const e = libError(`http://svc:${SENTINEL}@127.0.0.1:${port}/`, { onDownstreamCall: (ev: unknown) => calls.push(ev) });
    expect(e).toBeInstanceOf(TypeError);
    expect(await backendTotal()).toBe(before);
    expect(calls).toHaveLength(0);
  });

  it('control: the same backend without userinfo is accepted and serves a query (the counter is live)', async () => {
    const before = await backendTotal();
    const gw = createGateway({ restBaseUrl: backendUrl });
    try {
      const res = await gw.fetch(
        new Request('http://gateway.local/graphql', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: '{ author(id: "a1") { name } }' }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data?: { author?: { name?: unknown } } };
      expect(typeof body.data?.author?.name).toBe('string');
    } finally {
      await gw.close();
    }
    expect(await backendTotal()).toBeGreaterThan(before);
  });
});

describe('B4 - library, other errors redacted', () => {
  it('ftp://svc:pw@h/ keeps the absolute-http(s) wording with "ftp://***@h/"', () => {
    const e = libError(`ftp://svc:${SENTINEL}@h/`);
    expect(e).toBeInstanceOf(TypeError);
    expect(msgOf(e)).toBe('restBaseUrl must be an absolute http(s) URL, got "ftp://***@h/"');
    expect(msgOf(e)).not.toContain(SENTINEL);
  });

  it('an unparseable credentialed value is redacted too', () => {
    const e = libError(`ht!tp://svc:${SENTINEL}@x`);
    expect(e).toBeInstanceOf(TypeError);
    expect(msgOf(e)).toBe('restBaseUrl must be an absolute http(s) URL, got "ht!tp://***@x"');
  });
});

describe('B5 - library, still accepted / unchanged messages', () => {
  for (const u of ['http://127.0.0.1:9/', 'http://127.0.0.1:9/api/v1', 'http://127.0.0.1:9/a@b', 'http://@127.0.0.1:9/']) {
    it(`accepts ${u}`, () => {
      expect(libError(u)).toBeUndefined();
    });
  }

  it('empty-userinfo URL against the live backend is accepted', () => {
    expect(libError(backendUrl.replace('http://', 'http://@') + '/')).toBeUndefined();
  });

  // Frozen by running createGateway at the pre-change commit.
  const HEAD_LIB: Array<[string, string]> = [
    ['localhost:4001', 'restBaseUrl must be an absolute http(s) URL, got "localhost:4001"'],
    ['ht!tp://x', 'restBaseUrl must be an absolute http(s) URL, got "ht!tp://x"'],
    ['ftp://h/', 'restBaseUrl must be an absolute http(s) URL, got "ftp://h/"'],
    ['', 'restBaseUrl must be an absolute http(s) URL, got ""'],
    ['  ', 'restBaseUrl must be an absolute http(s) URL, got "  "'],
  ];
  for (const [u, m] of HEAD_LIB) {
    it(`no-userinfo message for ${JSON.stringify(u)} is byte-identical to before`, () => {
      const e = libError(u);
      expect(e).toBeInstanceOf(TypeError);
      expect(msgOf(e)).toBe(m);
    });
  }
});

describe('B6 - npm start, password', () => {
  it('startFromEnv rejects with the exact message, prints no REST backend line, never binds PORT', async () => {
    const port = await freePort();
    const logs: string[] = [];
    const e = await envError({ PORT: String(port), REST_BASE_URL: `http://svc:${SENTINEL}@127.0.0.1:9/` }, logs);
    expect(msgOf(e)).toBe(envCred('http://***@127.0.0.1:9/'));
    expect(logs.some((l) => l.includes('REST backend'))).toBe(false);
    expect(logs.join('\n')).not.toContain(SENTINEL);
    expect(await portIsClosed(port)).toBe(true);
  });

  it('startFromEnv: 0 requests reach a live backend named by the credentialed URL', async () => {
    const before = stubHits;
    const e = await envError({ REST_BASE_URL: `http://svc:${SENTINEL}@127.0.0.1:${stubPort}/` });
    expect(msgOf(e)).toBe(envCred(`http://***@127.0.0.1:${stubPort}/`));
    expect(stubHits - before).toBe(0);
  });

  it('spawned `tsx src/index.ts`: exit 1, message on stderr, no secret on either stream, no boot line, PORT never bound', { timeout: SPAWN_T }, async () => {
    const port = await freePort();
    const r = await runTsx('src/index.ts', [], cleanEnv({ PORT: String(port), REST_BASE_URL: `http://svc:${SENTINEL}@127.0.0.1:9/` }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(envCred('http://***@127.0.0.1:9/'));
    expect(r.stdout).not.toContain(SENTINEL);
    expect(r.stderr).not.toContain(SENTINEL);
    expect(r.stdout + r.stderr).not.toContain('REST backend');
    expect(await portIsClosed(port)).toBe(true);
  });
});

describe('B7 - npm start, username only', () => {
  it('startFromEnv rejects REST_BASE_URL=http://svc@127.0.0.1:9/ ending got "http://***@127.0.0.1:9/"', async () => {
    const logs: string[] = [];
    const e = await envError({ REST_BASE_URL: 'http://svc@127.0.0.1:9/' }, logs);
    expect(msgOf(e)).toBe(envCred('http://***@127.0.0.1:9/'));
    expect(logs.some((l) => l.includes('REST backend'))).toBe(false);
  });

  it('password-only REST_BASE_URL is refused and redacted', async () => {
    const e = await envError({ REST_BASE_URL: `http://:${SENTINEL}@127.0.0.1:9/` });
    expect(msgOf(e)).toContain('REST_BASE_URL must not contain credentials');
    expect(msgOf(e)).not.toContain(SENTINEL);
  });
});

describe('B8 - CLI, other REST_BASE_URL errors redacted', () => {
  it('ht!tp://svc:pw@x -> absolute-http(s) message with "ht!tp://***@x"', async () => {
    const e = await envError({ REST_BASE_URL: `ht!tp://svc:${SENTINEL}@x` });
    expect(msgOf(e)).toBe('REST_BASE_URL must be an absolute http(s) URL, got "ht!tp://***@x"');
  });

  it('ftp://svc:pw@h/ -> must use http: or https: with "ftp://***@h/"', async () => {
    const e = await envError({ REST_BASE_URL: `ftp://svc:${SENTINEL}@h/` });
    expect(msgOf(e)).toBe('REST_BASE_URL must use http: or https:, got "ftp://***@h/"');
  });

  it('http://svc:pw@h/?x=1 -> a REST_BASE_URL must ... message with ***@ and no secret', async () => {
    const m = msgOf(await envError({ REST_BASE_URL: `http://svc:${SENTINEL}@h/?x=1` }));
    expect(m.startsWith('REST_BASE_URL must ')).toBe(true);
    expect(m).toContain('***@');
    expect(m).not.toContain(SENTINEL);
  });

  // Frozen by running startFromEnv at the pre-change commit.
  const HEAD_ENV: Array<[string, string]> = [
    ['localhost:4001', 'REST_BASE_URL must use http: or https:, got "localhost:4001"'],
    ['ht!tp://x', 'REST_BASE_URL must be an absolute http(s) URL, got "ht!tp://x"'],
    ['ftp://h/', 'REST_BASE_URL must use http: or https:, got "ftp://h/"'],
    ['http://h/?x=1', 'REST_BASE_URL must not contain a query string or fragment, got "http://h/?x=1"'],
    ['http://h/#f', 'REST_BASE_URL must not contain a query string or fragment, got "http://h/#f"'],
    ['  ', 'REST_BASE_URL must be an absolute http(s) URL, got "  "'],
  ];
  for (const [u, m] of HEAD_ENV) {
    it(`no-userinfo message for ${JSON.stringify(u)} is byte-identical to before`, async () => {
      expect(msgOf(await envError({ REST_BASE_URL: u }))).toBe(m);
    });
  }
});

describe('B9 - check-backend, password', () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  };

  for (const args of [[], ['--json']]) {
    it(`runCheckBackend(${JSON.stringify(args)}) resolves 2, one redacted err line, 0 out lines, 0 requests`, async () => {
      const url = `http://svc:${SENTINEL}@127.0.0.1:${stubPort}/`;
      const before = stubHits;
      const c = capture();
      await expect(runCheckBackend(args, { REST_BASE_URL: url }, c.io)).resolves.toBe(2);
      expect(c.err).toEqual([envCred(`http://***@127.0.0.1:${stubPort}/`)]);
      expect(c.out).toEqual([]);
      expect(stubHits - before).toBe(0);
      expect([...c.out, ...c.err].join('\n')).not.toContain(SENTINEL);
    });
  }

  it('username-only URL against the bundled backend: exit 2, /__stats unchanged', async () => {
    const port = new URL(backendUrl).port;
    const before = await backendTotal();
    const c = capture();
    await expect(runCheckBackend([], { REST_BASE_URL: `http://svc@127.0.0.1:${port}/` }, c.io)).resolves.toBe(2);
    expect(c.err).toEqual([envCred(`http://***@127.0.0.1:${port}/`)]);
    expect(c.out).toEqual([]);
    expect(await backendTotal()).toBe(before);
  });

  it('spawned `tsx src/check-backend-main.ts`: exit 2, secret on neither stream, 0 requests', { timeout: SPAWN_T }, async () => {
    const before = stubHits;
    const r = await runTsx('src/check-backend-main.ts', [], cleanEnv({ REST_BASE_URL: `http://svc:${SENTINEL}@127.0.0.1:${stubPort}/` }));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(envCred(`http://***@127.0.0.1:${stubPort}/`));
    expect(r.stdout).not.toContain(SENTINEL);
    expect(r.stderr).not.toContain(SENTINEL);
    expect(stubHits - before).toBe(0);
  });
});

describe('B10 - unchanged paths without userinfo', () => {
  const open: Running[] = [];
  afterEach(async () => {
    while (open.length) await open.pop()!.close();
  });

  it('bundled default boots with the same two log lines', async () => {
    const startFromEnv = await loadStart();
    const logs: string[] = [];
    const r = await startFromEnv({ PORT: '0' }, (l) => logs.push(l));
    open.push(r);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/^REST backend \(bundled\): http:\/\/127\.0\.0\.1:\d+ \(latency 25ms\/request\)$/);
    expect(logs[1]).toMatch(/^GraphQL gateway \+ GraphiQL: http:\/\/localhost:\d+\/graphql$/);
  });

  it('external URL with a path prefix boots with the unredacted external line', async () => {
    const startFromEnv = await loadStart();
    const logs: string[] = [];
    const ext = `http://127.0.0.1:${stubPort}/api/v1`;
    const r = await startFromEnv({ PORT: '0', REST_BASE_URL: ext }, (l) => logs.push(l));
    open.push(r);
    expect(logs[0]).toBe(`REST backend (external): ${ext}`);
    expect(logs[1]).toMatch(/^GraphQL gateway \+ GraphiQL: http:\/\/localhost:\d+\/graphql$/);
  });

  it('an @ in the path only is not credentials: startFromEnv boots and logs the URL as given', async () => {
    const startFromEnv = await loadStart();
    const logs: string[] = [];
    const ext = `http://127.0.0.1:${stubPort}/a@b`;
    const r = await startFromEnv({ PORT: '0', REST_BASE_URL: ext }, (l) => logs.push(l));
    open.push(r);
    expect(logs[0]).toBe(`REST backend (external): ${ext}`);
  });

  it('check-backend against the live bundled backend: 5/5 PASS, exit 0, output as before', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const url = `${backendUrl}/`;
    await expect(runCheckBackend([], { REST_BASE_URL: url }, { out: (l) => out.push(l), err: (l) => err.push(l) })).resolves.toBe(0);
    expect(out).toEqual([
      `Checking ${url} -- REST_BASE_URL`,
      'PASS /authors',
      'PASS /authors/by-ids',
      'PASS /books/by-author',
      'PASS /books/by-ids',
      'PASS /reviews/by-book',
      '5/5 routes match the REST contract',
    ]);
    expect(err).toEqual([]);
  });

  it('check-backend config errors without userinfo are byte-identical to before (exit 2, 0 out)', async () => {
    const out: string[] = [];
    const err: string[] = [];
    await expect(runCheckBackend([], { REST_BASE_URL: 'localhost:4001' }, { out: (l) => out.push(l), err: (l) => err.push(l) })).resolves.toBe(2);
    expect(err).toEqual(['REST_BASE_URL must use http: or https:, got "localhost:4001"']);
    expect(out).toEqual([]);
  });
});

describe('B11 - docs', () => {
  it('README REST_BASE_URL env row says credentials are rejected at startup and points to FORWARD_HEADERS', () => {
    const row = readme.split('\n').find((l) => l.startsWith('| `REST_BASE_URL` |'));
    expect(row).toBeDefined();
    expect(row!).toMatch(/credentials/i);
    expect(row!).toMatch(/reject/i);
    expect(row!).toContain('FORWARD_HEADERS');
    expect(row!).toContain('authorization');
  });

  it('README §8 testing list names test_iter109_behavior.test.ts in a bullet', () => {
    const bullet = readme.split('\n').find((l) => l.startsWith('- ') && l.includes('test_iter109_behavior.test.ts'));
    expect(bullet).toBeDefined();
  });

  it('README never prints the test secret', () => {
    expect(readme).not.toContain(SENTINEL);
  });
});
