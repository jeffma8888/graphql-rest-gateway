import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, buildBackend, NAIVE } from '../src/lib';

/**
 * iter-84 HOTFIX (PRODUCT row 82): hop/latency assertions read the FASTEST
 * sample, never the median, so host CPU contention cannot red the suite.
 *
 * Static half (EB1-EB7): reads the 7 hop/latency test files and diffs them
 * against the iter-83 baseline commit (resolved by its subject, never HEAD).
 * Every git-based check returns early when git or the commit is unavailable.
 * The iter-84 commit, once it exists, is the comparison target so later
 * iterations' unrelated changes never red this file.
 *
 * Live half (EB8-EB9): the bundled backend at latencyMs 50 proves the
 * statistic is sound (a 3-hop NAIVE path never beats 145 ms) and stable (a
 * 100 ms event-loop block in 4 of 5 runs reds the median but not the minimum).
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOP_FILES = ['58', '63', '70', '76', '78'] as const;
const ALL7 = ['58', '63', '68', '70', '76', '78', '81'] as const;
const rel = (n: string): string => `test/test_iter${n}_behavior.test.ts`;
const read = (n: string): string => readFileSync(path.join(REPO, rel(n)), 'utf8');

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
  } catch {
    return null;
  }
}
function shaFor(iter: number): string | null {
  const out = git(['log', '--grep', `foundry iter ${iter})`, '--format=%H', '-1']);
  const sha = out?.trim() ?? '';
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}
const BASE = existsSync(path.join(REPO, '.git')) ? shaFor(83) : null;
const ITER84 = BASE ? shaFor(84) : null;
const atBase = (p: string): string | null => (BASE ? git(['show', `${BASE}:${p}`]) : null);
/** the iter-84 version of a file: its commit once it exists, else the working tree */
const target = (p: string): string | null =>
  ITER84 ? git(['show', `${ITER84}:${p}`]) : existsSync(path.join(REPO, p)) ? readFileSync(path.join(REPO, p), 'utf8') : null;

/** `function <name>(` through the first line that is exactly `}` */
function fnBody(src: string, name: string): string | null {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) return null;
  const end = src.indexOf('\n}\n', i);
  return end < 0 ? null : src.slice(i, end + 2);
}
const trimmedLines = (s: string): string[] => s.split('\n').map((l) => l.trim());
function numericBoundArgs(src: string): string[] {
  const re = /toBe(?:LessThan|LessThanOrEqual|GreaterThan|GreaterThanOrEqual)\(\s*(-?\d+(?:\.\d+)?)\s*[,)]/g;
  return [...src.matchAll(re)].map((m) => m[1]!).sort();
}
const itCount = (src: string): number => (src.match(/\bit\(/g) ?? []).length;

// ---------- EB1 ----------
describe('EB1 - hop helpers use the fastest of >= 5 samples after 1 warm-up', () => {
  it.each(HOP_FILES)('test_iter%s: no medianMs, a fastestMs that warms once, times >= 5 sequentially, returns the min', (n) => {
    const src = read(n);
    expect(src).not.toMatch(/\bmedianMs\b/);
    expect(src).not.toContain('samples[1]!');
    expect(src).not.toContain('samples[2]!');
    const body = fnBody(src, 'fastestMs');
    expect(body, `fastestMs missing in ${rel(n)}`).not.toBeNull();
    const loopAt = body!.search(/for \(let i = 0; i < (\d+); i\+\+\)/);
    expect(loopAt).toBeGreaterThan(0);
    const runs = Number(/for \(let i = 0; i < (\d+); i\+\+\)/.exec(body!)![1]);
    expect(runs).toBeGreaterThanOrEqual(5);
    const before = body!.slice(0, loopAt);
    const loop = body!.slice(loopAt);
    // exactly 1 untimed warm-up request before the loop, no timer before it
    expect((before.match(/await gql\(/g) ?? []).length).toBe(1);
    expect(before).not.toContain('performance.now()');
    // the loop awaits one timed request per iteration (sequential, not Promise.all)
    expect((loop.match(/await gql\(/g) ?? []).length).toBe(1);
    expect(loop).not.toContain('Promise.all');
    expect((loop.match(/performance\.now\(\)/g) ?? []).length).toBe(2);
    expect(loop).toContain('samples.push(');
    expect(body).toMatch(/return Math\.min\(\.\.\.samples\);/);
  });

  it.each(HOP_FILES)('test_iter%s: every per-sample assertion of the baseline helper is still made inside the loop', (n) => {
    const base = atBase(rel(n));
    if (base === null) return;
    const old = fnBody(base, 'medianMs');
    expect(old, `baseline ${rel(n)} has no medianMs`).not.toBeNull();
    const oldAsserts = trimmedLines(old!).filter((l) => l.startsWith('expect('));
    const body = fnBody(read(n), 'fastestMs')!;
    const loop = body.slice(body.search(/for \(let i = 0;/));
    for (const a of oldAsserts) expect(trimmedLines(loop)).toContain(a);
    if (n === '58' || n === '63') expect(oldAsserts).toContain('expect(body.errors).toBeUndefined();');
  });
});

// ---------- EB2 ----------
describe('EB2 - test_iter81 measureShape reports fastest = Math.min over 5 timed samples', () => {
  const src = read('81');
  it('measureShape returns `fastest: Math.min(...samples)` and no median field; Timed has no median', () => {
    const body = fnBody(src, 'measureShape');
    expect(body).not.toBeNull();
    expect(body).toContain('fastest: Math.min(...samples)');
    expect(body).not.toMatch(/median/);
    expect(src).not.toMatch(/\.median\b/);
    expect(src).not.toMatch(/\bmedian\s*:/);
    expect(body).toMatch(/for \(let i = 0; i < 5; i\+\+\)/);
    expect((body!.match(/performance\.now\(\)/g) ?? []).length).toBe(2);
  });

  it('every baseline `.median` comparison reads `.fastest` with the same operator and right-hand side', () => {
    const base = atBase(rel('81'));
    if (base === null) return;
    const oldCmp = trimmedLines(base).filter((l) => /\.median\)\.toBe/.test(l));
    expect(oldCmp.length).toBeGreaterThanOrEqual(10);
    const now = trimmedLines(src);
    for (const l of oldCmp) expect(now).toContain(l.replace('.median)', '.fastest)'));
  });

  it('per-run totals and the last run stats are recorded exactly as at baseline', () => {
    const base = atBase(rel('81'));
    if (base === null) return;
    const oldBody = trimmedLines(fnBody(base, 'measureShape')!);
    const newBody = trimmedLines(fnBody(src, 'measureShape')!);
    for (const l of oldBody.filter((x) => /totals|stats|resetStats|last = /.test(x) && !/median/.test(x))) {
      expect(newBody).toContain(l);
    }
  });
});

// ---------- EB3 ----------
describe('EB3 - test_iter68 bounds compare the fastest of 3 runs, all non-timing asserts on every run', () => {
  const src = read('68');
  const lines = src.split('\n');

  it('RUNS = 3 and the helper returns the min of RUNS sequential runs', () => {
    expect(src).toContain('const RUNS = 3;');
    const body = fnBody(src, 'fastestOf');
    expect(body).not.toBeNull();
    expect(body).toMatch(/for \(let i = 0; i < RUNS; i\+\+\) samples\.push\(await once\(\)\);/);
    expect(body).toContain('return Math.min(...samples);');
  });

  it('no raw `s.ms` / elapsed compared to BOUND_MS; every bound site reads a fastestOf result', () => {
    const sites = lines.map((l, i) => [l.trim(), i] as const).filter(([l]) => /toBeLessThan\(BOUND_MS/.test(l));
    expect(sites.length).toBeGreaterThanOrEqual(9);
    for (const [l, i] of sites) {
      expect(l).toMatch(/^expect\(ms\)\.toBeLessThan\(BOUND_MS( \* 2)?\);$/);
      // walk back to the it( and find the `const ms = await fastestOf(` in between
      let j = i - 1;
      while (j >= 0 && !/^\s*it\(/.test(lines[j]!)) j--;
      const block = lines.slice(j, i);
      const at = block.findIndex((x) => /const ms = await fastestOf\(async \(\) => \{/.test(x));
      expect(at, `site at line ${i + 1} has no fastestOf`).toBeGreaterThanOrEqual(0);
      // between the closure end and the bound there is no other expect (all of them run per run)
      const closeRel = block.findIndex((x, k) => k > at && /^\s*\}\);\s*$/.test(x));
      expect(closeRel).toBeGreaterThan(at);
      expect(block.slice(closeRel + 1).some((x) => x.includes('expect('))).toBe(false);
      // and no response field is asserted before the closure
      expect(block.slice(0, at).some((x) => /expect\((s|h|sm|body)\b/.test(x.trim()))).toBe(false);
    }
  });

  it('every baseline expect at a bound site is inside the per-run closure in the new file', () => {
    const base = atBase(rel('68'));
    if (base === null) return;
    const bl = base.split('\n');
    const closures: string[][] = [];
    lines.forEach((l, i) => {
      if (!/const ms = await fastestOf\(async \(\) => \{/.test(l)) return;
      const out: string[] = [];
      for (let k = i + 1; k < lines.length && !/^\s{4}\}\);\s*$/.test(lines[k]!); k++) out.push(lines[k]!.trim());
      closures.push(out);
    });
    let checked = 0;
    bl.forEach((l, i) => {
      if (!/toBeLessThan\(BOUND_MS/.test(l)) return;
      let j = i - 1;
      while (j >= 0 && !/^\s*it\(/.test(bl[j]!)) j--;
      const exps = bl
        .slice(j + 1, i)
        .map((x) => x.trim())
        .filter((x) => x.startsWith('expect(') && !/tokenCount/.test(x) && !/^expect\(t\)/.test(x));
      for (const e of exps) {
        expect(closures.some((c) => c.includes(e)), `baseline assert not per-run: ${e}`).toBe(true);
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(20);
  });
});

// ---------- EB4-EB6 ----------
describe('EB4-EB6 - thresholds, call-count/data lines and it( counts vs the iter-83 baseline', () => {
  it.each(['76', '78', '81'])('test_iter%s keeps `const HOP_MS = 145;`', (n) => {
    expect(trimmedLines(target(rel(n)) ?? '')).toContain('const HOP_MS = 145;');
  });
  it('test_iter68 keeps `const BOUND_MS = 250;`', () => {
    expect(trimmedLines(target(rel('68')) ?? '')).toContain('const BOUND_MS = 250;');
  });

  it.each(ALL7)('test_iter%s: numeric bound-argument multiset equals the baseline', (n) => {
    const base = atBase(rel(n));
    if (base === null) return;
    expect(numericBoundArgs(target(rel(n))!)).toEqual(numericBoundArgs(base));
  });

  it.each(ALL7)('test_iter%s: every baseline toBe(<int>) / toEqual( line is present verbatim', (n) => {
    const base = atBase(rel(n));
    if (base === null) return;
    // multiset: a duplicated pin line (e.g. 12 x `toBe(3)`) must keep every copy
    const tally = (ls: string[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const l of ls) m.set(l, (m.get(l) ?? 0) + 1);
      return m;
    };
    const now = tally(trimmedLines(target(rel(n))!));
    const pinned = trimmedLines(base).filter((l) => /toBe\(-?\d+\)/.test(l) || l.includes('toEqual('));
    expect(pinned.length).toBeGreaterThan(0);
    const missing = [...tally(pinned)].filter(([l, k]) => (now.get(l) ?? 0) < k).map(([l]) => l);
    expect(missing).toEqual([]);
  });

  it.each(ALL7)('test_iter%s: it( count >= baseline', (n) => {
    const base = atBase(rel(n));
    if (base === null) return;
    expect(itCount(target(rel(n))!)).toBeGreaterThanOrEqual(itCount(base));
  });
});

// ---------- EB7 ----------
describe('EB7 - scope fence: test-only, n-plus-1 byte-identical', () => {
  function changed(): string[] | null {
    if (!BASE) return null;
    const diff = ITER84 ? git(['diff', '--name-only', BASE, ITER84]) : git(['diff', '--name-only', BASE]);
    if (diff === null) return null;
    const untracked = ITER84 ? '' : (git(['ls-files', '--others', '--exclude-standard']) ?? '');
    return [...diff.split('\n'), ...untracked.split('\n')]
      .map((s) => s.trim())
      .filter((s) => s && s !== 'node_modules' && !s.startsWith('node_modules/'));
  }

  it('no file under src/ or benchmark/, nor codegen.ts, differs from baseline', () => {
    const c = changed();
    if (c === null) return;
    expect(c.filter((f) => f.startsWith('src/') || f.startsWith('benchmark/') || f === 'codegen.ts')).toEqual([]);
  });

  it('test/n-plus-1.test.ts is byte-identical to baseline', () => {
    const base = atBase('test/n-plus-1.test.ts');
    if (base === null) return;
    expect(target('test/n-plus-1.test.ts')).toBe(base);
    expect(base).toContain('toBe(3)');
    expect(base).toContain('toBe(21)');
  });

  it('the only test files that differ are the 7 hop/latency files plus test_iter84; none is a non-behavior file', () => {
    const c = changed();
    if (c === null) return;
    const allowed = new Set([...ALL7.map(rel), 'test/test_iter84_behavior.test.ts']);
    const tests = c.filter((f) => f.startsWith('test/'));
    expect(tests.filter((f) => !allowed.has(f))).toEqual([]);
    expect(tests.filter((f) => !/^test\/test_iter\d+_behavior\.test\.ts$/.test(f))).toEqual([]);
    expect(tests).toContain('test/test_iter84_behavior.test.ts');
  });
});

// ---------- EB8-EB9 (live) ----------
type Gateway = ReturnType<typeof createGateway>;
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
  extensions?: { downstreamCalls?: { total: number } };
};
const Q = '{ author(id:"a1"){ name books { title reviews { id } } } }';
const HOP = 145;

async function gql(gw: Gateway, query: string): Promise<GqlResult> {
  const res = await gw.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as GqlResult;
}
function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* synchronous event-loop block */
  }
}
type Run = { samples: number[]; totals: number[]; errors: unknown[]; names: unknown[] };
async function timedRuns(gw: Gateway, disturb: (i: number) => boolean): Promise<Run> {
  await gql(gw, Q); // warm-up
  const r: Run = { samples: [], totals: [], errors: [], names: [] };
  for (let i = 1; i <= 5; i++) {
    const t0 = performance.now();
    const p = gql(gw, Q);
    if (disturb(i)) setTimeout(() => busyWait(100), 10);
    const body = await p;
    r.samples.push(performance.now() - t0);
    r.totals.push(body.extensions?.downstreamCalls?.total ?? -1);
    r.errors.push(body.errors);
    r.names.push((body.data?.author as { name?: string } | null | undefined)?.name);
  }
  return r;
}

const apps: FastifyInstance[] = [];
let naive: Run;
let batched: Run;
let noisy: Run;

beforeAll(async () => {
  const boot = async (): Promise<string> => {
    const a = buildBackend({ latencyMs: 50 }).app;
    apps.push(a);
    return a.listen({ port: 0, host: '127.0.0.1' });
  };
  const [bN, bB] = await Promise.all([boot(), boot()]);
  // NAIVE and BATCHED each on their own backend; the noisy run goes last and alone,
  // because its event-loop blocks would otherwise land in the clean samples.
  [naive, batched] = await Promise.all([
    timedRuns(createGateway({ restBaseUrl: bN, loaderOptions: NAIVE }), () => false),
    timedRuns(createGateway({ restBaseUrl: bB }), () => false),
  ]);
  const bX = await boot();
  noisy = await timedRuns(createGateway({ restBaseUrl: bX }), (i) => i !== 3);
}, 30_000);

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

describe('EB8 - soundness floor: the fastest-of-5 statistic still separates 3 hops from 2', () => {
  it('NAIVE: fastest of 5 >= 145 ms, 5 downstream calls on every run, no errors', () => {
    expect(naive.totals).toEqual([5, 5, 5, 5, 5]);
    expect(naive.errors).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(naive.names.every((n) => n === 'Ada Lovelace')).toBe(true);
    expect(Math.min(...naive.samples)).toBeGreaterThanOrEqual(HOP);
  });
  it('BATCHED: fastest of 5 < 145 ms, 3 downstream calls on every run, no errors', () => {
    expect(batched.totals).toEqual([3, 3, 3, 3, 3]);
    expect(batched.errors).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(batched.names.every((n) => n === 'Ada Lovelace')).toBe(true);
    expect(Math.min(...batched.samples)).toBeLessThan(HOP);
  });
});

describe('EB9 - contention in 4 of 5 runs reds the median but not the fastest', () => {
  it('every run: no errors, 3 calls', () => {
    expect(noisy.totals).toEqual([3, 3, 3, 3, 3]);
    expect(noisy.errors).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
  it('Math.min(samples) < 145 ms', () => {
    expect(Math.min(...noisy.samples)).toBeLessThan(HOP);
  });
  it('median (sorted index 2) >= 145 ms', () => {
    const sorted = [...noisy.samples].sort((a, b) => a - b);
    expect(sorted[2]!).toBeGreaterThanOrEqual(HOP);
  });
  it('each disturbed run is >= 145 ms (the block really landed inside the request)', () => {
    for (const i of [0, 1, 3, 4]) expect(noisy.samples[i]!).toBeGreaterThanOrEqual(HOP);
  });
});
