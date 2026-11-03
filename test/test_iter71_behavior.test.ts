import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import codegenConfig from '../codegen';
import { createGateway, buildBackend, NAIVE } from '../src/lib';
import { BENCHMARK_QUERY } from '../benchmark/benchmark';

/**
 * iter-71: Relay backward pagination on `Query.authors` (`last` / `before`),
 * `after`+`before` windows, `BAD_PAGINATION_ARGS`, and every page truncated
 * to its clamped size (0..100).
 * Black-box: the bundled backend runs in-process on port 0 (latencyMs 0,
 * authors a1..a5) and the gateway is driven through createGateway(...).fetch.
 * Call counts come from the backend's own /__stats counter and are
 * cross-checked against extensions.downstreamCalls.total.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const README = readFileSync(resolve(root, 'README.md'), 'utf8');
const SDL = readFileSync(resolve(root, 'schema.graphql'), 'utf8');
const GENERATED = readFileSync(resolve(root, 'src/generated/graphql.ts'), 'utf8');

type Gateway = ReturnType<typeof createGateway>;
type Stats = { total: number; byRoute: Record<string, number> };
type GqlError = { message: string; path?: Array<string | number>; extensions?: Record<string, unknown> };
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
  extensions?: { downstreamCalls?: { total: number }; queryComplexity?: { cost: number } };
};
type PageInfo = {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
};
type Conn = {
  totalCount: number;
  edges: Array<{ cursor: string; node: { id: string } }>;
  pageInfo: PageInfo;
};

/** Cursor of the edge whose node is a<n>. */
const c = (n: number): string => Buffer.from(`offset:${n}`).toString('base64');

const SEL = '{ totalCount edges { cursor node { id } } pageInfo { hasNextPage hasPreviousPage startCursor endCursor } }';
const q = (args: string): string => (args ? `{ authors(${args}) ${SEL} }` : `{ authors ${SEL} }`);
/**
 * Slim selection for page sizes of 100: the full SEL with `cursor` costs 1001
 * at size 100, over the default maxComplexity 1000 (QUERY_TOO_COMPLEX).
 */
const SLIM = '{ totalCount edges { node { id } } pageInfo { hasNextPage hasPreviousPage startCursor endCursor } }';
const qs = (args: string): string => `{ authors(${args}) ${SLIM} }`;

async function gql(gw: Gateway, query: string, variables?: Record<string, unknown>): Promise<GqlResult> {
  const res = await gw.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as GqlResult;
}

async function resetStats(base: string): Promise<void> {
  const r = await fetch(`${base}/__stats/reset`, { method: 'POST' });
  expect(r.ok).toBe(true);
}

async function readStats(base: string): Promise<Stats> {
  const r = await fetch(`${base}/__stats`);
  return (await r.json()) as Stats;
}

async function measured(
  g: Gateway,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ body: GqlResult; stats: Stats }> {
  await resetStats(base);
  const body = await gql(g, query, variables);
  const stats = await readStats(base);
  if (body.extensions?.downstreamCalls) {
    expect(body.extensions.downstreamCalls.total).toBe(stats.total);
  }
  return { body, stats };
}

const ids = (conn: Conn): string[] => conn.edges.map((e) => e.node.id);
const conn = (body: GqlResult, key = 'authors'): Conn => {
  expect(body.errors).toBeUndefined();
  return body.data?.[key] as Conn;
};

let app: FastifyInstance;
let base: string;
let gw: Gateway;

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  gw = createGateway({ restBaseUrl: base });
});

afterAll(async () => {
  await app.close();
});

// ---------- EB1 ----------
describe('EB1 - SDL contract', () => {
  it('introspection shows exactly first/after/last/before, all nullable, no defaults', async () => {
    const body = await gql(
      gw,
      '{ __type(name: "Query") { fields { name args { name defaultValue type { kind name } } } } }',
    );
    expect(body.errors).toBeUndefined();
    const fields = (body.data?.__type as { fields: Array<{ name: string; args: Array<{ name: string; defaultValue: string | null; type: { kind: string; name: string | null } }> }> }).fields;
    const authors = fields.find((f) => f.name === 'authors');
    expect(authors).toBeDefined();
    expect(authors!.args).toEqual([
      { name: 'first', defaultValue: null, type: { kind: 'SCALAR', name: 'Int' } },
      { name: 'after', defaultValue: null, type: { kind: 'SCALAR', name: 'String' } },
      { name: 'last', defaultValue: null, type: { kind: 'SCALAR', name: 'Int' } },
      { name: 'before', defaultValue: null, type: { kind: 'SCALAR', name: 'String' } },
    ]);
  });

  it('schema.graphql declares the 4 args without the `first = 10` default', () => {
    const m = SDL.match(/authors\s*\(([^)]*)\)\s*:\s*AuthorConnection!/);
    expect(m).not.toBeNull();
    const args = m![1]!;
    expect(args).toMatch(/first\s*:\s*Int\b/);
    expect(args).toMatch(/after\s*:\s*String\b/);
    expect(args).toMatch(/last\s*:\s*Int\b/);
    expect(args).toMatch(/before\s*:\s*String\b/);
    expect(args).not.toMatch(/=/);
  });

  it('generated QueryAuthorsArgs has optional last and before', () => {
    const m = GENERATED.match(/export type QueryAuthorsArgs = \{([\s\S]*?)\};/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/last\?:/);
    expect(m![1]).toMatch(/before\?:/);
    expect(m![1]).toMatch(/first\?:/);
    expect(m![1]).toMatch(/after\?:/);
  });

  it('re-running codegen reproduces src/generated/graphql.ts byte for byte', { timeout: 60_000 }, () => {
    // Same plugins/config as codegen.ts, but written to a temp dir so the
    // tracked file is never touched. Run out-of-process: in-process generate()
    // trips graphql's cross-realm check under vitest.
    const dir = mkdtempSync(join(tmpdir(), 'iter71-codegen-'));
    try {
      const out = join(dir, 'graphql.ts');
      const cfg = {
        ...codegenConfig,
        schema: resolve(root, 'schema.graphql'),
        generates: { [out]: Object.values(codegenConfig.generates)[0] },
      };
      const cfgPath = join(dir, 'codegen.json');
      writeFileSync(cfgPath, JSON.stringify(cfg));
      execFileSync(resolve(root, 'node_modules/.bin/graphql-codegen'), ['--config', cfgPath, '--silent'], {
        cwd: root,
        stdio: 'pipe',
      });
      expect(readFileSync(out, 'utf8')).toBe(GENERATED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- EB2 ----------
describe('EB2 - forward paging unchanged', () => {
  it('no args: a1..a5 in 1 call', async () => {
    const { body, stats } = await measured(gw, '{ authors { edges { node { id } } } }');
    expect(ids(conn(body))).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect(stats.total).toBe(1);
  });

  it('first: 2 -> a1,a2, hasNextPage, no previous, 1 call', async () => {
    const { body, stats } = await measured(gw, q('first: 2'));
    const cn = conn(body);
    expect(ids(cn)).toEqual(['a1', 'a2']);
    expect(cn.pageInfo.hasNextPage).toBe(true);
    expect(cn.pageInfo.hasPreviousPage).toBe(false);
    expect(cn.edges.map((e) => e.cursor)).toEqual([c(1), c(2)]);
    expect(stats.total).toBe(1);
  });

  it('first: 2, after: c(2) -> a3,a4, 1 call', async () => {
    const { body, stats } = await measured(gw, q(`first: 2, after: "${c(2)}"`));
    expect(ids(conn(body))).toEqual(['a3', 'a4']);
    expect(stats.total).toBe(1);
  });

  it('benchmark query complexity cost unchanged (356)', async () => {
    const body = await gql(gw, BENCHMARK_QUERY);
    expect(body.errors).toBeUndefined();
    expect(body.extensions?.queryComplexity?.cost).toBe(356);
  });

  it('test/n-plus-1.test.ts is unmodified vs HEAD', () => {
    let out: string;
    try {
      out = execFileSync('git', ['status', '--porcelain', '--', 'test/n-plus-1.test.ts'], { cwd: root, encoding: 'utf8' });
    } catch {
      return; // not a git checkout
    }
    expect(out).toBe('');
    const src = readFileSync(resolve(root, 'test/n-plus-1.test.ts'), 'utf8');
    expect(src).toMatch(/21/);
  });
});

// ---------- EB3 ----------
describe('EB3 - last alone returns the tail', () => {
  it('last: 2 -> a4,a5 with truthful pageInfo and cursors, 2 calls to /authors', async () => {
    const { body, stats } = await measured(gw, q('last: 2'));
    const cn = conn(body);
    expect(ids(cn)).toEqual(['a4', 'a5']);
    expect(cn.totalCount).toBe(5);
    expect(cn.pageInfo).toEqual({ hasPreviousPage: true, hasNextPage: false, startCursor: c(4), endCursor: c(5) });
    expect(cn.edges.map((e) => e.cursor)).toEqual([c(4), c(5)]);
    expect(stats.total).toBe(2);
    expect(stats.byRoute).toEqual({ '/authors': 2 });
  });
});

// ---------- EB4 ----------
describe('EB4 - last covering the whole list', () => {
  for (const n of [5, 100]) {
    it(`last: ${n} -> a1..a5, no prev/next, 1 call`, async () => {
      const { body, stats } = await measured(gw, qs(`last: ${n}`));
      const cn = conn(body);
      expect(ids(cn)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
      expect(cn.pageInfo.hasPreviousPage).toBe(false);
      expect(cn.pageInfo.hasNextPage).toBe(false);
      expect(stats.total).toBe(1);
    });
  }

  it('last: 2 costs the same as first: 2', async () => {
    const a = await gql(gw, '{ authors(last: 2) { edges { node { id } } } }');
    const b = await gql(gw, '{ authors(first: 2) { edges { node { id } } } }');
    expect(a.errors).toBeUndefined();
    expect(b.errors).toBeUndefined();
    expect(typeof a.extensions?.queryComplexity?.cost).toBe('number');
    expect(a.extensions?.queryComplexity?.cost).toBe(b.extensions?.queryComplexity?.cost);
  });
});

// ---------- EB5 ----------
describe('EB5 - last + before', () => {
  it('last: 2, before: c(4) -> a2,a3, both flags true, 1 call', async () => {
    const { body, stats } = await measured(gw, q(`last: 2, before: "${c(4)}"`));
    const cn = conn(body);
    expect(ids(cn)).toEqual(['a2', 'a3']);
    expect(cn.pageInfo.hasPreviousPage).toBe(true);
    expect(cn.pageInfo.hasNextPage).toBe(true);
    expect(cn.edges.map((e) => e.cursor)).toEqual([c(2), c(3)]);
    expect(stats.total).toBe(1);
  });

  it('last: 2, before: c(2) -> a1, no previous, has next, 1 call', async () => {
    const { body, stats } = await measured(gw, q(`last: 2, before: "${c(2)}"`));
    const cn = conn(body);
    expect(ids(cn)).toEqual(['a1']);
    expect(cn.pageInfo.hasPreviousPage).toBe(false);
    expect(cn.pageInfo.hasNextPage).toBe(true);
    expect(stats.total).toBe(1);
  });

  it('last: 2, before: c(1) -> empty page, null cursors, totalCount 5, 1 call', async () => {
    const { body, stats } = await measured(gw, q(`last: 2, before: "${c(1)}"`));
    const cn = conn(body);
    expect(cn.edges).toEqual([]);
    expect(cn.totalCount).toBe(5);
    expect(cn.pageInfo).toEqual({ hasPreviousPage: false, hasNextPage: true, startCursor: null, endCursor: null });
    expect(stats.total).toBe(1);
  });
});

// ---------- EB6 ----------
describe('EB6 - backward walk round-trips', () => {
  for (const L of [1, 2, 3]) {
    it(`last: ${L} walk visits a1..a5 exactly once`, async () => {
      await resetStats(base);
      const pages: string[][] = [];
      let cn = conn(await gql(gw, q(`last: ${L}`)));
      pages.push(ids(cn));
      let guard = 0;
      while (cn.pageInfo.hasPreviousPage) {
        expect(++guard).toBeLessThan(20);
        expect(cn.pageInfo.startCursor).not.toBeNull();
        cn = conn(await gql(gw, q(`last: ${L}, before: "${cn.pageInfo.startCursor}"`)));
        pages.push(ids(cn));
      }
      const stats = await readStats(base);
      const flat = [...pages].reverse().flat();
      const forward = ids(conn(await gql(gw, qs('first: 100'))));
      expect(forward).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
      expect(flat).toEqual(forward);
      expect(new Set(flat).size).toBe(flat.length);
      if (L === 2) {
        expect(pages).toEqual([['a4', 'a5'], ['a2', 'a3'], ['a1']]);
        expect(stats.total).toBe(4);
      }
    });
  }
});

// ---------- EB7 ----------
describe('EB7 - after + before windows', () => {
  it('first: 2, before: c(5) -> a1,a2, 1 call', async () => {
    const { body, stats } = await measured(gw, q(`first: 2, before: "${c(5)}"`));
    expect(ids(conn(body))).toEqual(['a1', 'a2']);
    expect(stats.total).toBe(1);
  });

  it('after: c(1), before: c(5) -> a2,a3,a4, both flags true, 1 call', async () => {
    const { body, stats } = await measured(gw, q(`after: "${c(1)}", before: "${c(5)}"`));
    const cn = conn(body);
    expect(ids(cn)).toEqual(['a2', 'a3', 'a4']);
    expect(cn.pageInfo.hasPreviousPage).toBe(true);
    expect(cn.pageInfo.hasNextPage).toBe(true);
    expect(stats.total).toBe(1);
  });

  it('last: 1, after: c(3) -> a5, 2 calls', async () => {
    const { body, stats } = await measured(gw, q(`last: 1, after: "${c(3)}"`));
    expect(ids(conn(body))).toEqual(['a5']);
    expect(stats.total).toBe(2);
  });

  it('last: 9, after: c(3) -> a4,a5, hasPreviousPage, 1 call', async () => {
    const { body, stats } = await measured(gw, q(`last: 9, after: "${c(3)}"`));
    const cn = conn(body);
    expect(ids(cn)).toEqual(['a4', 'a5']);
    expect(cn.pageInfo.hasPreviousPage).toBe(true);
    expect(stats.total).toBe(1);
  });
});

// ---------- EB8 ----------
describe('EB8 - first and last together are rejected', () => {
  const expectRejected = (body: GqlResult, stats: Stats): void => {
    expect(body.data).toBeNull();
    expect(body.errors).toHaveLength(1);
    expect(body.errors![0]!.extensions?.code).toBe('BAD_PAGINATION_ARGS');
    expect(body.errors![0]!.path).toEqual(['authors']);
    expect(stats.total).toBe(0);
  };

  it('literal first: 2, last: 2', async () => {
    const { body, stats } = await measured(gw, q('first: 2, last: 2'));
    expectRejected(body, stats);
  });

  it('variables {f: 1, l: 1}', async () => {
    const { body, stats } = await measured(
      gw,
      `query ($f: Int, $l: Int) { authors(first: $f, last: $l) ${SEL} }`,
      { f: 1, l: 1 },
    );
    expectRejected(body, stats);
  });

  it('l: null with first: 2 is the normal forward page', async () => {
    const { body, stats } = await measured(
      gw,
      `query ($f: Int, $l: Int) { authors(first: $f, last: $l) ${SEL} }`,
      { f: 2, l: null },
    );
    expect(ids(conn(body))).toEqual(['a1', 'a2']);
    expect(stats.total).toBe(1);
  });
});

// ---------- EB9 ----------
describe('EB9 - page sizes clamp to 0..100, backend limit never trusted', () => {
  for (const n of [0, -3]) {
    it(`first: ${n} -> empty page, hasNextPage, 1 call`, async () => {
      const { body, stats } = await measured(gw, q(`first: ${n}`));
      const cn = conn(body);
      expect(cn.edges).toEqual([]);
      expect(cn.totalCount).toBe(5);
      expect(cn.pageInfo.hasNextPage).toBe(true);
      expect(cn.pageInfo.hasPreviousPage).toBe(false);
      expect(stats.total).toBe(1);
    });

    it(`last: ${n} -> empty page, hasPreviousPage, 1 call`, async () => {
      const { body, stats } = await measured(gw, q(`last: ${n}`));
      const cn = conn(body);
      expect(cn.edges).toEqual([]);
      expect(cn.totalCount).toBe(5);
      expect(cn.pageInfo.hasPreviousPage).toBe(true);
      expect(cn.pageInfo.hasNextPage).toBe(false);
      expect(stats.total).toBe(1);
    });
  }

  it('last: 500 under maxComplexity 100000 -> a1..a5, 1 call', async () => {
    const g = createGateway({ restBaseUrl: base, maxComplexity: 100_000 });
    const { body, stats } = await measured(g, q('last: 500'));
    expect(ids(conn(body))).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect(stats.total).toBe(1);
  });
});

// ---------- EB10 ----------
describe('EB10 - bad before cursor', () => {
  it('before: "zzz" -> BAD_CURSOR, 0 calls', async () => {
    const { body, stats } = await measured(gw, q('last: 2, before: "zzz"'));
    expect(body.errors?.length).toBeGreaterThan(0);
    expect(body.errors![0]!.extensions?.code).toBe('BAD_CURSOR');
    expect(stats.total).toBe(0);
  });
});

// ---------- EB11 ----------
describe('EB11 - page memo and budget interplay', () => {
  it('two identical last+before aliases -> 1 call', async () => {
    const page = `authors(last: 2, before: "${c(5)}") ${SEL}`;
    const { body, stats } = await measured(gw, `{ a: ${page} b: ${page} }`);
    expect(body.errors).toBeUndefined();
    expect(ids(conn(body, 'a'))).toEqual(['a3', 'a4']);
    expect(ids(conn(body, 'b'))).toEqual(['a3', 'a4']);
    expect(stats.total).toBe(1);
  });

  it('first: 2 + last: 2 aliases -> correct pages, 2 calls batched, 3 calls NAIVE', async () => {
    const op = `{ a: authors(first: 2) ${SEL} b: authors(last: 2) ${SEL} }`;
    const batched = await measured(gw, op);
    expect(ids(conn(batched.body, 'a'))).toEqual(['a1', 'a2']);
    expect(ids(conn(batched.body, 'b'))).toEqual(['a4', 'a5']);
    expect(batched.stats.total).toBe(2);

    const naive = createGateway({ restBaseUrl: base, loaderOptions: NAIVE });
    const n = await measured(naive, op);
    expect(ids(conn(n.body, 'a'))).toEqual(['a1', 'a2']);
    expect(ids(conn(n.body, 'b'))).toEqual(['a4', 'a5']);
    expect(n.stats.total).toBe(3);
  });

  it('maxDownstreamCalls 1 refuses last: 2; maxDownstreamCalls 2 serves it', async () => {
    const tight = createGateway({ restBaseUrl: base, maxDownstreamCalls: 1 });
    const r1 = await gql(tight, q('last: 2'));
    expect(r1.errors?.map((e) => e.extensions?.code)).toContain('DOWNSTREAM_BUDGET_EXCEEDED');

    const ok = createGateway({ restBaseUrl: base, maxDownstreamCalls: 2 });
    const r2 = await gql(ok, q('last: 2'));
    expect(ids(conn(r2))).toEqual(['a4', 'a5']);
  });
});

// ---------- EB12 ----------
describe('EB12 - nested backward page stays batched', () => {
  it('last: 2 with books+reviews -> 4 calls by route', async () => {
    const { body, stats } = await measured(
      gw,
      '{ authors(last: 2) { edges { node { id books { id reviews { id } } } } } }',
    );
    expect(body.errors).toBeUndefined();
    const edges = (body.data?.authors as { edges: Array<{ node: { id: string; books: Array<{ id: string }> } }> }).edges;
    expect(edges.map((e) => e.node.id)).toEqual(['a4', 'a5']);
    expect(edges.every((e) => e.node.books.length > 0)).toBe(true);
    expect(stats.total).toBe(4);
    expect(stats.byRoute).toEqual({ '/authors': 2, '/books/by-author': 1, '/reviews/by-book': 1 });
  });
});

// ---------- EB13 ----------
describe('EB13 - docs', () => {
  const section = (): string => {
    const start = README.indexOf('### Cursor pagination (Relay)');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = README.indexOf('\n### ', start + 5);
    return README.slice(start, end === -1 ? undefined : end);
  };

  it('README pagination section documents last/before, windows, call cost, BAD_PAGINATION_ARGS, empty pages', () => {
    const s = section();
    expect(s).toMatch(/`last`/);
    expect(s).toMatch(/`before`/);
    expect(s).toMatch(/`after` and `before` together/);
    expect(s).toMatch(/`last` without `before`/);
    expect(s).toMatch(/1 call/);
    expect(s).toMatch(/\b2 otherwise\b|\b2 (downstream )?calls\b/);
    expect(s).toContain('BAD_PAGINATION_ARGS');
    expect(s).toMatch(/0 or negative/);
    expect(s).toMatch(/empty page/);
  });

  it('BAD_PAGINATION_ARGS appears in README (iter-34 drift guard input)', () => {
    expect(README).toContain('BAD_PAGINATION_ARGS');
  });

  it('Query.authors SDL description mentions last, before and BAD_PAGINATION_ARGS', async () => {
    const body = await gql(gw, '{ __type(name: "Query") { fields { name description } } }');
    const f = (body.data?.__type as { fields: Array<{ name: string; description: string | null }> }).fields.find(
      (x) => x.name === 'authors',
    );
    const d = f?.description ?? '';
    expect(d).toMatch(/\blast\b/);
    expect(d).toMatch(/\bbefore\b/);
    expect(d).toContain('BAD_PAGINATION_ARGS');
  });
});
