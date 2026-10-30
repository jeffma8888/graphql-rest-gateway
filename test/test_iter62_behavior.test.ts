import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, type ExecFileException } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSchema, lexicographicSortSchema, printSchema } from 'graphql';

/**
 * iter-62: the BUILT package (`tsc -p tsconfig.build.json`) imports by name
 * from plain Node ESM and from a NodeNext TypeScript consumer, carries real
 * types, and finds `schema.graphql` at the package root.
 *
 * Black-box: everything is built under os.tmpdir() and driven through child
 * processes (`node`, `tsc`, `graphql-codegen`). Nothing is written in the repo.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_MODULES = path.join(REPO, 'node_modules');
const TSC = path.join(NODE_MODULES, 'typescript', 'bin', 'tsc');
const CODEGEN = path.join(NODE_MODULES, '@graphql-codegen', 'cli', 'cjs', 'bin.js');
const T = 30_000;

const NESTED = '{ authors(first: 3) { edges { node { name books { title reviews { rating } } } } } }';

type Run = { code: number; stdout: string; stderr: string; ms: number };

/** Child process with a clean env: no tsx, no --loader, no NODE_OPTIONS. */
function run(args: string[], cwd: string, timeout = 25_000): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '' };
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  const t0 = Date.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024 },
      (err: ExecFileException | null, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr), ms: Date.now() - t0 });
      },
    );
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

const MAIN_MJS = `
import { createGateway, buildBackend } from 'graphql-rest-gateway';
const { app } = buildBackend({ latencyMs: 0 });
const restBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
const gateway = createGateway({ restBaseUrl });
const res = await gateway.fetch('http://gateway.local/graphql', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: ${JSON.stringify(NESTED)} }),
});
const body = await res.json();
await gateway.close();
await app.close();
console.log(JSON.stringify({ status: res.status, execArgv: process.execArgv, body }));
`;

const BARREL_MJS = `
import * as m from 'graphql-rest-gateway';
const out = {
  createGateway: typeof m.createGateway,
  createContext: typeof m.createContext,
  parseAuth: typeof m.parseAuth,
  buildBackend: typeof m.buildBackend,
  hasSchema: typeof m.schema === 'object' && m.schema !== null,
  authorType: m.schema && typeof m.schema.getType === 'function' && m.schema.getType('Author') ? String(m.schema.getType('Author')) : null,
};
console.log(JSON.stringify(out));
`;

const POS_TS = `import { createGateway, buildBackend, type GatewayOptions } from 'graphql-rest-gateway';
const opts: GatewayOptions = { restBaseUrl: 'http://127.0.0.1:1' };
const gateway = createGateway(opts);
const direct = createGateway({ restBaseUrl: 'http://127.0.0.1:1' });
void gateway;
void direct;
void buildBackend;
`;

const NEG_TS = `import type { GatewayOptions } from 'graphql-rest-gateway';
const o: GatewayOptions = { restBaseUrl: 42 };
void o;
`;

function makeConsumer(root: string, name: string, pkgDir: string): string {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  symlinkSync(pkgDir, path.join(dir, 'node_modules', 'graphql-rest-gateway'), 'dir');
  writeFileSync(path.join(dir, 'main.mjs'), MAIN_MJS);
  writeFileSync(path.join(dir, 'barrel.mjs'), BARREL_MJS);
  return dir;
}

function distSnapshot(): string {
  const distDir = path.join(REPO, 'dist');
  if (!existsSync(distDir)) return 'absent';
  const files = walk(distDir)
    .map((f) => `${path.relative(distDir, f)}@${statSync(f).mtimeMs}`)
    .sort();
  return `present:${statSync(distDir).mtimeMs}:${files.join('|')}`;
}

function gitStatus(): Promise<Run> {
  return run(
    [
      '-e',
      "const r=require('node:child_process').spawnSync('git',['status','--porcelain','--untracked-files=all'],{encoding:'utf8'});process.stdout.write(r.stdout||'');process.exit(r.status??1)",
    ],
    REPO,
  );
}

let tmp = '';
let pkg = '';
let consumer = '';
let consumerNoSdl = '';
let build: Run;
let codegen: Run;
let codegenOut = '';
let mainRun: Run;
let mainRunNoSdl: Run;
let barrelRun: Run;
let tscRun: Run;
let before: { porcelain: string; dist: string };
const fileStart = Date.now();

beforeAll(async () => {
  before = { porcelain: (await gitStatus()).stdout, dist: distSnapshot() };

  tmp = mkdtempSync(path.join(os.tmpdir(), 'gw-iter62-'));
  pkg = path.join(tmp, 'pkg');
  mkdirSync(pkg);
  cpSync(path.join(REPO, 'package.json'), path.join(pkg, 'package.json'));
  cpSync(path.join(REPO, 'schema.graphql'), path.join(pkg, 'schema.graphql'));
  symlinkSync(NODE_MODULES, path.join(pkg, 'node_modules'), 'dir');

  // codegen sandbox: same config + SDL, output lands under the sandbox.
  const cg = path.join(tmp, 'codegen');
  mkdirSync(cg);
  cpSync(path.join(REPO, 'codegen.ts'), path.join(cg, 'codegen.ts'));
  cpSync(path.join(REPO, 'schema.graphql'), path.join(cg, 'schema.graphql'));
  cpSync(path.join(REPO, 'package.json'), path.join(cg, 'package.json'));
  symlinkSync(NODE_MODULES, path.join(cg, 'node_modules'), 'dir');

  [build, codegen] = await Promise.all([
    run([TSC, '-p', path.join(REPO, 'tsconfig.build.json'), '--outDir', path.join(pkg, 'dist')], REPO, 60_000),
    run([CODEGEN, '--config', 'codegen.ts'], cg, 60_000),
  ]);
  const genFile = path.join(cg, 'src', 'generated', 'graphql.ts');
  codegenOut = existsSync(genFile) ? readFileSync(genFile, 'utf8') : '';

  consumer = makeConsumer(tmp, 'consumer', pkg);
  writeFileSync(path.join(consumer, 'pos.ts'), POS_TS);
  writeFileSync(path.join(consumer, 'neg.ts'), NEG_TS);

  // Second package with schema.graphql deleted from its root (real copy of
  // dist, not a symlink, so realpath cannot lead back to the first pkg).
  const pkgNoSdl = path.join(tmp, 'pkg-nosdl');
  mkdirSync(pkgNoSdl);
  cpSync(path.join(REPO, 'package.json'), path.join(pkgNoSdl, 'package.json'));
  if (existsSync(path.join(pkg, 'dist'))) {
    cpSync(path.join(pkg, 'dist'), path.join(pkgNoSdl, 'dist'), { recursive: true });
  }
  symlinkSync(NODE_MODULES, path.join(pkgNoSdl, 'node_modules'), 'dir');
  consumerNoSdl = makeConsumer(tmp, 'consumer-nosdl', pkgNoSdl);

  [mainRun, barrelRun, mainRunNoSdl, tscRun] = await Promise.all([
    run(['main.mjs'], consumer),
    run(['barrel.mjs'], consumer),
    run(['main.mjs'], consumerNoSdl),
    run(
      [
        TSC,
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--target',
        'ES2022',
        '--types',
        'node',
        '--typeRoots',
        path.join(NODE_MODULES, '@types'),
        '--pretty',
        'false',
        'pos.ts',
        'neg.ts',
      ],
      consumer,
      60_000,
    ),
  ]);
}, 120_000);

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function parseJsonLine(r: Run): any {
  const line = r.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  return JSON.parse(line);
}

describe('EB1 build config', () => {
  it('tsconfig.build.json extends tsconfig.json with NodeNext, include [src], rootDir "."', { timeout: T }, async () => {
    const p = path.join(REPO, 'tsconfig.build.json');
    expect(existsSync(p)).toBe(true);
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    expect(raw.extends).toMatch(/^\.\/tsconfig(\.json)?$/);
    expect(raw.include).toEqual(['src']);
    const shown = await run([TSC, '-p', p, '--showConfig'], REPO);
    expect(shown.code).toBe(0);
    const eff = JSON.parse(shown.stdout);
    expect(String(eff.compilerOptions.module).toLowerCase()).toBe('nodenext');
    expect(String(eff.compilerOptions.moduleResolution).toLowerCase()).toBe('nodenext');
    expect(path.resolve(REPO, eff.compilerOptions.rootDir)).toBe(REPO);
    // effective file list is src only
    for (const f of eff.files as string[]) {
      expect(path.relative(REPO, path.resolve(REPO, f)).split(path.sep)[0]).toBe('src');
    }
  });

  it('scripts.build is tsc -p tsconfig.build.json', () => {
    const pj = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    expect(pj.scripts.build).toBe('tsc -p tsconfig.build.json');
  });

  it('the build exits 0 and emits src/lib.js + src/lib.d.ts, no test/ or benchmark/', { timeout: T }, () => {
    expect(build.stdout + build.stderr).toBe('');
    expect(build.code).toBe(0);
    const out = path.join(pkg, 'dist');
    expect(existsSync(path.join(out, 'src', 'lib.js'))).toBe(true);
    expect(existsSync(path.join(out, 'src', 'lib.d.ts'))).toBe(true);
    expect(existsSync(path.join(out, 'test'))).toBe(false);
    expect(existsSync(path.join(out, 'benchmark'))).toBe(false);
    expect(readdirSync(out)).toEqual(['src']);
  });
});

describe('EB2 specifier guard', () => {
  it('every relative specifier in src/**/*.ts ends in .js and names a file, not a directory', () => {
    const files = walk(path.join(REPO, 'src')).filter((f) => f.endsWith('.ts'));
    expect(files.some((f) => f.endsWith(path.join('src', 'generated', 'graphql.ts')))).toBe(true);
    const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}(?:\/[^'"]*)?)\1/g;
    const offenders: string[] = [];
    let scanned = 0;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(re)) {
        const spec = m[2] as string;
        scanned++;
        const target = path.resolve(path.dirname(f), spec);
        const ok =
          spec.endsWith('.js') &&
          !(existsSync(target) && statSync(target).isDirectory()) &&
          (existsSync(target.replace(/\.js$/, '.ts')) || existsSync(target));
        if (!ok) offenders.push(`${path.relative(REPO, f)}: ${spec}`);
      }
    }
    expect(scanned).toBeGreaterThanOrEqual(30);
    expect(offenders).toEqual([]);
  });
});

describe('EB3 codegen stays the source', () => {
  it('codegen.ts mappers and contextType use .js module paths', async () => {
    const mod = (await import('../codegen')) as { default: any };
    const gens = mod.default.generates as Record<string, any>;
    const target = gens['./src/generated/graphql.ts'];
    expect(target).toBeDefined();
    const cfg = target.config;
    const paths = [cfg.contextType, ...Object.values(cfg.mappers ?? {})] as string[];
    expect(Object.keys(cfg.mappers ?? {}).length).toBeGreaterThanOrEqual(5);
    for (const p of paths) {
      const [modulePath, symbol] = p.split('#');
      expect(modulePath, p).toMatch(/\.js$/);
      expect(symbol, p).toBeTruthy();
    }
  });

  it('npm run codegen output is byte-identical to the committed src/generated/graphql.ts', { timeout: T }, () => {
    expect(codegen.code, codegen.stderr).toBe(0);
    expect(codegenOut.length).toBeGreaterThan(0);
    const committed = readFileSync(path.join(REPO, 'src', 'generated', 'graphql.ts'), 'utf8');
    expect(codegenOut === committed).toBe(true);
    expect(committed).toMatch(/from '\.\.\/rest-backend\/data\.js'/);
  });
});

describe('EB4 plain Node import by package name', () => {
  it('node main.mjs: exit 0, 200, no errors, 3 edges, downstreamCalls.total === 3', { timeout: T }, () => {
    expect(mainRun.code, mainRun.stderr).toBe(0);
    const out = parseJsonLine(mainRun);
    expect(out.execArgv).toEqual([]);
    expect(out.status).toBe(200);
    expect(out.body.errors).toBeUndefined();
    expect(out.body.data.authors.edges).toHaveLength(3);
    for (const e of out.body.data.authors.edges) {
      expect(typeof e.node.name).toBe('string');
      expect(Array.isArray(e.node.books)).toBe(true);
    }
    expect(out.body.extensions.downstreamCalls.total).toBe(3);
  });
});

describe('EB5 barrel via the built package', () => {
  it('createGateway/createContext/parseAuth/buildBackend are functions and schema has Author', { timeout: T }, () => {
    expect(barrelRun.code, barrelRun.stderr).toBe(0);
    const out = parseJsonLine(barrelRun);
    expect(out.createGateway).toBe('function');
    expect(out.createContext).toBe('function');
    expect(out.parseAuth).toBe('function');
    expect(out.buildBackend).toBe('function');
    expect(out.hasSchema).toBe(true);
    expect(out.authorType).toBe('Author');
  });
});

describe('EB6 SDL lookup is layout-independent', () => {
  it('pkg has schema.graphql only at its root (none under dist/) and EB4 still succeeds', () => {
    expect(existsSync(path.join(pkg, 'schema.graphql'))).toBe(true);
    const underDist = walk(path.join(pkg, 'dist')).filter((f) => path.basename(f) === 'schema.graphql');
    expect(underDist).toEqual([]);
    expect(mainRun.code).toBe(0);
    expect(parseJsonLine(mainRun).body.data.authors.edges).toHaveLength(3);
  });

  it('with schema.graphql deleted from pkg root, the import fails non-zero naming schema.graphql', { timeout: T }, () => {
    expect(existsSync(path.join(consumerNoSdl, 'node_modules', 'graphql-rest-gateway', 'dist', 'src', 'lib.js'))).toBe(true);
    expect(existsSync(path.join(consumerNoSdl, 'node_modules', 'graphql-rest-gateway', 'schema.graphql'))).toBe(false);
    expect(mainRunNoSdl.code).not.toBe(0);
    expect(mainRunNoSdl.stderr).toContain('schema.graphql');
    expect(mainRunNoSdl.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
  });

  it('in-repo (vitest) the schema read is the repo-root schema.graphql', async () => {
    const srcSdl = walk(path.join(REPO, 'src')).filter((f) => path.basename(f) === 'schema.graphql');
    expect(srcSdl).toEqual([]);
    const { schema } = await import('../src/gateway/schema');
    const expected = buildSchema(readFileSync(path.join(REPO, 'schema.graphql'), 'utf8'));
    expect(printSchema(lexicographicSortSchema(schema))).toBe(printSchema(lexicographicSortSchema(expected)));
  });
});

describe('EB7 NodeNext TS consumer gets real types', () => {
  it('exactly one diagnostic: TS2322 in neg.ts; pos.ts clean', { timeout: T }, () => {
    const all = (tscRun.stdout + tscRun.stderr).split('\n').filter((l) => /error TS\d+/.test(l));
    expect(all, tscRun.stdout + tscRun.stderr).toHaveLength(1);
    const diag = all[0] ?? '';
    expect(diag).toMatch(/^neg\.ts\(\d+,\d+\): error TS2322:/);
    expect(all.filter((l) => l.startsWith('pos.ts'))).toEqual([]);
    expect(tscRun.code).not.toBe(0);
  });
});

describe('EB8 package manifest', () => {
  const pj = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));

  it('files lists dist/src, schema.graphql, README.md, LICENSE and nothing matching test', () => {
    expect(Array.isArray(pj.files)).toBe(true);
    for (const f of ['dist/src', 'schema.graphql', 'README.md', 'LICENSE']) {
      expect(pj.files).toContain(f);
    }
    expect((pj.files as string[]).filter((f) => /test/i.test(f))).toEqual([]);
    for (const f of pj.files as string[]) {
      if (!f.startsWith('dist')) expect(existsSync(path.join(REPO, f)), f).toBe(true);
    }
  });

  it('scripts.prepack is npm run build', () => {
    expect(pj.scripts.prepack).toBe('npm run build');
  });

  it('main/types/exports keep the iter-03 pins', () => {
    expect(pj.main).toBe('dist/src/lib.js');
    expect(pj.types).toBe('dist/src/lib.d.ts');
    expect(pj.exports).toEqual({
      '.': { types: './dist/src/lib.d.ts', import: './dist/src/lib.js' },
    });
  });
});

describe('EB9 no repo pollution, dev paths unchanged', () => {
  it('npm start path (startFromEnv under tsx/vitest) still serves the nested query', { timeout: T }, async () => {
    const mod = (await import('../src/cli')) as {
      startFromEnv: (
        env: Record<string, string | undefined>,
        log?: (l: string) => void,
      ) => Promise<{ url: string; close(): Promise<void> }>;
    };
    const running = await mod.startFromEnv({ PORT: '0', REST_LATENCY_MS: '0' }, () => {});
    try {
      const res = await fetch(running.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: NESTED }),
      });
      const body = (await res.json()) as any;
      expect(res.status).toBe(200);
      expect(body.errors).toBeUndefined();
      expect(body.data.authors.edges).toHaveLength(3);
      expect(body.extensions.downstreamCalls.total).toBe(3);
    } finally {
      await running.close();
    }
  });

  it('existing tests (incl. N+1 and lib-entry) are unmodified in the working tree', async () => {
    const r = await run(
      [
        '-e',
        "const r=require('node:child_process').spawnSync('git',['status','--porcelain','--untracked-files=all','--','test'],{encoding:'utf8'});process.stdout.write(r.stdout||'');process.exit(r.status??1)",
      ],
      REPO,
    );
    expect(r.code).toBe(0);
    const lines = r.stdout.split('\n').filter(Boolean);
    expect(lines.filter((l) => !l.endsWith('test/test_iter62_behavior.test.ts'))).toEqual([]);
    expect(existsSync(path.join(REPO, 'test', 'n-plus-1.test.ts'))).toBe(true);
    expect(existsSync(path.join(REPO, 'test', 'lib-entry.test.ts'))).toBe(true);
  });

  it('running this file created/modified nothing in the repo (git status and dist/ unchanged)', { timeout: T }, async () => {
    const after = { porcelain: (await gitStatus()).stdout, dist: distSnapshot() };
    expect(after.porcelain).toBe(before.porcelain);
    expect(after.dist).toBe(before.dist);
    for (const p of [build, codegen, mainRun, barrelRun, mainRunNoSdl, tscRun]) {
      expect(p.ms).toBeLessThan(25_000);
    }
    expect(Date.now() - fileStart).toBeLessThan(25_000);
  });
});
