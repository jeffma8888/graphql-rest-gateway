import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, buildBackend } from '../src/lib';
import { NAIVE } from '../src/gateway/loaders';
import { encodeCursor } from '../src/gateway/pagination/relay';

/**
 * iter-59: per-request downstream call budget (maxDownstreamCalls).
 * Black-box: the bundled backend runs in-process on port 0 and gateways are
 * driven through createGateway(...).fetch or startFromEnv over real HTTP.
 * Every call count is cross-checked against the backend /__stats counter,
 * read after in-flight calls settle (polled, never allowed to exceed).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

type Gateway = ReturnType<typeof createGateway>;
type Stats = { total: number; byRoute: Record<string, number> };
type GqlError = { message: string; extensions?: Record<string, unknown> };
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
  extensions?: {
    downstreamCalls?: { total: number };
    queryComplexity?: { cost: number; depth: number };
  };
};

const NESTED = `{ authors(first: 5) { edges { node { id name books { id title reviews { id rating } } } } } }`;
const LOOKAHEAD = `{ author(id: "a1") { name books { id } } }`;

function ALIASES(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`p${i}: authors(first: 0, after: ${JSON.stringify(encodeCursor(i))}) { totalCount }`);
  }
  return `{ ${parts.join(' ')} }`;
}

const BUDGET_CODE = 'DOWNSTREAM_BUDGET_EXCEEDED';

async function postJson(url: string, query: string): Promise<GqlResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as GqlResult;
}

async function gql(gw: Gateway, query: string): Promise<GqlResult> {
  const res = await gw.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as GqlResult;
}

async function resetStats(b: string): Promise<void> {
  const r = await fetch(`${b}/__stats/reset`, { method: 'POST' });
  expect(r.ok).toBe(true);
}

async function readStats(b: string): Promise<Stats> {
  const r = await fetch(`${b}/__stats`);
  return (await r.json()) as Stats;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Polls the backend for up to 500 ms. The total must never exceed `expected`;
 * returns the final stats once settled (or at the deadline).
 */
async function settledStats(b: string, expected: number): Promise<Stats> {
  const deadline = Date.now() + 500;
  let s = await readStats(b);
  for (;;) {
    expect(s.total).toBeLessThanOrEqual(expected);
    if (s.total === expected || Date.now() >= deadline) break;
    await sleep(20);
    s = await readStats(b);
  }
  // one more read after a short pause: nothing may arrive late past the figure
  await sleep(30);
  s = await readStats(b);
  expect(s.total).toBeLessThanOrEqual(expected);
  return s;
}

function codes(body: GqlResult): unknown[] {
  return (body.errors ?? []).map((e) => e.extensions?.code);
}

function budgetErrors(body: GqlResult): GqlError[] {
  return (body.errors ?? []).filter((e) => e.extensions?.code === BUDGET_CODE);
}

let app: FastifyInstance;
let base: string;
let unlimited: Gateway;

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  unlimited = createGateway({ restBaseUrl: base });
});

afterAll(async () => {
  await app.close();
});

describe('EB1 - default is unlimited (HEAD-equal)', () => {
  it('ALIASES(100) succeeds with 100 calls (extension and backend)', async () => {
    await resetStats(base);
    const body = await gql(unlimited, ALIASES(100));
    expect(body.errors).toBeUndefined();
    expect(body.extensions?.downstreamCalls?.total).toBe(100);
    const s = await settledStats(base, 100);
    expect(s.total).toBe(100);
    expect(s.byRoute['/authors']).toBe(100);
  });

  it('NESTED succeeds with 3 calls, one per route', async () => {
    await resetStats(base);
    const body = await gql(unlimited, NESTED);
    expect(body.errors).toBeUndefined();
    expect(body.extensions?.downstreamCalls?.total).toBe(3);
    const s = await settledStats(base, 3);
    expect(s.total).toBe(3);
    expect(s.byRoute).toEqual({ '/authors': 1, '/books/by-author': 1, '/reviews/by-book': 1 });
  });
});

describe('EB2/EB3/EB6 - budget 50 stops ALIASES(100)', () => {
  let body: GqlResult;
  let stats: Stats;

  beforeAll(async () => {
    const gw = createGateway({ restBaseUrl: base, maxDownstreamCalls: 50 });
    await resetStats(base);
    body = await gql(gw, ALIASES(100)); // asserts HTTP 200
    stats = await settledStats(base, 50);
  });

  it('EB2: data is null and every error is DOWNSTREAM_BUDGET_EXCEEDED', () => {
    expect(body.data).toBeNull();
    expect(body.errors?.length ?? 0).toBeGreaterThan(0);
    for (const c of codes(body)) expect(c).toBe(BUDGET_CODE);
  });

  it('EB2/EB6: extension total is exactly 50 and backend total is exactly 50 on /authors', () => {
    expect(body.extensions?.downstreamCalls?.total).toBe(50);
    expect(stats.total).toBe(50);
    expect(stats.byRoute['/authors']).toBe(50);
  });

  it('EB3: each budget error carries budget 50 and a message naming 50 and "budget"', () => {
    const errs = budgetErrors(body);
    expect(errs.length).toBeGreaterThan(0);
    for (const e of errs) {
      expect(e.extensions?.budget).toBe(50);
      expect(e.message).toContain('50');
      expect(e.message.toLowerCase()).toContain('budget');
    }
  });

  it('EB3: queryComplexity is still reported with cost 100', () => {
    expect(body.extensions?.queryComplexity?.cost).toBe(100);
  });
});

describe('EB4 - budget equal to the need is allowed', () => {
  it('budget 3: NESTED succeeds with identical data and total 3', async () => {
    const ref = await gql(unlimited, NESTED);
    const gw = createGateway({ restBaseUrl: base, maxDownstreamCalls: 3 });
    await resetStats(base);
    const body = await gql(gw, NESTED);
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual(ref.data);
    expect(body.extensions?.downstreamCalls?.total).toBe(3);
    const s = await settledStats(base, 3);
    expect(s.total).toBe(3);
  });
});

describe('EB5/EB6 - one short is refused before the call', () => {
  it('budget 2: NESTED errors, 2 calls sent, /reviews/by-book never reached', async () => {
    const gw = createGateway({ restBaseUrl: base, maxDownstreamCalls: 2 });
    await resetStats(base);
    const body = await gql(gw, NESTED);
    expect(codes(body)).toContain(BUDGET_CODE);
    expect(body.extensions?.downstreamCalls?.total).toBe(2);
    const s = await settledStats(base, 2);
    expect(s.total).toBe(2);
    expect(s.byRoute['/reviews/by-book'] ?? 0).toBe(0);
    expect(s.byRoute['/authors']).toBe(1);
    expect(s.byRoute['/books/by-author']).toBe(1);
  });
});

describe('EB6 - refused calls are never counted (at most the budget)', () => {
  it.each([1, 7, 25, 99])('budget %i on ALIASES(100): extension total == backend total == budget', async (n) => {
    const gw = createGateway({ restBaseUrl: base, maxDownstreamCalls: n });
    await resetStats(base);
    const body = await gql(gw, ALIASES(100));
    expect(codes(body)).toContain(BUDGET_CODE);
    expect(body.extensions?.downstreamCalls?.total).toBeLessThanOrEqual(n);
    expect(body.extensions?.downstreamCalls?.total).toBe(n);
    const s = await settledStats(base, n);
    expect(s.total).toBe(n);
  });

  it('budget 100 on ALIASES(100) is exactly enough: no errors, total 100', async () => {
    const gw = createGateway({ restBaseUrl: base, maxDownstreamCalls: 100 });
    await resetStats(base);
    const body = await gql(gw, ALIASES(100));
    expect(body.errors).toBeUndefined();
    expect(body.extensions?.downstreamCalls?.total).toBe(100);
    expect((await settledStats(base, 100)).total).toBe(100);
  });
});

describe('EB7 - the cap also holds with NAIVE loaders', () => {
  it('NAIVE unlimited NESTED makes 21 calls (baseline)', async () => {
    const gw = createGateway({ restBaseUrl: base, loaderOptions: NAIVE });
    await resetStats(base);
    const body = await gql(gw, NESTED);
    expect(body.errors).toBeUndefined();
    expect(body.extensions?.downstreamCalls?.total).toBe(21);
    expect((await settledStats(base, 21)).total).toBe(21);
  });

  it('NAIVE + budget 10: DOWNSTREAM_BUDGET_EXCEEDED with 10 calls (extension and backend)', async () => {
    const gw = createGateway({ restBaseUrl: base, loaderOptions: NAIVE, maxDownstreamCalls: 10 });
    await resetStats(base);
    const body = await gql(gw, NESTED);
    expect(codes(body)).toContain(BUDGET_CODE);
    expect(body.extensions?.downstreamCalls?.total).toBe(10);
    const s = await settledStats(base, 10);
    expect(s.total).toBe(10);
  });
});

describe('EB8 - the budget is per request, not per gateway', () => {
  it('two sequential NESTED requests on a budget-3 gateway each succeed with total 3', async () => {
    const gw = createGateway({ restBaseUrl: base, maxDownstreamCalls: 3 });
    for (let i = 0; i < 2; i++) {
      await resetStats(base);
      const body = await gql(gw, NESTED);
      expect(body.errors).toBeUndefined();
      expect(body.extensions?.downstreamCalls?.total).toBe(3);
      expect((await settledStats(base, 3)).total).toBe(3);
    }
  });

  it('two concurrent NESTED requests each succeed with total 3; backend total is 6', async () => {
    const gw = createGateway({ restBaseUrl: base, maxDownstreamCalls: 3 });
    await resetStats(base);
    const [a, b] = await Promise.all([gql(gw, NESTED), gql(gw, NESTED)]);
    expect(a.errors).toBeUndefined();
    expect(b.errors).toBeUndefined();
    expect(a.extensions?.downstreamCalls?.total).toBe(3);
    expect(b.extensions?.downstreamCalls?.total).toBe(3);
    const s = await settledStats(base, 6);
    expect(s.total).toBe(6);
  });

  it('a third request after a refused one still gets a fresh budget', async () => {
    const gw = createGateway({ restBaseUrl: base, maxDownstreamCalls: 3 });
    await resetStats(base);
    const refused = await gql(gw, ALIASES(10));
    expect(codes(refused)).toContain(BUDGET_CODE);
    expect(refused.extensions?.downstreamCalls?.total).toBe(3);
    await settledStats(base, 3);
    await resetStats(base);
    const ok = await gql(gw, NESTED);
    expect(ok.errors).toBeUndefined();
    expect(ok.extensions?.downstreamCalls?.total).toBe(3);
    expect((await settledStats(base, 3)).total).toBe(3);
  });
});

describe('EB9 - lookahead prefetch counts against the budget', () => {
  it('unlimited baseline makes 2 calls', async () => {
    await resetStats(base);
    const body = await gql(unlimited, LOOKAHEAD);
    expect(body.errors).toBeUndefined();
    expect(body.extensions?.downstreamCalls?.total).toBe(2);
    expect((await settledStats(base, 2)).total).toBe(2);
  });

  it('budget 2 succeeds with total 2', async () => {
    const gw = createGateway({ restBaseUrl: base, maxDownstreamCalls: 2 });
    await resetStats(base);
    const body = await gql(gw, LOOKAHEAD);
    expect(body.errors).toBeUndefined();
    expect(body.extensions?.downstreamCalls?.total).toBe(2);
    expect((await settledStats(base, 2)).total).toBe(2);
  });

  it('budget 1 gives DOWNSTREAM_BUDGET_EXCEEDED with total 1 (extension and backend)', async () => {
    const gw = createGateway({ restBaseUrl: base, maxDownstreamCalls: 1 });
    await resetStats(base);
    const body = await gql(gw, LOOKAHEAD);
    expect(codes(body)).toContain(BUDGET_CODE);
    expect(body.extensions?.downstreamCalls?.total).toBe(1);
    expect((await settledStats(base, 1)).total).toBe(1);
  });
});

describe('EB10 - invalid library values fail fast', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'maxDownstreamCalls=%s throws a RangeError naming the option',
    (v) => {
      let caught: unknown;
      try {
        createGateway({ restBaseUrl: base, maxDownstreamCalls: v });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RangeError);
      expect((caught as Error).message).toContain('maxDownstreamCalls');
    },
  );

  it('maxDownstreamCalls=1 does not throw', () => {
    expect(() => createGateway({ restBaseUrl: base, maxDownstreamCalls: 1 })).not.toThrow();
  });
});

// ---------- EB11: npm start env var ----------

type Running = {
  url: string;
  restBaseUrl: string;
  backend: 'bundled' | 'external';
  close(): Promise<void>;
};
type StartFromEnv = (
  env: Record<string, string | undefined>,
  log?: (line: string) => void,
) => Promise<Running>;

async function loadStart(): Promise<StartFromEnv> {
  const mod = (await import('../src/cli')) as { startFromEnv: StartFromEnv };
  return mod.startFromEnv;
}

const open: Running[] = [];

async function start(env: Record<string, string | undefined>): Promise<Running> {
  const startFromEnv = await loadStart();
  const r = await startFromEnv(env, () => {});
  open.push(r);
  return r;
}

async function closeTracked(r: Running): Promise<void> {
  const i = open.indexOf(r);
  if (i >= 0) open.splice(i, 1);
  await r.close();
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

describe('EB11 - MAX_DOWNSTREAM_CALLS env var for npm start', () => {
  afterEach(async () => {
    while (open.length) {
      const r = open.pop();
      if (r) await r.close();
    }
  });

  it("MAX_DOWNSTREAM_CALLS='2': NESTED carries DOWNSTREAM_BUDGET_EXCEEDED with total 2", async () => {
    const r = await start({ PORT: '0', REST_LATENCY_MS: '0', MAX_DOWNSTREAM_CALLS: '2' });
    expect(r.backend).toBe('bundled');
    await resetStats(r.restBaseUrl);
    const body = await postJson(r.url, NESTED);
    expect(codes(body)).toContain(BUDGET_CODE);
    expect(budgetErrors(body)[0]?.extensions?.budget).toBe(2);
    expect(body.extensions?.downstreamCalls?.total).toBe(2);
    expect((await settledStats(r.restBaseUrl, 2)).total).toBe(2);
  });

  it.each([
    ['empty', ''],
    ['unset', undefined],
  ])('MAX_DOWNSTREAM_CALLS %s: NESTED succeeds with total 3', async (_label, value) => {
    const env: Record<string, string | undefined> = { PORT: '0', REST_LATENCY_MS: '0' };
    if (value !== undefined) env.MAX_DOWNSTREAM_CALLS = value;
    const r = await start(env);
    await resetStats(r.restBaseUrl);
    const body = await postJson(r.url, NESTED);
    expect(body.errors).toBeUndefined();
    expect(body.extensions?.downstreamCalls?.total).toBe(3);
    expect((await settledStats(r.restBaseUrl, 3)).total).toBe(3);
  });

  it.each(['0', 'abc', '1.5'])(
    "MAX_DOWNSTREAM_CALLS=%j rejects naming the variable and leaves nothing listening",
    async (value) => {
      // learn a free port, then reject on it, then start on that same port
      const probe = await start({ PORT: '0', REST_LATENCY_MS: '0' });
      const port = portOf(probe.url);
      await closeTracked(probe);

      const startFromEnv = await loadStart();
      const lines: string[] = [];
      let caught: unknown;
      try {
        const r = await startFromEnv(
          { PORT: String(port), REST_LATENCY_MS: '0', MAX_DOWNSTREAM_CALLS: value },
          (l) => lines.push(l),
        );
        open.push(r);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain('MAX_DOWNSTREAM_CALLS');
      expect(lines).toEqual([]);

      const again = await start({ PORT: String(port), REST_LATENCY_MS: '0' });
      expect(portOf(again.url)).toBe(port);
    },
  );
});

// ---------- EB12: documentation ----------

describe('EB12 - README documents the budget', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  const lines = readme.split('\n');

  it('(a) GatewayOptions table has a maxDownstreamCalls row: number, unlimited', () => {
    const row = lines.find((l) => l.startsWith('|') && l.includes('`maxDownstreamCalls`') && !l.includes('MAX_DOWNSTREAM_CALLS'));
    expect(row).toBeDefined();
    const cells = (row ?? '').split('|').map((c) => c.trim());
    expect(cells[1]).toBe('`maxDownstreamCalls`');
    expect(cells[2]).toContain('number');
    expect((cells[3] ?? '').toLowerCase()).toContain('unlimited');
  });

  it('(b) npm start env table has a MAX_DOWNSTREAM_CALLS row', () => {
    const row = lines.find((l) => l.startsWith('|') && l.includes('`MAX_DOWNSTREAM_CALLS`'));
    expect(row).toBeDefined();
    expect(row).toContain('maxDownstreamCalls');
  });

  function section(heading: string): string {
    const start = lines.findIndex((l) => l.trim() === heading);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^#{1,3} /.test(l));
    return (end < 0 ? rest : rest.slice(0, end)).join('\n');
  }

  it('(c) section 7 has a "Downstream call budget" subsection with code, budget, and the 100/100 vs 351/3 figures', () => {
    const s7 = readme.indexOf('## 7.');
    const s8 = readme.indexOf('## 8.');
    const sub = readme.indexOf('### Downstream call budget');
    expect(s7).toBeGreaterThan(0);
    expect(sub).toBeGreaterThan(s7);
    expect(sub).toBeLessThan(s8);
    const body = section('### Downstream call budget');
    expect(body).toContain('DOWNSTREAM_BUDGET_EXCEEDED');
    expect(body).toContain('extensions.budget');
    expect(body).toContain('maxComplexity');
    expect(body).toMatch(/\b100\b[\s\S]*\b100\b/);
    expect(body).toMatch(/\b351\b/);
    expect(body).toMatch(/\b3\b/);
  });

  it('(d) "Downstream call metrics" says calls refused by the budget are not counted', () => {
    const body = section('### Downstream call metrics');
    expect(body.toLowerCase()).toMatch(/refused[^.]*budget[^.]*not counted|budget[^.]*refused[^.]*not counted/);
  });

  it('badge count equals the section 8 count and is at least the pre-iter-59 figure', () => {
    const badge = readme.match(/tests-(\d+)%20passing/);
    const s8 = readme.match(/(\d+) tests across (\d+) files/);
    expect(badge).not.toBeNull();
    expect(s8).not.toBeNull();
    expect(Number(badge?.[1])).toBe(Number(s8?.[1]));
    expect(Number(badge?.[1])).toBeGreaterThanOrEqual(397);
  });
});
