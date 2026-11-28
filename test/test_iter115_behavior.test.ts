import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend, createGateway, type GatewayOptions, type DownstreamCallEvent } from '../src/lib';
import { OPTION_ENV } from '../src/cli';
import { BENCHMARK_QUERY } from '../benchmark/benchmark';

/**
 * iter-115: sync edge verifier `createGateway({ authenticate })` (PRODUCT row 139).
 * The verifier replaces the stub bearer parser for every GraphQL edge request,
 * drives the shipped UNAUTHENTICATED / @requiresScope / pii gates, and fails
 * closed (throw, Promise, malformed result -> anonymous).
 *
 * Black-box: every case builds its OWN bundled Fastify backend on port 0 and
 * puts `createGateway` in front of it, driven through `gw.fetch`, through
 * `gw.nodeListener` on an ephemeral 127.0.0.1 port, or through the CLI's
 * `startFromEnv`. Every call count is a THREE-way oracle: the backend
 * `GET /__stats` delta must equal the `onDownstreamCall` events in the same
 * window, and (for a single JSON reply) `extensions.downstreamCalls.total`.
 * No wall-clock bound is asserted anywhere.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

type Auth = GatewayOptions['authenticate'];
type AnyAuth = (req: Request) => unknown;

const TABLE: Record<string, { userId: string; scopes: string[] }> = {
  'Bearer good': { userId: '7', scopes: ['write'] },
  'Bearer good-pii': { userId: '7', scopes: ['write', 'pii'] },
  'Bearer good-read': { userId: '7', scopes: ['read'] },
};
const V: NonNullable<Auth> = (req) => TABLE[req.headers.get('authorization') ?? ''] ?? null;

const ADD = 'mutation { addReview(bookId: "a1-b1", rating: 5, body: "ok") { id reviewer } }';
const REVIEWERS = '{ book(id: "a1-b1") { reviews { reviewer } } }';
const TITLE = '{ book(id: "a1-b1") { title } }';
const SECRET = 'jwks-secret-detail';

type Body = { data?: any; errors?: Array<{ message: string; extensions?: Record<string, any> }>; extensions?: any };
type Gw = ReturnType<typeof createGateway>;
type Stats = { total: number; byRoute: Record<string, number> };
type Reply = { status: number; text: string; json: any };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wrap a verifier so every call (and its argument) is recorded. */
function counted(fn: AnyAuth): { fn: NonNullable<Auth>; args: Request[] } {
  const args: Request[] = [];
  const wrapped = ((req: Request) => {
    args.push(req);
    return fn(req);
  }) as unknown as NonNullable<Auth>;
  return { fn: wrapped, args };
}

type Env = {
  gw: Gw;
  url: string;
  events: DownstreamCallEvent[];
  /** Run `fn`; return the backend hit delta, checked equal to the hook events in the same window. */
  measure: <R>(fn: () => Promise<R>) => Promise<{ calls: number; value: R; routes: string[] }>;
};

async function withEnv<T>(opts: Omit<GatewayOptions, 'restBaseUrl'>, fn: (env: Env) => Promise<T>): Promise<T> {
  const app: FastifyInstance = buildBackend({ latencyMs: 0 }).app;
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  const events: DownstreamCallEvent[] = [];
  const gw = createGateway({ restBaseUrl: url, ...opts, onDownstreamCall: (e) => void events.push(e) });
  const stats = async () => (await (await fetch(`${url}/__stats`)).json()) as Stats;
  const measure: Env['measure'] = async (f) => {
    const before = await stats();
    const ev0 = events.length;
    const value = await f();
    await sleep(25);
    const after = await stats();
    const calls = after.total - before.total;
    expect(events.length - ev0, 'onDownstreamCall events vs /__stats delta').toBe(calls);
    return { calls, value, routes: events.slice(ev0).map((e) => e.route) };
  };
  try {
    return await fn({ gw, url, events, measure });
  } finally {
    await gw.close();
    const closing = app.close();
    app.server.closeAllConnections();
    await closing;
  }
}

function gqlRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://gateway.local/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body,
  });
}

async function post(gw: Gw, query: string, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await gw.fetch(gqlRequest(JSON.stringify({ query }), headers));
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

/** One GraphQL op through gw.fetch, with the 3-way call oracle. */
async function op(env: Env, query: string, headers: Record<string, string> = {}): Promise<{ r: Reply; b: Body; calls: number; routes: string[] }> {
  const { calls, value: r, routes } = await env.measure(() => post(env.gw, query, headers));
  expect(r.json, `JSON body (got: ${r.text.slice(0, 200)})`).toBeDefined();
  const b = r.json as Body;
  expect(b.extensions?.downstreamCalls?.total ?? 0, 'extensions.downstreamCalls.total vs backend hits').toBe(calls);
  return { r, b, calls, routes };
}

function expectCode(b: Body, code: string): void {
  expect(b.errors, `errors (body: ${JSON.stringify(b).slice(0, 300)})`).toBeDefined();
  expect(b.errors![0]!.extensions?.code).toBe(code);
  expect(b.data).toBeNull();
}

function expectWrite(r: Reply, b: Body, calls: number, routes: string[]): void {
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  expect(b.errors, JSON.stringify(b.errors)).toBeUndefined();
  expect(b.data.addReview.id).toMatch(/^a1-b1-r\d+$/);
  expect(calls).toBe(1);
  expect(routes).toEqual(['/reviews']);
}

async function listen(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = http.createServer(handler);
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = (srv.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((ok) => {
        srv.closeAllConnections();
        srv.close(() => ok());
      }),
  };
}

function throwsOf(extra: Record<string, unknown>): unknown {
  try {
    createGateway({ restBaseUrl: 'http://127.0.0.1:1', ...extra } as unknown as GatewayOptions);
  } catch (e) {
    return e;
  }
  return undefined;
}

// ---------------------------------------------------------------- EB1 ----

describe('EB1: default (no authenticate) is unchanged', () => {
  for (const [label, opts] of [
    ['key absent', {}],
    ['authenticate: undefined', { authenticate: undefined }],
  ] as const) {
    it(`${label}: stub write token writes at 1 call; anonymous UNAUTHENTICATED and read-only FORBIDDEN at 0`, async () => {
      await withEnv(opts, async (env) => {
        const w = await op(env, ADD, { authorization: 'Bearer user:42:read,write' });
        expectWrite(w.r, w.b, w.calls, w.routes);
        expect(w.b.data.addReview.reviewer).toBe('REDACTED');

        const anon = await op(env, ADD);
        expectCode(anon.b, 'UNAUTHENTICATED');
        expect(anon.calls).toBe(0);

        const ro = await op(env, ADD, { authorization: 'Bearer user:42:read' });
        expectCode(ro.b, 'FORBIDDEN');
        expect(ro.b.errors![0]!.extensions?.requiredScope).toBe('write');
        expect(ro.calls).toBe(0);
      });
    });
  }
});

// ---------------------------------------------------------------- EB2 ----

describe('EB2: verifier grants a write', () => {
  it('Bearer good -> 200, reviewer REDACTED, exactly 1 POST /reviews', async () => {
    await withEnv({ authenticate: V }, async (env) => {
      const w = await op(env, ADD, { authorization: 'Bearer good' });
      expectWrite(w.r, w.b, w.calls, w.routes);
      expect(w.b.data.addReview.reviewer).toBe('REDACTED');
    });
  });

  it('Bearer good-pii -> reviewer is the verifier userId "7", at 1 call, and it is stored', async () => {
    await withEnv({ authenticate: V }, async (env) => {
      const w = await op(env, ADD, { authorization: 'Bearer good-pii' });
      expectWrite(w.r, w.b, w.calls, w.routes);
      expect(w.b.data.addReview.reviewer).toBe('7');
      const id = w.b.data.addReview.id as string;
      const back = await op(env, '{ book(id: "a1-b1") { reviews { id reviewer } } }', { authorization: 'Bearer good-pii' });
      const mine = (back.b.data.book.reviews as Array<{ id: string; reviewer: string }>).find((x) => x.id === id);
      expect(mine, 'the new review is listed').toBeDefined();
      expect(mine!.reviewer).toBe('7');
    });
  });
});

// ---------------------------------------------------------------- EB3 ----

describe('EB3: verifier scopes gate the write', () => {
  it('Bearer good-read -> FORBIDDEN requiredScope write, data null, 0 calls', async () => {
    await withEnv({ authenticate: V }, async (env) => {
      const x = await op(env, ADD, { authorization: 'Bearer good-read' });
      expectCode(x.b, 'FORBIDDEN');
      expect(x.b.errors![0]!.extensions?.requiredScope).toBe('write');
      expect(x.calls).toBe(0);
    });
  });
});

// ---------------------------------------------------------------- EB4 ----

describe('EB4: the stub token stops working once a verifier is set', () => {
  it('Bearer user:42:read,write and anonymous -> UNAUTHENTICATED at 0 calls', async () => {
    await withEnv({ authenticate: V }, async (env) => {
      for (const h of [{ authorization: 'Bearer user:42:read,write' }, {}] as Record<string, string>[]) {
        const x = await op(env, ADD, h);
        expectCode(x.b, 'UNAUTHENTICATED');
        expect(x.calls).toBe(0);
      }
    });
  });
});

// ---------------------------------------------------------------- EB5 ----

describe('EB5: pii follows the verifier', () => {
  it('pii scope shows real reviewers (equal to default + user:1:pii); no scope / null user redact; same call count', async () => {
    const base = await withEnv({}, async (env) => op(env, REVIEWERS, { authorization: 'Bearer user:1:pii' }));
    expect(base.b.errors).toBeUndefined();
    const realReviewers = (base.b.data.book.reviews as Array<{ reviewer: string }>).map((x) => x.reviewer);
    expect(realReviewers.length).toBeGreaterThan(0);
    expect(realReviewers.every((x) => x !== 'REDACTED')).toBe(true);

    const pii = await withEnv({ authenticate: () => ({ userId: '9', scopes: ['pii'] }) }, async (env) => op(env, REVIEWERS));
    expect(pii.b.errors).toBeUndefined();
    expect(pii.b.data).toStrictEqual(base.b.data);
    expect(pii.calls).toBe(base.calls);

    for (const a of [() => ({ userId: '9', scopes: [] }), () => ({ userId: null, scopes: ['pii'] })] as NonNullable<Auth>[]) {
      const red = await withEnv({ authenticate: a }, async (env) => op(env, REVIEWERS));
      expect(red.b.errors).toBeUndefined();
      const rs = (red.b.data.book.reviews as Array<{ reviewer: string }>).map((x) => x.reviewer);
      expect(rs).toHaveLength(realReviewers.length);
      expect(rs.every((x) => x === 'REDACTED')).toBe(true);
      expect(red.calls).toBe(base.calls);
    }
  });
});

// ---------------------------------------------------------------- EB6 ----

describe('EB6: one verifier call per edge request, with the edge request', () => {
  it('called once with a Request whose headers include the client headers; 2 sequential -> 2', async () => {
    const c = counted(V);
    await withEnv({ authenticate: c.fn }, async (env) => {
      const x = await op(env, TITLE, { 'x-api-key': 'k1' });
      expect(x.b.errors).toBeUndefined();
      expect(c.args).toHaveLength(1);
      const req = c.args[0]!;
      expect(typeof req.url).toBe('string');
      expect(new URL(req.url).pathname).toBe('/graphql');
      expect(typeof req.headers.get).toBe('function');
      expect(req.headers.get('x-api-key')).toBe('k1');

      const y = await op(env, ADD, { authorization: 'Bearer good' });
      expectWrite(y.r, y.b, y.calls, y.routes);
      expect(c.args).toHaveLength(2);
      expect(c.args[1]!.headers.get('authorization')).toBe('Bearer good');
    });
  });

  it('maxBatchSize 5: one batched POST of 3 writes -> verifier called once, 3 ops succeed, 3 POST /reviews', async () => {
    const c = counted(V);
    await withEnv({ authenticate: c.fn, maxBatchSize: 5 }, async (env) => {
      const body = JSON.stringify([{ query: ADD }, { query: ADD }, { query: ADD }]);
      const { calls, value, routes } = await env.measure(async () => {
        const res = await env.gw.fetch(gqlRequest(body, { authorization: 'Bearer good' }));
        return { status: res.status, json: (await res.json()) as Body[] };
      });
      expect(value.status).toBe(200);
      expect(Array.isArray(value.json)).toBe(true);
      expect(value.json).toHaveLength(3);
      const ids = new Set<string>();
      for (const b of value.json) {
        expect(b.errors, JSON.stringify(b.errors)).toBeUndefined();
        expect(b.data.addReview.id).toMatch(/^a1-b1-r\d+$/);
        ids.add(b.data.addReview.id);
      }
      expect(ids.size).toBe(3);
      expect(calls).toBe(3);
      expect(routes).toEqual(['/reviews', '/reviews', '/reviews']);
      expect(c.args).toHaveLength(1);
    });
  });

  it('works through gw.nodeListener on a real http server: Bearer good writes at 1 call, verifier called once', async () => {
    const c = counted(V);
    await withEnv({ authenticate: c.fn }, async (env) => {
      const srv = await listen(env.gw.nodeListener as unknown as http.RequestListener);
      try {
        const { calls, value, routes } = await env.measure(async () => {
          const res = await fetch(`http://127.0.0.1:${srv.port}/graphql`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer good' },
            body: JSON.stringify({ query: ADD }),
          });
          return { status: res.status, text: await res.text() };
        });
        const b = JSON.parse(value.text) as Body;
        expectWrite({ status: value.status, text: value.text, json: b }, b, calls, routes);
        expect(b.extensions?.downstreamCalls?.total).toBe(1);
        expect(c.args).toHaveLength(1);
        expect(c.args[0]!.headers.get('authorization')).toBe('Bearer good');
      } finally {
        await srv.close();
      }
    });
  });
});

// ---------------------------------------------------------------- EB7 ----

describe('EB7: not called off the GraphQL path', () => {
  it('/healthz, /readyz and a 413 REQUEST_TOO_LARGE never call the verifier', async () => {
    const c = counted(V);
    await withEnv({ authenticate: c.fn, maxRequestBytes: 1024 }, async (env) => {
      expect((await env.gw.fetch('http://gateway.local/healthz')).status).toBe(200);
      expect((await env.gw.fetch('http://gateway.local/readyz')).status).toBe(200);
      const big = JSON.stringify({ query: ADD, variables: { pad: 'x'.repeat(4096) } });
      const res = await env.gw.fetch(gqlRequest(big, { authorization: 'Bearer good' }));
      expect(res.status).toBe(413);
      const b = (await res.json()) as Body;
      expect(b.errors![0]!.extensions?.code).toBe('REQUEST_TOO_LARGE');
      expect(c.args).toHaveLength(0);
      // control: the counter does move on the GraphQL path
      await op(env, TITLE);
      expect(c.args).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------- EB8 ----

describe('EB8: a throwing verifier fails closed and does not leak', () => {
  it('write UNAUTHENTICATED at 0 calls, open read 200, no secret in any body, next request served', async () => {
    const boom: NonNullable<Auth> = () => {
      throw new Error(SECRET);
    };
    await withEnv({ authenticate: boom }, async (env) => {
      const w = await op(env, ADD, { authorization: 'Bearer good' });
      expectCode(w.b, 'UNAUTHENTICATED');
      expect(w.calls).toBe(0);
      expect(w.r.text).not.toContain(SECRET);

      const rd = await op(env, TITLE);
      expect(rd.r.status).toBe(200);
      expect(rd.b.errors).toBeUndefined();
      expect(rd.b.data.book.title).toEqual(expect.any(String));
      expect(rd.b.data.book.title.length).toBeGreaterThan(0);
      expect(rd.r.text).not.toContain(SECRET);

      const again = await op(env, ADD);
      expectCode(again.b, 'UNAUTHENTICATED');
      expect(again.r.text).not.toContain(SECRET);
      const rd2 = await op(env, TITLE);
      expect(rd2.b.data.book.title).toBe(rd.b.data.book.title);
    });
  });
});

// ---------------------------------------------------------------- EB9 ----

describe('EB9: malformed results fail closed', () => {
  const BAD: Array<[string, AnyAuth]> = [
    ['undefined', () => undefined],
    ['"7"', () => '7'],
    ['numeric userId', () => ({ userId: 7, scopes: ['write'] })],
    ['no scopes', () => ({ userId: '7' })],
    ['scopes string', () => ({ userId: '7', scopes: 'write' })],
    ['non-string scope', () => ({ userId: '7', scopes: ['write', 1] })],
    ['empty userId', () => ({ userId: '', scopes: ['write'] })],
    ['a Promise', async () => ({ userId: '7', scopes: ['write'] })],
  ];
  for (const [label, fn] of BAD) {
    it(`${label} -> UNAUTHENTICATED, data null, 0 calls`, async () => {
      await withEnv({ authenticate: fn as unknown as NonNullable<Auth> }, async (env) => {
        const x = await op(env, ADD, { authorization: 'Bearer good' });
        expectCode(x.b, 'UNAUTHENTICATED');
        expect(x.calls).toBe(0);
      });
    });
  }

  it('control: the same shape, well-formed, does write (so the cases above are not vacuous)', async () => {
    await withEnv({ authenticate: () => ({ userId: '7', scopes: ['write'] }) }, async (env) => {
      const w = await op(env, ADD, { authorization: 'Bearer anything' });
      expectWrite(w.r, w.b, w.calls, w.routes);
    });
  });

  it('a rejecting Promise -> UNAUTHENTICATED and no unhandledRejection', async () => {
    const seen: unknown[] = [];
    const onRej = (e: unknown) => void seen.push(e);
    process.on('unhandledRejection', onRej);
    try {
      await withEnv({ authenticate: (() => Promise.reject(new Error('x'))) as unknown as NonNullable<Auth> }, async (env) => {
        const x = await op(env, ADD, { authorization: 'Bearer good' });
        expectCode(x.b, 'UNAUTHENTICATED');
        expect(x.calls).toBe(0);
        await sleep(50);
        await new Promise<void>((r) => setImmediate(r));
      });
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRej);
    }
  });
});

// --------------------------------------------------------------- EB10 ----

describe('EB10: call counts and the N+1 oracle unchanged', () => {
  it('sample nested query costs 3 batched calls with a verifier (Bearer good and anonymous), same as default', async () => {
    const base = await withEnv({}, async (env) => op(env, BENCHMARK_QUERY));
    expect(base.b.errors).toBeUndefined();
    expect(base.calls).toBe(3);
    await withEnv({ authenticate: V }, async (env) => {
      for (const h of [{ authorization: 'Bearer good' }, {}] as Record<string, string>[]) {
        const x = await op(env, BENCHMARK_QUERY, h);
        expect(x.b.errors).toBeUndefined();
        expect(x.calls).toBe(3);
        expect(x.b.data).toStrictEqual(base.b.data);
      }
    });
  });
});

// --------------------------------------------------------------- EB11 ----

describe('EB11: validation', () => {
  for (const v of ['jwt', {}, null]) {
    it(`authenticate: ${JSON.stringify(v)} throws TypeError "authenticate must be a function..."`, () => {
      const e = throwsOf({ authenticate: v });
      expect(e).toBeInstanceOf(TypeError);
      expect((e as Error).message.startsWith('authenticate must be a function')).toBe(true);
    });
  }

  it('a function and undefined are accepted', () => {
    expect(throwsOf({ authenticate: V })).toBeUndefined();
    expect(throwsOf({ authenticate: undefined })).toBeUndefined();
  });

  it('the typo key authenticat is rejected by the unknown-key check, suggesting authenticate', () => {
    const e = throwsOf({ authenticat: V });
    expect(e).toBeInstanceOf(TypeError);
    expect((e as Error).message).toMatch(/^Unknown createGateway option "authenticat"/);
    expect((e as Error).message).toContain('authenticate');
  });
});

// --------------------------------------------------------------- EB12 ----

type Running = { url: string; restBaseUrl: string; close(): Promise<void> };
type StartFromEnv = (env: Record<string, string | undefined>, log?: (line: string) => void) => Promise<Running>;

describe('EB12: library-only', () => {
  it('OPTION_ENV has key authenticate with value null', () => {
    const map = OPTION_ENV as Record<string, string | null>;
    expect(Object.prototype.hasOwnProperty.call(map, 'authenticate')).toBe(true);
    expect(map.authenticate).toBeNull();
  });

  it('startFromEnv still writes with the stub token (an AUTHENTICATE env var changes nothing)', async () => {
    const start = ((await import('../src/cli')) as unknown as { startFromEnv: StartFromEnv }).startFromEnv;
    const r = await start({ PORT: '0', AUTHENTICATE: 'jwt' }, () => {});
    try {
      const send = async (h: Record<string, string>) => {
        const res = await fetch(r.url.replace(/\/?$/, ''), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...h },
          body: JSON.stringify({ query: ADD }),
        });
        return (await res.json()) as Body;
      };
      const ok = await send({ authorization: 'Bearer user:42:read,write' });
      expect(ok.errors, JSON.stringify(ok.errors)).toBeUndefined();
      expect(ok.data.addReview.id).toMatch(/^a1-b1-r\d+$/);
      expect(ok.extensions?.downstreamCalls?.total).toBe(1);
      const anon = await send({});
      expectCode(anon, 'UNAUTHENTICATED');
    } finally {
      await r.close();
    }
  });
});

// --------------------------------------------------------------- EB13 ----

function section(heading: string): string {
  const start = readme.indexOf(`\n${heading}`);
  expect(start, heading).toBeGreaterThan(-1);
  const next = readme.indexOf('\n## ', start + heading.length + 1);
  return readme.slice(start, next === -1 ? undefined : next);
}

describe('EB13: README', () => {
  it('options table has an authenticate row naming the signature, sync and fail closed', () => {
    const row = readme.split('\n').find((l) => l.startsWith('| `authenticate` |'));
    expect(row, 'authenticate option row').toBeDefined();
    expect(row!).toContain('(request: Request) => AuthContext \\| null');
    expect(row!).toMatch(/\bsync\b/);
    expect(row!).toMatch(/fail closed/);
  });

  it('the library-only sentence names loaderOptions, onDownstreamCall and authenticate', () => {
    const line = readme.split('\n').find((l) => /library-only/.test(l) && l.includes('`loaderOptions`') && !l.startsWith('|'));
    expect(line, 'library-only sentence').toBeDefined();
    expect(line!).toContain('`onDownstreamCall`');
    expect(line!).toContain('`authenticate`');
  });

  it('§7 auth paragraph names createGateway({ authenticate }) instead of telling users to swap parseAuth', () => {
    const s7 = section('## 7. Senior-concern coverage');
    const para = s7.split('\n').find((l) => l.startsWith('A bearer token is parsed'));
    expect(para, '§7 auth paragraph').toBeDefined();
    expect(para!).toContain('createGateway({ authenticate })');
    expect(para!).not.toMatch(/swap\s+`?parseAuth/i);
    expect(readme).not.toMatch(/swap\s+`?parseAuth`?\s+for/i);
  });

  it('§10 Real auth bullet says the hook has shipped and async/JWKS is next', () => {
    const s10 = section("## 10. What I'd do next in production");
    const bullet = s10.split('\n').find((l) => /^\s*-\s+\*\*Real auth\*\*/.test(l));
    expect(bullet, 'Real auth bullet').toBeDefined();
    expect(bullet!).toMatch(/shipped/);
    expect(bullet!).toContain('authenticate');
    expect(bullet!).toMatch(/async/i);
    expect(bullet!).toMatch(/JWKS/);
    expect(bullet!).toMatch(/next/i);
  });

  it('§8 names this test file and the count line matches the badge and the file count', () => {
    const s8 = section('## 8. Testing');
    expect(s8).toContain('test_iter115_behavior.test.ts');
    const badge = /tests-(\d+)%20passing/.exec(readme);
    const line = /`npm test` — (\d+) tests across (\d+) files/.exec(readme);
    expect(badge).not.toBeNull();
    expect(line).not.toBeNull();
    expect(badge![1]).toBe(line![1]);
    const files = readdirSync(dirname(fileURLToPath(import.meta.url))).filter((f) => f.endsWith('.test.ts')).length;
    expect(Number(line![2])).toBe(files);
  });
});
