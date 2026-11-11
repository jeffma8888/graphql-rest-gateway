import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lib from '../src/lib';
import { createGateway, buildBackend, NAIVE } from '../src/lib';

/**
 * iter-69: identical `authors(first, after)` list pages are fetched from REST
 * once per edge HTTP request (batched operations and same-page aliases).
 * Black-box: the bundled backend runs in-process on port 0; the gateway is
 * driven through createGateway(...).fetch. "Calls" is the backend /__stats
 * `total` delta over one gateway request and "/authors" is the
 * `byRoute['/authors']` delta, cross-checked against an onRequest recorder.
 *
 * HEAD figures quoted in comments were measured on a `git archive HEAD` copy.
 *
 * Spec notes:
 * - The EB3 `first:100` + `first:150` aliases with a `node { id }` selection cost
 *   1002 > the default maxComplexity 1000 (QUERY_TOO_COMPLEX, 0 calls) on both
 *   trees, so the case uses `totalCount edges { cursor }`.
 * - "cursor of offset 1" is read as the cursor the gateway itself returns for
 *   the first edge (it decodes to "offset:1"); the page after it starts at a2.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const README = readFileSync(resolve(root, 'README.md'), 'utf8');

type Gateway = ReturnType<typeof createGateway>;
type Stats = { total: number; byRoute: Record<string, number> };
type GqlError = { message: string; path?: unknown[]; extensions?: Record<string, unknown> };
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
  extensions?: { downstreamCalls?: { total: number } };
};
type Sent = { status: number; body: unknown; calls: number; authors: number };

const S = `{ authors(first: 5) { totalCount edges { node { id books { id reviews { id } } } } } }`;
const ALIAS = `{ list: authors(first:5){ edges{ node{ name } } } count: authors(first:5){ totalCount } }`;
const BUDGET_CODE = 'DOWNSTREAM_BUDGET_EXCEEDED';
const HEAD_500_MESSAGE = 'Downstream REST error 500 Internal Server Error for /authors';

let app: FastifyInstance;
let base: string;
let recorded = 0;
let gw: Gateway;
let singleS: GqlResult;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function readStats(): Promise<Stats> {
  const r = await fetch(`${base}/__stats`);
  return (await r.json()) as Stats;
}

async function post(g: Gateway, payload: unknown): Promise<{ status: number; body: unknown }> {
  const res = await g.fetch('http://gw.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** One gateway HTTP request, measured as a backend stats delta. */
async function send(g: Gateway, payload: unknown): Promise<Sent> {
  const r = await fetch(`${base}/__stats/reset`, { method: 'POST' });
  expect(r.ok).toBe(true);
  recorded = 0;
  const { status, body } = await post(g, payload);
  await sleep(25);
  const stats = await readStats();
  expect(recorded).toBe(stats.total);
  return { status, body, calls: stats.total, authors: stats.byRoute['/authors'] ?? 0 };
}

function asArray(body: unknown): GqlResult[] {
  expect(Array.isArray(body)).toBe(true);
  return body as GqlResult[];
}

function asOne(body: unknown): GqlResult {
  expect(Array.isArray(body)).toBe(false);
  expect(body).toBeTypeOf('object');
  expect(body).not.toBeNull();
  return body as GqlResult;
}

const batchOf = (n: number, query: string): { query: string }[] =>
  Array.from({ length: n }, () => ({ query }));

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  app.addHook('onRequest', (req, _reply, done) => {
    if (!req.url.startsWith('/__')) recorded += 1;
    done();
  });
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  gw = createGateway({ restBaseUrl: base, maxBatchSize: 10 });
  const s = await send(gw, { query: S });
  expect(s.status).toBe(200);
  expect(s.calls).toBe(3);
  singleS = asOne(s.body);
  expect(singleS.errors).toBeUndefined();
  const edges = (singleS.data as { authors: { edges: unknown[] } }).authors.edges;
  expect(edges.length).toBe(5);
});

afterAll(async () => {
  await app.close();
});

// ---------- EB1 ----------
describe('EB1 - batch of identical list ops', () => {
  for (const n of [1, 2, 5, 10]) {
    it(`a batch of ${n} copies of S costs 3 calls and 1 /authors`, async () => {
      // HEAD: 3/4/7/12 calls and N /authors.
      const s = await send(gw, batchOf(n, S));
      expect(s.status).toBe(200);
      expect(s.calls).toBe(3);
      expect(s.authors).toBe(1);
      const els = asArray(s.body);
      expect(els.length).toBe(n);
      for (const el of els) {
        expect(el.errors).toBeUndefined();
        expect(el.data).toEqual(singleS.data);
      }
      const totals = els.map((e) => e.extensions?.downstreamCalls?.total ?? -1);
      expect(Math.max(...totals)).toBe(3);
    });
  }
});

// ---------- EB2 ----------
describe('EB2 - same-page aliases in one op', () => {
  it('list + count aliases of authors(first:5) cost one call', async () => {
    // HEAD: 2 calls.
    const s = await send(gw, { query: ALIAS });
    expect(s.status).toBe(200);
    expect(s.calls).toBe(1);
    expect(s.authors).toBe(1);
    const r = asOne(s.body);
    expect(r.errors).toBeUndefined();
    expect(r.extensions?.downstreamCalls?.total).toBe(1);
    const data = r.data as {
      list: { edges: { node: { name: string } }[] };
      count: { totalCount: number };
    };
    expect(data.list.edges.length).toBe(5);
    expect(data.list.edges[0]?.node.name).toBe('Ada Lovelace');
    expect(data.count.totalCount).toBe(5);
  });
});

// ---------- EB3 ----------
describe('EB3 - the key is the page actually sent downstream', () => {
  /** Runs `{ a: authors(A) {SEL} b: authors(B) {SEL} }` and each alias alone. */
  async function pair(argsA: string, argsB: string, sel: string): Promise<GqlResult> {
    const q = `{ a: authors(${argsA}){ ${sel} } b: authors(${argsB}){ ${sel} } }`;
    const s = await send(gw, { query: q });
    expect(s.status).toBe(200);
    expect(s.authors).toBe(1); // HEAD: 2
    expect(s.calls).toBe(1);
    const r = asOne(s.body);
    expect(r.errors).toBeUndefined();
    // Same data as each alias run on its own (HEAD fetched each alias separately).
    const a = asOne((await send(gw, { query: `{ a: authors(${argsA}){ ${sel} } }` })).body);
    const b = asOne((await send(gw, { query: `{ b: authors(${argsB}){ ${sel} } }` })).body);
    expect(r.data?.a).toEqual(a.data?.a);
    expect(r.data?.b).toEqual(b.data?.b);
    expect(r.data?.a).toBeTypeOf('object');
    return r;
  }

  it('first:100 and first:150 (clamped to 100) share one call', async () => {
    const r = await pair('first:100', 'first:150', 'totalCount edges { cursor }');
    const d = r.data as { a: { totalCount: number; edges: unknown[] }; b: { edges: unknown[] } };
    expect(d.a.totalCount).toBe(5);
    expect(d.a.edges.length).toBe(5);
    expect(d.b).toEqual(d.a);
  });

  it('first:2 and first:2, after:null share one call with deep-equal edges', async () => {
    const r = await pair('first:2', 'first:2, after: null', 'edges { cursor node { id } }');
    const d = r.data as { a: { edges: { node: { id: string } }[] }; b: { edges: unknown[] } };
    expect(d.a.edges.length).toBe(2);
    expect(d.a.edges.map((e) => e.node.id)).toEqual(['a1', 'a2']);
    expect(d.b.edges).toEqual(d.a.edges);
  });

  it('first:0 and first:0 share one call', async () => {
    const r = await pair('first:0', 'first:0', 'totalCount edges { node { id } }');
    const d = r.data as { a: { totalCount: number }; b: unknown };
    expect(d.a.totalCount).toBe(5);
    expect(d.b).toEqual(d.a);
  });
});

// ---------- EB4 ----------
describe('EB4 - distinct pages still cost one call each', () => {
  it('first:2, first:3 and first:2 after <cursor of offset 1> make 3 /authors calls', async () => {
    const c = asOne((await send(gw, { query: `{ authors(first:2){ edges { cursor } } }` })).body);
    const cursor = (c.data as { authors: { edges: { cursor: string }[] } }).authors.edges[0]?.cursor;
    expect(cursor).toBeTypeOf('string');
    const q =
      `{ x: authors(first:2){ edges { node { id } } } ` +
      `y: authors(first:3){ edges { node { id } } } ` +
      `z: authors(first:2, after:${JSON.stringify(cursor)}){ edges { node { id } } } }`;
    const s = await send(gw, { query: q });
    expect(s.status).toBe(200);
    expect(s.authors).toBe(3);
    expect(s.calls).toBe(3);
    const r = asOne(s.body);
    expect(r.errors).toBeUndefined();
    const ids = (k: string): string[] =>
      ((r.data as Record<string, { edges: { node: { id: string } }[] }>)[k]?.edges ?? []).map(
        (e) => e.node.id,
      );
    expect(ids('x')).toEqual(['a1', 'a2']);
    expect(ids('y')).toEqual(['a1', 'a2', 'a3']);
    expect(ids('z')).toEqual(['a2', 'a3']);
  });

  it('the iter-59 distinct-cursor test file is tracked and unmodified', () => {
    const file = resolve(root, 'test/test_iter59_behavior.test.ts');
    expect(readFileSync(file, 'utf8')).toMatch(/after/);
    let out: string;
    try {
      out = execFileSync('git', ['status', '--porcelain', '--', 'test/test_iter59_behavior.test.ts'], {
        cwd: root,
        encoding: 'utf8',
      });
    } catch {
      return; // not a git checkout
    }
    expect(out.trim()).toBe('');
  });
});

// ---------- EB5 ----------
describe('EB5 - no sharing across HTTP requests', () => {
  it('three separate POSTs of S cost 3 calls each, 9 in total', async () => {
    const r = await fetch(`${base}/__stats/reset`, { method: 'POST' });
    expect(r.ok).toBe(true);
    const per: number[] = [];
    let before = 0;
    for (let i = 0; i < 3; i += 1) {
      const p = await post(gw, { query: S });
      expect(p.status).toBe(200);
      expect(asOne(p.body).extensions?.downstreamCalls?.total).toBe(3);
      await sleep(25);
      const now = (await readStats()).total;
      per.push(now - before);
      before = now;
    }
    expect(per).toEqual([3, 3, 3]);
    expect(before).toBe(9);
  });
});

// ---------- EB6 ----------
describe('EB6 - NAIVE is unchanged', () => {
  let naive: Gateway;
  beforeAll(() => {
    naive = createGateway({ restBaseUrl: base, maxBatchSize: 10, loaderOptions: NAIVE });
  });

  it('a single S costs 21 calls', async () => {
    const s = await send(naive, { query: S });
    expect(s.status).toBe(200);
    expect(s.calls).toBe(21);
    expect(asOne(s.body).data).toEqual(singleS.data);
  });

  it('a batch of 2 S costs 42 calls', async () => {
    const s = await send(naive, batchOf(2, S));
    expect(s.status).toBe(200);
    expect(s.calls).toBe(42);
    expect(s.authors).toBe(2);
  });

  it('the EB2 alias op costs 2 calls (2 /authors)', async () => {
    const s = await send(naive, { query: ALIAS });
    expect(s.status).toBe(200);
    expect(s.calls).toBe(2);
    expect(s.authors).toBe(2);
  });

  it('test/n-plus-1.test.ts is present, keeps its 21/3 oracle and is unmodified', () => {
    const src = readFileSync(resolve(root, 'test/n-plus-1.test.ts'), 'utf8');
    expect(src).toMatch(/21/);
    expect(src).toMatch(/NAIVE/);
    let out: string;
    try {
      out = execFileSync('git', ['status', '--porcelain', '--', 'test/n-plus-1.test.ts'], {
        cwd: root,
        encoding: 'utf8',
      });
    } catch {
      return;
    }
    expect(out.trim()).toBe('');
  });
});

// ---------- EB7 ----------
describe('EB7 - the budget sees deduped calls', () => {
  it('maxDownstreamCalls 3: a batch of 5 S all succeed in 3 calls', async () => {
    // HEAD: all 5 refused with DOWNSTREAM_BUDGET_EXCEEDED.
    const g = createGateway({ restBaseUrl: base, maxBatchSize: 10, maxDownstreamCalls: 3 });
    const s = await send(g, batchOf(5, S));
    expect(s.status).toBe(200);
    expect(s.calls).toBe(3);
    const els = asArray(s.body);
    expect(els.length).toBe(5);
    for (const el of els) {
      expect(el.errors).toBeUndefined();
      expect(el.data).not.toBeNull();
      expect(el.data).toEqual(singleS.data);
    }
  });

  it('maxDownstreamCalls 2: a batch of 2 S makes 2 calls and both elements are refused', async () => {
    const g = createGateway({ restBaseUrl: base, maxBatchSize: 10, maxDownstreamCalls: 2 });
    const s = await send(g, batchOf(2, S));
    expect(s.status).toBe(200);
    expect(s.calls).toBe(2);
    const els = asArray(s.body);
    expect(els.length).toBe(2);
    for (const el of els) {
      const codes = (el.errors ?? []).map((e) => e.extensions?.code);
      expect(codes).toContain(BUDGET_CODE);
    }
  });
});

// ---------- EB8 ----------
describe('EB8 - a failure is shared, not retried', () => {
  let stub: Server;
  let hits = 0;
  let stubBase = '';
  beforeAll(async () => {
    stub = createServer((_req, res) => {
      hits += 1;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((ok) => stub.listen(0, '127.0.0.1', ok));
    stubBase = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((ok) => stub.close(() => ok()));
  });

  it('a batch [S, S, a/b aliases] against an always-500 backend sends 1 request', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      hits = 0;
      const g = createGateway({ restBaseUrl: stubBase, maxBatchSize: 10 });
      const { status, body } = await post(g, [
        { query: S },
        { query: S },
        { query: `{ a: authors(first:5){totalCount} b: authors(first:5){totalCount} }` },
      ]);
      await sleep(25);
      expect(hits).toBe(1); // HEAD: 4
      expect(status).toBe(200);
      const els = asArray(body);
      expect(els.length).toBe(3);
      const expectedPaths = [['authors'], ['authors'], ['a']];
      els.forEach((el, i) => {
        expect(el.data).toBeNull();
        const first = el.errors?.[0];
        expect(first).toBeTypeOf('object');
        expect(first?.extensions?.code).toBe('DOWNSTREAM_ERROR');
        expect(first?.extensions?.status).toBe(500);
        expect(first?.path).toEqual(expectedPaths[i]);
        // Same message HEAD produces for this request.
        expect(first?.message).toBe(HEAD_500_MESSAGE);
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// ---------- EB9 ----------
describe('EB9 - unchanged surfaces', () => {
  it('the README sample query still costs 3 calls', async () => {
    const m = /```graphql\n([\s\S]*?)```/.exec(README);
    expect(m).not.toBeNull();
    const query = m?.[1] ?? '';
    expect(query).toMatch(/authors\(first: 5\)/);
    const s = await send(gw, { query });
    expect(s.status).toBe(200);
    expect(asOne(s.body).errors).toBeUndefined();
    expect(s.calls).toBe(3);
  });

  function headPorcelain(paths: string[], extra: string[] = []): string | null {
    try {
      return execFileSync('git', ['status', '--porcelain', ...extra, '--', ...paths], {
        cwd: root,
        encoding: 'utf8',
      });
    } catch {
      return null; // not a git checkout
    }
  }

  // The git pin on src/lib.ts was dropped at iter-77 (type-only `DownstreamCallEvent`
  // export); the runtime export list below is still pinned.
  it('the src/lib.ts export list is unchanged', () => {
    const keys = Object.keys(lib).sort();
    expect(keys).toEqual(['BATCHED', 'NAIVE', 'buildBackend', 'createContext', 'createGateway', 'parseAuth', 'schema']);
  });

  // SDL + generated types dropped from the list at iter-71 (Relay `last`/`before` args);
  // datasources dropped at iter-73 (2xx bodies checked against the REST contract);
  // loaders re-pinned at iter-85 (unsendable by-id keys filtered in loaders.ts) from
  // "working tree vs HEAD" to "the iter-69 commit vs its parent".
  it('loaders are unmodified by the iter-69 commit', () => {
    const iter69 = 'fa5fc8e014d51d0efa288e182335a10bfcac8c0e';
    let out: string | null;
    try {
      out = execFileSync('git', ['diff', '--name-only', `${iter69}~1`, iter69, '--', 'src/gateway/loaders.ts'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      out = null; // not a git checkout, or a shallow clone without the commit
    }
    if (out !== null) expect(out.trim()).toBe('');
  });

  it('no tracked non-behavior test file is edited or deleted', () => {
    const out = headPorcelain(['test'], ['--untracked-files=no']);
    if (out === null) return;
    const lines = out.split('\n').filter(Boolean);
    // An older behavior file may be MODIFIED (a HEAD-pin path list narrowed by a later slice);
    // n-plus-1, lib-entry and every other non-behavior test stay byte-frozen, nothing is deleted.
    const bumpedBehaviorFile = /^(M | M|MM) test\/test_iter\d+_behavior\.test\.ts$/;
    expect(lines.filter((l) => !bumpedBehaviorFile.test(l))).toEqual([]);
    expect(lines.some((l) => /^ ?D|^.D/.test(l))).toBe(false);
  });
});

// ---------- EB10 ----------
describe('EB10 - docs', () => {
  function batchingSection(): string {
    const start = README.indexOf('### Request batching');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = README.slice(start + 1);
    const next = rest.search(/\n#{2,3} /);
    return next === -1 ? rest : rest.slice(0, next);
  }

  it('Request batching states identical authors pages are fetched once per edge HTTP request', () => {
    const sec = batchingSection();
    const sentences = sec.split(/(?<=\.)\s+/);
    const hit = sentences.find((t) => t.includes('once per edge HTTP request'));
    expect(hit).toBeTypeOf('string');
    expect(hit).toMatch(/authors/);
    expect(hit).toMatch(/first/);
    expect(hit).toMatch(/after/);
    expect(hit).toMatch(/clamp/);
    expect(hit).toMatch(/batch of 10/);
    expect(hit).toMatch(/\b3 downstream calls\b/);
  });

  it('the section says NAIVE loaders (no cache) do not dedupe', () => {
    const sec = batchingSection();
    expect(sec).toMatch(/NAIVE loaders \(no cache\) do not dedupe/);
  });
});
