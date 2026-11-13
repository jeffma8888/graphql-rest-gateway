import { describe, it, expect, beforeAll, afterAll, expectTypeOf } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphQLError } from 'graphql';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway, createContext, NAIVE, type GatewayOptions, type DownstreamCallEvent } from '../src/lib';
import { RestClient } from '../src/gateway/datasources/rest-client';

/**
 * iter-96: client-disconnect cancellation (PRODUCT row 94).
 *
 * Black-box: the bundled Fastify backend (`latencyMs: 300`) behind
 * `createGateway`, driven through `gateway.fetch(new Request(..., { signal }))`
 * and, for EB5, `http.createServer(gateway.nodeListener)`. Every call count is
 * read from the backend own `/__stats` counter after a settle wait of at
 * least 2x latency past the abort, so a late send would show up.
 *
 * The in-process `gateway.fetch` promise may reject with `AbortError` once
 * aborted; that is caught and never asserted on.
 *
 * Each abort case owns its own backend, so the cases run concurrently and the
 * file stays fast. EB11 patches the global `AbortSignal.any`, so it runs in a
 * sequential block of its own.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(resolve(__dirname, '..', 'README.md'), 'utf8');

const LATENCY = 300;
const SETTLE = 2 * LATENCY + 50;
const Q = '{ authors(first:5){ edges { node { name books { title reviews { rating } } } } } }';
const Q_DEFER = '{ authors(first:5){ edges { node { name ... @defer { books { title reviews { rating } } } } } } }';
const Q_BOOK = '{ book(id:"a1-b1"){ title reviews { rating } } }';
const Q_TIMEOUT = '{ authors(first:1){ totalCount } }';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Backend = { app: FastifyInstance; url: string };
type Stats = { total: number; byRoute: Record<string, number> };

async function withBackend<T>(fn: (b: Backend) => Promise<T>, latencyMs = LATENCY): Promise<T> {
  const app = buildBackend({ latencyMs }).app;
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    return await fn({ app, url });
  } finally {
    // drop the gateway idle keep-alive sockets too, so teardown does not wait out their timeout
    const closing = app.close();
    app.server.closeAllConnections();
    await closing;
  }
}
async function stats(b: Backend): Promise<Stats> {
  return (await (await fetch(`${b.url}/__stats`)).json()) as Stats;
}
async function reset(b: Backend): Promise<void> {
  const r = await fetch(`${b.url}/__stats/reset`, { method: 'POST' });
  if (!r.ok) throw new Error('reset failed');
}
/** Poll `/__stats` until `pred` holds (the backend has received the call and is sleeping). */
async function waitStats(b: Backend, pred: (s: Stats) => boolean, timeoutMs = 3000): Promise<Stats> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = await stats(b);
    if (pred(s)) return s;
    if (Date.now() > until) throw new Error(`stats predicate never held: ${JSON.stringify(s)}`);
    await sleep(5);
  }
}
const route = (s: Stats, r: string): number => s.byRoute[r] ?? 0;

function gqlRequest(body: unknown, signal?: AbortSignal, accept?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (accept) headers.accept = accept;
  return new Request('http://g/graphql', { method: 'POST', headers, body: JSON.stringify(body), signal });
}

/** Fire `gw.fetch` and swallow the (allowed) AbortError so it is never asserted on. */
function fire(gw: ReturnType<typeof createGateway>, req: Request): Promise<Response | undefined> {
  return Promise.resolve(gw.fetch(req)).then(
    async (res) => {
      // drain so nothing dangles; an aborted body may error, which is fine
      try {
        await res.clone().text();
      } catch {
        /* aborted */
      }
      return res;
    },
    () => undefined,
  );
}

type Body = { data?: any; errors?: Array<{ message: string; extensions?: Record<string, unknown> }> };

// ---------- shared scenario bodies (reused by EB11) ----------

async function scenarioControl(b: Backend, loaderOptions?: GatewayOptions['loaderOptions']) {
  await reset(b);
  const events: DownstreamCallEvent[] = [];
  const gw = createGateway({ restBaseUrl: b.url, loaderOptions, onDownstreamCall: (e) => events.push(e) });
  const ac = new AbortController();
  const res = await gw.fetch(gqlRequest({ query: Q }, ac.signal));
  const body = (await res.json()) as Body;
  await sleep(20);
  const s = await stats(b);
  await gw.close();
  return { status: res.status, body, events, stats: s };
}

async function scenarioAbortAfterHop1(b: Backend, loaderOptions?: GatewayOptions['loaderOptions']) {
  await reset(b);
  const events: DownstreamCallEvent[] = [];
  const ac = new AbortController();
  const gw = createGateway({
    restBaseUrl: b.url,
    loaderOptions,
    onDownstreamCall: (e) => {
      events.push(e);
      if (e.route === '/authors' && e.outcome === 'ok') ac.abort();
    },
  });
  await fire(gw, gqlRequest({ query: Q }, ac.signal));
  await sleep(SETTLE);
  const s = await stats(b);
  await gw.close();
  return { events, stats: s, aborted: ac.signal.aborted };
}

async function scenarioInFlight(b: Backend) {
  await reset(b);
  const events: DownstreamCallEvent[] = [];
  const ac = new AbortController();
  const gw = createGateway({ restBaseUrl: b.url, onDownstreamCall: (e) => events.push(e) });
  const pending = fire(gw, gqlRequest({ query: Q }, ac.signal));
  await waitStats(b, (s) => route(s, '/authors') === 1);
  ac.abort();
  await pending;
  await sleep(SETTLE);
  const s = await stats(b);
  await gw.close();
  return { events, stats: s };
}

function expectInFlightCancelled(r: { events: DownstreamCallEvent[]; stats: Stats }): void {
  expect(r.stats.total).toBe(1);
  expect(r.stats.byRoute).toEqual({ '/authors': 1 });
  expect(r.events).toHaveLength(1);
  const e = r.events[0]!;
  expect(e).toMatchObject({ route: '/authors', status: null, outcome: 'aborted', errorCode: 'CLIENT_CLOSED_REQUEST' });
  expect(e.durationMs).toBeLessThan(250);
  expect(['unreachable', 'timeout']).not.toContain(e.outcome);
  expect(['DOWNSTREAM_UNREACHABLE', 'DOWNSTREAM_TIMEOUT']).not.toContain(e.errorCode);
}

describe.concurrent('iter-96 client-disconnect cancellation', () => {
  // ---------- EB1 ----------
  it('EB1: an unaborted signal changes nothing (200, same data, 3 calls, 3 ok events; NAIVE 21)', async () => {
    await withBackend(async (b) => {
      // reference: no signal at all
      await reset(b);
      const ref = createGateway({ restBaseUrl: b.url });
      const refRes = await ref.fetch(gqlRequest({ query: Q }));
      const refBody = (await refRes.json()) as Body;
      await ref.close();

      const r = await scenarioControl(b);
      expect(r.status).toBe(200);
      expect(r.body.errors).toBeUndefined();
      expect(r.body.data).toEqual(refBody.data);
      expect(r.body.data.authors.edges).toHaveLength(5);
      expect(r.body.data.authors.edges[0].node.books.length).toBeGreaterThan(0);
      expect(r.stats.total).toBe(3);
      expect(r.stats.byRoute).toEqual({ '/authors': 1, '/books/by-author': 1, '/reviews/by-book': 1 });
      expect(r.events).toHaveLength(3);
      expect(r.events.every((e) => e.outcome === 'ok')).toBe(true);

      const naive = await scenarioControl(b, NAIVE);
      expect(naive.status).toBe(200);
      expect(naive.body.data).toEqual(refBody.data);
      expect(naive.stats.total).toBe(21);
    });
  });

  // ---------- EB2 ----------
  it('EB2: abort inside the hook on the /authors ok event -> 1 call, 1 event', async () => {
    await withBackend(async (b) => {
      const r = await scenarioAbortAfterHop1(b);
      expect(r.aborted).toBe(true);
      expect(r.stats.total).toBe(1);
      expect(r.stats.byRoute).toEqual({ '/authors': 1 });
      expect(route(r.stats, '/books/by-author')).toBe(0);
      expect(route(r.stats, '/reviews/by-book')).toBe(0);
      expect(r.events).toHaveLength(1);
      expect(r.events[0]).toMatchObject({ route: '/authors', outcome: 'ok' });
    });
  });

  // ---------- EB3 ----------
  it('EB3: the same hook-driven abort under NAIVE -> 1 call, 1 event (HEAD 21)', async () => {
    await withBackend(async (b) => {
      const r = await scenarioAbortAfterHop1(b, NAIVE);
      expect(r.stats.total).toBe(1);
      expect(r.stats.byRoute).toEqual({ '/authors': 1 });
      expect(r.events).toHaveLength(1);
    });
  });

  // ---------- EB4 ----------
  it('EB4: an in-flight call is cancelled as CLIENT_CLOSED_REQUEST / aborted, never unreachable or timeout', async () => {
    await withBackend(async (b) => {
      expectInFlightCancelled(await scenarioInFlight(b));
    });
  });

  // ---------- EB5 ----------
  it('EB5: real socket via nodeListener: a fetch aborted after /authors arrives costs 1 call', async () => {
    await withBackend(async (b) => {
      await reset(b);
      const gw = createGateway({ restBaseUrl: b.url });
      const server = createServer(gw.nodeListener);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as AddressInfo).port;
      try {
        const ac = new AbortController();
        const pending = fetch(`http://127.0.0.1:${port}/graphql`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: Q }),
          signal: ac.signal,
        }).then(
          (r) => r.text(),
          () => undefined,
        );
        await waitStats(b, (s) => route(s, '/authors') === 1);
        ac.abort();
        await pending.catch(() => undefined);
        await sleep(SETTLE);
        const s = await stats(b);
        expect(s.total).toBe(1);
        expect(route(s, '/books/by-author')).toBe(0);
        expect(route(s, '/reviews/by-book')).toBe(0);
      } finally {
        await gw.close();
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  });

  // ---------- EB6 ----------
  it('EB6: a @defer stream cancelled after part 1 skips /reviews/by-book; read to the end it costs 3', async () => {
    await withBackend(async (b) => {
      await reset(b);
      const gw = createGateway({ restBaseUrl: b.url });
      const ac = new AbortController();
      const res = await gw.fetch(gqlRequest({ query: Q_DEFER }, ac.signal, 'multipart/mixed'));
      expect(res.headers.get('content-type') ?? '').toContain('multipart/mixed');
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let text = '';
      while (!/"hasNext"\s*:\s*true/.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
      expect(text).toMatch(/"hasNext"\s*:\s*true/);
      expect(text).toContain('"name"');
      ac.abort();
      await reader.cancel().catch(() => undefined);
      await sleep(SETTLE);
      const s = await stats(b);
      expect(route(s, '/reviews/by-book')).toBe(0);
      expect(s.total).toBeLessThanOrEqual(2);
      expect(route(s, '/authors')).toBe(1);

      // the same query read to the end still costs 3
      await reset(b);
      const full = await gw.fetch(gqlRequest({ query: Q_DEFER }, new AbortController().signal, 'multipart/mixed'));
      const all = await full.text();
      expect(all).toMatch(/"hasNext"\s*:\s*false/);
      expect(all).toContain('"rating"');
      await sleep(20);
      const s2 = await stats(b);
      expect(s2.total).toBe(3);
      expect(s2.byRoute).toEqual({ '/authors': 1, '/books/by-author': 1, '/reviews/by-book': 1 });
      await gw.close();
    });
  });

  // ---------- EB7 ----------
  it('EB7: an aborted batched POST shares one fate (/books/by-author 0, total <= 3); unaborted it costs 5', async () => {
    await withBackend(async (b) => {
      const batch = [{ query: Q }, { query: Q_BOOK }];
      await reset(b);
      const gw = createGateway({ restBaseUrl: b.url, maxBatchSize: 5 });
      const ac = new AbortController();
      const pending = fire(gw, gqlRequest(batch, ac.signal));
      await waitStats(b, (s) => s.total >= 1);
      ac.abort();
      await pending;
      await sleep(SETTLE);
      const s = await stats(b);
      expect(route(s, '/books/by-author')).toBe(0);
      expect(s.total).toBeLessThanOrEqual(3);

      await reset(b);
      const res = await gw.fetch(gqlRequest(batch, new AbortController().signal));
      expect(res.status).toBe(200);
      const arr = (await res.json()) as Body[];
      expect(arr).toHaveLength(2);
      expect(arr[0]!.errors).toBeUndefined();
      expect(arr[0]!.data.authors.edges).toHaveLength(5);
      expect(arr[1]!.errors).toBeUndefined();
      expect(arr[1]!.data.book.title).toEqual(expect.any(String));
      await sleep(20);
      expect((await stats(b)).total).toBe(5);
      await gw.close();
    });
  });

  // ---------- EB8 ----------
  it('EB8: one /readyz prober leaving does not cancel the check a concurrent prober shares', async () => {
    await withBackend(async (b) => {
      await reset(b);
      const gw = createGateway({ restBaseUrl: b.url });
      const ac = new AbortController();
      const first = fire(gw, new Request('http://g/readyz', { signal: ac.signal }));
      const second = Promise.resolve(gw.fetch(new Request('http://g/readyz')));
      await sleep(50);
      ac.abort();
      const res = await second;
      expect(res.status).toBe(200);
      expect(JSON.parse(await res.text())).toEqual({ status: 'ready' });
      await first;
      await sleep(SETTLE);
      expect((await stats(b)).total).toBe(1);
      await gw.close();
    });
  });

  // ---------- EB9 ----------
  it('EB9: timeouts keep DOWNSTREAM_TIMEOUT / outcome timeout with a never-aborting signal (and without one)', async () => {
    await withBackend(async (b) => {
      for (const signal of [new AbortController().signal, undefined]) {
        const events: DownstreamCallEvent[] = [];
        const gw = createGateway({ restBaseUrl: b.url, downstreamTimeoutMs: 50, onDownstreamCall: (e) => events.push(e) });
        const res = await gw.fetch(gqlRequest({ query: Q_TIMEOUT }, signal));
        const body = (await res.json()) as Body;
        expect(body.errors?.[0]?.extensions?.code).toBe('DOWNSTREAM_TIMEOUT');
        await sleep(20);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ outcome: 'timeout', errorCode: 'DOWNSTREAM_TIMEOUT', status: null });
        await gw.close();
      }
    });
  });

  // ---------- EB10 ----------
  it('EB10: createContext({ signal }) with an aborted signal: get() rejects CLIENT_CLOSED_REQUEST and sends nothing', async () => {
    await withBackend(async (b) => {
      await reset(b);
      const ac = new AbortController();
      ac.abort();
      const ctx = createContext({ restBaseUrl: b.url, signal: ac.signal });
      const err = await ctx.restClient.get('/authors').then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(GraphQLError);
      expect((err as GraphQLError).extensions.code).toBe('CLIENT_CLOSED_REQUEST');
      expect(ctx.restClient.stats.total).toBe(0);
      await sleep(SETTLE);
      expect((await stats(b)).total).toBe(0);

      // without signal: as at HEAD, the call is sent and counted
      const plain = createContext({ restBaseUrl: b.url });
      const data = await plain.restClient.get('/authors');
      expect(data).toBeTruthy();
      expect(plain.restClient.stats.total).toBe(1);
      expect((await stats(b)).total).toBe(1);
    }, 20);
  });
});

// ---------- EB11 (patches a global, so sequential) ----------
describe('EB11: works without AbortSignal.any (Node 20.0-20.2)', () => {
  it('EB2, EB4 and the EB1 control hold with AbortSignal.any undefined', async () => {
    const desc = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    expect(desc).toBeDefined();
    Object.defineProperty(AbortSignal, 'any', { ...desc!, value: undefined });
    try {
      expect((AbortSignal as unknown as { any?: unknown }).any).toBeUndefined();
      await withBackend(async (b) => {
        const [hop1, inflight, control] = await Promise.all([
          withBackend((b2) => scenarioAbortAfterHop1(b2)),
          withBackend((b3) => scenarioInFlight(b3)),
          scenarioControl(b),
        ]);
        expect(hop1.stats.total).toBe(1);
        expect(hop1.stats.byRoute).toEqual({ '/authors': 1 });
        expect(hop1.events).toHaveLength(1);
        expectInFlightCancelled(inflight);
        expect(control.status).toBe(200);
        expect(control.body.errors).toBeUndefined();
        expect(control.stats.total).toBe(3);
        expect(control.events).toHaveLength(3);
      });
    } finally {
      Object.defineProperty(AbortSignal, 'any', desc!);
    }
    expect(typeof AbortSignal.any).toBe('function');
  });
});

// ---------- EB12 ----------
describe('EB12: typed vocabulary + README', () => {
  it("DownstreamCallEvent['outcome'] admits 'aborted' (checked by tsc --noEmit)", () => {
    const outcome: DownstreamCallEvent['outcome'] = 'aborted';
    expectTypeOf<'aborted'>().toMatchTypeOf<DownstreamCallEvent['outcome']>();
    expect(outcome).toBe('aborted');
  });

  const section7 = readme.slice(readme.indexOf('## 7.'), readme.indexOf('## 8.'));

  it('README section 7 has a section naming CLIENT_CLOSED_REQUEST that says further calls stop and in-flight calls are cancelled', () => {
    expect(section7.length).toBeGreaterThan(100);
    const m = /### Client disconnect\n([\s\S]*?)\n### /.exec(section7);
    expect(m, 'no "### Client disconnect" section in README section 7').not.toBeNull();
    const sec = m![1]!;
    expect(sec).toContain('CLIENT_CLOSED_REQUEST');
    expect(sec).toMatch(/stops? (spending |sending |further )?downstream calls/i);
    expect(sec).toMatch(/in flight[^.]*cancelled/i);
  });

  it('README Observability lists aborted among outcomes and CLIENT_CLOSED_REQUEST among errorCodes', () => {
    const m = /### Observability\n([\s\S]*)$/.exec(section7);
    expect(m).not.toBeNull();
    const obs = m![1]!;
    const outcomes = /`outcome` is one of ([^.]*)\./.exec(obs);
    expect(outcomes).not.toBeNull();
    expect(outcomes![1]).toContain('`aborted`');
    const codes = /`errorCode` is the client-visible `extensions.code` \(([^)]*)\)/.exec(obs);
    expect(codes).not.toBeNull();
    expect(codes![1]).toContain('`CLIENT_CLOSED_REQUEST`');
  });
});

// ---------- Fix-review pins (REV BLOCKING 1, carried from the fix stage) ----------
/*
 * A request with more than 10 concurrent downstream calls must not print
 * `MaxListenersExceededWarning` on its edge signal, and must leave that
 * signal listeners as HEAD did (1, the undici one). The edge abort still fans
 * out to every in-flight call.
 */
describe('edge signal fan-out (one listener per client)', () => {
  const ALIASES = `{ ${Array.from({ length: 12 }, (_, i) => `a${i}: authors(first:${i + 1}){ totalCount }`).join(' ')} }`;
  const NESTED = Q;

  let app: FastifyInstance;
  let url: string;
  let slowApp: FastifyInstance;
  let slowUrl: string;

  beforeAll(async () => {
    app = buildBackend({ latencyMs: 20 }).app;
    url = await app.listen({ port: 0, host: '127.0.0.1' });
    slowApp = buildBackend({ latencyMs: 300 }).app;
    slowUrl = await slowApp.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await app.close();
    await slowApp.close();
  });

  async function run(query: string, loaderOptions: typeof NAIVE | undefined, signal?: AbortSignal) {
    let calls = 0;
    const gw = createGateway({ restBaseUrl: url, loaderOptions, onDownstreamCall: () => (calls += 1) });
    const res = await gw.fetch(
      new Request('http://gateway.test/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
        signal,
      }),
    );
    const body = (await res.json()) as { data?: unknown; errors?: unknown[] };
    return { status: res.status, body, calls };
  }

  it.each([
    ['12 aliased roots, BATCHED', ALIASES, undefined, 12],
    ['nested sample query, NAIVE', NESTED, NAIVE, 21],
  ] as const)('%s: 0 MaxListeners warnings, same data and calls, no listener left', async (_label, query, opts, expectedCalls) => {
    let warnings = 0;
    const onWarning = (w: Error): void => {
      if (w.name === 'MaxListenersExceededWarning') warnings += 1;
    };
    process.on('warning', onWarning);
    try {
      const control = await run(query, opts);
      const ac = new AbortController();
      const signalled = await run(query, opts, ac.signal);
      await new Promise((r) => setTimeout(r, 20)); // warnings are emitted on a later tick
      expect(warnings).toBe(0);
      expect(signalled.status).toBe(200);
      expect(signalled.body.errors).toBeUndefined();
      expect(signalled.body.data).toEqual(control.body.data);
      expect(control.calls).toBe(expectedCalls);
      expect(signalled.calls).toBe(expectedCalls);
      expect(getEventListeners(ac.signal, 'abort').length).toBeLessThanOrEqual(1);
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('an edge abort cancels all 12 concurrent in-flight calls with one listener', async () => {
    const ac = new AbortController();
    const events: string[] = [];
    const client = new RestClient(slowUrl, 5000, undefined, {}, (e) => events.push(e.outcome), ac.signal);
    const calls = Array.from({ length: 12 }, (_, i) => client.get('/authors', { offset: i, limit: 1 }).then(() => 'ok', (err: unknown) => err));
    await new Promise((r) => setTimeout(r, 30));
    expect(getEventListeners(ac.signal, 'abort').length).toBe(1);
    const started = performance.now();
    ac.abort();
    const results = await Promise.all(calls);
    expect(performance.now() - started).toBeLessThan(250);
    for (const r of results) {
      expect(r).toBeInstanceOf(GraphQLError);
      expect((r as GraphQLError).extensions.code).toBe('CLIENT_CLOSED_REQUEST');
    }
    expect(client.stats.total).toBe(12);
    expect(events).toEqual(Array.from({ length: 12 }, () => 'aborted'));
    expect(getEventListeners(ac.signal, 'abort').length).toBe(0);
  });
});
