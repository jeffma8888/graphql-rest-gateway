import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, buildBackend } from '../src/lib';

/**
 * iter-88: pagination contract truth (README "Cursor pagination (Relay)" and
 * the SDL descriptions on AuthorEdge.cursor and PageInfo).
 * Black-box: README read as text and sliced by its section header; the
 * bundled backend runs in-process on port 0 (latencyMs 0, authors a1..a5) and
 * the gateway is driven through createGateway(...).fetch. Call counts come
 * from the backend's own /__stats counter and are cross-checked against
 * extensions.downstreamCalls.total. Descriptions come from introspection.
 *
 * Deliberately NOT pinned (row 45, planned behaviour change): pageInfo
 * (hasPreviousPage / startCursor) on past-end pages, `""` cursors, and the
 * edges of a `before` cursor far past the end with the default / `first`
 * spelling.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8');

const README = read('README.md');
const SDL = read('schema.graphql');
const GENERATED = read('src/generated/graphql.ts');

const HEADER = '### Cursor pagination (Relay)';
function section(): string {
  const start = README.indexOf(HEADER);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = README.indexOf('\n### ', start + HEADER.length);
  expect(end).toBeGreaterThan(start);
  return README.slice(start, end);
}
/** Sentence split that ignores dots inside backtick code spans. */
function sentences(text: string): string[] {
  const masked = text.replace(/`[^`]*`/g, (m) => m.replace(/\./g, '\u0000'));
  return masked
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\u0000/g, '.').trim())
    .filter((s) => s.length > 0);
}

type Gateway = ReturnType<typeof createGateway>;
type Stats = { total: number };
type GqlError = { message: string; path?: Array<string | number>; extensions?: Record<string, unknown> };
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
  extensions?: { downstreamCalls?: { total: number } };
};
type Conn = { totalCount: number; edges: Array<{ cursor: string; node: { id: string } }> };

const b64 = (s: string): string => Buffer.from(s).toString('base64');
const off = (n: number): string => b64(`offset:${n}`);

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

async function post(query: string): Promise<{ status: number; body: GqlResult; calls: number }> {
  const r0 = await fetch(`${base}/__stats/reset`, { method: 'POST' });
  expect(r0.ok).toBe(true);
  const res = await gw.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as GqlResult;
  const stats = (await (await fetch(`${base}/__stats`)).json()) as Stats;
  if (body.extensions?.downstreamCalls) {
    expect(body.extensions.downstreamCalls.total).toBe(stats.total);
  }
  return { status: res.status, body, calls: stats.total };
}

const SEL = '{ totalCount edges { cursor node { id } } }';
const authors = (args: string): string => `{ authors(${args}) ${SEL} }`;

type Field = { name: string; description: string | null };
async function fieldsOf(type: string): Promise<Field[]> {
  const { status, body } = await post(`{ __type(name: "${type}") { fields { name description } } }`);
  expect(status).toBe(200);
  expect(body.errors).toBeUndefined();
  const t = body.data?.__type as { fields: Field[] } | null;
  expect(t).not.toBeNull();
  return t!.fields;
}
async function descOf(type: string, field: string): Promise<string> {
  const f = (await fieldsOf(type)).find((x) => x.name === field);
  expect(f, `${type}.${field} exists`).toBeDefined();
  return f!.description ?? '';
}

// ---------- EB1 ----------
describe('EB1 - README section no longer promises BAD_CURSOR for out-of-range cursors', () => {
  it('section does not contain "out-of-range cursors surface"', () => {
    expect(section()).not.toContain('out-of-range cursors surface');
  });

  it('no sentence ties BAD_CURSOR to an out-of-range / past-the-end / stale cursor', () => {
    const bad = sentences(section()).filter(
      (s) => s.includes('BAD_CURSOR') && /out[- ]of[- ]range|past (the|either) end|past-the-end|stale/i.test(s),
    );
    expect(bad).toEqual([]);
  });
});

// ---------- EB2 ----------
describe('EB2 - README states malformed cursors fail with BAD_CURSOR before any downstream call', () => {
  it('section still contains the literal BAD_CURSOR (test_iter34 EB4)', () => {
    expect(section()).toContain('BAD_CURSOR');
  });

  it('one sentence names malformed + negative offset + extensions.code = BAD_CURSOR + before any downstream call', () => {
    const hits = sentences(section()).filter(
      (s) =>
        /malformed/i.test(s) &&
        /negative/i.test(s) &&
        s.includes('extensions.code = BAD_CURSOR') &&
        /before any downstream call/i.test(s),
    );
    expect(hits).toHaveLength(1);
  });
});

// ---------- EB3 ----------
describe('EB3 - README states a well-formed past-end cursor is an empty page with no error', () => {
  it('section contains "empty page", "past" and "no error"', () => {
    const s = section();
    expect(s).toContain('empty page');
    expect(s).toMatch(/\bpast\b/);
    expect(s).toContain('no error');
  });

  it('the "past" sentence says empty page, no error, totalCount still filled in, and names `after`', () => {
    const hits = sentences(section()).filter((s) => /\bpast\b/.test(s) && /well-formed/i.test(s));
    expect(hits).toHaveLength(1);
    const s = hits[0]!;
    expect(s).toContain('empty page');
    expect(s).toContain('no error');
    expect(s).toContain('totalCount');
    expect(s).toContain('`after`');
    expect(s).not.toContain('BAD_CURSOR');
  });

  it('the past-end sentence makes no claim about hasPreviousPage/startCursor, nor about "" cursors', () => {
    const hits = sentences(section()).filter((x) => /\bpast\b/.test(x) && /well-formed/i.test(x));
    expect(hits).toHaveLength(1);
    expect(hits[0]!).not.toMatch(/hasPreviousPage|hasNextPage|startCursor|endCursor/);
    // Scoped to this slice's sentence so row 45 may later document `""` elsewhere.
    expect(hits[0]!).not.toContain('""');
    expect(hits[0]!).not.toMatch(/empty[- ]string/i);
  });
});

// ---------- EB4 ----------
describe('EB4 - malformed cursors: BAD_CURSOR, data null, path ["authors"], 0 downstream calls', () => {
  it.each([
    ['first:2, after:"zzz"'],
    ['last:2, before:"zzz"'],
    [`first:2, after:"${b64('offset:-1')}"`],
    [`last:2, before:"${b64('offset:-3')}"`],
  ])('authors(%s)', async (args) => {
    const { status, body, calls } = await post(authors(args));
    expect(status).toBe(200);
    expect(body.data).toBeNull();
    expect(body.errors).toHaveLength(1);
    expect(body.errors![0]!.extensions?.code).toBe('BAD_CURSOR');
    expect(body.errors![0]!.path).toEqual(['authors']);
    expect(body.extensions?.downstreamCalls?.total).toBe(0);
    expect(calls).toBe(0);
  });
});

// ---------- EB5 ----------
describe('EB5 - well-formed past-end cursors: 200, no errors, edges [], totalCount 5', () => {
  it.each([
    [`first:2, after:"${off(9999)}"`],
    [`last:2, before:"${off(9999)}"`],
    [`first:2, after:"${off(5)}"`],
    // README sentence as shipped: `after` at the end with other size spellings,
    // and a `before` cursor at the list's start.
    [`after:"${off(5)}"`],
    [`first:100, after:"${off(5)}"`],
    [`last:2, after:"${off(9999)}"`],
    [`last:2, before:"${off(1)}"`],
    [`first:2, before:"${off(1)}"`],
    [`before:"${off(0)}"`],
  ])('authors(%s)', async (args) => {
    const { status, body } = await post(authors(args));
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('errors');
    const conn = body.data?.authors as Conn;
    expect(conn.edges).toEqual([]);
    expect(conn.totalCount).toBe(5);
  });

  it('the first:2, after:<offset:9999> past-end page still costs exactly 1 downstream call', async () => {
    const { body, calls } = await post(authors(`first:2, after:"${off(9999)}"`));
    expect(body).not.toHaveProperty('errors');
    expect(calls).toBe(1);
  });
});

// ---------- EB6 ----------
describe('EB6 - AuthorEdge.cursor description names `after` and `before`', () => {
  it('introspection description is non-empty and contains both literals', async () => {
    const d = await descOf('AuthorEdge', 'cursor');
    expect(d.trim().length).toBeGreaterThan(0);
    expect(d).toContain('`after`');
    expect(d).toContain('`before`');
  });
});

// ---------- EB7 ----------
describe('EB7 - an edge cursor works as `before` and as `after`', () => {
  it('c = authors(first:3).edges[2].cursor; before:c -> a1,a2; after:c -> a4,a5', async () => {
    const p = await post(authors('first:3'));
    expect(p.body.errors).toBeUndefined();
    const first3 = p.body.data?.authors as Conn;
    expect(first3.edges.map((e) => e.node.id)).toEqual(['a1', 'a2', 'a3']);
    const c = first3.edges[2]!.cursor;

    const back = await post(`{ authors(last:2, before:${JSON.stringify(c)}) { edges { node { id } } } }`);
    expect(back.status).toBe(200);
    expect(back.body.errors).toBeUndefined();
    expect((back.body.data?.authors as Conn).edges.map((e) => e.node.id)).toEqual(['a1', 'a2']);

    const fwd = await post(`{ authors(first:2, after:${JSON.stringify(c)}) { edges { node { id } } } }`);
    expect(fwd.status).toBe(200);
    expect(fwd.body.errors).toBeUndefined();
    expect((fwd.body.data?.authors as Conn).edges.map((e) => e.node.id)).toEqual(['a4', 'a5']);
  });
});

// ---------- EB8 ----------
describe('EB8 - all 4 PageInfo fields are described', () => {
  it.each([['hasNextPage'], ['hasPreviousPage'], ['startCursor'], ['endCursor']])(
    'PageInfo.%s has a non-empty description',
    async (name) => {
      const d = await descOf('PageInfo', name);
      expect(d.trim().length).toBeGreaterThan(0);
    },
  );

  it('startCursor mentions `before` and endCursor mentions `after`', async () => {
    expect(await descOf('PageInfo', 'startCursor')).toContain('`before`');
    expect(await descOf('PageInfo', 'endCursor')).toContain('`after`');
  });
});

// ---------- EB9 ----------
describe('EB9 - schema-first: SDL and generated types carry the descriptions', () => {
  const targets: Array<[string, string]> = [
    ['AuthorEdge', 'cursor'],
    ['PageInfo', 'hasNextPage'],
    ['PageInfo', 'hasPreviousPage'],
    ['PageInfo', 'startCursor'],
    ['PageInfo', 'endCursor'],
  ];

  it.each(targets)('%s.%s live description appears in schema.graphql and src/generated/graphql.ts', async (type, field) => {
    const d = (await descOf(type, field)).trim();
    expect(d.length).toBeGreaterThan(0);
    // Compare on whitespace-normalised text: codegen may re-wrap comment lines.
    const norm = (s: string): string => s.replace(/\s+/g, ' ');
    expect(norm(SDL)).toContain(norm(d));
    const genText = norm(GENERATED.replace(/^\s*\*\s?/gm, ' '));
    expect(genText).toContain(norm(d));
  });

  it('the one-directional "pass as `after` to page forward" text is gone from SDL and generated types', () => {
    const old = 'pass as `after` to page forward';
    expect(SDL).not.toContain(old);
    expect(GENERATED).not.toContain(old);
  });
});

// ---------- EB10 ----------
/**
 * Range for "unchanged" pins: if this iteration's commit already exists, diff
 * that commit against its parent (`hit~1..hit`), so later iterations' src
 * changes do not count; otherwise diff HEAD against the working tree.
 * (iter-89 re-pin: the old base diffed `hit~1` against the WORKING TREE.)
 */
function baseRev(): string[] {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const hit = git('log', '--format=%H', '--grep', 'foundry iter 88)', '-n', '1');
  return hit ? [`${hit}~1`, hit] : ['HEAD'];
}
function changedSince(revs: string[], ...paths: string[]): string[] {
  const out = execFileSync('git', ['diff', '--name-only', ...revs, '--', ...paths], { cwd: root, encoding: 'utf8' });
  return out.split('\n').filter((l) => l.length > 0);
}

describe('EB10 - no behaviour change', () => {
  it('nothing under src/ changed except src/generated/graphql.ts', () => {
    const changed = changedSince(baseRev(), 'src').filter((p) => p !== 'src/generated/graphql.ts');
    expect(changed).toEqual([]);
  });

  it('the N+1 regression test and the pinned iter-34 / iter-71 tests are unchanged', () => {
    const changed = changedSince(
      baseRev(),
      'test/n-plus-1.test.ts',
      'test/test_iter34_behavior.test.ts',
      'test/test_iter71_behavior.test.ts',
    );
    expect(changed).toEqual([]);
  });

  it('README: the "Any `before` costs 1 downstream call ... 2 otherwise" sentences are still in the section', () => {
    const s = section();
    expect(s).toContain('Any `before` costs 1 downstream call.');
    expect(s).toContain('`last` without `before` costs 1 call when the tail fits in the first page read, and 2 otherwise');
  });
});
