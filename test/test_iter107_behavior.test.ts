import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, buildBackend, NAIVE } from '../src/lib';

/**
 * iter-107 HOTFIX (PRODUCT row 122): the suite's burst and absolute-latency
 * assertions are load-robust WITHOUT being weakened.
 *
 * Static half: reads the de-flaked test files, README and PRODUCT.md as text
 * (anchored on substrings and headings, never on line numbers or commit shas).
 * Live half: proves the soundness premise the resampling relies on -- a 3-hop
 * (NAIVE) shape against the bundled backend at latencyMs 50 can never come in under the
 * 145 ms hop threshold however many times it is sampled alone, so a resampled
 * minimum cannot turn a 3-hop shape into a false `< 145` pass. That leg asserts
 * only the `>=` direction, which host load can only make MORE true.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepo = (p: string): string => readFileSync(path.join(REPO, p), 'utf8');
const readTest = (n: string): string => readRepo(`test/test_iter${n}_behavior.test.ts`);
const lines = (s: string): string[] => s.split('\n').map((l) => l.trim());

/** `function <name>(` through the first line that is exactly `}` */
function fnBody(src: string, name: string): string | null {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) return null;
  const end = src.indexOf('\n}\n', i);
  return end < 0 ? null : src.slice(i, end + 2);
}

/** the `it(` block that starts at the first line containing `title`, up to the next `it(`/`describe(` */
function itBlock(src: string, title: string): string | null {
  const ls = src.split('\n');
  const at = ls.findIndex((l) => l.includes(title) && /\bit\(/.test(l));
  if (at < 0) return null;
  let end = at + 1;
  while (end < ls.length && !/^\s*(it|describe)(\.each)?\(/.test(ls[end]!)) end++;
  return ls.slice(at, end).join('\n');
}

// ---------------------------------------------------------------- EB2 / EB3 / EB4 (iter103)
describe('EB2-EB4 - test_iter103 bursts explain themselves, keep exact counts, and get load headroom', () => {
  const src = readTest('103');

  it('EB3: BURST stays 50', () => {
    expect(lines(src)).toContain('const BURST = 50;');
  });

  it('EB2: the burst failure message carries statuses, per-reply totals, distinct codes and the hit delta', () => {
    const body = fnBody(src, 'burst');
    expect(body, 'burst() helper missing').not.toBeNull();
    const why = /const why = JSON\.stringify\(\{([^}]*)\}\)/.exec(body!);
    expect(why, 'no JSON.stringify failure message in burst()').not.toBeNull();
    const keys = why![1]!.split(',').map((k) => k.trim().split(':')[0]!.trim());
    for (const k of ['statuses', 'totals', 'codes', 'backendHits']) expect(keys).toContain(k);
    // codes are the DISTINCT errors[].extensions.code values
    expect(body).toMatch(/new Set\([^\n]*extensions\?\.code/);
  });

  it('EB2: every assertion on a burst result passes that message (no bare `expected false to be true`)', () => {
    const sites = lines(src).filter((l) => /^expect\(b[.)]/.test(l));
    expect(sites.length).toBeGreaterThanOrEqual(10);
    for (const l of sites) expect(l, l).toMatch(/^expect\(b(\.\w+)?, b\.why\)/);
  });

  it('EB3: the no-coalescing invariants stay exact (50x200, every total 3, summed 150, hits 150)', () => {
    const body = fnBody(src, 'expectUncoalesced');
    expect(body).not.toBeNull();
    const ls = lines(body!);
    expect(ls).toContain('expect(b.statuses, b.why).toEqual(Array(BURST).fill(200));');
    expect(ls).toContain('expect(b.totals, b.why).toEqual(Array(BURST).fill(3));');
    expect(ls).toContain('expect(b.sum, b.why).toBe(150);');
    expect(ls).toContain('expect(b.backendHits, b.why).toBe(150);');
    expect(body).not.toMatch(/toBeLessThanOrEqual|toBeGreaterThan/);
  });

  it('EB3: unset, "0", "false" and "" all go through the exact no-coalescing check', () => {
    expect(src).toMatch(/for \(const v of \['0', 'false', ''\]\)/);
    const calls = lines(src).filter((l) => l.includes('expectUncoalesced(await burst('));
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('EB3: the coalescing cases keep summed <= 15 and summed === backend hits', () => {
    for (const v of ["COALESCE_IN_FLIGHT: '1'", "COALESCE_IN_FLIGHT: 'true'"]) {
      const at = src.indexOf(v);
      expect(at, v).toBeGreaterThan(0);
      const block = src.slice(at, src.indexOf('}, BURST_TEST_MS)', at));
      expect(block).toContain('expect(b.statuses, b.why).toEqual(Array(BURST).fill(200));');
      expect(block).toContain('expect(b.sum, b.why).toBeLessThanOrEqual(15);');
      expect(block).toContain('expect(b.sum, b.why).toBe(b.backendHits);');
    }
    // the only <= anywhere in the file are the two coalescing `summed <= 15` bounds
    const le = lines(src).filter((l) => l.includes('toBeLessThanOrEqual('));
    expect(le).toEqual(Array(2).fill('expect(b.sum, b.why).toBeLessThanOrEqual(15);'));
  });

  it('EB4: every burst test has an explicit per-test timeout and the coalescing window is widened, not narrowed', () => {
    const m = /const BURST_TEST_MS = ([\d_]+);/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m![1]!.replace(/_/g, ''))).toBeGreaterThan(5_000); // above vitest's default
    const burstIts = (src.match(/await burst\(r\)/g) ?? []).length;
    const timed = (src.match(/\}, BURST_TEST_MS\);/g) ?? []).length;
    expect(burstIts).toBeGreaterThanOrEqual(4);
    expect(timed).toBeGreaterThanOrEqual(burstIts);
    const lat = /const COALESCE_LATENCY_MS = '(\d+)';/.exec(src);
    expect(lat).not.toBeNull();
    expect(Number(lat![1])).toBeGreaterThanOrEqual(50);
  });
});

// ---------------------------------------------------------------- EB5 / EB6 / EB7 (iter81)
describe('EB5-EB7 - test_iter81 resamples every `< HOP_MS` site alone; `>=` sites stay single-pass', () => {
  const src = readTest('81');
  const ls = lines(src);

  it('EB5/EB7: HOP_MS stays 145', () => {
    expect(ls).toContain('const HOP_MS = 145;');
  });

  it('EB5: every `toBeLessThan(HOP_MS)` reads a resampled fastest, and the required keys are all covered', () => {
    const lt = ls.filter((l) => l.includes('toBeLessThan(HOP_MS)'));
    expect(lt.length).toBeGreaterThanOrEqual(6);
    const keys: string[] = [];
    for (const l of lt) {
      const m = /^expect\(await resampledFastest\('(\w+)', (\d+), HOP_MS\)\)\.toBeLessThan\(HOP_MS\);$/.exec(l);
      expect(m, `not resampled: ${l}`).not.toBeNull();
      keys.push(m![1]!);
    }
    for (const k of ['EB1', 'EB2', 'EB6_LIT', 'EB6_VAR_T', 'EB7', 'EB8_OK']) expect(keys).toContain(k);
    // no `.fastest` is compared with `<` directly any more
    expect(src).not.toMatch(/\.fastest\)\.toBeLessThan\(/);
  });

  it('EB5: the resample helper re-measures alone, sequentially, <= 3 extra rounds of 5, stops at the first miss-free round, asserts totals', () => {
    const body = fnBody(src, 'resampledFastest');
    expect(body, 'resampledFastest missing').not.toBeNull();
    expect(ls).toContain('const RESAMPLE_ROUNDS = 3;');
    // outer loop bounded by RESAMPLE_ROUNDS and gated on the running min still missing the bound
    expect(body).toMatch(/for \(let round = 0; round < RESAMPLE_ROUNDS && Math\.min\(\.\.\.all\) >= bound; round\+\+\)/);
    expect(body).toMatch(/for \(let i = 0; i < 5; i\+\+\)/);
    expect(body).not.toContain('Promise.all');
    // the concurrent-phase samples are included in the minimum
    expect(body).toMatch(/const all = \[\.\.\.tm\.samples\];/);
    expect(body).toContain('return Math.min(...all);');
    // every resampled run asserts no errors and the exact downstream total
    expect(body).toMatch(/expect\(body\.errors[^)]*\)\.toBeUndefined\(\);/);
    expect(body).toMatch(/expect\(body\.extensions\?\.downstreamCalls\?\.total[^)]*\)\.toBe\(total\);/);
  });

  it('EB5/EB7: resampling lives outside measureShape, whose pinned body is unchanged in shape', () => {
    const ms = fnBody(src, 'measureShape');
    expect(ms).not.toBeNull();
    expect(ms).not.toMatch(/resample|RESAMPLE/);
    expect(ms).toMatch(/for \(let i = 0; i < 5; i\+\+\)/);
    expect((ms!.match(/performance\.now\(\)/g) ?? []).length).toBe(2);
    expect(ms).toContain('fastest: Math.min(...samples)');
  });

  it('EB5: expectCalls keeps its exact 5-element concurrent-phase totals assertion', () => {
    const body = fnBody(src, 'expectCalls');
    expect(body).not.toBeNull();
    expect(lines(body!)).toContain('expect(tm.totals).toEqual([total, total, total, total, total]);');
  });

  it('EB6: every `>= HOP_MS` site keeps the single-pass concurrent fastest and never resamples', () => {
    const ge = ls.filter((l) => l.includes('toBeGreaterThanOrEqual(HOP_MS)'));
    expect(ge.length).toBeGreaterThanOrEqual(5);
    for (const l of ge) {
      expect(l, l).not.toContain('resampledFastest');
      expect(l, l).toMatch(/\.fastest\)\.toBeGreaterThanOrEqual\(HOP_MS\);$/);
    }
  });
});

// ---------------------------------------------------------------- EB7 / EB8 (iter84)
describe('EB7-EB8 - test_iter84 EB8 BATCHED / EB9 noisy series take <= 3 extra whole rounds; NAIVE untouched', () => {
  const src = readTest('84');
  const ls = lines(src);

  it('EB7: the iter84 hop threshold and the iter76/78/81 HOP_MS pins are intact', () => {
    expect(ls).toContain('const HOP = 145;');
    for (const n of ['76', '78', '81']) expect(lines(readTest(n))).toContain('const HOP_MS = 145;');
  });

  it('EB8: at most 3 extra rounds; BATCHED re-runs only while its fastest misses; noisy repeats whole until run 3 is under', () => {
    expect(ls).toContain('const EXTRA_ROUNDS = 3;');
    expect(src).toMatch(/for \(let k = 0; k < EXTRA_ROUNDS && fastestOfRuns\(\[batched, \.\.\.batchedExtra\]\) >= HOP; k\+\+\)/);
    expect(src).toMatch(/for \(let k = 0; k < EXTRA_ROUNDS && noisy\.samples\[2\]! >= HOP; k\+\+\) \{\s*noisy = await timedRuns\(gX, \(i\) => i !== 3\);/);
  });

  it('EB8: assertions read the accepted series -- min < 145, sorted[2] >= 145, every disturbed run >= 145; BATCHED < 145 over all rounds', () => {
    expect(ls).toContain('expect(Math.min(...noisy.samples)).toBeLessThan(HOP);');
    expect(ls).toContain('expect(sorted[2]!).toBeGreaterThanOrEqual(HOP);');
    expect(ls).toContain('for (const i of [0, 1, 3, 4]) expect(noisy.samples[i]!).toBeGreaterThanOrEqual(HOP);');
    expect(ls).toContain('expect(fastestOfRuns([batched, ...batchedExtra])).toBeLessThan(HOP);');
  });

  it('EB8: NAIVE `>= 145` stays single-pass (never resampled)', () => {
    expect(ls).toContain('expect(Math.min(...naive.samples)).toBeGreaterThanOrEqual(HOP);');
    expect(src).not.toMatch(/naiveExtra|naive = await timedRuns/);
  });

  it('EB8/EB11: every noisy and batched run still asserts no errors and 3 calls', () => {
    // the per-run total/errors are collected by timedRuns and asserted on the accepted series
    expect(fnBody(src, 'timedRuns')).toContain('r.totals.push(body.extensions?.downstreamCalls?.total ?? -1);');
    expect(src).toMatch(/noisy\.totals\)\.toEqual\(\[3, 3, 3, 3, 3\]\)/);
    expect(src).not.toContain('toBeLessThanOrEqual(');
  });
});

// ---------------------------------------------------------------- EB9 (iter77)
describe('EB9 - test_iter77 EB7 hang case uses 500 ms headroom with every assertion intact', () => {
  const src = readTest('77');
  const block = itBlock(src, "kind: 'hang'") ?? itBlock(src, 'no headers within downstreamTimeoutMs');

  it('the hang case uses downstreamTimeoutMs: 500 (not 50) and durationMs >= 490', () => {
    expect(block, 'hang it-block not found').not.toBeNull();
    expect(block).toContain('downstreamTimeoutMs: 500');
    expect(block).not.toMatch(/downstreamTimeoutMs: 50\b(?!0)/);
    expect(block).toContain('.durationMs).toBeGreaterThanOrEqual(490);');
  });

  it('exactly one timeout event with status null / DOWNSTREAM_TIMEOUT, codes exactly that, others ok 200', () => {
    expect(block).toContain("expect(bad).toHaveLength(1);");
    expect(block).toContain("toMatchObject({ status: null, outcome: 'timeout', errorCode: 'DOWNSTREAM_TIMEOUT' })");
    expect(block).toContain("expect(new Set(codesOf(r))).toEqual(new Set(['DOWNSTREAM_TIMEOUT']));");
    expect(block).toContain("toMatchObject({ outcome: 'ok', status: 200, errorCode: null })");
  });
});

// ---------------------------------------------------------------- EB11
describe('EB11 - N+1 guard present and no call-count assertion loosened in the de-flaked files', () => {
  it('the N+1 guard test file still exists and is non-trivial', () => {
    const p = path.join(REPO, 'test/n-plus-1-guard.test.ts');
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).toMatch(/expect\(/);
  });

  it.each(['77', '81', '84'])('test_iter%s has no `toBeLessThanOrEqual` count bound', (n) => {
    expect(readTest(n)).not.toContain('toBeLessThanOrEqual(');
  });
});

// ---------------------------------------------------------------- EB12
describe('EB12 - README §8 and PRODUCT row 122', () => {
  const readme = readRepo('README.md');
  const product = readRepo('PRODUCT.md');

  it('README §8 "not load-invariant" paragraph explains resampled `<` vs single-pass `>=` against 145 ms', () => {
    const s8 = readme.slice(readme.indexOf('## 8. Testing'), readme.indexOf('## 9.'));
    const para = s8.split('\n').find((l) => l.includes('not load-invariant'));
    expect(para, 'no "not load-invariant" paragraph in §8').toBeDefined();
    expect(para).toMatch(/resampled fastest/);
    expect(para).toMatch(/single-pass fastest/);
    expect(para).toContain('145 ms');
    expect(para).toMatch(/load only adds time/);
  });

  it('PRODUCT.md has row 122 HOTFIX (bcb46cb post-release BROKEN) with status done | 107', () => {
    const row = product.split('\n').find((l) => /^\|\s*122\s*\|/.test(l));
    expect(row, 'row 122 missing').toBeDefined();
    expect(row).toContain('HOTFIX (bcb46cb post-release BROKEN)');
    expect(row).toMatch(/\|\s*done\s*\|\s*107\s*\|\s*$/);
  });
});

// ---------------------------------------------------------------- soundness premise (live)
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
  extensions?: { downstreamCalls?: { total: number } };
};
type Gateway = ReturnType<typeof createGateway>;
const HOP = 145;
const THREE_HOP = '{ author(id:"a1"){ name books { title reviews { id } } } }';

async function gql(gw: Gateway, query: string): Promise<GqlResult> {
  const res = await gw.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as GqlResult;
}

describe('EB5/EB8 soundness - a 3-hop shape resampled alone never dips under the 145 ms hop threshold', () => {
  let app: FastifyInstance;
  const samples: number[] = [];
  const totals: number[] = [];
  const errors: unknown[] = [];

  beforeAll(async () => {
    app = buildBackend({ latencyMs: 50 }).app;
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    // NAIVE: author -> books -> reviews are 3 sequential hops (the batched path prefetches to 2)
    const gw = createGateway({ restBaseUrl: base, loaderOptions: NAIVE });
    await gql(gw, THREE_HOP); // warm-up
    // 1 concurrent-phase-sized round + the maximum 3 extra rounds of 5, all sequential
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const body = await gql(gw, THREE_HOP);
      samples.push(performance.now() - t0);
      totals.push(body.extensions?.downstreamCalls?.total ?? -1);
      errors.push(body.errors);
    }
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it('every one of the 20 samples is a 5-call (NAIVE), error-free reply', () => {
    expect(totals).toEqual(Array(20).fill(5));
    expect(errors).toEqual(Array(20).fill(undefined));
  });

  it('min over 4 rounds of 5 is still >= 145 ms (more samples cannot buy a false `<` pass)', () => {
    expect(samples).toHaveLength(20);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(HOP);
  });
});
