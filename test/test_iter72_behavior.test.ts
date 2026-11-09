import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, buildBackend, NAIVE, BATCHED } from '../src/lib';

/**
 * iter-72: `createGateway(opts)` validates its WHOLE options object
 * synchronously, before anything is built: numeric limits, the
 * downstreamTimeoutMs 2^31-1 cap, restBaseUrl, loaderOptions, non-object
 * options, unknown keys with a did-you-mean hint, explicit-undefined as
 * omitted, plus the CLI DOWNSTREAM_TIMEOUT_MS upper bound and the README
 * Options table.
 * Black-box: the bundled backend runs in-process on port 0 (latencyMs 0) and
 * the gateway is driven through createGateway(...).fetch. Call counts come
 * from the backend's own /__stats counter.
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
  extensions?: { downstreamCalls?: { total: number } };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyOpts = any;
const make = (opts: AnyOpts): Gateway => createGateway(opts as AnyOpts);

const KNOWN = [
  'restBaseUrl',
  'maxDepth',
  'maxComplexity',
  'loaderOptions',
  'downstreamTimeoutMs',
  'maxDownstreamCalls',
  'forwardHeaders',
  'maxBatchSize',
  'onDownstreamCall',
] as const;

const AUTHOR_Q = '{ author(id:"a1"){ id name } }';
const BENCH_Q = '{ authors(first:5){ edges{ node{ id books{ id reviews{ id } } } } } }';
const LIST_Q = '{ authors(first:5){ edges{ node{ id } } } }';

let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  base = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
});

async function resetStats(): Promise<void> {
  const r = await fetch(`${base}/__stats/reset`, { method: 'POST' });
  expect(r.ok).toBe(true);
}

async function readStats(): Promise<Stats> {
  const r = await fetch(`${base}/__stats`);
  return (await r.json()) as Stats;
}

async function gql(gw: Gateway, query: string): Promise<{ status: number; body: GqlResult }> {
  const res = await gw.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { status: res.status, body: (await res.json()) as GqlResult };
}

/** Run fn synchronously and return what it threw (undefined if nothing). */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

function expectThrow(opts: AnyOpts, type: typeof RangeError | typeof TypeError, ...needles: string[]): Error {
  const e = thrown(() => make(opts));
  expect(e).toBeInstanceOf(type);
  for (const n of needles) expect((e as Error).message).toContain(n);
  return e as Error;
}

// ---------- EB1 ----------
const NUM_KEYS = ['maxDepth', 'maxComplexity', 'downstreamTimeoutMs'] as const;
const BAD_NUMS: Array<[string, unknown]> = [
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['0', 0],
  ['-1', -1],
  ['2.5', 2.5],
  ['"10" (string)', '10'],
  ['null', null],
];
const NUM_CASES: Array<[string, string, unknown]> = NUM_KEYS.flatMap((k) =>
  BAD_NUMS.map(([label, v]): [string, string, unknown] => [k, label, v]),
);

describe('EB1 - numeric limits reject non-positive-integer values with RangeError', () => {
  it.each(NUM_CASES)('%s = %s throws a RangeError naming the key', (key, _label, value) => {
    expectThrow({ restBaseUrl: base, [key]: value }, RangeError, key);
  });

  it('none of the throwing cases makes a downstream call', async () => {
    await resetStats();
    for (const [key, , value] of NUM_CASES) {
      expect(thrown(() => make({ restBaseUrl: base, [key]: value }))).toBeInstanceOf(RangeError);
    }
    // give any stray async work a moment to reach the backend
    await new Promise((r) => setTimeout(r, 50));
    expect((await readStats()).total).toBe(0);
  });
});

// ---------- EB2 ----------
describe('EB2 - downstreamTimeoutMs upper bound 2147483647', () => {
  it('2147483648 throws a RangeError naming the key and the 2147483647 maximum', () => {
    expectThrow({ restBaseUrl: base, downstreamTimeoutMs: 2147483648 }, RangeError, 'downstreamTimeoutMs', '2147483647');
  });

  it.each([4294967295, Number.MAX_SAFE_INTEGER])('%s also throws a RangeError', (v) => {
    expectThrow({ restBaseUrl: base, downstreamTimeoutMs: v }, RangeError, 'downstreamTimeoutMs');
  });

  it('2147483647 constructs and serves a query with no errors', async () => {
    const gw = make({ restBaseUrl: base, downstreamTimeoutMs: 2147483647 });
    const { status, body } = await gql(gw, AUTHOR_Q);
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect((body.data?.author as { id: string }).id).toBe('a1');
  });
});

// ---------- EB3 ----------
describe('EB3 - valid numerics still construct and are honoured', () => {
  it.each(NUM_KEYS)('%s = 1 constructs', (key) => {
    expect(() => make({ restBaseUrl: base, [key]: 1 })).not.toThrow();
  });

  it('maxComplexity 1 still rejects the authors list query with QUERY_TOO_COMPLEX at 0 calls', async () => {
    const gw = make({ restBaseUrl: base, maxComplexity: 1 });
    await resetStats();
    const { body } = await gql(gw, LIST_Q);
    expect(body.errors?.[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX');
    expect(body.data ?? null).toBeNull();
    expect((await readStats()).total).toBe(0);
  });

  it('maxComplexity 1000 (the default) admits the same query', async () => {
    const gw = make({ restBaseUrl: base, maxComplexity: 1000 });
    const { body } = await gql(gw, LIST_Q);
    expect(body.errors).toBeUndefined();
  });
});

// ---------- EB4 ----------
const BAD_URLS: Array<[string, AnyOpts]> = [
  ['{}', {}],
  ["''", { restBaseUrl: '' }],
  ["'not a url'", { restBaseUrl: 'not a url' }],
  ["'ftp://x'", { restBaseUrl: 'ftp://x' }],
  ["'localhost:4001'", { restBaseUrl: 'localhost:4001' }],
  ['42', { restBaseUrl: 42 }],
];

describe('EB4 - restBaseUrl must be an absolute http(s) URL', () => {
  it.each(BAD_URLS)('%s throws a TypeError naming restBaseUrl', (_label, opts) => {
    expectThrow(opts, TypeError, 'restBaseUrl');
  });

  it('none of the bad-URL cases makes a downstream call', async () => {
    await resetStats();
    for (const [, opts] of BAD_URLS) expect(thrown(() => make(opts))).toBeInstanceOf(TypeError);
    await new Promise((r) => setTimeout(r, 50));
    expect((await readStats()).total).toBe(0);
  });

  it.each(['http://127.0.0.1:4001', 'https://rest.example.test', 'https://rest.example.test/api/v1'])(
    '%s constructs',
    (url) => {
      expect(() => make({ restBaseUrl: url })).not.toThrow();
    },
  );

  it('a path-prefixed base (`${base}/api/v1`) constructs', () => {
    expect(() => make({ restBaseUrl: `${base}/api/v1` })).not.toThrow();
  });

  it('a query string / fragment is still ignored (constructs and serves)', async () => {
    const gw = make({ restBaseUrl: `${base}/?x=1#frag` });
    const { status, body } = await gql(gw, AUTHOR_Q);
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect((body.data?.author as { id: string }).id).toBe('a1');
  });
});

// ---------- EB5 ----------
describe('EB5 - non-object options throw TypeError', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('createGateway(%s) throws a TypeError', (_l, v) => {
    expect(thrown(() => make(v))).toBeInstanceOf(TypeError);
  });
});

// ---------- EB6 ----------
describe('EB6 - unknown keys throw TypeError naming the key', () => {
  it.each(['foo', 'maxComplexty', 'restBaseURL', 'loaders', 'port', 'MAXDEPTH'])(
    'unknown key %s throws',
    (key) => {
      expectThrow({ restBaseUrl: base, [key]: 1 }, TypeError, key);
    },
  );

  it('an unknown key throws even when its value is undefined', () => {
    expectThrow({ restBaseUrl: base, maxComplexty: undefined }, TypeError, 'maxComplexty');
  });

  it('an unknown key throws alongside otherwise valid options', () => {
    expectThrow({ restBaseUrl: base, maxDepth: 5, loaderOptions: BATCHED, extra: true }, TypeError, 'extra');
  });

  it('all eight known keys with valid values construct', () => {
    expect(() =>
      make({
        restBaseUrl: base,
        maxDepth: 10,
        maxComplexity: 1000,
        loaderOptions: BATCHED,
        downstreamTimeoutMs: 30000,
        maxDownstreamCalls: 50,
        forwardHeaders: ['authorization'],
        maxBatchSize: 5,
      }),
    ).not.toThrow();
  });
});

// ---------- EB7 ----------
describe('EB7 - did-you-mean hint', () => {
  it.each([
    ['maxComplexty', 'maxComplexity'],
    ['maxDownstreamCall', 'maxDownstreamCalls'],
    ['loaders', 'loaderOptions'],
  ])('%s suggests %s', (bad, good) => {
    expectThrow({ restBaseUrl: base, [bad]: 1 }, TypeError, bad, good);
  });

  it('restBaseURL (no restBaseUrl) suggests restBaseUrl', () => {
    const e = thrown(() => make({ restBaseURL: base }));
    expect(e).toBeInstanceOf(TypeError);
    const msg = (e as Error).message;
    expect(msg).toContain('restBaseURL');
    expect(msg).toContain('restBaseUrl');
  });

  it('foo names no known key', () => {
    const e = expectThrow({ restBaseUrl: base, foo: 1 }, TypeError, 'foo');
    for (const k of KNOWN) expect(e.message).not.toContain(k);
  });
});

// ---------- EB8 ----------
describe('EB8 - loaderOptions shape', () => {
  it.each([
    ["{ batch: 'yes', cache: true }", { batch: 'yes', cache: true }],
    ['{}', {}],
    ['null', null],
  ])('loaderOptions %s throws a TypeError naming loaderOptions', (_l, v) => {
    expectThrow({ restBaseUrl: base, loaderOptions: v }, TypeError, 'loaderOptions');
  });

  it.each([
    ['NAIVE', NAIVE],
    ['BATCHED', BATCHED],
    ['{ batch: true, cache: false }', { batch: true, cache: false }],
  ])('loaderOptions %s constructs', (_l, v) => {
    expect(() => make({ restBaseUrl: base, loaderOptions: v })).not.toThrow();
  });
});

// ---------- EB9 ----------
type Running = { url: string; restBaseUrl: string; close(): Promise<void> };
type StartFromEnv = (env: Record<string, string | undefined>, log?: (line: string) => void) => Promise<Running>;

async function loadStart(): Promise<StartFromEnv> {
  const mod = (await import('../src/cli')) as { startFromEnv: StartFromEnv };
  return mod.startFromEnv;
}

describe('EB9 - explicit undefined means omitted', () => {
  const ALL_UNDEFINED: AnyOpts = {
    maxDepth: undefined,
    maxComplexity: undefined,
    loaderOptions: undefined,
    downstreamTimeoutMs: undefined,
    maxDownstreamCalls: undefined,
    forwardHeaders: undefined,
    maxBatchSize: undefined,
  };

  it('all-undefined optional keys construct and behave like { restBaseUrl }', async () => {
    const gw = make({ restBaseUrl: base, ...ALL_UNDEFINED });
    const plain = make({ restBaseUrl: base });
    await resetStats();
    const a = await gql(gw, BENCH_Q);
    const afterA = (await readStats()).total;
    await resetStats();
    const b = await gql(plain, BENCH_Q);
    const afterB = (await readStats()).total;
    expect(a.status).toBe(200);
    expect(a.body.errors).toBeUndefined();
    expect(a.body.data).toEqual(b.body.data);
    expect(afterA).toBe(3);
    expect(afterB).toBe(3);
  });

  it('startFromEnv with only PORT=0 (every other var unset) boots and /healthz is 200', async () => {
    const r = await (await loadStart())({ PORT: '0', REST_LATENCY_MS: '0' }, () => {});
    try {
      const res = await fetch(new URL('/healthz', r.url));
      expect(res.status).toBe(200);
    } finally {
      await r.close();
    }
  });
});

// ---------- EB10 ----------
describe('EB10 - existing validators keep their types and messages', () => {
  // Frozen from the HEAD (iter-71) tree by running createGateway there.
  it.each<[AnyOpts, typeof Error, string]>([
    [{ maxDownstreamCalls: 0 }, RangeError, 'maxDownstreamCalls must be a positive integer, got 0'],
    [{ maxDownstreamCalls: 1.5 }, RangeError, 'maxDownstreamCalls must be a positive integer, got 1.5'],
    [{ maxDownstreamCalls: null }, RangeError, 'maxDownstreamCalls must be a positive integer, got null'],
    [{ maxBatchSize: 0 }, RangeError, 'maxBatchSize must be a positive integer, got 0'],
    [{ maxBatchSize: 2.5 }, RangeError, 'maxBatchSize must be a positive integer, got 2.5'],
    [{ forwardHeaders: 'x' }, TypeError, 'forwardHeaders must be an array of header names'],
    [
      { forwardHeaders: ['connection'] },
      Error,
      'forwardHeaders entry "connection" is a hop-by-hop header and cannot be forwarded',
    ],
    [{ forwardHeaders: ['bad header'] }, Error, 'forwardHeaders entry "bad header" is not a valid HTTP header name'],
  ])('%j -> same error type and message as before', (extra, type, message) => {
    const e = thrown(() => make({ restBaseUrl: base, ...extra }));
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).constructor).toBe(type);
    expect((e as Error).message).toBe(message);
  });
});

// ---------- EB11 ----------
describe('EB11 - downstream call counts unchanged', () => {
  it('BATCHED benchmark query: extensions total 3 and backend delta 3', async () => {
    const gw = make({ restBaseUrl: base });
    await resetStats();
    const { status, body } = await gql(gw, BENCH_Q);
    const stats = await readStats();
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.extensions?.downstreamCalls?.total).toBe(3);
    expect(stats.total).toBe(3);
  });

  it('loaderOptions NAIVE benchmark query: 21 calls', async () => {
    const gw = make({ restBaseUrl: base, loaderOptions: NAIVE });
    await resetStats();
    const { status, body } = await gql(gw, BENCH_Q);
    const stats = await readStats();
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(stats.total).toBe(21);
    expect(body.extensions?.downstreamCalls?.total).toBe(21);
  });
});

// ---------- EB12 ----------
describe('EB12 - CLI DOWNSTREAM_TIMEOUT_MS upper bound', () => {
  const open: Running[] = [];
  afterEach(async () => {
    while (open.length) await open.pop()?.close();
  });

  it.each(['2147483648', '4294967295'])('DOWNSTREAM_TIMEOUT_MS=%s rejects naming the variable', async (v) => {
    const lines: string[] = [];
    let caught: unknown;
    try {
      open.push(await (await loadStart())({ PORT: '0', REST_LATENCY_MS: '0', DOWNSTREAM_TIMEOUT_MS: v }, (l) => lines.push(l)));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('DOWNSTREAM_TIMEOUT_MS');
    // rejected up front: nothing listened, so no "listening" URL was logged
    expect(lines.join('\n')).not.toMatch(/https?:\/\//);
  });

  it('DOWNSTREAM_TIMEOUT_MS=2147483647 boots and serves a query', async () => {
    const r = await (await loadStart())({ PORT: '0', REST_LATENCY_MS: '0', DOWNSTREAM_TIMEOUT_MS: '2147483647' }, () => {});
    open.push(r);
    const res = await fetch(r.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: AUTHOR_Q }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GqlResult;
    expect(body.errors).toBeUndefined();
    expect((body.data?.author as { id: string }).id).toBe('a1');
  });
});

// ---------- EB13 ----------
function tableRow(md: string, firstCell: string): string | undefined {
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells[0] === firstCell) return t;
  }
  return undefined;
}

/** The README `GatewayOptions` block: from its heading line to the next `**`...`**` heading. */
function optionsBlock(): string {
  const start = README.indexOf('**`GatewayOptions`**');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = README.indexOf('**`BackendOptions`**', start);
  expect(end).toBeGreaterThan(start);
  return README.slice(start, end);
}

function optionsTableKeys(block: string): string[] {
  const keys: string[] = [];
  for (const line of block.split('\n')) {
    const m = line.trim().match(/^\|\s*`([A-Za-z]+)`\s*\|/);
    if (m) keys.push(m[1]!);
  }
  return keys;
}

describe('EB13 - README Options table', () => {
  it.each(['maxDepth', 'maxComplexity', 'downstreamTimeoutMs'])('%s row: positive integer, else RangeError', (k) => {
    const row = tableRow(optionsBlock(), `\`${k}\``);
    expect(row).toBeDefined();
    expect(row).toMatch(/positive integer/);
    expect(row).toMatch(/else `RangeError`/);
  });

  it('downstreamTimeoutMs row states the 2147483647 maximum', () => {
    expect(tableRow(optionsBlock(), '`downstreamTimeoutMs`')).toContain('2147483647');
  });

  it('restBaseUrl row: absolute http(s) URL, else TypeError', () => {
    const row = tableRow(optionsBlock(), '`restBaseUrl`');
    expect(row).toMatch(/absolute http\(s\) URL/);
    expect(row).toMatch(/else `TypeError`/);
  });

  it('loaderOptions row: else TypeError', () => {
    expect(tableRow(optionsBlock(), '`loaderOptions`')).toMatch(/else `TypeError`/);
  });

  it('a sentence under the table covers unknown keys, did-you-mean, and unlimited-only-by-omission', () => {
    const block = optionsBlock();
    const prose = block
      .split('\n')
      .filter((l) => !l.trim().startsWith('|'))
      .join('\n');
    expect(prose).toMatch(/unknown key[^.]*`?TypeError`?/i);
    expect(prose).toMatch(/did-you-mean/i);
    expect(prose).toMatch(/unlimited only by omission/i);
    expect(prose).toContain('maxDownstreamCalls');
    expect(prose).toMatch(/maxDepth`?\s*10/);
    expect(prose).toMatch(/maxComplexity`?\s*1000/);
  });

  it('the README table lists exactly the nine known keys', () => {
    expect(optionsTableKeys(optionsBlock()).sort()).toEqual([...KNOWN].sort());
  });
});

// ---------- Drift guard (acceptance criterion) ----------
const VALID: Record<string, unknown> = {
  restBaseUrl: 'http://127.0.0.1:4001',
  maxDepth: 10,
  maxComplexity: 1000,
  loaderOptions: BATCHED,
  downstreamTimeoutMs: 30000,
  maxDownstreamCalls: 10,
  forwardHeaders: ['authorization'],
  maxBatchSize: 5,
  onDownstreamCall: () => undefined,
};

describe('Drift guard - README GatewayOptions table vs validator', () => {
  const keys = optionsTableKeys(README.slice(README.indexOf('**`GatewayOptions`**'), README.indexOf('**`BackendOptions`**')));

  it('the table is non-empty and every row has a known valid value', () => {
    expect(keys.length).toBe(9);
    for (const k of keys) expect(VALID).toHaveProperty(k);
  });

  it.each(keys)('%s constructs with a valid value', (k) => {
    expect(() => make({ restBaseUrl: base, [k]: VALID[k] })).not.toThrow();
  });

  it.each(keys)('%s with one character dropped throws as an unknown key', (k) => {
    for (const mutant of [k.slice(1), k.slice(0, -1)]) {
      expectThrow({ restBaseUrl: base, [mutant]: VALID[k] }, TypeError, mutant);
    }
  });
});
