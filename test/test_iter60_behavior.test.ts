import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, buildBackend } from '../src/lib';
import { NAIVE } from '../src/gateway/loaders';

/**
 * iter-60: opt-in forwardHeaders allowlist (library option + FORWARD_HEADERS).
 * Black-box: the bundled backend runs in-process on port 0 with an extra
 * onRequest hook that records the headers of every data route call. Every
 * downstream figure is triangulated three ways: the recorded request count,
 * extensions.downstreamCalls.total and the backend /__stats counter.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

type Gateway = ReturnType<typeof createGateway>;
type Stats = { total: number; byRoute: Record<string, number> };
type GqlError = { message: string; extensions?: Record<string, unknown> };
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
  extensions?: { downstreamCalls?: { total: number } };
};
type Recorded = { url: string; headers: Record<string, string | string[] | undefined> };
type AuthorsData = {
  authors: { edges: { node: { id: string; books: { id: string; reviews: { id: string }[] }[] } }[] };
};

const NESTED = `{ authors(first:5){ edges{ node{ id books{ id reviews{ id rating } } } } } }`;
const LOOKAHEAD = `{ author(id:"a1"){ id books{ id } } }`;
const BUDGET_CODE = 'DOWNSTREAM_BUDGET_EXCEEDED';
const TOKEN = 'Bearer user:u1:pii';

let app: FastifyInstance;
let base: string;
const recorded: Recorded[] = [];
/** A real bundled book id, discovered over HTTP (EB7 spec literal "b1" is not a real id). */
let bookId = '';

function attachRecorder(a: FastifyInstance, sink: Recorded[]): void {
  a.addHook('onRequest', (req, _reply, done) => {
    if (!req.url.startsWith('/__')) sink.push({ url: req.url, headers: { ...req.headers } });
    done();
  });
}

async function gql(
  gw: Gateway,
  query: string,
  headers: Record<string, string> = {},
): Promise<GqlResult> {
  const res = await gw.fetch('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as GqlResult;
}

async function postJson(
  url: string,
  query: string,
  headers: Record<string, string> = {},
): Promise<GqlResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
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

/** Waits briefly for stragglers, then returns the stats; never allowed to exceed `expected`. */
async function settledStats(b: string, expected: number): Promise<Stats> {
  const deadline = Date.now() + 400;
  let s = await readStats(b);
  while (s.total < expected && Date.now() < deadline) {
    await sleep(20);
    s = await readStats(b);
  }
  await sleep(30);
  s = await readStats(b);
  expect(s.total).toBeLessThanOrEqual(expected);
  return s;
}

function expectNestedCorrect(body: GqlResult): void {
  expect(body.errors).toBeUndefined();
  const data = body.data as unknown as AuthorsData;
  expect(data.authors.edges).toHaveLength(5);
  for (const e of data.authors.edges) {
    expect(e.node.books).toHaveLength(3);
    for (const b of e.node.books) expect(b.reviews).toHaveLength(2);
  }
}

function hasHeader(r: Recorded, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(r.headers, name);
}

async function measure(
  gw: Gateway,
  query: string,
  headers: Record<string, string>,
): Promise<{ body: GqlResult; reqs: Recorded[]; stats: Stats }> {
  recorded.length = 0;
  await resetStats(base);
  const body = await gql(gw, query, headers);
  const total = body.extensions?.downstreamCalls?.total ?? -1;
  const stats = await settledStats(base, total);
  return { body, reqs: [...recorded], stats };
}

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  attachRecorder(app, recorded);
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  const body = await gql(createGateway({ restBaseUrl: base }), `{ author(id:"a1"){ books{ id } } }`);
  const books = (body.data as { author: { books: { id: string }[] } }).author.books;
  bookId = books[0]?.id ?? '';
  expect(bookId).not.toBe('');
});

afterAll(async () => {
  await app.close();
});

// ---------- EB1 ----------
describe('EB1 - default is unchanged (nothing forwarded)', () => {
  it.each([
    ['omitted', undefined],
    ['empty array', [] as string[]],
  ])('forwardHeaders %s: no authorization / x-request-id downstream, total 3', async (_l, fh) => {
    const gw = createGateway(fh === undefined ? { restBaseUrl: base } : { restBaseUrl: base, forwardHeaders: fh });
    const { body, reqs, stats } = await measure(gw, NESTED, {
      authorization: TOKEN,
      'x-request-id': 'req-1',
    });
    expectNestedCorrect(body);
    expect(body.extensions?.downstreamCalls?.total).toBe(3);
    expect(stats.total).toBe(3);
    expect(reqs).toHaveLength(3);
    for (const r of reqs) {
      expect(hasHeader(r, 'authorization')).toBe(false);
      expect(hasHeader(r, 'x-request-id')).toBe(false);
    }
  });
});

// ---------- EB2 ----------
describe('EB2 - allowlisted headers ride on every downstream call', () => {
  it('authorization + x-request-id on all 3 calls (recorded = extensions = /__stats)', async () => {
    const gw = createGateway({ restBaseUrl: base, forwardHeaders: ['authorization', 'x-request-id'] });
    const { body, reqs, stats } = await measure(gw, NESTED, {
      authorization: TOKEN,
      'x-request-id': 'req-1',
    });
    expectNestedCorrect(body);
    expect(body.extensions?.downstreamCalls?.total).toBe(3);
    expect(stats.total).toBe(3);
    expect(reqs).toHaveLength(3);
    for (const r of reqs) {
      expect(r.headers.authorization).toBe(TOKEN);
      expect(r.headers['x-request-id']).toBe('req-1');
    }
  });
});

// ---------- EB3 ----------
describe('EB3 - allowlist matching is case-insensitive', () => {
  it.each([
    ['lowercase edge headers', { authorization: TOKEN, 'x-request-id': 'req-1' }],
    ['uppercase edge headers', { AUTHORIZATION: TOKEN, 'X-REQUEST-ID': 'req-1' }],
  ])("forwardHeaders ['Authorization','X-Request-Id'] with %s", async (_l, edge) => {
    const gw = createGateway({ restBaseUrl: base, forwardHeaders: ['Authorization', 'X-Request-Id'] });
    const { body, reqs, stats } = await measure(gw, NESTED, edge);
    expectNestedCorrect(body);
    expect(body.extensions?.downstreamCalls?.total).toBe(3);
    expect(stats.total).toBe(3);
    expect(reqs).toHaveLength(3);
    for (const r of reqs) {
      expect(r.headers.authorization).toBe(TOKEN);
      expect(r.headers['x-request-id']).toBe('req-1');
    }
  });

  it("lowercase allowlist + uppercase edge header 'AUTHORIZATION' still forwards", async () => {
    const gw = createGateway({ restBaseUrl: base, forwardHeaders: ['authorization'] });
    const { reqs } = await measure(gw, NESTED, { AUTHORIZATION: TOKEN });
    expect(reqs).toHaveLength(3);
    for (const r of reqs) expect(r.headers.authorization).toBe(TOKEN);
  });
});

// ---------- EB4 ----------
describe('EB4 - only allowlisted headers leave the gateway', () => {
  it("forwardHeaders ['authorization']: cookie, x-request-id, x-secret never sent", async () => {
    const gw = createGateway({ restBaseUrl: base, forwardHeaders: ['authorization'] });
    const { body, reqs, stats } = await measure(gw, NESTED, {
      authorization: TOKEN,
      cookie: 's=1',
      'x-request-id': 'req-1',
      'x-secret': 'z',
    });
    expectNestedCorrect(body);
    expect(stats.total).toBe(3);
    expect(reqs).toHaveLength(3);
    for (const r of reqs) {
      expect(r.headers.authorization).toBe(TOKEN);
      expect(hasHeader(r, 'cookie')).toBe(false);
      expect(hasHeader(r, 'x-request-id')).toBe(false);
      expect(hasHeader(r, 'x-secret')).toBe(false);
    }
  });
});

// ---------- EB5 ----------
describe('EB5 - an absent edge header is not sent (not even empty)', () => {
  it('only x-request-id sent: downstream has x-request-id, no authorization key at all', async () => {
    const gw = createGateway({ restBaseUrl: base, forwardHeaders: ['authorization', 'x-request-id'] });
    const { body, reqs, stats } = await measure(gw, NESTED, { 'x-request-id': 'req-2' });
    expectNestedCorrect(body);
    expect(stats.total).toBe(3);
    expect(reqs).toHaveLength(3);
    for (const r of reqs) {
      expect(r.headers['x-request-id']).toBe('req-2');
      expect(hasHeader(r, 'authorization')).toBe(false);
    }
  });
});

// ---------- EB6 ----------
describe('EB6 - per request, no bleed between concurrent callers', () => {
  it('two concurrent requests: 3 downstream calls carry only u1, 3 carry only u2', async () => {
    const gw = createGateway({ restBaseUrl: base, forwardHeaders: ['authorization'] });
    recorded.length = 0;
    await resetStats(base);
    const [a, b] = await Promise.all([
      gql(gw, NESTED, { authorization: 'Bearer user:u1:' }),
      gql(gw, NESTED, { authorization: 'Bearer user:u2:' }),
    ]);
    expectNestedCorrect(a);
    expectNestedCorrect(b);
    expect(a.extensions?.downstreamCalls?.total).toBe(3);
    expect(b.extensions?.downstreamCalls?.total).toBe(3);
    expect((await settledStats(base, 6)).total).toBe(6);
    expect(recorded).toHaveLength(6);
    const auths = recorded.map((r) => r.headers.authorization);
    expect(auths.filter((x) => x === 'Bearer user:u1:')).toHaveLength(3);
    expect(auths.filter((x) => x === 'Bearer user:u2:')).toHaveLength(3);
  });

  it('a later request without the header does not inherit the previous caller token', async () => {
    const gw = createGateway({ restBaseUrl: base, forwardHeaders: ['authorization'] });
    await measure(gw, NESTED, { authorization: 'Bearer user:u1:' });
    const { reqs } = await measure(gw, NESTED, {});
    expect(reqs).toHaveLength(3);
    for (const r of reqs) expect(hasHeader(r, 'authorization')).toBe(false);
  });
});

// ---------- EB7 ----------
describe('EB7 - every downstream path carries the header', () => {
  const opts = (): Parameters<typeof createGateway>[0] => ({
    restBaseUrl: base,
    forwardHeaders: ['x-request-id'],
  });

  it('lookahead prefetch author(id){books}: exactly 2 calls, both carry x-request-id', async () => {
    const { body, reqs, stats } = await measure(createGateway(opts()), LOOKAHEAD, {
      'x-request-id': 'req-7a',
    });
    expect(body.errors).toBeUndefined();
    expect(body.extensions?.downstreamCalls?.total).toBe(2);
    expect(stats.total).toBe(2);
    expect(reqs).toHaveLength(2);
    for (const r of reqs) expect(r.headers['x-request-id']).toBe('req-7a');
  });

  it('book(id){reviews}: exactly 2 calls, both carry x-request-id', async () => {
    const q = `{ book(id:${JSON.stringify(bookId)}){ id reviews{ id } } }`;
    const { body, reqs, stats } = await measure(createGateway(opts()), q, { 'x-request-id': 'req-7b' });
    expect(body.errors).toBeUndefined();
    expect((body.data as { book: { id: string } | null }).book?.id).toBe(bookId);
    expect(body.extensions?.downstreamCalls?.total).toBe(2);
    expect(stats.total).toBe(2);
    expect(reqs).toHaveLength(2);
    for (const r of reqs) expect(r.headers['x-request-id']).toBe('req-7b');
  });

  it('NESTED under NAIVE loaders: HEAD call count (21, per the N+1 test), all carry x-request-id', async () => {
    const gw = createGateway({ ...opts(), loaderOptions: NAIVE });
    const { body, reqs, stats } = await measure(gw, NESTED, { 'x-request-id': 'req-7c' });
    expectNestedCorrect(body);
    // 1 authors + 5 books (per author) + 15 reviews (per book), unbatched.
    expect(body.extensions?.downstreamCalls?.total).toBe(21);
    expect(stats.total).toBe(21);
    expect(reqs).toHaveLength(21);
    for (const r of reqs) expect(r.headers['x-request-id']).toBe('req-7c');
  });
});

// ---------- EB8 ----------
describe('EB8 - composes with the call budget', () => {
  it('maxDownstreamCalls 1: exactly 1 recorded call carrying authorization + budget error', async () => {
    const gw = createGateway({ restBaseUrl: base, forwardHeaders: ['authorization'], maxDownstreamCalls: 1 });
    const { body, reqs, stats } = await measure(gw, NESTED, { authorization: TOKEN });
    const codes = (body.errors ?? []).map((e) => e.extensions?.code);
    expect(codes).toContain(BUDGET_CODE);
    expect(body.extensions?.downstreamCalls?.total).toBe(1);
    expect(stats.total).toBe(1);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.headers.authorization).toBe(TOKEN);
  });
});

// ---------- EB9 ----------
describe('EB9 - invalid allowlist fails fast in createGateway', () => {
  const HOP = [
    'host',
    'connection',
    'content-length',
    'transfer-encoding',
    'keep-alive',
    'upgrade',
    'te',
    'trailer',
    'proxy-connection',
  ];

  function thrownBy(fh: string[]): unknown {
    try {
      createGateway({ restBaseUrl: base, forwardHeaders: fh });
    } catch (e) {
      return e;
    }
    return undefined;
  }

  it("'' throws an Error naming forwardHeaders", () => {
    const e = thrownBy(['']);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toContain('forwardHeaders');
  });

  it("'bad header' (not an HTTP token) throws naming forwardHeaders and the entry", () => {
    const e = thrownBy(['authorization', 'bad header']);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toContain('forwardHeaders');
    expect((e as Error).message).toContain('bad header');
  });

  it.each(HOP)('hop-by-hop %s throws naming forwardHeaders and the entry', (name) => {
    const e = thrownBy([name]);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toContain('forwardHeaders');
    expect((e as Error).message).toContain(name);
  });

  it.each(HOP.map((h) => h.toUpperCase()))('hop-by-hop %s (upper case) also throws', (name) => {
    const e = thrownBy(['x-request-id', name]);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toContain('forwardHeaders');
    expect((e as Error).message.toLowerCase()).toContain(name.toLowerCase());
  });

  it("mixed-case 'Content-Length' throws", () => {
    expect(thrownBy(['Content-Length'])).toBeInstanceOf(Error);
  });

  it('valid names authorization, x-request-id, X-Tenant do not throw and the gateway serves', async () => {
    expect(thrownBy(['authorization', 'x-request-id', 'X-Tenant'])).toBeUndefined();
    const gw = createGateway({ restBaseUrl: base, forwardHeaders: ['X-Tenant'] });
    const { body, reqs } = await measure(gw, NESTED, { 'x-tenant': 't-9' });
    expectNestedCorrect(body);
    expect(reqs).toHaveLength(3);
    for (const r of reqs) expect(r.headers['x-tenant']).toBe('t-9');
  });
});

// ---------- EB10 / EB11: npm start ----------
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

describe('EB10 - FORWARD_HEADERS env var for npm start', () => {
  let userApp: FastifyInstance;
  let userBase: string;
  const userRecorded: Recorded[] = [];

  beforeAll(async () => {
    userApp = buildBackend({ latencyMs: 0 }).app;
    attachRecorder(userApp, userRecorded);
    userBase = await userApp.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await userApp.close();
  });

  beforeEach(() => {
    userRecorded.length = 0;
  });

  afterEach(async () => {
    while (open.length) {
      const r = open.pop();
      if (r) await r.close();
    }
  });

  it("FORWARD_HEADERS=' authorization , x-request-id ,': 3 calls, each carries both headers", async () => {
    const r = await start({
      PORT: '0',
      REST_BASE_URL: userBase,
      FORWARD_HEADERS: ' authorization , x-request-id ,',
    });
    expect(r.backend).toBe('external');
    await resetStats(userBase);
    userRecorded.length = 0;
    const body = await postJson(r.url, NESTED, { authorization: TOKEN, 'x-request-id': 'req-10' });
    expectNestedCorrect(body);
    expect(body.extensions?.downstreamCalls?.total).toBe(3);
    expect((await settledStats(userBase, 3)).total).toBe(3);
    expect(userRecorded).toHaveLength(3);
    for (const rec of userRecorded) {
      expect(rec.headers.authorization).toBe(TOKEN);
      expect(rec.headers['x-request-id']).toBe('req-10');
    }
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('FORWARD_HEADERS %s: 3 calls, neither header forwarded', async (_l, value) => {
    const env: Record<string, string | undefined> = { PORT: '0', REST_BASE_URL: userBase };
    if (value !== undefined) env.FORWARD_HEADERS = value;
    const r = await start(env);
    await resetStats(userBase);
    userRecorded.length = 0;
    const body = await postJson(r.url, NESTED, { authorization: TOKEN, 'x-request-id': 'req-10' });
    expectNestedCorrect(body);
    expect(body.extensions?.downstreamCalls?.total).toBe(3);
    expect((await settledStats(userBase, 3)).total).toBe(3);
    expect(userRecorded).toHaveLength(3);
    for (const rec of userRecorded) {
      expect(hasHeader(rec, 'authorization')).toBe(false);
      expect(hasHeader(rec, 'x-request-id')).toBe(false);
    }
  });
});

describe('EB11 - FORWARD_HEADERS is validated before anything listens', () => {
  afterEach(async () => {
    while (open.length) {
      const r = open.pop();
      if (r) await r.close();
    }
  });

  it.each(['host', 'bad header', 'authorization,Connection'])(
    'FORWARD_HEADERS=%j rejects naming the variable and the entry, leaves nothing listening',
    async (value) => {
      // learn a free port, reject on it, then start successfully on that same port
      const probe = await start({ PORT: '0', REST_LATENCY_MS: '0' });
      const port = portOf(probe.url);
      await closeTracked(probe);

      const startFromEnv = await loadStart();
      const lines: string[] = [];
      let caught: unknown;
      const attempt = startFromEnv(
        { PORT: String(port), REST_LATENCY_MS: '0', FORWARD_HEADERS: value },
        (l) => lines.push(l),
      ).then(
        (r) => {
          open.push(r);
          return 'resolved' as const;
        },
        (e: unknown) => {
          caught = e;
          return 'rejected' as const;
        },
      );
      const outcome = await Promise.race([attempt, sleep(2000).then(() => 'hung' as const)]);
      expect(outcome).toBe('rejected');
      expect(caught).toBeInstanceOf(Error);
      const msg = (caught as Error).message;
      expect(msg).toContain('FORWARD_HEADERS');
      const entry = value.includes(',') ? 'connection' : value;
      expect(msg.toLowerCase()).toContain(entry.toLowerCase());
      expect(lines).toEqual([]);

      const again = await start({ PORT: String(port), REST_LATENCY_MS: '0' });
      expect(portOf(again.url)).toBe(port);
    },
  );
});

// ---------- EB12: documentation ----------
describe('EB12 - README documents forwardHeaders / FORWARD_HEADERS', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

  it('GatewayOptions table lists forwardHeaders and has exactly 7 data rows', () => {
    const start = readme.indexOf('**`GatewayOptions`**');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = readme.slice(start);
    const lines = rest.split('\n');
    const tableStart = lines.findIndex((l) => l.startsWith('|'));
    expect(tableStart).toBeGreaterThan(0);
    const table: string[] = [];
    for (let i = tableStart; i < lines.length && (lines[i] ?? '').startsWith('|'); i++) {
      table.push(lines[i] ?? '');
    }
    const dataRows = table.slice(1).filter((l) => !/^\|\s*-/.test(l));
    expect(dataRows).toHaveLength(7);
    expect(dataRows.some((l) => l.includes('`forwardHeaders`'))).toBe(true);
  });

  it('npm start env table lists FORWARD_HEADERS', () => {
    const rows = readme.split('\n').filter((l) => l.startsWith('| `FORWARD_HEADERS`'));
    expect(rows).toHaveLength(1);
  });

  it('a README passage says opt-in + allowlist-only, downstream host, hop-by-hop rejected', () => {
    const paras = readme.split(/\n\s*\n/).filter((p) => p.includes('forwardHeaders'));
    const hit = paras.find((p) => {
      const t = p.toLowerCase();
      return (
        t.includes('opt-in') &&
        t.includes('allowlist') &&
        t.includes('downstream host') &&
        t.includes('hop-by-hop') &&
        t.includes('rejected')
      );
    });
    expect(hit).toBeDefined();
  });
});

// ---------- EB13: no regression guards ----------
describe('EB13 - N+1 regression test is intact', () => {
  it('n-plus-1.test.ts still pins naive 21 and batched 3', () => {
    const src = readFileSync(resolve(root, 'test/n-plus-1.test.ts'), 'utf8');
    expect(src).toContain('Naive  : 1 (authors) + 5 (books, one per author) + 15 (reviews, one per book) = 21');
    expect(src).toContain('Batched: 1 (authors) + 1 (books, batched) + 1 (reviews, batched)              = 3');
  });
});
