import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend, createGateway, type GatewayOptions, type DownstreamCallEvent } from '../src/lib';
import { DATASET_SIZE, REVIEWS } from '../src/rest-backend/data';

/**
 * iter-101: the first write path, `Mutation.addReview` proxied to the bundled
 * backend's `POST /reviews` (PRODUCT row 102).
 *
 * Black-box: every case builds its OWN backend (writes are per instance), puts
 * `createGateway` in front of it and drives `gateway.fetch`. "calls" is the
 * delta of the backend's own `GET /__stats` (`total` + `byRoute`), cross-checked
 * against `extensions.downstreamCalls.total` where the spec says so. EB9 puts a
 * recording node:http proxy in front of the backend to observe what the POST
 * actually carried.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const sdl = readFileSync(resolve(root, 'schema.graphql'), 'utf8');
const generated = readFileSync(resolve(root, 'src/generated/graphql.ts'), 'utf8');

const M = 'mutation { addReview(bookId: "a1-b1", rating: 5, body: "Great read") { id rating body reviewer } }';
const T = { authorization: 'Bearer user:u7:pii' };
const READ_REVIEWS = '{ book(id: "a1-b1") { reviews { id reviewer } } }';

type Body = { data?: any; errors?: Array<{ message: string; extensions?: Record<string, any> }>; extensions?: any };
type Gw = ReturnType<typeof createGateway>;
type Stats = { total: number; byRoute: Record<string, number> };
type Env = { gw: Gw; url: string; stats: () => Promise<Stats> };

async function withEnv<T>(
  opts: Omit<GatewayOptions, 'restBaseUrl'>,
  fn: (env: Env) => Promise<T>,
  backendOpts: { latencyMs?: number } = { latencyMs: 0 },
  front?: (backendUrl: string) => Promise<{ url: string; close: () => Promise<void> }>,
): Promise<T> {
  const app: FastifyInstance = buildBackend(backendOpts).app;
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  const proxy = front ? await front(url) : undefined;
  const gw = createGateway({ restBaseUrl: proxy ? proxy.url : url, ...opts });
  const stats = async () => (await (await fetch(`${url}/__stats`)).json()) as Stats;
  try {
    return await fn({ gw, url, stats });
  } finally {
    await gw.close();
    if (proxy) await proxy.close();
    const closing = app.close();
    app.server.closeAllConnections();
    await closing;
  }
}

async function post(gw: Gw, query: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Body }> {
  const res = await gw.fetch(
    new Request('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ query }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Body };
}

/** Run `fn` and return the backend stats delta (total and per route) it caused. */
async function measured<R>(env: Env, fn: () => Promise<R>): Promise<{ calls: number; byRoute: Record<string, number>; value: R }> {
  const before = await env.stats();
  const value = await fn();
  await new Promise((r) => setTimeout(r, 30));
  const after = await env.stats();
  const byRoute: Record<string, number> = {};
  for (const [k, v] of Object.entries(after.byRoute)) {
    const d = v - (before.byRoute[k] ?? 0);
    if (d !== 0) byRoute[k] = d;
  }
  return { calls: after.total - before.total, byRoute, value };
}

const addReview = (bookId: string, rating: number, body: string, sel = '{ id }') =>
  `mutation { addReview(bookId: ${JSON.stringify(bookId)}, rating: ${rating}, body: ${JSON.stringify(body)}) ${sel} }`;

function expectRefused(body: Body, code: string): void {
  expect(body.data ?? null).toBeNull();
  expect(body.errors).toHaveLength(1);
  expect(body.errors?.[0]?.extensions?.code).toBe(code);
}

// ------------------------------------------------------------------ EB1-8 ----

describe.concurrent('iter-101 addReview: resolver paths with call counts', () => {
  it('EB1: happy path returns the stored review at exactly 1 call', async () => {
    await withEnv({}, async (env) => {
      const m = await measured(env, () => post(env.gw, M, T));
      expect(m.value.status).toBe(200);
      expect(m.value.body.errors).toBeUndefined();
      expect(m.value.body.data.addReview).toEqual({ id: 'a1-b1-r3', rating: 5, body: 'Great read', reviewer: 'u7' });
      expect(m.calls).toBe(1);
      expect(m.byRoute).toEqual({ '/reviews': 1 });
      expect(m.value.body.extensions?.downstreamCalls?.total).toBe(1);
    });
  });

  it('EB2: the write persists in its backend instance only; seed REVIEWS untouched', async () => {
    const seedLen = REVIEWS.length;
    expect(DATASET_SIZE.reviews).toBe(seedLen);
    await withEnv({}, async (env) => {
      expect((await post(env.gw, M, T)).body.errors).toBeUndefined();
      const r = await post(env.gw, READ_REVIEWS, T);
      expect(r.body.errors).toBeUndefined();
      expect(r.body.data.book.reviews.map((x: { id: string }) => x.id)).toEqual(['a1-b1-r1', 'a1-b1-r2', 'a1-b1-r3']);
    });
    await withEnv({}, async (env) => {
      const r = await post(env.gw, READ_REVIEWS, T);
      expect(r.body.data.book.reviews.map((x: { id: string }) => x.id)).toEqual(['a1-b1-r1', 'a1-b1-r2']);
    });
    expect(REVIEWS.length).toBe(seedLen);
    expect(DATASET_SIZE.reviews).toBe(REVIEWS.length);
  });

  it('EB3: no-pii caller sees REDACTED; stored reviewer is the caller userId', async () => {
    await withEnv({}, async (env) => {
      const m = await measured(env, () => post(env.gw, M, { authorization: 'Bearer user:u7:' }));
      expect(m.value.body.errors).toBeUndefined();
      expect(m.value.body.data.addReview.reviewer).toBe('REDACTED');
      expect(m.value.body.data.addReview.id).toBe('a1-b1-r3');
      expect(m.calls).toBe(1);
      const r = await post(env.gw, READ_REVIEWS, T);
      const mine = r.body.data.book.reviews.find((x: { id: string }) => x.id === 'a1-b1-r3');
      expect(mine).toEqual({ id: 'a1-b1-r3', reviewer: 'u7' });
    });
  });

  it('EB4: anonymous and unparseable tokens are UNAUTHENTICATED at 0 calls, before argument checks', async () => {
    await withEnv({}, async (env) => {
      const cases: Array<[string, Record<string, string>]> = [
        [M, {}],
        [M, { authorization: 'Bearer nonsense' }],
        [addReview('a1-b1', 9, 'x'), {}],
      ];
      for (const [q, h] of cases) {
        const m = await measured(env, () => post(env.gw, q, h));
        expectRefused(m.value.body, 'UNAUTHENTICATED');
        expect(m.calls).toBe(0);
        expect(m.value.body.extensions?.downstreamCalls?.total).toBe(0);
      }
      // nothing was written
      const r = await post(env.gw, READ_REVIEWS, T);
      expect(r.body.data.book.reviews).toHaveLength(2);
    });
  });

  it('EB5: bad rating / blank body / overlong body are BAD_ARGUMENT at 0 calls', async () => {
    await withEnv({}, async (env) => {
      const bad = [
        addReview('a1-b1', 0, 'x'),
        addReview('a1-b1', 6, 'x'),
        addReview('a1-b1', -1, 'x'),
        addReview('a1-b1', 3, ''),
        addReview('a1-b1', 3, '   '),
        addReview('a1-b1', 3, 'y'.repeat(2001)),
      ];
      for (const q of bad) {
        const m = await measured(env, () => post(env.gw, q, T));
        expectRefused(m.value.body, 'BAD_ARGUMENT');
        expect(m.calls).toBe(0);
        expect(m.value.body.extensions?.downstreamCalls?.total).toBe(0);
      }
      // boundaries are accepted: rating 1 and a body of exactly 2000 chars
      const ok = await measured(env, () => post(env.gw, addReview('a1-b1', 1, 'z'.repeat(2000), '{ id rating }'), T));
      expect(ok.value.body.errors).toBeUndefined();
      expect(ok.value.body.data.addReview).toEqual({ id: 'a1-b1-r3', rating: 1 });
      expect(ok.calls).toBe(1);
    });
  });

  it('EB6: unknown book is NOT_FOUND after exactly 1 call; hook reports 404 http_error', async () => {
    const events: DownstreamCallEvent[] = [];
    await withEnv({ onDownstreamCall: (e) => void events.push(e) }, async (env) => {
      const m = await measured(env, () => post(env.gw, addReview('zz-nope', 4, 'x'), T));
      expectRefused(m.value.body, 'NOT_FOUND');
      expect(m.calls).toBe(1);
      expect(m.byRoute).toEqual({ '/reviews': 1 });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ route: '/reviews', status: 404, outcome: 'http_error', errorCode: 'DOWNSTREAM_ERROR' });
    });
  });

  it('EB7: read-your-write in the same response at exactly 3 calls', async () => {
    await withEnv({}, async (env) => {
      const q = 'mutation { addReview(bookId: "a1-b1", rating: 4, body: "x") { id book { id reviews { id } } } }';
      const m = await measured(env, () => post(env.gw, q, T));
      expect(m.value.body.errors).toBeUndefined();
      const r = m.value.body.data.addReview;
      expect(r.id).toBe('a1-b1-r3');
      expect(r.book.id).toBe('a1-b1');
      expect(r.book.reviews.map((x: { id: string }) => x.id)).toEqual(['a1-b1-r1', 'a1-b1-r2', 'a1-b1-r3']);
      expect(m.calls).toBe(3);
      expect(m.byRoute).toEqual({ '/reviews': 1, '/books/by-ids': 1, '/reviews/by-book': 1 });
      expect(m.value.body.extensions?.downstreamCalls?.total).toBe(3);
    });
  });

  it('EB8: two aliased mutations run serially and each sees the one before, at exactly 5 calls', async () => {
    await withEnv({}, async (env) => {
      const q = `mutation {
        a: addReview(bookId: "a1-b1", rating: 4, body: "first") { id book { reviews { id } } }
        b: addReview(bookId: "a1-b1", rating: 2, body: "second") { id book { reviews { id } } }
      }`;
      const m = await measured(env, () => post(env.gw, q, T));
      expect(m.value.body.errors).toBeUndefined();
      const { a, b } = m.value.body.data;
      expect(a.id).toBe('a1-b1-r3');
      expect(b.id).toBe('a1-b1-r4');
      expect(a.book.reviews.map((x: { id: string }) => x.id)).toEqual(['a1-b1-r1', 'a1-b1-r2', 'a1-b1-r3']);
      expect(b.book.reviews.map((x: { id: string }) => x.id)).toEqual(['a1-b1-r1', 'a1-b1-r2', 'a1-b1-r3', 'a1-b1-r4']);
      expect(m.calls).toBe(5);
      expect(m.byRoute).toEqual({ '/reviews': 2, '/books/by-ids': 1, '/reviews/by-book': 2 });
    });
  });
});

// ------------------------------------------------------------- EB9-EB15 ----

type Seen = { method: string; path: string; headers: IncomingHttpHeaders; body: string };

/** A recording proxy: logs every request (method, path, headers, body) and forwards it to the backend. */
function recorder(seen: Seen[]) {
  return async (backendUrl: string) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        seen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
        const headers: Record<string, string> = {};
        if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
        fetch(backendUrl + (req.url ?? '/'), { method: req.method, headers, body: req.method === 'GET' ? undefined : body })
          .then(async (r) => {
            const text = await r.text();
            res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
            res.end(text);
          })
          .catch(() => {
            res.writeHead(502);
            res.end();
          });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      },
    };
  };
}

describe.concurrent('iter-101 addReview: the edge contract on the POST', () => {
  it('EB9: forwarded header + JSON body reach POST /reviews; authorization is not forwarded', async () => {
    const seen: Seen[] = [];
    await withEnv(
      { forwardHeaders: ['x-tenant'] },
      async (env) => {
        const r = await post(env.gw, M, { ...T, 'x-tenant': 'acme' });
        expect(r.body.errors).toBeUndefined();
        const posts = seen.filter((s) => s.method === 'POST' && s.path.split('?')[0] === '/reviews');
        expect(posts).toHaveLength(1);
        const p = posts[0]!;
        expect(p.headers['x-tenant']).toBe('acme');
        expect(String(p.headers['content-type'] ?? '')).toMatch(/^application\/json/);
        expect(p.headers.authorization).toBeUndefined();
        expect(JSON.parse(p.body)).toMatchObject({ bookId: 'a1-b1', rating: 5, body: 'Great read', reviewer: 'u7' });
      },
      { latencyMs: 0 },
      recorder(seen),
    );
  });

  it('EB9b: authorization IS forwarded on the POST when allowlisted', async () => {
    const seen: Seen[] = [];
    await withEnv(
      { forwardHeaders: ['authorization'] },
      async (env) => {
        const r = await post(env.gw, M, T);
        expect(r.body.errors).toBeUndefined();
        const p = seen.find((s) => s.method === 'POST' && s.path.split('?')[0] === '/reviews');
        expect(p?.headers.authorization).toBe(T.authorization);
      },
      { latencyMs: 0 },
      recorder(seen),
    );
  });

  it('EB10: exactly one hook event with the GET event key set', async () => {
    const events: DownstreamCallEvent[] = [];
    await withEnv({ onDownstreamCall: (e) => void events.push(e) }, async (env) => {
      expect((await post(env.gw, M, T)).body.errors).toBeUndefined();
      await new Promise((r) => setTimeout(r, 20));
      expect(events).toHaveLength(1);
      const ev = events[0]!;
      expect(ev).toMatchObject({ route: '/reviews', status: 201, outcome: 'ok', errorCode: null });
      expect(typeof ev.durationMs).toBe('number');
      expect(ev.durationMs).toBeGreaterThanOrEqual(0);
      events.length = 0;
      expect((await post(env.gw, '{ book(id: "a1-b1") { id } }', T)).body.errors).toBeUndefined();
      await new Promise((r) => setTimeout(r, 20));
      expect(events).toHaveLength(1);
      expect(Object.keys(ev).sort()).toEqual(Object.keys(events[0]!).sort());
      expect(Object.keys(ev).sort()).toEqual(['durationMs', 'errorCode', 'outcome', 'route', 'status']);
    });
  });

  it('EB11: maxDownstreamCalls: 1 lets exactly one POST through', async () => {
    await withEnv({ maxDownstreamCalls: 1 }, async (env) => {
      const q = `mutation {
        a: addReview(bookId: "a1-b1", rating: 4, body: "one") { id }
        b: addReview(bookId: "a1-b1", rating: 4, body: "two") { id }
      }`;
      const m = await measured(env, () => post(env.gw, q, T));
      expect(m.value.body.data ?? null).toBeNull();
      expect(m.value.body.errors?.some((e) => e.extensions?.code === 'DOWNSTREAM_BUDGET_EXCEEDED')).toBe(true);
      expect(m.byRoute).toEqual({ '/reviews': 1 });
      expect(m.calls).toBe(1);
    });
  });

  it('EB11b: after the budget refusal a later read shows 3 reviews, not 4', async () => {
    await withEnv({}, async (env) => {
      const capped = createGateway({ restBaseUrl: env.url, maxDownstreamCalls: 1 });
      try {
        const q = `mutation {
          a: addReview(bookId: "a1-b1", rating: 4, body: "one") { id }
          b: addReview(bookId: "a1-b1", rating: 4, body: "two") { id }
        }`;
        const r = await post(capped, q, T);
        expect(r.body.errors?.some((e) => e.extensions?.code === 'DOWNSTREAM_BUDGET_EXCEEDED')).toBe(true);
      } finally {
        await capped.close();
      }
      const read = await post(env.gw, READ_REVIEWS, T);
      expect(read.body.data.book.reviews).toHaveLength(3);
    });
  });

  it('EB12: never coalesced: two concurrent identical writes are two POSTs and two reviews', async () => {
    await withEnv(
      { coalesceInFlight: true },
      async (env) => {
        const m = await measured(env, () => Promise.all([post(env.gw, M, T), post(env.gw, M, T)]));
        const [x, y] = m.value;
        expect(x.body.errors).toBeUndefined();
        expect(y.body.errors).toBeUndefined();
        expect([x.body.data.addReview.id, y.body.data.addReview.id].sort()).toEqual(['a1-b1-r3', 'a1-b1-r4']);
        expect(x.body.extensions?.downstreamCalls?.total).toBe(1);
        expect(y.body.extensions?.downstreamCalls?.total).toBe(1);
        expect(m.byRoute).toEqual({ '/reviews': 2 });
      },
      { latencyMs: 50 },
    );
  });

  it('EB13: a mutation over GET is refused with 405 at 0 calls', async () => {
    await withEnv({}, async (env) => {
      const m = await measured(env, () =>
        env.gw.fetch(new Request(`http://gateway.local/graphql?query=${encodeURIComponent(M)}`, { method: 'GET', headers: T })),
      );
      expect(m.value.status).toBe(405);
      expect(m.calls).toBe(0);
      const read = await post(env.gw, READ_REVIEWS, T);
      expect(read.body.data.book.reviews).toHaveLength(2);
    });
  });

  it('EB14: mutation cost is reported and maxComplexity / maxDepth refuse at 0 calls', async () => {
    const costQ = 'mutation { addReview(bookId: "a1-b1", rating: 5, body: "Great read") { id rating } }';
    await withEnv({}, async (env) => {
      const r = await post(env.gw, costQ, T);
      expect(r.body.errors).toBeUndefined();
      expect(r.body.extensions?.queryComplexity?.cost).toBe(3);
    });
    await withEnv({ maxComplexity: 2 }, async (env) => {
      const m = await measured(env, () => post(env.gw, costQ, T));
      expect(m.value.body.errors?.[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX');
      expect(m.value.body.data ?? undefined).toBeUndefined();
      expect(m.calls).toBe(0);
    });
    await withEnv({ maxDepth: 1 }, async (env) => {
      const deep = 'mutation { addReview(bookId: "a1-b1", rating: 5, body: "x") { book { id } } }';
      const m = await measured(env, () => post(env.gw, deep, T));
      expect(m.value.body.errors?.[0]?.extensions?.code).toBe('QUERY_TOO_DEEP');
      expect(m.calls).toBe(0);
    });
  });

  it('EB15: backend POST /reviews direct: 201 / 404 / 400 and counted under /reviews', async () => {
    const app = buildBackend({ latencyMs: 0 }).app;
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const send = async (payload: unknown) => {
        const res = await fetch(`${url}/reviews`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return { status: res.status, json: (await res.json().catch(() => null)) as any };
      };
      const ok = await send({ bookId: 'a1-b1', rating: 5, body: 'x', reviewer: 'u1' });
      expect(ok.status).toBe(201);
      expect(ok.json).toEqual({ id: 'a1-b1-r3', bookId: 'a1-b1', rating: 5, body: 'x', reviewer: 'u1' });
      expect((await send({ bookId: 'zz-nope', rating: 5, body: 'x', reviewer: 'u1' })).status).toBe(404);
      const bad: unknown[] = [
        { bookId: 'a1-b1', rating: 0, body: 'x', reviewer: 'u1' },
        { bookId: 'a1-b1', rating: 6, body: 'x', reviewer: 'u1' },
        { bookId: 'a1-b1', rating: 2.5, body: 'x', reviewer: 'u1' },
        { bookId: 'a1-b1', rating: 3, reviewer: 'u1' },
        { bookId: 'a1-b1', rating: 3, body: '', reviewer: 'u1' },
        { bookId: 'a1-b1', rating: 3, body: 'x' },
        { bookId: 'a1-b1', rating: 3, body: 'x', reviewer: '' },
      ];
      for (const p of bad) expect((await send(p)).status, JSON.stringify(p)).toBe(400);
      const stats = (await (await fetch(`${url}/__stats`)).json()) as Stats;
      expect(stats.byRoute['/reviews']).toBe(2 + bad.length);
      // the refused writes appended nothing: the next valid write is r4, and it counts too
      const next = await send({ bookId: 'a1-b1', rating: 1, body: 'y', reviewer: 'u2' });
      expect(next.status).toBe(201);
      expect(next.json?.id).toBe('a1-b1-r4');
      const after = (await (await fetch(`${url}/__stats`)).json()) as Stats;
      expect(after.byRoute['/reviews']).toBe(3 + bad.length);
    } finally {
      const closing = app.close();
      app.server.closeAllConnections();
      await closing;
    }
  });
});

// ----------------------------------------------------------- EB16-EB17 ----

describe('iter-101 addReview: contract artifacts', () => {
  it('EB16: schema.graphql declares Mutation.addReview with an honest doc string', () => {
    expect(sdl).toMatch(/type Mutation\s*\{/);
    expect(sdl).toMatch(/addReview\(bookId: ID!, rating: Int!, body: String!\): Review!/);
    const body = sdl.slice(sdl.indexOf('type Mutation'));
    const doc = body.slice(0, body.indexOf('addReview('));
    expect(doc).toMatch(/"""/);
    expect(doc).toMatch(/UNAUTHENTICATED|authenticated/i);
    expect(doc).toMatch(/1\s*(\.\.|to|-|–)\s*5/);
    expect(doc).toMatch(/1 downstream call/i);
  });

  it('EB16: generated types are regenerated with MutationAddReviewArgs', () => {
    expect(generated).toMatch(/MutationAddReviewArgs/);
    expect(generated).toMatch(/addReview/);
  });

  it('EB16: README names addReview as the shipped user of UNAUTHENTICATED and documents the mutation', () => {
    expect(readme).not.toMatch(/no shipped field (yet )?uses/i);
    const auth = readme.slice(readme.search(/requireAuth\(ctx\)/));
    expect(auth.slice(0, 600)).toMatch(/addReview/);
    const wp = readme.slice(readme.indexOf('Write path (`addReview`)'));
    expect(readme.indexOf('Write path (`addReview`)')).toBeGreaterThan(-1);
    const sec = wp.slice(0, wp.indexOf('\n###') > 0 ? wp.indexOf('\n###') : 4000);
    expect(sec).toMatch(/UNAUTHENTICATED/);
    expect(sec).toMatch(/BAD_ARGUMENT/);
    expect(sec).toMatch(/1 downstream call/);
    expect(sec).toMatch(/reviewsByBookId/);
    expect(sec).toMatch(/never coalesced/i);
    expect(readme).toMatch(/test_iter101_behavior\.test\.ts/);
  });

  it('EB17: the N+1 oracle still asserts 3 (BATCHED) and 21 (NAIVE)', () => {
    const n1 = readFileSync(resolve(root, 'test/n-plus-1.test.ts'), 'utf8');
    expect(n1).toMatch(/\b3\b/);
    expect(n1).toMatch(/\b21\b/);
  });
});
