import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, buildBackend, NAIVE } from '../src/lib';

/**
 * iter-66: hostile-document refusal. A fixed 2000-token parser cap gives
 * QUERY_TOO_LARGE, and the gateway's own depth/complexity rules run before the
 * graphql-js specified rules; when they reject, their errors are returned alone.
 *
 * Black-box: the bundled backend runs in-process on port 0; the gateway is
 * driven through createGateway(...).fetch. "Calls" are the backend /__stats
 * delta across one gateway request. Wall-clock bounds are the spec's generous
 * ones (500 / 200 ms); HEAD took ~7 s / ~390 ms for the same documents.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const README = readFileSync(resolve(root, 'README.md'), 'utf8');

type Gateway = ReturnType<typeof createGateway>;
type Stats = { total: number; byRoute: Record<string, number> };
type GqlError = { message: string; extensions?: Record<string, unknown> };
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
  extensions?: Record<string, unknown>;
};
type Sent = { status: number; body: unknown; calls: number; ms: number };

const TOO_LARGE = 'QUERY_TOO_LARGE';
const TOO_COMPLEX = 'QUERY_TOO_COMPLEX';
const TOO_DEEP = 'QUERY_TOO_DEEP';

/** Exactly 2000 tokens: `{` + 1998 names + `}`. */
const DOC_2000 = '{ ' + '__typename '.repeat(1998) + '}';
/** 2001 tokens. */
const DOC_2001 = '{ ' + '__typename '.repeat(1999) + '}';
const repeatName = (n: number): string => `{ author(id:"a1"){ id ${'name '.repeat(n)}} }`;
const DOC_8000 = repeatName(8000);
const TYPENAME_32000 = '{ ' + '__typename '.repeat(32000) + '}';
const SMALL = '{ author(id:"a1"){ name } }';

let app: FastifyInstance;
let base: string;
let gw: Gateway;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function resetStats(): Promise<void> {
  const r = await fetch(`${base}/__stats/reset`, { method: 'POST' });
  expect(r.ok).toBe(true);
}

async function readStats(): Promise<Stats> {
  const r = await fetch(`${base}/__stats`);
  return (await r.json()) as Stats;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** One POST through the gateway; measures wall-clock and the downstream delta. */
async function post(g: Gateway, payload: unknown): Promise<Sent> {
  await resetStats();
  const t0 = performance.now();
  const res = await g.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await parseBody(res);
  const ms = performance.now() - t0;
  await sleep(30);
  const stats = await readStats();
  return { status: res.status, body, calls: stats.total, ms };
}

async function get(g: Gateway, query: string): Promise<Sent> {
  await resetStats();
  const t0 = performance.now();
  const res = await g.fetch(`http://gateway.local/graphql?query=${encodeURIComponent(query)}`, {
    method: 'GET',
  });
  const body = await parseBody(res);
  const ms = performance.now() - t0;
  await sleep(30);
  const stats = await readStats();
  return { status: res.status, body, calls: stats.total, ms };
}

function single(s: Sent): GqlResult {
  expect(Array.isArray(s.body)).toBe(false);
  expect(typeof s.body).toBe('object');
  return s.body as GqlResult;
}

function codes(r: GqlResult): unknown[] {
  return (r.errors ?? []).map((e) => e.extensions?.code);
}

/** The full EB1 shape of a QUERY_TOO_LARGE refusal. */
function expectTooLarge(r: GqlResult): void {
  expect(r.errors).toBeDefined();
  expect(r.errors).toHaveLength(1);
  const e = r.errors![0]!;
  expect(e.extensions?.code).toBe(TOO_LARGE);
  expect(e.extensions?.maxTokens).toBe(2000);
  expect(e.message.startsWith('Query is too large')).toBe(true);
  expect('data' in r).toBe(false);
  expect(r.extensions?.queryComplexity).toBeUndefined();
  expect(r.extensions?.downstreamCalls).toBeUndefined();
}

/** Nested `author{ books{ author{ ... title } } }` chain with exactly `levels` fields (leaf included). */
function nested(levels: number): string {
  // level 1 = author(id), levels 2..n-1 alternate books / author, level n = leaf `title`.
  let inner = 'title';
  for (let i = levels - 2; i >= 1; i--) {
    const field = i % 2 === 1 ? 'books' : 'author';
    inner = `${field} { ${i % 2 === 1 ? '' : 'id '}${inner} }`;
  }
  return `{ author(id:"a1"){ ${inner} } }`;
}

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  gw = createGateway({ restBaseUrl: base });
});

afterAll(async () => {
  await app.close();
});

// ---------- EB1 ----------
describe('EB1 - over the cap', () => {
  it('a >2000-token document gets exactly one QUERY_TOO_LARGE error, no data, 0 calls', async () => {
    const s = await post(gw, { query: DOC_2001 });
    expectTooLarge(single(s));
    expect(s.calls).toBe(0);
  });

  it('HTTP status equals the status of a QUERY_TOO_COMPLEX rejection of the same shape (200)', async () => {
    const big = await post(gw, { query: DOC_2001 });
    const complex = await post(gw, { query: repeatName(1800) });
    expect(codes(single(complex))).toContain(TOO_COMPLEX);
    expect(big.status).toBe(complex.status);
    expect(big.status).toBe(200);
  });
});

// ---------- EB2 ----------
describe('EB2 - boundary', () => {
  it('exactly 2000 tokens is accepted: data.__typename === "Query", no errors, 0 calls', async () => {
    const s = await post(gw, { query: DOC_2000 });
    const r = single(s);
    expect(r.errors).toBeUndefined();
    expect((r.data as { __typename?: string } | undefined)?.__typename).toBe('Query');
    expect(s.calls).toBe(0);
  });

  it('2001 tokens is refused with QUERY_TOO_LARGE', async () => {
    const s = await post(gw, { query: DOC_2001 });
    expectTooLarge(single(s));
    expect(s.calls).toBe(0);
  });
});

// ---------- EB3 ----------
describe('EB3 - comments are not counted', () => {
  it('a 100 000-char comment before a small query is served with 1 call', async () => {
    const q = '# ' + 'x'.repeat(100000) + '\n{ author(id:"a1"){ name } }';
    const s = await post(gw, { query: q });
    const r = single(s);
    expect(r.errors).toBeUndefined();
    expect((r.data as { author: { name: string } }).author.name).toBe('Ada Lovelace');
    expect(s.calls).toBe(1);
  });

  it('heavy whitespace padding between tokens is not counted either', async () => {
    const q = '{' + ' '.repeat(50000) + '__typename' + '\n'.repeat(50000) + '}';
    const s = await post(gw, { query: q });
    const r = single(s);
    expect(r.errors).toBeUndefined();
    expect((r.data as { __typename?: string }).__typename).toBe('Query');
  });
});

// ---------- EB4 ----------
describe('EB4 - fast refusal', () => {
  it('name x8000 (40 KB) is QUERY_TOO_LARGE in < 500 ms (HEAD: ~6.9 s QUERY_TOO_COMPLEX)', async () => {
    const s = await post(gw, { query: DOC_8000 });
    expectTooLarge(single(s));
    expect(s.calls).toBe(0);
    expect(s.ms).toBeLessThan(500);
  });

  it('cost-0 __typename x32000 is QUERY_TOO_LARGE in < 500 ms (HEAD: accepted after ~7 s)', async () => {
    const s = await post(gw, { query: TYPENAME_32000 });
    expectTooLarge(single(s));
    expect(s.calls).toBe(0);
    expect(s.ms).toBeLessThan(500);
  });
});

// ---------- EB5 ----------
describe('EB5 - no stall for neighbours', () => {
  it('a small query sent 1 ms after the hostile one is served; both settle in < 500 ms', async () => {
    const send = (q: string): Promise<GqlResult> =>
      gw
        .fetch('http://gateway.local/graphql', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: q }),
        })
        .then((r) => r.json() as Promise<GqlResult>);
    const t0 = performance.now();
    const hostile = send(DOC_8000);
    await sleep(1);
    const small = send('{ author(id:"a2"){ name } }');
    const [h, sm] = await Promise.all([hostile, small]);
    const ms = performance.now() - t0;
    expect(codes(h)).toEqual([TOO_LARGE]);
    expect(sm.errors).toBeUndefined();
    const name = (sm.data as { author: { name: string } }).author.name;
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(500);
  });
});

// ---------- EB6 ----------
describe('EB6 - gateway limits short-circuit', () => {
  it('name x1800 (under the cap) is one QUERY_TOO_COMPLEX, cost 1802, 0 calls, < 200 ms', async () => {
    const s = await post(gw, { query: repeatName(1800) });
    const r = single(s);
    expect(r.errors).toHaveLength(1);
    const e = r.errors![0]!;
    expect(e.extensions?.code).toBe(TOO_COMPLEX);
    expect(e.extensions?.cost).toBe(1802);
    expect(e.extensions?.maxComplexity).toBe(1000);
    expect(s.calls).toBe(0);
    expect(s.ms).toBeLessThan(200);
  });
});

// ---------- EB7 ----------
describe('EB7 - limit errors are returned alone', () => {
  it('an over-complex doc with an unknown field returns only QUERY_TOO_COMPLEX (cost 1102)', async () => {
    const s = await post(gw, { query: `{ author(id:"a1"){ nope ${'name '.repeat(1100)}} }` });
    const r = single(s);
    expect(r.errors).toHaveLength(1);
    expect(r.errors![0]!.extensions?.code).toBe(TOO_COMPLEX);
    expect(r.errors![0]!.extensions?.cost).toBe(1102);
    expect(codes(r)).not.toContain('GRAPHQL_VALIDATION_FAILED');
    expect(s.calls).toBe(0);
  });

  it('within the limits the spec rules still run: unknown field is GRAPHQL_VALIDATION_FAILED at 0 calls', async () => {
    const s = await post(gw, { query: '{ author(id:"a1"){ nope name } }' });
    const r = single(s);
    expect(codes(r)).toContain('GRAPHQL_VALIDATION_FAILED');
    const msg = r.errors!.find((e) => e.extensions?.code === 'GRAPHQL_VALIDATION_FAILED')!.message;
    expect(msg.startsWith('Cannot query field "nope"')).toBe(true);
    expect(codes(r)).not.toContain(TOO_COMPLEX);
    expect(s.calls).toBe(0);
  });
});

// ---------- EB8 ----------
describe('EB8 - both gateway rules still report together', () => {
  it('a depth-11 author/books chain gets QUERY_TOO_DEEP (11 / 10) and QUERY_TOO_COMPLEX, 0 calls', async () => {
    const s = await post(gw, { query: nested(11) });
    const r = single(s);
    const cs = codes(r);
    expect(cs).toContain(TOO_DEEP);
    expect(cs).toContain(TOO_COMPLEX);
    expect(cs).not.toContain('GRAPHQL_VALIDATION_FAILED');
    const deep = r.errors!.find((e) => e.extensions?.code === TOO_DEEP)!;
    expect(deep.extensions?.depth).toBe(11);
    expect(deep.extensions?.maxDepth).toBe(10);
    expect('data' in r ? r.data : undefined).toBeUndefined();
    expect(s.calls).toBe(0);
  });

  it('control: the depth-10 chain is not QUERY_TOO_DEEP', async () => {
    const s = await post(gw, { query: nested(10) });
    expect(codes(single(s))).not.toContain(TOO_DEEP);
  });
});

// ---------- EB9 ----------
describe('EB9 - per element in a batch', () => {
  it('[2001-token doc, small query] -> [QUERY_TOO_LARGE, data], 1 downstream call total', async () => {
    const g = createGateway({ restBaseUrl: base, maxBatchSize: 5 });
    const s = await post(g, [{ query: DOC_2001 }, { query: SMALL }]);
    expect(Array.isArray(s.body)).toBe(true);
    const arr = s.body as GqlResult[];
    expect(arr).toHaveLength(2);
    expectTooLarge(arr[0]!);
    expect(arr[1]!.errors).toBeUndefined();
    expect((arr[1]!.data as { author: { name: string } }).author.name).toBe('Ada Lovelace');
    expect(s.calls).toBe(1);
  });
});

// ---------- EB10 ----------
describe('EB10 - GET too', () => {
  it('GET ?query=<2001-token doc> is QUERY_TOO_LARGE at 0 calls', async () => {
    const s = await get(gw, DOC_2001);
    expectTooLarge(single(s));
    expect(s.calls).toBe(0);
  });

  it('control: GET of a small query is served', async () => {
    const s = await get(gw, SMALL);
    expect((single(s).data as { author: { name: string } }).author.name).toBe('Ada Lovelace');
  });
});

// ---------- EB11 ----------
describe('EB11 - fixed and independent of the other limits', () => {
  it('maxComplexity 1e6 / maxDepth 100 still refuse 2001 tokens with maxTokens 2000', async () => {
    const g = createGateway({ restBaseUrl: base, maxComplexity: 1000000, maxDepth: 100 });
    const s = await post(g, { query: DOC_2001 });
    expectTooLarge(single(s));
    expect(s.calls).toBe(0);
  });

  it('no new GatewayOptions row / env var: README options table still has exactly 8 rows, none token-related', () => {
    const start = README.indexOf('**`GatewayOptions`**');
    expect(start).toBeGreaterThan(-1);
    const end = README.indexOf('**`BackendOptions`**', start);
    expect(end).toBeGreaterThan(start);
    const rows = README.slice(start, end)
      .split('\n')
      .filter((l) => /^\| `[A-Za-z]+` \|/.test(l));
    expect(rows).toHaveLength(8);
    expect(rows.join('\n')).not.toMatch(/token/i);
    expect(README).not.toMatch(/MAX_TOKENS/);
  });

  it('the README 100-alias budget example (~1400 tokens) is NOT QUERY_TOO_LARGE', async () => {
    const first = await post(gw, { query: '{ authors(first: 1) { pageInfo { endCursor } } }' });
    const cursor = (
      single(first).data as { authors: { pageInfo: { endCursor: string } } }
    ).authors.pageInfo.endCursor;
    expect(typeof cursor).toBe('string');
    const aliases = Array.from(
      { length: 100 },
      (_, i) => `a${i}: authors(first: 0, after: ${JSON.stringify(cursor)}) { totalCount }`,
    ).join(' ');
    const s = await post(gw, { query: `{ ${aliases} }` });
    const r = single(s);
    expect(codes(r)).not.toContain(TOO_LARGE);
    expect(r.errors).toBeUndefined();
    expect(Object.keys(r.data ?? {})).toHaveLength(100);
  });
});

// ---------- EB12 ----------
describe('EB12 - docs', () => {
  /** README section from a heading to the next heading of the same or higher level, skipping code fences. */
  function section(title: string): string {
    const lines = README.split('\n');
    const i = lines.findIndex((l) => /^#{2,4} /.test(l) && l.includes(title));
    expect(i).toBeGreaterThan(-1);
    const level = /^(#+)/.exec(lines[i]!)![1]!.length;
    const out: string[] = [];
    let fence = false;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (/^```/.test(l)) fence = !fence;
      const m = !fence && /^(#+) /.exec(l);
      if (m && m[1]!.length <= level) break;
      out.push(l);
    }
    return out.join('\n');
  }

  it('§7 "Query depth + complexity limiting" documents the 2000-token cap, comments/whitespace not counted', () => {
    const s = section('Query depth + complexity limiting');
    expect(s).toMatch(/\b2000\b/);
    expect(s).toMatch(/token/i);
    expect(s).toMatch(/comment/i);
    expect(s).toMatch(/whitespace/i);
  });

  it('documents QUERY_TOO_LARGE with maxTokens, refused before validation, 0 downstream calls', () => {
    const s = section('Query depth + complexity limiting');
    expect(s).toContain('QUERY_TOO_LARGE');
    expect(s).toContain('maxTokens');
    expect(s).toMatch(/before[^.]*validation/i);
    expect(s).toMatch(/0 downstream calls|no downstream call/i);
  });

  it('documents that depth/complexity rejections are returned alone', () => {
    const s = section('Query depth + complexity limiting');
    expect(s).toMatch(/only (their|those|these) errors/i);
  });
});

// ---------- EB13 ----------
describe('EB13 - unchanged', () => {
  it('a syntax error is still GRAPHQL_PARSE_FAILED at 0 calls', async () => {
    const s = await post(gw, { query: '{ author(id:"a1"){ name ' });
    const r = single(s);
    expect(codes(r)).toEqual(['GRAPHQL_PARSE_FAILED']);
    expect(s.calls).toBe(0);
  });

  it('a short string literal echoing the cap phrase is still GRAPHQL_PARSE_FAILED, not QUERY_TOO_LARGE', async () => {
    const s = await post(gw, {
      query: '{ "Syntax Error: Document contains more than 5 tokens." }',
    });
    expect(codes(single(s))).toEqual(['GRAPHQL_PARSE_FAILED']);
  });

  const NESTED =
    '{ authors(first: 5) { edges { node { id name books { id title reviews { id rating } } } } } }';

  it('the nested sample query still makes 3 batched calls', async () => {
    const s = await post(gw, { query: NESTED });
    expect(single(s).errors).toBeUndefined();
    expect(s.calls).toBe(3);
  });

  it('the nested sample query still makes 21 naive calls', async () => {
    const g = createGateway({ restBaseUrl: base, loaderOptions: NAIVE });
    const s = await post(g, { query: NESTED });
    expect(single(s).errors).toBeUndefined();
    expect(s.calls).toBe(21);
  });

  it('every tracked test file is byte-identical to HEAD; only new behavior files are untracked', () => {
    let changed = 0;
    try {
      execFileSync('git', ['diff', 'HEAD', '--quiet', '--', 'test'], { cwd: root, stdio: 'pipe' });
    } catch (err) {
      changed = (err as { status?: number }).status ?? 1;
    }
    expect(changed).toBe(0);
    const status = execFileSync('git', ['status', '--porcelain', '--', 'test'], {
      cwd: root,
      encoding: 'utf8',
    });
    const lines = status.split('\n').filter((l) => l.trim() !== '');
    for (const l of lines) {
      expect(l).toMatch(/^\?\? test\/test_iter\d+_behavior\.test\.ts$/);
    }
  });
});
