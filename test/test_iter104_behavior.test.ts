import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  symlinkSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * iter-104 (PRODUCT row 77): the suite is git-free and one content guard,
 * `test/n-plus-1-guard.test.ts`, pins the N+1 oracle's assertions.
 *
 * Black-box: the guard is judged by RUNNING it (`vitest run <guard>`) in small
 * throwaway copies of the repo (no VCS metadata, node_modules symlinked) whose
 * oracle is mutated. A clean copy is the control: it must pass, so a red
 * mutant is the guard biting, not a broken sandbox. Everything else is plain
 * file reads. This file spawns only node (the vitest CLI), never the VCS.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TEST_DIR = resolve(ROOT, 'test');
const GUARD = 'n-plus-1-guard.test.ts';
const ORACLE = 'n-plus-1.test.ts';
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
const guardSrc = existsSync(join(TEST_DIR, GUARD)) ? readFileSync(join(TEST_DIR, GUARD), 'utf8') : '';
const oracleSrc = readFileSync(join(TEST_DIR, ORACLE), 'utf8');

const TITLES = [
  'naive (no batching) makes 1 + N + M downstream calls',
  'batched (request-scoped DataLoader) makes exactly 3 downstream calls',
  'batching strictly reduces downstream load and returns identical data',
] as const;

const ASSERTIONS = [
  'expect(total).toBe(21);',
  'expect(total).toBe(3);',
  "expect(byPath['/authors']).toBe(1);",
  "expect(byPath['/books/by-author']).toBe(5);",
  "expect(byPath['/reviews/by-book']).toBe(15);",
  "expect(byPath['/books/by-author']).toBe(1);",
  "expect(byPath['/reviews/by-book']).toBe(1);",
  'expect(batched.total).toBeLessThan(naive.total);',
  'expect(batched.data).toEqual(naive.data);',
] as const;

// The spec's two spawn regexes (EB5), assembled so this file never matches itself.
const VCS = ['g', 'i', 't'].join('');
const SPAWN_ARG = new RegExp(`['"]${VCS}['"]`);
const SPAWN_CMD = new RegExp('exec(File)?(Sync)?\\(\\s*[`\'"]' + VCS + '\\s');

const T = 60_000;
const sandboxes: string[] = [];

/** A minimal repo copy that can run the guard: config + the two N+1 files, node_modules symlinked. */
function sandbox(mutate?: (oracle: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gw-iter104-'));
  sandboxes.push(dir);
  for (const f of ['package.json', 'vitest.config.ts', 'tsconfig.json']) copyFileSync(join(ROOT, f), join(dir, f));
  mkdirSync(join(dir, 'test'));
  copyFileSync(join(TEST_DIR, GUARD), join(dir, 'test', GUARD));
  const oracle = readFileSync(join(TEST_DIR, ORACLE), 'utf8');
  const next = mutate ? mutate(oracle) : oracle;
  if (mutate) expect(next, 'mutation must change the oracle').not.toBe(oracle);
  writeFileSync(join(dir, 'test', ORACLE), next);
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function runGuard(dir: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [VITEST, 'run', `test/${GUARD}`], {
    cwd: dir,
    encoding: 'utf8',
    timeout: T - 5_000,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

afterAll(() => {
  for (const d of sandboxes) rmSync(d, { recursive: true, force: true });
});

// ---------- EB1 ----------
describe('EB1: the guard file exists, reads the oracle as text, and passes', () => {
  it('test/n-plus-1-guard.test.ts exists and is non-empty', () => {
    expect(existsSync(join(TEST_DIR, GUARD))).toBe(true);
    expect(guardSrc.length).toBeGreaterThan(0);
  });

  it('uses no subprocess (no child_process import, no spawn/exec call)', () => {
    expect(guardSrc).not.toMatch(/child_process/);
    expect(guardSrc).not.toMatch(/\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/);
  });

  it('reads test/n-plus-1.test.ts as text', () => {
    expect(guardSrc).toMatch(/readFileSync/);
    expect(guardSrc).toContain(ORACLE);
  });

  it.each(TITLES)('the guard names oracle title %j and the oracle has it verbatim', (title) => {
    expect(guardSrc).toContain(title);
    expect(oracleSrc).toContain(title);
  });

  it.each(ASSERTIONS)('the guard names assertion %s and the oracle has it verbatim', (a) => {
    expect(guardSrc).toContain(a);
    expect(oracleSrc).toContain(a);
  });

  it.each(['.skip', '.only', '.todo', '.fails', '.skipIf', '.runIf', 'xit(', 'xdescribe('])(
    'the guard forbids %s and the oracle contains none',
    (d) => {
      expect(guardSrc).toContain(d);
      expect(oracleSrc).not.toContain(d);
    },
  );
});

// ---------- EB2-4 (+ control) ----------
describe.concurrent('EB2-4: mutants turn the guard red; a clean copy stays green', () => {
  it('control: the unmodified oracle copy passes the guard (exit 0)', { timeout: T }, () => {
    const r = runGuard(sandbox());
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/passed/);
    expect(r.out).not.toMatch(/\bfailed\b/);
  });

  it('EB2: expect(total).toBe(3) → toBe(4) turns the guard red', { timeout: T }, () => {
    const r = runGuard(sandbox((s) => s.replace('expect(total).toBe(3);', 'expect(total).toBe(4);')));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/\bfailed\b/);
  });

  it('EB3: renaming the batched title turns the guard red', { timeout: T }, () => {
    const r = runGuard(
      sandbox((s) =>
        s.replace(
          'batched (request-scoped DataLoader) makes exactly 3 downstream calls',
          'batched (request-scoped DataLoader) makes few downstream calls',
        ),
      ),
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/\bfailed\b/);
  });

  it('EB4: it( → it.skip( on the first oracle test turns the guard red', { timeout: T }, () => {
    const r = runGuard(sandbox((s) => s.replace(/\bit\(/, 'it.skip(')));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/\bfailed\b/);
  });

  it('extra: dropping the identical-data assertion turns the guard red', { timeout: T }, () => {
    const r = runGuard(sandbox((s) => s.replace('expect(batched.data).toEqual(naive.data);', '')));
    expect(r.status).not.toBe(0);
  });

  it('extra: it.only on the naive test turns the guard red', { timeout: T }, () => {
    const r = runGuard(
      sandbox((s) => s.replace("it('naive (no batching)", "it.only('naive (no batching)")),
    );
    expect(r.status).not.toBe(0);
  });
});

// ---------- EB5 ----------
describe('EB5: no file under test/ spawns the VCS', () => {
  const files = readdirSync(TEST_DIR, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? (e as unknown as { path: string }).path, e.name));

  it('test/ holds more than 70 files to scan (sanity)', () => {
    expect(files.length).toBeGreaterThan(70);
  });

  it('no test file matches the quoted-argument regex', () => {
    const hits = files.filter((f) => SPAWN_ARG.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('no test file matches the exec(...) command regex', () => {
    const hits = files.filter((f) => SPAWN_CMD.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('the regexes do catch a spawn line (self-check of the scanner)', () => {
    expect(SPAWN_ARG.test(`spawnSync('${VCS}', ['status'])`)).toBe(true);
    expect(SPAWN_CMD.test(`execSync("${VCS} diff HEAD")`)).toBe(true);
    expect(SPAWN_CMD.test(`execFileSync('${VCS} rev-parse')`)).toBe(true);
  });
});

// ---------- EB8 (in-suite half) ----------
describe('EB8: the oracle still pins 3 and 21', () => {
  it('oracle has the 21 naive and 3 batched totals and its three plain it() tests', () => {
    expect(oracleSrc).toContain('expect(total).toBe(21);');
    expect(oracleSrc).toContain('expect(total).toBe(3);');
    for (const t of TITLES) expect(oracleSrc).toContain(`it('${t}'`);
  });
});

// ---------- EB12 ----------
describe('EB12: mixed blocks keep their non-VCS legs', () => {
  it('test_iter62 still compares the dist/ snapshot after the run', () => {
    const s = readFileSync(join(TEST_DIR, 'test_iter62_behavior.test.ts'), 'utf8');
    expect(s).toContain('function distSnapshot()');
    expect(s).toContain('expect(after.dist).toBe(before.dist);');
  });

  it('test_iter80 still compares the dist/ snapshot', () => {
    const s = readFileSync(join(TEST_DIR, 'test_iter80_behavior.test.ts'), 'utf8');
    expect(s).toContain('function distSnapshot()');
    expect(s).toContain('expect(distSnapshot()).toBe(before.dist);');
  });
});

// ---------- EB13 ----------
describe('EB13: README', () => {
  let testFiles: number;
  beforeAll(() => {
    testFiles = readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.ts')).length;
  });

  it('badge total equals the "N tests across M files" prose, and M is the test file count', () => {
    const badge = /tests-(\d+)%20passing/.exec(readme);
    const line = /(\d+) tests across (\d+) files/.exec(readme);
    expect(badge).not.toBeNull();
    expect(line).not.toBeNull();
    expect(badge![1]).toBe(line![1]);
    expect(Number(line![2])).toBe(testFiles);
  });

  it('§8 has a bullet naming n-plus-1-guard.test.ts that says it pins the oracle without the VCS', () => {
    const bullet = readme.split('\n').find((l) => /^\s*-\s/.test(l) && l.includes(GUARD));
    expect(bullet, 'a list bullet naming the guard file').toBeDefined();
    expect(bullet!).toMatch(/N\+1/);
    expect(bullet!).toMatch(new RegExp(`without ${VCS}`, 'i'));
  });

  it('one sentence says the suite runs from a tarball or ZIP export with no checkout needed', () => {
    const sentences = readme.split(/(?<=[.:])\s+/);
    const hit = sentences.find(
      (s) => /tarball/i.test(s) && /ZIP/.test(s) && new RegExp(`no ${VCS} checkout`, 'i').test(s),
    );
    expect(hit).toBeDefined();
  });
});
