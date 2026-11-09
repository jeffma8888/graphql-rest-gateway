import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, spawn, type ChildProcess, type ExecFileException } from 'node:child_process';
import {
  accessSync,
  constants as fsc,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * iter-80: the INSTALLED package runs the operator CLIs through `bin`.
 *
 * Black-box: the worktree is built with `tsc -p tsconfig.build.json --outDir`
 * under os.tmpdir(), packed with `npm pack --ignore-scripts`, extracted into a
 * consumer's node_modules beside symlinked runtime deps, and linked offline with
 * `npm rebuild --offline --ignore-scripts graphql-rest-gateway`. The commands are
 * then run as `<consumer>/node_modules/.bin/<name>` (shebang) or through
 * `npm exec --offline --no-install`. No network, no `npm install`, nothing
 * written in the repo.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_MODULES = path.join(REPO, 'node_modules');
const TSC = path.join(NODE_MODULES, 'typescript', 'bin', 'tsc');
const TSX = path.join(NODE_MODULES, 'tsx', 'dist', 'cli.mjs');
const PKG_NAME = 'graphql-rest-gateway';
const GW = 'graphql-rest-gateway';
const CB = 'graphql-rest-gateway-check-backend';
const RUNTIME_DEPS = ['graphql', 'graphql-yoga', 'fastify', 'dataloader', '@graphql-tools'];
const T = 30_000;
const BOOT_RE = /^GraphQL gateway \+ GraphiQL: http:\/\/localhost:(\d+)\/graphql$/m;
const NESTED = '{ authors(first: 3) { edges { node { name books { title reviews { rating } } } } } }';

type Run = { code: number | null; signal: string | null; stdout: string; stderr: string; ms: number };

/** Clean env: no NODE_OPTIONS, no tsx loader, no VITEST vars; node on PATH for the shebang. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '' };
  for (const k of Object.keys(env)) {
    if (k.startsWith('VITEST') || k === 'REST_BASE_URL' || k === 'PORT' || k === 'MAX_DEPTH') delete env[k];
    if (k.startsWith('npm_')) delete env[k];
  }
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`;
  return { ...env, ...extra };
}

function runFile(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 25_000): Promise<Run> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024 }, (err: ExecFileException | null, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      const signal = err && err.signal ? String(err.signal) : null;
      resolve({ code, signal, stdout: String(stdout), stderr: String(stderr), ms: Date.now() - t0 });
    });
  });
}

function runNode(args: string[], cwd: string, env: NodeJS.ProcessEnv = cleanEnv(), timeout = 60_000): Promise<Run> {
  return runFile(process.execPath, args, cwd, env, timeout);
}

/** npm's own CLI script, run with this node (so no dependency on a global npm shim). */
function npmCli(): string {
  const candidates = [
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return '';
}

function runNpm(args: string[], cwd: string, env: NodeJS.ProcessEnv = cleanEnv(), timeout = 60_000): Promise<Run> {
  const cli = npmCli();
  if (cli) return runNode([cli, ...args], cwd, env, timeout);
  return runFile('npm', args, cwd, env, timeout);
}

type Live = {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: string | null; at: number }>;
};

function startLive(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Live {
  const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout!.on('data', (d) => (out += String(d)));
  child.stderr!.on('data', (d) => (err += String(d)));
  const exited = new Promise<{ code: number | null; signal: string | null; at: number }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, at: Date.now() }));
  });
  return { child, stdout: () => out, stderr: () => err, exited };
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function distSnapshot(): string {
  const distDir = path.join(REPO, 'dist');
  if (!existsSync(distDir)) return 'absent';
  const files = walk(distDir)
    .map((f) => `${path.relative(distDir, f)}@${statSync(f).mtimeMs}`)
    .sort();
  return `present:${statSync(distDir).mtimeMs}:${files.join('|')}`;
}

async function gitStatus(): Promise<string> {
  const r = await runFile('git', ['status', '--porcelain', '--untracked-files=all'], REPO, cleanEnv());
  return r.stdout;
}

function firstLine(file: string): string {
  return readFileSync(file, 'utf8').split('\n')[0]!;
}

function section(md: string, headingIncludes: string): string {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^#{2,3}\s/.test(l) && l.includes(headingIncludes));
  if (start < 0) return '';
  const level = /^(#+)/.exec(lines[start]!)![1]!.length;
  let end = lines.length;
  let inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('```')) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#+)\s/.exec(lines[i]!);
    if (m && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

const bin = (name: string) => path.join(consumer, 'node_modules', '.bin', name);

const PKG_JSON = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const README = readFileSync(path.join(REPO, 'README.md'), 'utf8');

let tmp = '';
let pkgDir = '';
let consumer = '';
let installed = '';
let build: Run;
let pack: Run;
let dryRun: Run;
let rebuild: Run;
let before: { porcelain: string; dist: string };
const runs = new Map<string, Run>();
let eb8Port = 0;
let eb10Port = 0;
const ARG_CASES = [
  ['--help', ['--help'], '--help'],
  ['extra', ['extra'], 'extra'],
  ['several args name only the first', ['--help', 'extra', '--json'], '--help'],
  ['an argument that needs JSON quoting', ['a"b'], 'a"b'],
] as const;
const validEnv = () => cleanEnv({ PORT: '0', REST_LATENCY_MS: '0' });

beforeAll(async () => {
  before = { porcelain: await gitStatus(), dist: distSnapshot() };
  tmp = mkdtempSync(path.join(os.tmpdir(), 'gw-iter80-'));

  // Package staging dir: the manifest + root assets the `files` field ships, dist built from the worktree.
  pkgDir = path.join(tmp, 'pkg');
  mkdirSync(pkgDir);
  for (const f of ['package.json', 'schema.graphql', '.graphqlrc.yml', 'README.md', 'LICENSE']) {
    if (existsSync(path.join(REPO, f))) cpSync(path.join(REPO, f), path.join(pkgDir, f));
  }
  build = await runNode([TSC, '-p', path.join(REPO, 'tsconfig.build.json'), '--outDir', path.join(pkgDir, 'dist')], REPO);

  [dryRun, pack] = await Promise.all([
    runNpm(['pack', '--ignore-scripts', '--dry-run', '--json'], pkgDir),
    runNpm(['pack', '--ignore-scripts', '--pack-destination', tmp], pkgDir),
  ]);

  consumer = path.join(tmp, 'consumer');
  installed = path.join(consumer, 'node_modules', PKG_NAME);
  mkdirSync(installed, { recursive: true });
  writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', version: '0.0.0', private: true }));
  const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  if (tgz) {
    await runFile('tar', ['-xzf', path.join(tmp, tgz), '-C', installed, '--strip-components=1'], tmp, cleanEnv());
  }
  for (const d of RUNTIME_DEPS) {
    const dest = path.join(consumer, 'node_modules', d);
    if (!existsSync(dest)) symlinkSync(path.join(NODE_MODULES, d), dest, 'dir');
  }
  rebuild = await runNpm(['rebuild', '--offline', '--ignore-scripts', PKG_NAME], consumer);

  // Every short-lived command run, concurrently (each `it` reads its result from `runs`).
  [eb8Port, eb10Port] = await Promise.all([freePort(), freePort()]);
  const jobs: [string, Promise<Run>][] = [
    ['eb7', runFile(bin(GW), [], consumer, cleanEnv({ PORT: '0', REST_LATENCY_MS: '0', MAX_DEPTH: 'x' }))],
    ...ARG_CASES.map(([label, args]) => [`eb8:${label}`, runFile(bin(GW), [...args], consumer, validEnv(), 10_000)] as [string, Promise<Run>]),
    ['eb8:port', runFile(bin(GW), ['--help'], consumer, cleanEnv({ PORT: String(eb8Port), REST_LATENCY_MS: '0' }), 10_000)],
    ['eb8:npx', runNpm(['exec', '--offline', '--no-install', '--', GW, '--help'], consumer, validEnv(), 20_000)],
    ['eb9:bin', runFile(bin(CB), ['--json'], consumer, cleanEnv())],
    ['eb9:npx', runNpm(['exec', '--offline', '--no-install', '--', CB, '--json'], consumer, cleanEnv(), 20_000)],
    ['eb10:bogus', runFile(bin(CB), ['--bogus'], consumer, cleanEnv())],
    ['eb10:down', runFile(bin(CB), [], consumer, cleanEnv({ REST_BASE_URL: `http://127.0.0.1:${eb10Port}` }))],
  ];
  const results = await Promise.all(jobs.map(([, p]) => p));
  jobs.forEach(([k], i) => runs.set(k, results[i]!));
}, 120_000);

function got(key: string): Run {
  const r = runs.get(key);
  if (!r) throw new Error(`no run recorded for ${key}`);
  return r;
}

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});


describe('EB1 package.json bin field', () => {
  it('bin deep-equals the two command → dist target entries', () => {
    expect(PKG_JSON.bin).toEqual({
      'graphql-rest-gateway': 'dist/src/index.js',
      'graphql-rest-gateway-check-backend': 'dist/src/check-backend-main.js',
    });
  });

  it('main, types, exports and files keep their iter-03/iter-62 values', () => {
    expect(PKG_JSON.main).toBe('dist/src/lib.js');
    expect(PKG_JSON.types).toBe('dist/src/lib.d.ts');
    expect(PKG_JSON.exports).toEqual({ '.': { types: './dist/src/lib.d.ts', import: './dist/src/lib.js' } });
    expect(PKG_JSON.files).toEqual(['dist/src', 'schema.graphql', '.graphqlrc.yml', 'README.md', 'LICENSE']);
  });
});

describe('EB2 shebangs survive the build', () => {
  it('line 1 of both entry sources is exactly #!/usr/bin/env node', () => {
    expect(firstLine(path.join(REPO, 'src', 'index.ts'))).toBe('#!/usr/bin/env node');
    expect(firstLine(path.join(REPO, 'src', 'check-backend-main.ts'))).toBe('#!/usr/bin/env node');
  });

  it('the build exits 0 and line 1 of both dist entries is the same shebang', () => {
    expect(build.code, build.stdout + build.stderr).toBe(0);
    expect(firstLine(path.join(pkgDir, 'dist', 'src', 'index.js'))).toBe('#!/usr/bin/env node');
    expect(firstLine(path.join(pkgDir, 'dist', 'src', 'check-backend-main.js'))).toBe('#!/usr/bin/env node');
  });
});

describe('EB3 pack file list', () => {
  it('npm pack --dry-run --json lists both entries and every bin target', () => {
    expect(dryRun.code, dryRun.stderr).toBe(0);
    const doc = JSON.parse(dryRun.stdout);
    const files = new Set<string>((doc[0].files as { path: string }[]).map((f) => f.path));
    expect(files.has('dist/src/index.js')).toBe(true);
    expect(files.has('dist/src/check-backend-main.js')).toBe(true);
    const targets = Object.values(PKG_JSON.bin as Record<string, string>);
    expect(targets.length).toBe(2);
    for (const t of targets) expect(files.has(t.replace(/^\.\//, '')), t).toBe(true);
  });

  it('the real (non-dry) pack produced a tarball', () => {
    expect(pack.code, pack.stderr).toBe(0);
    expect(readdirSync(tmp).some((f) => f.endsWith('.tgz'))).toBe(true);
  });
});

describe('EB4 offline install links executable bins', () => {
  it('npm rebuild --offline exits 0', () => {
    expect(rebuild.code, rebuild.stdout + rebuild.stderr).toBe(0);
  });

  for (const [name, target] of [
    [GW, 'dist/src/index.js'],
    [CB, 'dist/src/check-backend-main.js'],
  ] as const) {
    it(`.bin/${name} exists, resolves to ${target} of the installed package, and is executable`, () => {
      const p = bin(name);
      expect(existsSync(p)).toBe(true);
      expect(realpathSync(p)).toBe(realpathSync(path.join(installed, target)));
      expect(() => accessSync(p, fsc.X_OK)).not.toThrow();
    });
  }
});

describe('EB5 + EB6 installed gateway boots, serves batched, drains on SIGTERM', () => {
  let live: Live | undefined;
  let url = '';

  afterAll(async () => {
    if (live && live.child.exitCode === null && live.child.signalCode === null) {
      live.child.kill('SIGKILL');
      await live.exited;
    }
  });

  it('EB5: boot line within 15 s, nested query → 200, 3 authors, downstreamCalls.total === 3', { timeout: T }, async () => {
    live = startLive(bin(GW), [], consumer, cleanEnv({ PORT: '0', REST_LATENCY_MS: '0' }));
    const l = live;
    const booted = await waitFor(() => BOOT_RE.test(l.stdout()) || l.child.exitCode !== null, 15_000);
    expect(booted, `stdout=${l.stdout()} stderr=${l.stderr()}`).toBe(true);
    const m = BOOT_RE.exec(l.stdout());
    expect(m, `stdout=${l.stdout()} stderr=${l.stderr()}`).not.toBeNull();
    expect(l.stdout()).toMatch(/REST backend \(bundled\)/);
    url = `http://localhost:${m![1]}/graphql`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: NESTED }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.errors).toBeUndefined();
    expect(body.data.authors.edges.length).toBe(3);
    for (const e of body.data.authors.edges) {
      expect(typeof e.node.name).toBe('string');
      expect(Array.isArray(e.node.books)).toBe(true);
    }
    expect(body.extensions.downstreamCalls.total).toBe(3);
  });

  it('EB6: SIGTERM → exit code 0 within 10 s', { timeout: T }, async () => {
    expect(live, 'EB5 must have started the process').toBeDefined();
    const l = live!;
    expect(l.child.exitCode).toBeNull();
    const t0 = Date.now();
    l.child.kill('SIGTERM');
    const r = await Promise.race([
      l.exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
    ]);
    expect(r, 'process did not exit within 10 s of SIGTERM').not.toBeNull();
    expect(r!.code).toBe(0);
    expect(r!.at - t0).toBeLessThan(10_000);
  });
});

describe('EB7 invalid env through the installed bin', () => {
  it('MAX_DEPTH=x → exit 1, stderr names the variable, no boot line', { timeout: T }, async () => {
    const r = got('eb7');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('MAX_DEPTH must be a positive decimal integer, got "x"');
    expect(r.stdout).not.toContain('GraphQL gateway');
  });
});

describe('EB8 the gateway rejects any argument with exit 2', () => {
  const msg = (arg: string) =>
    `graphql-rest-gateway: unknown argument ${JSON.stringify(arg)} (no arguments are supported; configure it with environment variables such as REST_BASE_URL)`;
  for (const [label, , named] of ARG_CASES) {
    it(`${label}: exit 2 within 5 s, exactly one stderr line, empty stdout`, { timeout: T }, async () => {
      const r = got(`eb8:${label}`);
      expect(r.code, `signal=${r.signal} stderr=${r.stderr}`).toBe(2);
      expect(r.ms).toBeLessThan(5_000);
      expect(r.stdout).toBe('');
      expect(r.stderr.replace(/\n$/, '')).toBe(msg(named));
      expect(r.stderr.replace(/\n$/, '').split('\n').length).toBe(1);
    });
  }

  it('nothing listens: a fixed PORT stays free after the rejected run', { timeout: T }, async () => {
    const port = eb8Port;
    const r = got('eb8:port');
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    // the port is still bindable by us (the rejected process never held it)
    await new Promise<void>((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(port, () => s.close(() => resolve()));
    });
  });

  it('via npm exec --offline --no-install: --help still exits 2 with the same message', { timeout: T }, async () => {
    const r = got('eb8:npx');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(msg('--help'));
    expect(r.stdout).not.toContain('GraphQL gateway');
  });
});

describe('EB9 installed check-backend --json against the bundled backend', () => {
  it('exit 0, one JSON document, backend "bundled", ok true, 5 routes (direct .bin file)', { timeout: T }, async () => {
    const r = got('eb9:bin');
    expect(r.code, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.backend).toBe('bundled');
    expect(doc.ok).toBe(true);
    expect(doc.routes.length).toBe(5);
    for (const route of doc.routes) expect(route.ok).toBe(true);
  });

  it('same result through npm exec --offline --no-install', { timeout: T }, async () => {
    const r = got('eb9:npx');
    expect(r.code, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.backend).toBe('bundled');
    expect(doc.ok).toBe(true);
    expect(doc.routes.length).toBe(5);
  });
});

describe('EB10 installed check-backend error exits', () => {
  it('--bogus → exit 2 with the unknown-argument message', { timeout: T }, async () => {
    const r = got('eb10:bogus');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('check-backend: unknown argument "--bogus" (supported: --json)');
  });

  it('REST_BASE_URL on a port nothing listens on → exit 1', { timeout: T }, async () => {
    const r = got('eb10:down');
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/0\/5 routes match/);
  });
});

describe('EB11 the repo path is unchanged', () => {
  it('`npm start` path (tsx src/index.ts, no args) still boots and serves the nested query batched', { timeout: T }, async () => {
    const live = startLive(process.execPath, [TSX, 'src/index.ts'], REPO, cleanEnv({ PORT: '0', REST_LATENCY_MS: '0' }));
    try {
      const ok = await waitFor(() => BOOT_RE.test(live.stdout()) || live.child.exitCode !== null, 15_000);
      expect(ok, `stdout=${live.stdout()} stderr=${live.stderr()}`).toBe(true);
      const m = BOOT_RE.exec(live.stdout());
      expect(m, live.stderr()).not.toBeNull();
      const res = await fetch(`http://localhost:${m![1]}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: NESTED }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.errors).toBeUndefined();
      expect(body.extensions.downstreamCalls.total).toBe(3);
    } finally {
      live.child.kill('SIGTERM');
      const r = await Promise.race([live.exited, new Promise<null>((res) => setTimeout(() => res(null), 8_000))]);
      if (r === null) {
        live.child.kill('SIGKILL');
        await live.exited;
      }
    }
  });

  it('test/n-plus-1.test.ts still pins BATCHED 3 and NAIVE 21', () => {
    const src = readFileSync(path.join(REPO, 'test', 'n-plus-1.test.ts'), 'utf8');
    expect(src).toContain('expect(total).toBe(21);');
    expect(src).toContain('expect(total).toBe(3);');
    expect(src).toContain("expect(byPath['/reviews/by-book']).toBe(15);");
    expect(src).toContain("expect(byPath['/books/by-author']).toBe(5);");
  });

  // Runs last in file order: everything above built/packed/ran under os.tmpdir().
  it('the repo dist/ and git status are unchanged by this file', async () => {
    expect(distSnapshot()).toBe(before.dist);
    expect(await gitStatus()).toBe(before.porcelain);
  });
});

describe('EB12 README §3 "Installed from npm" passage (added, nothing reworded)', () => {
  const quick = section(README, 'Quickstart');

  it('names both npx commands, shows a REST_BASE_URL=… npx graphql-rest-gateway example', () => {
    expect(quick).toContain('Installed from npm');
    expect(quick).toContain('`npx graphql-rest-gateway`');
    expect(quick).toContain('`npx graphql-rest-gateway-check-backend`');
    expect(quick).toMatch(/^REST_BASE_URL=\S+ npx graphql-rest-gateway$/m);
  });

  it('says the gateway takes no arguments, is configured by env like npm start, and an argument exits 2', () => {
    const start = quick.indexOf('Installed from npm');
    const passage = quick.slice(start, start + 1500);
    expect(passage).toMatch(/takes no arguments/);
    expect(passage).toMatch(/same environment variables as `npm start`/);
    expect(passage).toMatch(/exits 2/);
  });

  it('the passage sits after the "Other entry points" table, and Quickstart\'s first graphql fence is still the sample query', () => {
    expect(quick.indexOf('Installed from npm')).toBeGreaterThan(quick.indexOf('| `npm run build` | Type-check + emit to `dist/` |'));
    const firstGraphql = /```graphql\n([\s\S]*?)```/.exec(quick);
    expect(firstGraphql?.[1]).toMatch(/^query Sample \{/);
    expect((quick.match(/```graphql/g) ?? []).length).toBe(1);
  });

  it('the "Other entry points" command table is byte-identical', () => {
    const table = [
      'Other entry points:',
      '',
      '| Command | What it does |',
      '| --- | --- |',
      '| `npm start` | GraphQL gateway (GraphiQL) in front of the bundled REST backend, or your own via `REST_BASE_URL` (see below) |',
      '| `npm run backend` | Just the bundled REST backend (`REST_PORT`, `REST_LATENCY_MS`) |',
      '| `npm run check-backend` | Pre-flight: checks `REST_BASE_URL` (or the bundled backend) against the REST contract, PASS/FAIL per route (`--json`; exit 0/1/2) |',
      '| `npm run benchmark` | Prints the naive-vs-batched downstream call table (`--json` for machine-readable output, `--threshold N` exits 1 when factor < N) |',
      '| `npm test` | Full test suite (unit + integration + N+1 regression) |',
      '| `npm run coverage` | Tests with an istanbul coverage report |',
      '| `npm run codegen` | Regenerate TS types from `schema.graphql` |',
      '| `npm run build` | Type-check + emit to `dist/` |',
      '',
    ].join('\n');
    expect(quick).toContain(table);
  });

  it('pre-existing Quickstart sentences are kept verbatim', () => {
    for (const s of [
      "Open **http://localhost:4000/graphql** and run the sample query (it's pre-filled in GraphiQL):",
      '> `reviewer` is redacted to `REDACTED` unless the request carries a bearer token with the `pii` scope. Send header `Authorization: Bearer user:42:pii` (see [Auth context](#auth-context)) to reveal it.',
      '`npm start` boots the bundled demo backend unless `REST_BASE_URL` is set. In that case it fronts the service you already run, which is the strangler-fig on-ramp.',
      'Two-terminal example (the backend runs in its own process, and the gateway fronts it):',
      '```bash\nnpm install\nnpm start\n# -> REST backend (bundled) boots on a random port\n# -> GraphQL gateway + GraphiQL on http://localhost:4000/graphql\n```',
    ]) {
      expect(quick, s).toContain(s);
    }
  });
});
