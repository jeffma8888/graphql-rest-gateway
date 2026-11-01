import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import * as lib from '../src/lib';
import { type LoaderOptions, NAIVE, BATCHED } from '../src/lib';
import { NAIVE as INTERNAL_NAIVE, BATCHED as INTERNAL_BATCHED } from '../src/gateway/loaders';

/**
 * iter-64: the package entry exports NAIVE / BATCHED (frozen) and type LoaderOptions,
 * and the README states no API the entry does not export.
 * Black-box: the bundled backend runs in-process on port 0 (latencyMs: 0) and the
 * gateway is driven through lib.createGateway(...).fetch. Call counts are read from
 * the backend's /__stats counter and cross-checked against
 * extensions.downstreamCalls.total. README guards are COMPUTED from the live
 * README / entry export list, never from hard-coded literals.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const README = readFileSync(resolve(root, 'README.md'), 'utf8');
const LIB_SRC = readFileSync(resolve(root, 'src', 'lib.ts'), 'utf8');

const BENCHMARK_QUERY = `{ authors(first: 5) { totalCount edges { node { id name books { id title reviews { id rating } } } } } }`;

type Gateway = ReturnType<typeof lib.createGateway>;
type Stats = { total: number; byRoute: Record<string, number> };
type GqlError = { message: string; path?: Array<string | number>; extensions?: Record<string, unknown> };
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
  extensions?: { downstreamCalls?: { total: number } };
};

async function gql(gw: Gateway, query: string, headers: Record<string, string> = {}): Promise<GqlResult> {
  const res = await gw.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as GqlResult;
}

const settle = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function resetStats(b: string): Promise<void> {
  const r = await fetch(`${b}/__stats/reset`, { method: 'POST' });
  expect(r.ok).toBe(true);
}

async function readStats(b: string): Promise<Stats> {
  const r = await fetch(`${b}/__stats`);
  return (await r.json()) as Stats;
}

async function measured(gw: Gateway, b: string, query: string): Promise<{ body: GqlResult; stats: Stats }> {
  await resetStats(b);
  const body = await gql(gw, query);
  await settle();
  const stats = await readStats(b);
  expect(body.extensions?.downstreamCalls?.total).toBe(stats.total);
  return { body, stats };
}

// ---------- README / entry parsing helpers (computed, not literal) ----------

/** Names exported by an entry source: `export { a, type B, c as d } from '...'` (+ any direct declarations). */
function entryExportNames(src: string): Set<string> {
  const names = new Set<string>();
  const clause = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g;
  for (const m of src.matchAll(clause)) {
    for (const raw of m[1]!.split(',')) {
      let item = raw.replace(/\/\/.*$/gm, '').trim();
      if (!item) continue;
      item = item.replace(/^type\s+/, '');
      const asMatch = /^\S+\s+as\s+(\S+)$/.exec(item);
      names.add(asMatch ? asMatch[1]! : item);
    }
  }
  const direct = /export\s+(?:declare\s+)?(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of src.matchAll(direct)) names.add(m[1]!);
  return names;
}

function readmeExportedSymbols(md: string): { lines: string[]; names: Set<string> } {
  const lines = md.split('\n').filter((l) => l.startsWith('Exported symbols:'));
  const names = new Set<string>();
  for (const l of lines) for (const m of l.matchAll(/`([^`]+)`/g)) names.add(m[1]!);
  return { lines, names };
}

/** Rows of the markdown table that follows `heading` (first `|` table after it). */
function tableRows(md: string, heading: string): string[][] {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.includes(heading));
  if (start < 0) return [];
  const rows: string[][] = [];
  let inTable = false;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (l.startsWith('|')) {
      inTable = true;
      rows.push(l.split('|').slice(1, -1).map((c) => c.trim()));
    } else if (inTable) break;
  }
  // drop header + separator
  return rows.slice(2);
}

const PRIMITIVES = new Set(['string', 'number', 'boolean']);
// Literal keywords match the identifier regex but name no importable symbol (e.g. Default `false`).
const LITERALS = new Set(['true', 'false', 'null', 'undefined']);

/** Bare-identifier tokens in the Type (col 1) and Default (col 2) columns of the given rows. */
function identifierTokens(rows: string[][]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    for (const cell of [r[1] ?? '', r[2] ?? '']) {
      for (const m of cell.matchAll(/`([^`]+)`/g)) {
        const tok = m[1]!;
        if (/^[A-Za-z_$][\w$]*$/.test(tok) && !PRIMITIVES.has(tok) && !LITERALS.has(tok)) out.push(tok);
      }
    }
  }
  return out;
}

function unimportable(rows: string[][], exportSet: Set<string>): string[] {
  return identifierTokens(rows).filter((t) => !exportSet.has(t));
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
    if (inFence) continue; // `# comment` lines inside code blocks are not headings
    const m = /^(#+)\s/.exec(lines[i]!);
    if (m && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function sentences(text: string): string[] {
  return text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z`*(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- fixtures ----------

let app: FastifyInstance;
let base: string;
let defaultGw: Gateway;
let naiveGw: Gateway;
let batchedGw: Gateway;

beforeAll(async () => {
  app = lib.buildBackend({ latencyMs: 0 }).app;
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  defaultGw = lib.createGateway({ restBaseUrl: base });
  naiveGw = lib.createGateway({ restBaseUrl: base, loaderOptions: lib.NAIVE });
  batchedGw = lib.createGateway({ restBaseUrl: base, loaderOptions: lib.BATCHED });
});

afterAll(async () => {
  await defaultGw?.close();
  await naiveGw?.close();
  await batchedGw?.close();
  await app?.close();
});

// ---------- EB1 ----------

describe('EB1 value exports from the package entry', () => {
  it('lib.NAIVE deep-equals { batch: false, cache: false }', () => {
    expect(lib.NAIVE).toEqual({ batch: false, cache: false });
  });

  it('lib.BATCHED deep-equals { batch: true, cache: true }', () => {
    expect(lib.BATCHED).toEqual({ batch: true, cache: true });
  });

  it('both are the very same objects as in src/gateway/loaders', () => {
    expect(lib.NAIVE).toBe(INTERNAL_NAIVE);
    expect(lib.BATCHED).toBe(INTERNAL_BATCHED);
    expect(NAIVE).toBe(INTERNAL_NAIVE);
    expect(BATCHED).toBe(INTERNAL_BATCHED);
  });
});

// ---------- EB2 ----------

describe('EB2 frozen defaults', () => {
  it('Object.isFrozen is true for both constants', () => {
    // Object.isFrozen(undefined) === true, so first prove both are real objects
    expect(lib.NAIVE).toBeTypeOf('object');
    expect(lib.NAIVE).not.toBeNull();
    expect(lib.BATCHED).toBeTypeOf('object');
    expect(lib.BATCHED).not.toBeNull();
    expect(Object.isFrozen(lib.NAIVE)).toBe(true);
    expect(Object.isFrozen(lib.BATCHED)).toBe(true);
  });

  it('a strict-mode write to BATCHED.batch throws TypeError and the default gateway still makes 3 calls', async () => {
    const target = lib.BATCHED as { batch: boolean };
    const original = target.batch;
    let thrown: unknown;
    try {
      target.batch = false;
    } catch (e) {
      thrown = e;
    } finally {
      // never leak a mutation into the rest of this file if the freeze is missing
      if (target.batch !== original && !Object.isFrozen(target)) target.batch = original;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(lib.BATCHED.batch).toBe(true);

    const fresh = lib.createGateway({ restBaseUrl: base });
    try {
      const { body, stats } = await measured(fresh, base, BENCHMARK_QUERY);
      expect(body.errors).toBeUndefined();
      expect(body.extensions?.downstreamCalls?.total).toBe(3);
      expect(stats.total).toBe(3);
    } finally {
      await fresh.close();
    }
  });

  it('a strict-mode write to NAIVE.cache throws TypeError', () => {
    const target = lib.NAIVE as { cache: boolean };
    expect(() => {
      target.cache = true;
    }).toThrow(TypeError);
    expect(lib.NAIVE.cache).toBe(false);
  });
});

// ---------- EB3 ----------

describe('EB3 NAIVE through the entry reproduces N+1', () => {
  it('benchmark query: no errors, 21 calls (1 /authors, 5 /books/by-author, 15 /reviews/by-book)', async () => {
    const { body, stats } = await measured(naiveGw, base, BENCHMARK_QUERY);
    expect(body.errors).toBeUndefined();
    expect(body.extensions?.downstreamCalls?.total).toBe(21);
    expect(stats.total).toBe(21);
    expect(stats.byRoute['/authors']).toBe(1);
    expect(stats.byRoute['/books/by-author']).toBe(5);
    expect(stats.byRoute['/reviews/by-book']).toBe(15);
  });
});

// ---------- EB4 ----------

describe('EB4 BATCHED through the entry equals the default', () => {
  it('BATCHED makes 3 calls and its data equals the default and NAIVE data', async () => {
    const b = await measured(batchedGw, base, BENCHMARK_QUERY);
    expect(b.body.errors).toBeUndefined();
    expect(b.body.extensions?.downstreamCalls?.total).toBe(3);
    expect(b.stats.total).toBe(3);

    const d = await measured(defaultGw, base, BENCHMARK_QUERY);
    expect(d.body.errors).toBeUndefined();
    expect(d.body.extensions?.downstreamCalls?.total).toBe(3);

    const n = await measured(naiveGw, base, BENCHMARK_QUERY);
    expect(n.body.extensions?.downstreamCalls?.total).toBe(21);

    expect(b.body.data).toBeTruthy();
    const edges = (b.body.data as { authors: { edges: unknown[] } }).authors.edges;
    expect(edges.length).toBe(5);
    expect(b.body.data).toEqual(d.body.data);
    expect(b.body.data).toEqual(n.body.data);
  });
});

// ---------- EB5 ----------

describe('EB5 LoaderOptions type export works and is not any', () => {
  it('typed assignments compile (enforced by tsc --noEmit) and hold at runtime', () => {
    const ok: LoaderOptions = { batch: false, cache: true };
    // @ts-expect-error -- batch must be boolean; if LoaderOptions degraded to `any` this directive is unused and typecheck fails
    const bad: LoaderOptions = { batch: 'yes', cache: true };
    const fromNaive: LoaderOptions = NAIVE;
    const fromBatched: LoaderOptions = BATCHED;
    expect(ok).toEqual({ batch: false, cache: true });
    expect(typeof bad.batch).toBe('string');
    expect(fromNaive).toBe(INTERNAL_NAIVE);
    expect(fromBatched).toBe(INTERNAL_BATCHED);
  });

  it('a gateway built with a plain LoaderOptions object works', async () => {
    const opts: LoaderOptions = { batch: true, cache: true };
    const gw = lib.createGateway({ restBaseUrl: base, loaderOptions: opts });
    try {
      const { body } = await measured(gw, base, BENCHMARK_QUERY);
      expect(body.errors).toBeUndefined();
      expect(body.extensions?.downstreamCalls?.total).toBe(3);
    } finally {
      await gw.close();
    }
  });
});

// ---------- EB6 ----------

describe('EB6 README "Exported symbols" line equals the entry, both ways', () => {
  it('exactly one such line, and the two sets are equal', () => {
    const { lines, names } = readmeExportedSymbols(README);
    expect(lines).toHaveLength(1);
    const entry = entryExportNames(LIB_SRC);
    expect(entry.size).toBeGreaterThan(0);
    const missing = [...entry].filter((n) => !names.has(n)).sort();
    const extra = [...names].filter((n) => !entry.has(n)).sort();
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    for (const n of ['NAIVE', 'BATCHED', 'LoaderOptions']) expect(names.has(n)).toBe(true);
  });

  it('parser cross-check: every runtime value export of the entry is in the parsed set', () => {
    const entry = entryExportNames(LIB_SRC);
    const runtime = Object.keys(lib);
    expect(runtime).toContain('NAIVE');
    expect(runtime).toContain('BATCHED');
    expect(runtime.filter((k) => !entry.has(k))).toEqual([]);
  });

  it('parser teeth: an extra README name and a missing entry name are both detected', () => {
    const entry = entryExportNames(LIB_SRC);
    const mutated = README.replace(/^Exported symbols:(.*)$/m, (_l, rest: string) =>
      `Exported symbols:${rest.replace('`NAIVE`, ', '')} \`requireAuth\``,
    );
    const { names } = readmeExportedSymbols(mutated);
    expect([...entry].filter((n) => !names.has(n))).toEqual(['NAIVE']);
    expect([...names].filter((n) => !entry.has(n))).toEqual(['requireAuth']);
  });
});

// ---------- EB7 ----------

describe('EB7 Options tables name only importable identifiers', () => {
  const entry = entryExportNames(LIB_SRC);
  const gwRows = tableRows(README, '**`GatewayOptions`**');
  const beRows = tableRows(README, '**`BackendOptions`**');

  it('both tables are found and every bare-identifier Type/Default token is exported', () => {
    expect(gwRows.length).toBeGreaterThan(0);
    expect(beRows.length).toBeGreaterThan(0);
    expect(gwRows.some((r) => r[0] === '`loaderOptions`')).toBe(true);
    const toks = identifierTokens([...gwRows, ...beRows]);
    expect(toks).toContain('LoaderOptions');
    expect(toks).toContain('BATCHED');
    expect(unimportable([...gwRows, ...beRows], entry)).toEqual([]);
  });

  it('teeth: the same checker on an in-memory copy with one cell set to `FOO` reports FOO', () => {
    const copy = gwRows.map((r) => [...r]);
    const row = copy.find((r) => r[0] === '`loaderOptions`')!;
    row[2] = '`FOO`';
    expect(unimportable([...copy, ...beRows], entry)).toEqual(['FOO']);
    // README on disk is untouched
    expect(readFileSync(resolve(root, 'README.md'), 'utf8')).toBe(README);
  });
});

// ---------- EB8 ----------

describe('EB8 requireAuth prose matches the code', () => {
  it('lib.requireAuth is undefined', () => {
    expect((lib as Record<string, unknown>)['requireAuth']).toBeUndefined();
  });

  it('Auth context section still mentions UNAUTHENTICATED', () => {
    const auth = section(README, 'Auth context');
    expect(auth.length).toBeGreaterThan(0);
    expect(auth).toContain('UNAUTHENTICATED');
  });

  it('no requireAuth sentence says "is provided"; it says internal + no shipped field', () => {
    const hits = sentences(README).filter((s) => s.includes('requireAuth'));
    expect(hits.length).toBeGreaterThan(0);
    for (const s of hits) expect(s).not.toContain('is provided');
    const auth = sentences(section(README, 'Auth context')).filter((s) => s.includes('requireAuth'));
    expect(auth.length).toBeGreaterThan(0);
    for (const s of auth) {
      expect(s).toContain('internal');
      expect(s).toContain('no shipped field');
    }
  });

  it('README Quickstart sample query without authorization: no UNAUTHENTICATED, reviewer REDACTED', async () => {
    const quick = section(README, 'Quickstart');
    const m = /```graphql\n([\s\S]*?)```/.exec(quick);
    expect(m).not.toBeNull();
    const query = m![1]!;
    expect(query).toMatch(/reviews\s*\{\s*id\s+rating\s+reviewer\s*\}/);
    const body = await gql(defaultGw, query);
    expect(body.data).toBeTruthy();
    const codes = (body.errors ?? []).map((e) => e.extensions?.['code']);
    expect(codes).not.toContain('UNAUTHENTICATED');
    const reviewers: unknown[] = [];
    const edges = (body.data as { authors: { edges: Array<{ node: { books: Array<{ reviews: Array<{ reviewer: unknown }> }> } }> } })
      .authors.edges;
    for (const e of edges) for (const b of e.node.books) for (const r of b.reviews) reviewers.push(r.reviewer);
    expect(reviewers.length).toBeGreaterThan(0);
    expect(reviewers.every((r) => r === 'REDACTED')).toBe(true);
  });
});

// ---------- EB9 ----------

describe('EB9 no behavior drift', () => {
  it('npm run benchmark -- --json reports naive 21 and batched 3', { timeout: 30_000 }, async () => {
    const out = await new Promise<string>((res, rej) => {
      execFile(
        'npm',
        ['run', '--silent', 'benchmark', '--', '--json'],
        { cwd: root, timeout: 25_000, env: { ...process.env, NO_COLOR: '1' } },
        (err, stdout) => (err ? rej(err) : res(stdout)),
      );
    });
    const line = out
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('{') && l.includes('"naive"'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!) as { naive: { calls: number }; batched: { calls: number } };
    expect(parsed.naive.calls).toBe(21);
    expect(parsed.batched.calls).toBe(3);
  });

  it('tracked test files (incl. n-plus-1) are byte-unchanged; only new behavior files appear', () => {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'test'], {
      cwd: root,
      encoding: 'utf8',
    });
    const lines = out.split('\n').filter(Boolean);
    const newBehaviorFile = /^(\?\?|A ) test\/test_iter\d+_behavior\.test\.ts$/;
    // An older behavior file may be MODIFIED (a pinned count bumped for a new option);
    // n-plus-1, lib-entry and every other non-behavior test stay byte-frozen, nothing is deleted.
    const bumpedBehaviorFile = /^(M | M|MM) test\/test_iter\d+_behavior\.test\.ts$/;
    expect(lines.filter((l) => !newBehaviorFile.test(l) && !bumpedBehaviorFile.test(l))).toEqual([]);
    expect(lines.some((l) => /^ ?D|^.D/.test(l))).toBe(false);
  });
});
