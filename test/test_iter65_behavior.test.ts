import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, buildBackend } from '../src/lib';

/**
 * iter-65: opt-in HTTP request batching (`maxBatchSize` / MAX_BATCH_SIZE).
 * Black-box: the bundled backend runs in-process on port 0 with an onRequest
 * recorder; the gateway is driven through createGateway(...).fetch (and
 * startFromEnv over real HTTP for the env path). "Calls" are the backend
 * /__stats delta across one gateway request, cross-checked against the
 * recorder count.
 *
 * Spec note: the spec's Q3 literal `book(id:"b1")` is not a real bundled id
 * (it yields NOT_FOUND, contradicting EB2's "no element has errors"). The
 * error-free EBs use a real book id discovered over GraphQL (a1's first book);
 * the literal-"b1" spec figures (3+3+2 = 8 separate, 5 batched) are pinned in
 * a dedicated EB3 case.
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
type Recorded = { url: string; headers: Record<string, string | string[] | undefined> };
type Sent = { status: number; body: unknown; calls: number; recorded: Recorded[] };

const Q1 = `{ a: author(id:"a1"){ id books { id reviews { id } } } }`;
const Q2 = `{ b: author(id:"a2"){ id books { id reviews { id } } } }`;
const q3For = (id: string): string => `{ c: book(id:"${id}"){ id author { id } reviews { id } } }`;
const mergedFor = (id: string): string =>
  `{ a: author(id:"a1"){ id books { id reviews { id } } } ` +
  `b: author(id:"a2"){ id books { id reviews { id } } } ` +
  `c: book(id:"${id}"){ id author { id } reviews { id } } }`;
const TOO_COMPLEX = `{ authors(first:100){ edges { node { books { reviews { id } } } } } }`;
const BUDGET_CODE = 'DOWNSTREAM_BUDGET_EXCEEDED';
const NOT_SUPPORTED = 'Batching is not supported.';

let app: FastifyInstance;
let base: string;
const recorded: Recorded[] = [];
/** A real bundled book id (a1's first book), discovered over GraphQL. */
let bookId = '';
let Q3 = '';
let M = '';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function resetStats(b: string): Promise<void> {
  const r = await fetch(`${b}/__stats/reset`, { method: 'POST' });
  expect(r.ok).toBe(true);
}

async function readStats(b: string): Promise<Stats> {
  const r = await fetch(`${b}/__stats`);
  return (await r.json()) as Stats;
}

/** Lets stragglers land, then returns the settled stats. */
async function settled(b: string): Promise<Stats> {
  await sleep(30);
  return readStats(b);
}

/** Sends one raw POST body through the gateway and measures the downstream delta. */
async function send(
  gw: Gateway,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<Sent> {
  await resetStats(base);
  recorded.length = 0;
  const res = await gw.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const stats = await settled(base);
  const rec = [...recorded];
  expect(rec.length).toBe(stats.total);
  return { status: res.status, body, calls: stats.total, recorded: rec };
}

function asArray(body: unknown): GqlResult[] {
  expect(Array.isArray(body)).toBe(true);
  return body as GqlResult[];
}

function codes(r: GqlResult): unknown[] {
  return (r.errors ?? []).map((e) => e.extensions?.code);
}

async function alone(gw: Gateway, query: string): Promise<{ r: GqlResult; calls: number }> {
  const s = await send(gw, { query });
  expect(s.status).toBe(200);
  expect(Array.isArray(s.body)).toBe(false);
  return { r: s.body as GqlResult, calls: s.calls };
}

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  app.addHook('onRequest', (req, _reply, done) => {
    if (!req.url.startsWith('/__')) recorded.push({ url: req.url, headers: { ...req.headers } });
    done();
  });
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  const s = await send(createGateway({ restBaseUrl: base }), {
    query: `{ author(id:"a1"){ books{ id } } }`,
  });
  const books = ((s.body as GqlResult).data as { author: { books: { id: string }[] } }).author.books;
  bookId = books[0]?.id ?? '';
  expect(bookId).not.toBe('');
  Q3 = q3For(bookId);
  M = mergedFor(bookId);
});

afterAll(async () => {
  await app.close();
});

// ---------- EB1 ----------
describe('EB1 - default off', () => {
  it('no maxBatchSize: array POST gets 400 "Batching is not supported." / BAD_REQUEST at 0 calls', async () => {
    const s = await send(createGateway({ restBaseUrl: base }), [{ query: Q1 }, { query: Q2 }]);
    expect(s.status).toBe(400);
    const body = s.body as GqlResult;
    expect(Array.isArray(body)).toBe(false);
    expect(body.errors?.[0]?.message).toBe(NOT_SUPPORTED);
    expect(body.errors?.[0]?.extensions?.code).toBe('BAD_REQUEST');
    expect(s.calls).toBe(0);
  });
});

// ---------- EB2 ----------
describe('EB2 - batched results in request order', () => {
  it('[Q1,Q2,Q3] -> 200, array of 3, each data deep-equals the query alone, no errors', async () => {
    const gw = createGateway({ restBaseUrl: base, maxBatchSize: 10 });
    const solo = [await alone(gw, Q1), await alone(gw, Q2), await alone(gw, Q3)];
    for (const x of solo) expect(x.r.errors).toBeUndefined();
    const s = await send(gw, [{ query: Q1 }, { query: Q2 }, { query: Q3 }]);
    expect(s.status).toBe(200);
    const arr = asArray(s.body);
    expect(arr).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(arr[i]?.errors).toBeUndefined();
      expect(arr[i]?.data).toEqual(solo[i]?.r.data);
    }
    // request order: element keys follow the aliases a, b, c
    expect(Object.keys(arr[0]?.data ?? {})).toEqual(['a']);
    expect(Object.keys(arr[1]?.data ?? {})).toEqual(['b']);
    expect(Object.keys(arr[2]?.data ?? {})).toEqual(['c']);
  });
});

// ---------- EB3 ----------
describe('EB3 - call count: batched === merged < separate sum', () => {
  it('real book id: batched 5 === merged 5 < separate 3+3+3', async () => {
    const gw = createGateway({ restBaseUrl: base, maxBatchSize: 10 });
    const sep = [await alone(gw, Q1), await alone(gw, Q2), await alone(gw, Q3)];
    const sepSum = sep.reduce((n, x) => n + x.calls, 0);
    const merged = await alone(gw, M);
    expect(merged.r.errors).toBeUndefined();
    const batch = await send(gw, [{ query: Q1 }, { query: Q2 }, { query: Q3 }]);
    expect(batch.status).toBe(200);
    expect(batch.calls).toBe(5);
    expect(merged.calls).toBe(5);
    expect(batch.calls).toBe(merged.calls);
    expect(sep.map((x) => x.calls)).toEqual([3, 3, 3]);
    expect(sepSum).toBe(9);
    expect(batch.calls).toBeLessThan(sepSum);
  });

  it('spec literal book(id:"b1"): separate 3+3+2 = 8, batched 5 === merged 5', async () => {
    const gw = createGateway({ restBaseUrl: base, maxBatchSize: 10 });
    const lit3 = q3For('b1');
    const sep = [await alone(gw, Q1), await alone(gw, Q2), await alone(gw, lit3)];
    expect(sep.map((x) => x.calls)).toEqual([3, 3, 2]);
    const merged = await alone(gw, mergedFor('b1'));
    const batch = await send(gw, [{ query: Q1 }, { query: Q2 }, { query: lit3 }]);
    expect(batch.status).toBe(200);
    expect(asArray(batch.body)).toHaveLength(3);
    expect(merged.calls).toBe(5);
    expect(batch.calls).toBe(5);
    expect(sep.reduce((n, x) => n + x.calls, 0)).toBe(8);
  });
});

// ---------- EB4 ----------
describe('EB4 - loader dedup across ops', () => {
  it('[Q1,Q1] makes 3 calls, same as Q1 alone, both data deep-equal', async () => {
    const gw = createGateway({ restBaseUrl: base, maxBatchSize: 10 });
    const one = await alone(gw, Q1);
    expect(one.calls).toBe(3);
    const s = await send(gw, [{ query: Q1 }, { query: Q1 }]);
    expect(s.status).toBe(200);
    const arr = asArray(s.body);
    expect(arr).toHaveLength(2);
    expect(s.calls).toBe(3);
    expect(arr[0]?.data).toEqual(arr[1]?.data);
    expect(arr[0]?.data).toEqual(one.r.data);
  });
});

// ---------- EB5 ----------
describe('EB5 - per-op downstreamCalls extension', () => {
  it('each element has an integer total in [1, delta] and the max equals the delta (5)', async () => {
    const gw = createGateway({ restBaseUrl: base, maxBatchSize: 10 });
    const s = await send(gw, [{ query: Q1 }, { query: Q2 }, { query: Q3 }]);
    const arr = asArray(s.body);
    expect(s.calls).toBe(5);
    const totals = arr.map((r) => r.extensions?.downstreamCalls?.total);
    for (const t of totals) {
      expect(Number.isInteger(t)).toBe(true);
      expect(t as number).toBeGreaterThanOrEqual(1);
      expect(t as number).toBeLessThanOrEqual(s.calls);
    }
    expect(Math.max(...(totals as number[]))).toBe(s.calls);
  });
});

// ---------- EB6 ----------
describe('EB6 - one budget per HTTP request', () => {
  it('maxDownstreamCalls 3: the batch makes <= 3 calls and some element carries the budget error (budget 3)', async () => {
    const gw = createGateway({ restBaseUrl: base, maxBatchSize: 10, maxDownstreamCalls: 3 });
    const s = await send(gw, [{ query: Q1 }, { query: Q2 }, { query: Q3 }]);
    expect(s.status).toBe(200);
    const arr = asArray(s.body);
    expect(arr).toHaveLength(3);
    expect(s.calls).toBeLessThanOrEqual(3);
    const budgetErrs = arr.flatMap((r) => (r.errors ?? []).filter((e) => e.extensions?.code === BUDGET_CODE));
    expect(budgetErrs.length).toBeGreaterThanOrEqual(1);
    for (const e of budgetErrs) expect(e.extensions?.budget).toBe(3);
  });

  it('same options: Q1, Q2, Q3 alone each carry no budget error', async () => {
    const gw = createGateway({ restBaseUrl: base, maxBatchSize: 10, maxDownstreamCalls: 3 });
    for (const q of [Q1, Q2, Q3]) {
      const x = await alone(gw, q);
      expect(codes(x.r)).not.toContain(BUDGET_CODE);
      expect(x.r.errors).toBeUndefined();
      expect(x.calls).toBeLessThanOrEqual(3);
    }
  });
});

// ---------- EB7 ----------
describe('EB7 - batch size limit', () => {
  it('maxBatchSize 2: a 3-op batch is 413 with the limit message at 0 calls', async () => {
    const gw = createGateway({ restBaseUrl: base, maxBatchSize: 2 });
    const s = await send(gw, [{ query: Q1 }, { query: Q2 }, { query: Q3 }]);
    expect(s.status).toBe(413);
    const body = s.body as GqlResult;
    expect(body.errors?.[0]?.message).toBe('Batching is limited to 2 operations per request.');
    expect(s.calls).toBe(0);
  });

  it('maxBatchSize 2: a 2-op batch is 200 with an array of 2', async () => {
    const gw = createGateway({ restBaseUrl: base, maxBatchSize: 2 });
    const s = await send(gw, [{ query: Q1 }, { query: Q2 }]);
    expect(s.status).toBe(200);
    const arr = asArray(s.body);
    expect(arr).toHaveLength(2);
    for (const r of arr) expect(r.errors).toBeUndefined();
  });

  it('maxBatchSize 1: a 1-element array is 200 with an array of 1', async () => {
    const gw = createGateway({ restBaseUrl: base, maxBatchSize: 1 });
    const s = await send(gw, [{ query: Q1 }]);
    expect(s.status).toBe(200);
    const arr = asArray(s.body);
    expect(arr).toHaveLength(1);
    expect(arr[0]?.errors).toBeUndefined();
    expect(s.calls).toBe(3);
  });
});

// ---------- EB8 ----------
describe('EB8 - per-op validation isolation', () => {
  it('valid / unknown-field / too-complex ops keep their own outcome; 3 calls; rejected ops carry no extension', async () => {
    const gw = createGateway({ restBaseUrl: base, maxBatchSize: 10, maxComplexity: 50 });
    const one = await alone(gw, Q1);
    const s = await send(gw, [{ query: Q1 }, { query: '{ nope }' }, { query: TOO_COMPLEX }]);
    expect(s.status).toBe(200);
    const arr = asArray(s.body);
    expect(arr).toHaveLength(3);
    expect(arr[0]?.errors).toBeUndefined();
    expect(arr[0]?.data).toEqual(one.r.data);
    expect(codes(arr[1] as GqlResult)).toContain('GRAPHQL_VALIDATION_FAILED');
    expect(codes(arr[2] as GqlResult)).toContain('QUERY_TOO_COMPLEX');
    expect(s.calls).toBe(3);
    expect(arr[1]?.extensions?.downstreamCalls).toBeUndefined();
    expect(arr[2]?.extensions?.downstreamCalls).toBeUndefined();
    expect(arr[0]?.extensions?.downstreamCalls?.total).toBe(3);
  });
});

// ---------- EB9 ----------
describe('EB9 - non-batched requests unchanged when enabled', () => {
  it('single-object POST returns an object identical to a gateway without maxBatchSize', async () => {
    const on = await alone(createGateway({ restBaseUrl: base, maxBatchSize: 10 }), Q1);
    const off = await alone(createGateway({ restBaseUrl: base }), Q1);
    expect(on.r.data).toEqual(off.r.data);
    expect(on.r.extensions?.downstreamCalls?.total).toBe(3);
    expect(off.r.extensions?.downstreamCalls?.total).toBe(3);
    expect(on.calls).toBe(3);
    expect(on.r.errors).toBeUndefined();
  });

  it('GET /graphql?query=... still works', async () => {
    const gw = createGateway({ restBaseUrl: base, maxBatchSize: 10 });
    await resetStats(base);
    const res = await gw.fetch(`http://gateway.local/graphql?query=${encodeURIComponent(Q1)}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GqlResult;
    expect(Array.isArray(body)).toBe(false);
    expect(body.errors).toBeUndefined();
    expect((body.data as { a: { id: string } }).a.id).toBe('a1');
    expect(body.extensions?.downstreamCalls?.total).toBe(3);
    expect((await settled(base)).total).toBe(3);
  });
});

// ---------- EB10 ----------
describe('EB10 - no cross-request sharing', () => {
  it('two sequential [Q1] batches each make exactly 3 calls', async () => {
    const gw = createGateway({ restBaseUrl: base, maxBatchSize: 10 });
    const a = await send(gw, [{ query: Q1 }]);
    const b = await send(gw, [{ query: Q1 }]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.calls).toBe(3);
    expect(b.calls).toBe(3);
  });

  it('two concurrent batches with different authorization each reach the backend only with their own value', async () => {
    const gw = createGateway({ restBaseUrl: base, maxBatchSize: 10, forwardHeaders: ['authorization'] });
    const TA = 'Bearer user:ua:read';
    const TB = 'Bearer user:ub:read';
    await resetStats(base);
    recorded.length = 0;
    const post = (q: string, token: string): Promise<Response> =>
      gw.fetch('http://gateway.local/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: token },
        body: JSON.stringify([{ query: q }]),
      });
    const [ra, rb] = await Promise.all([post(Q1, TA), post(Q2, TB)]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    const ba = asArray(await ra.json());
    const bb = asArray(await rb.json());
    expect(ba[0]?.errors).toBeUndefined();
    expect(bb[0]?.errors).toBeUndefined();
    const stats = await settled(base);
    const rec = [...recorded];
    expect(rec.length).toBe(stats.total);
    expect(rec).toHaveLength(6);
    const withA = rec.filter((r) => r.headers.authorization === TA);
    const withB = rec.filter((r) => r.headers.authorization === TB);
    expect(withA).toHaveLength(3);
    expect(withB).toHaveLength(3);
    for (const r of withA) expect(decodeURIComponent(r.url)).not.toMatch(/a2/);
    for (const r of withB) expect(decodeURIComponent(r.url)).not.toMatch(/a1/);
  });
});

// ---------- EB11 ----------
describe('EB11 - option validation', () => {
  it.each([
    ['0', 0],
    ['-1', -1],
    ['1.5', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ["'3' (string cast)", '3' as unknown as number],
  ])('maxBatchSize %s throws RangeError', (_l, v) => {
    expect(() => createGateway({ restBaseUrl: base, maxBatchSize: v })).toThrow(RangeError);
  });

  it.each([1, 10])('maxBatchSize %d constructs', (v) => {
    expect(() => createGateway({ restBaseUrl: base, maxBatchSize: v })).not.toThrow();
  });
});

// ---------- EB12 ----------
type Running = { url: string; restBaseUrl: string; close(): Promise<void> };
type StartFromEnv = (
  env: Record<string, string | undefined>,
  log?: (line: string) => void,
) => Promise<Running>;

async function loadStart(): Promise<StartFromEnv> {
  const mod = (await import('../src/cli')) as { startFromEnv: StartFromEnv };
  return mod.startFromEnv;
}

describe('EB12 - MAX_BATCH_SIZE for npm start', () => {
  const open: Running[] = [];
  afterEach(async () => {
    while (open.length) {
      const r = open.pop();
      if (r) await r.close();
    }
  });

  async function start(env: Record<string, string | undefined>): Promise<Running> {
    const r = await (await loadStart())(env, () => {});
    open.push(r);
    return r;
  }

  async function postArray(url: string, n: number): Promise<{ status: number; body: unknown }> {
    const ops = [Q1, Q2, Q3].slice(0, n).map((query) => ({ query }));
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ops),
    });
    return { status: res.status, body: await res.json() };
  }

  it('MAX_BATCH_SIZE=2: a 2-op batch is 200 with an array, a 3-op batch is 413', async () => {
    const r = await start({ PORT: '0', REST_LATENCY_MS: '0', MAX_BATCH_SIZE: '2' });
    const two = await postArray(r.url, 2);
    expect(two.status).toBe(200);
    expect(asArray(two.body)).toHaveLength(2);
    const three = await postArray(r.url, 3);
    expect(three.status).toBe(413);
    expect((three.body as GqlResult).errors?.[0]?.message).toBe(
      'Batching is limited to 2 operations per request.',
    );
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('MAX_BATCH_SIZE %s: a batch POST gets 400 "Batching is not supported."', async (_l, value) => {
    const env: Record<string, string | undefined> = { PORT: '0', REST_LATENCY_MS: '0' };
    if (value !== undefined) env.MAX_BATCH_SIZE = value;
    const r = await start(env);
    const res = await postArray(r.url, 2);
    expect(res.status).toBe(400);
    expect((res.body as GqlResult).errors?.[0]?.message).toBe(NOT_SUPPORTED);
  });

  it.each(['0', 'abc'])('MAX_BATCH_SIZE=%j rejects with a message naming MAX_BATCH_SIZE', async (value) => {
    const startFromEnv = await loadStart();
    let caught: unknown;
    try {
      const r = await startFromEnv({ PORT: '0', REST_LATENCY_MS: '0', MAX_BATCH_SIZE: value }, () => {});
      open.push(r);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('MAX_BATCH_SIZE');
  });
});

// ---------- EB13 ----------
function tableRow(md: string, firstCell: string): string[] | undefined {
  for (const line of md.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    if (cells[0] === firstCell) return cells;
  }
  return undefined;
}

function section(md: string, heading: RegExp): string {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return '';
  const level = (lines[start]?.match(/^#+/)?.[0] ?? '#').length;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i]?.match(/^(#+)\s/);
    if (m && (m[1]?.length ?? 0) <= level) break;
    out.push(lines[i] ?? '');
  }
  return out.join('\n');
}

describe('EB13 - docs', () => {
  it('GatewayOptions table has a maxBatchSize row: type number, default "unset → batching off"', () => {
    const row = tableRow(README, '`maxBatchSize`');
    expect(row).toBeDefined();
    expect(row?.[1]).toBe('`number`');
    expect(row?.[2]).toBe('unset → batching off');
  });

  it('env table has a MAX_BATCH_SIZE row mapping to maxBatchSize', () => {
    const row = tableRow(README, '`MAX_BATCH_SIZE`');
    expect(row).toBeDefined();
    expect(row?.join(' ')).toContain('maxBatchSize');
    expect(row?.join(' ')).toMatch(/unset/);
  });

  it('a "Request batching" paragraph states sharing, per-op limits, the multiplied cost and the extension meaning', () => {
    const para = section(README, /^#+\s+Request batching\s*$/);
    expect(para.length).toBeGreaterThan(0);
    expect(para).toMatch(/loader/i);
    expect(para).toContain('maxDownstreamCalls');
    expect(para).toMatch(/share/i);
    expect(para).toContain('maxDepth');
    expect(para).toContain('maxComplexity');
    expect(para).toMatch(/per operation/i);
    expect(para).toMatch(/maxBatchSize\s*[×x*]\s*maxComplexity/);
    expect(para).toContain('downstreamCalls.total');
  });

  it('the budget paragraph still says concurrent requests never share it, worded per HTTP request', () => {
    const idx = README.indexOf('concurrent requests never share it');
    expect(idx).toBeGreaterThan(-1);
    const sentenceStart = README.lastIndexOf('. ', idx);
    const sentence = README.slice(sentenceStart, idx + 40);
    expect(sentence).toMatch(/budget/i);
    expect(sentence).toMatch(/per (edge )?HTTP request/i);
  });
});
