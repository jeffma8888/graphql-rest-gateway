import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend, createGateway, type GatewayOptions, type DownstreamCallEvent } from '../src/lib';
import { RestClient } from '../src/gateway/datasources/rest-client';
import { BENCHMARK_QUERY } from '../benchmark/benchmark';

/**
 * iter-116: Server-Timing `dur` is read from ONE per-request settled-duration
 * sum kept by the request-scoped `RestClient` (PRODUCT row 131). The operator's
 * `onDownstreamCall` hook is passed through unwrapped, and the header is timed
 * even when no hook is configured.
 *
 * Black-box: every case builds its OWN bundled Fastify backend on port 0 and
 * drives `createGateway(...).fetch` in-process. Call counts come from the
 * backend's `GET /__stats`. No wall-clock bound is asserted (H2): durations are
 * checked by exact equality with the hook's own `durationMs` values and by the
 * physical floor N × latency − 1 (load only ever adds time).
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = BENCHMARK_QUERY;
const FORMAT = /^downstream;dur=\d+\.\d;desc="\d+ calls?"$/;
const ZERO = 'downstream;dur=0.0;desc="0 calls"';
const L = 12; // backend latency per call, ms
const EVENT_KEYS = ['durationMs', 'errorCode', 'outcome', 'route', 'status'];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Gw = ReturnType<typeof createGateway>;
type Stats = { total: number; byRoute: Record<string, number> };
type Reply = { status: number; st: string | null; text: string; body: any };

function parseHeader(h: string | null): { durText: string; dur: number; n: number } {
  expect(h, 'server-timing header missing').not.toBeNull();
  expect(h!).toMatch(FORMAT);
  const m = /^downstream;dur=(\d+\.\d);desc="(\d+) calls?"$/.exec(h!)!;
  return { durText: m[1]!, dur: Number(m[1]), n: Number(m[2]) };
}

async function startBackend(latencyMs = 0): Promise<{ url: string; stats: () => Promise<Stats>; close: () => Promise<void> }> {
  const app: FastifyInstance = buildBackend({ latencyMs }).app;
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return {
    url,
    stats: async () => (await (await fetch(`${url}/__stats`)).json()) as Stats,
    close: async () => {
      const closing = app.close();
      app.server.closeAllConnections();
      await closing;
    },
  };
}

type Env = {
  gw: Gw;
  url: string;
  /** Run `fn`, return the backend hit delta it caused (after a settle pause). */
  measure: <R>(fn: () => Promise<R>) => Promise<{ calls: number; value: R }>;
};

/** NOTE: the hook (if any) is handed to createGateway exactly as given -- no wrapper. */
async function withGw<T>(opts: Omit<GatewayOptions, 'restBaseUrl'>, fn: (env: Env) => Promise<T>, latencyMs = 0): Promise<T> {
  const be = await startBackend(latencyMs);
  const gw = createGateway({ restBaseUrl: be.url, ...opts });
  const measure: Env['measure'] = async (f) => {
    const before = await be.stats();
    const value = await f();
    await sleep(25);
    const after = await be.stats();
    return { calls: after.total - before.total, value };
  };
  try {
    return await fn({ gw, url: be.url, measure });
  } finally {
    await gw.close();
    await be.close();
  }
}

async function post(gw: Gw, query: string): Promise<Reply> {
  const res = await gw.fetch(
    new Request('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query }),
    }),
  );
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, st: res.headers.get('server-timing'), text, body };
}

const totalOf = (b: any) => b?.extensions?.downstreamCalls?.total as number;
const sumMs = (evs: DownstreamCallEvent[]) => evs.reduce((s, e) => s + e.durationMs, 0);

// ------------------------------------------------------------------- EBs ---

describe('EB1: iter-110 suite is present and untouched in shape', () => {
  it('test_iter110_behavior.test.ts still exists and still covers EB1..EB12 describe blocks', () => {
    const src = readFileSync(resolve(root, 'test', 'test_iter110_behavior.test.ts'), 'utf8');
    for (let i = 1; i <= 12; i++) expect(src, `EB${i}`).toContain(`describe('EB${i}:`);
    // the duration oracle it encodes (tolerance 0.1) is still there
    expect(src).toContain('Σ event.durationMs');
  });
});

describe('EB2: dur equals the hook sum EXACTLY', () => {
  it(`latency ${L} ms, 5 sequential SAMPLE requests: dur === (Σ durationMs).toFixed(1), each only its own`, async () => {
    const events: DownstreamCallEvent[] = [];
    await withGw(
      { serverTiming: true, onDownstreamCall: (e) => void events.push(e) },
      async ({ gw, measure }) => {
        for (let i = 0; i < 5; i++) {
          const start = events.length;
          const m = await measure(() => post(gw, SAMPLE));
          expect(m.value.status).toBe(200);
          expect(m.value.body.errors).toBeUndefined();
          const h = parseHeader(m.value.st);
          expect(m.value.st).toContain('desc="3 calls"');
          expect(h.n).toBe(3);
          expect(totalOf(m.value.body)).toBe(3);
          const mine = events.slice(start);
          expect(mine).toHaveLength(3);
          expect(m.calls).toBe(3);
          // exact string equality, no tolerance; only THIS request's events
          expect(h.durText, `request ${i}`).toBe(sumMs(mine).toFixed(1));
          expect(h.dur).toBeGreaterThanOrEqual(3 * L - 1);
        }
        expect(events).toHaveLength(15);
      },
      L,
    );
  });
});

describe('EB3: timed without a hook', () => {
  it(`no onDownstreamCall, latency ${L} ms: SAMPLE is "3 calls" and dur >= 3×L − 1`, async () => {
    await withGw(
      { serverTiming: true },
      async ({ gw, measure }) => {
        for (let i = 0; i < 2; i++) {
          const m = await measure(() => post(gw, SAMPLE));
          expect(m.value.status).toBe(200);
          const h = parseHeader(m.value.st);
          expect(m.value.st).toContain('desc="3 calls"');
          expect(h.n).toBe(3);
          expect(totalOf(m.value.body)).toBe(3);
          expect(m.calls).toBe(3);
          expect(h.dur).toBeGreaterThanOrEqual(3 * L - 1);
        }
      },
      L,
    );
  });

  it('no hook, one-call root query: "1 call" with dur >= L − 1 (never the 0.0 of an untimed client)', async () => {
    await withGw(
      { serverTiming: true },
      async ({ gw }) => {
        const r = await post(gw, '{ book(id: "a1-b1") { title } }');
        const h = parseHeader(r.st);
        expect(h.n).toBe(1);
        expect(r.st).toContain('desc="1 call"');
        expect(h.dur).toBeGreaterThanOrEqual(L - 1);
      },
      L,
    );
  });
});

describe('EB4: hook passed through unwrapped', () => {
  async function record(serverTiming: boolean) {
    const thisVals: unknown[] = [];
    const argc: number[] = [];
    const keys: string[][] = [];
    const events: DownstreamCallEvent[] = [];
    const hook = function (this: unknown, ...args: unknown[]) {
      thisVals.push(this);
      argc.push(args.length);
      const e = args[0] as DownstreamCallEvent;
      keys.push(Object.keys(e).sort());
      events.push(e);
    } as unknown as GatewayOptions['onDownstreamCall'];
    const out = await withGw({ serverTiming, onDownstreamCall: hook }, async ({ gw, measure }) => {
      const m = await measure(() => post(gw, SAMPLE));
      return { calls: m.calls, reply: m.value };
    });
    return { thisVals, argc, keys, events, ...out };
  }

  it('one event per sent call, own keys exactly {route,status,durationMs,outcome,errorCode}; same this/arity as off', async () => {
    const on = await record(true);
    const off = await record(false);
    for (const run of [on, off]) {
      expect(run.calls).toBe(3);
      expect(run.events).toHaveLength(3);
      expect(run.argc).toEqual([1, 1, 1]);
      for (const k of run.keys) expect(k).toEqual(EVENT_KEYS);
      for (const e of run.events) {
        expect(e.outcome).toBe('ok');
        expect(e.status).toBe(200);
        expect(e.errorCode).toBeNull();
        expect(typeof e.durationMs).toBe('number');
      }
    }
    expect(on.thisVals).toHaveLength(3);
    expect(on.thisVals).toEqual(off.thisVals);
    expect(on.argc).toEqual(off.argc);
    expect(on.keys).toEqual(off.keys);
    expect(on.events.map((e) => e.route).sort()).toEqual(off.events.map((e) => e.route).sort());
    expect(on.reply.st).not.toBeNull();
    expect(off.reply.st).toBeNull();
  });
});

describe('EB5: a failing hook still costs time and nothing else', () => {
  const variants: Array<[string, () => GatewayOptions['onDownstreamCall']]> = [
    ['sync throw', () => () => {
      throw new Error('hook boom');
    }],
    ['rejected promise', () => () => Promise.reject(new Error('hook reject'))],
  ];

  for (const [name, make] of variants) {
    it(`${name}: 200, data byte-identical to hook-free, 3 calls, dur >= 3×L − 1, no unhandledRejection`, async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (r: unknown) => void unhandled.push(r);
      process.on('unhandledRejection', onUnhandled);
      try {
        const plain = await withGw({ serverTiming: true }, async ({ gw }) => post(gw, SAMPLE), L);
        let fired = 0;
        const inner = make()!;
        const hook: GatewayOptions['onDownstreamCall'] = (e) => {
          fired++;
          return inner(e);
        };
        await withGw(
          { serverTiming: true, onDownstreamCall: hook },
          async ({ gw, measure }) => {
            const m = await measure(() => post(gw, SAMPLE));
            expect(m.value.status).toBe(200);
            expect(m.value.body.errors).toBeUndefined();
            expect(JSON.stringify(m.value.body.data)).toBe(JSON.stringify(plain.body.data));
            const h = parseHeader(m.value.st);
            expect(h.n).toBe(3);
            expect(totalOf(m.value.body)).toBe(3);
            expect(m.calls).toBe(3);
            expect(h.dur).toBeGreaterThanOrEqual(3 * L - 1);
            expect(fired).toBe(3);
          },
          L,
        );
        await sleep(30);
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });
  }
});

describe('EB6: shared and coalesced calls count per request', () => {
  it('coalesceInFlight burst of 10: N == own total; ΣN == events == hits; |Σdur − Σevents| ≤ 0.501', async () => {
    const events: DownstreamCallEvent[] = [];
    await withGw(
      { serverTiming: true, coalesceInFlight: true, onDownstreamCall: (e) => void events.push(e) },
      async ({ gw, measure }) => {
        const m = await measure(() => Promise.all(Array.from({ length: 10 }, () => post(gw, SAMPLE))));
        let sumN = 0;
        let sumDur = 0;
        for (const r of m.value) {
          expect(r.status).toBe(200);
          expect(r.body.errors).toBeUndefined();
          const h = parseHeader(r.st);
          expect(h.n).toBe(totalOf(r.body));
          sumN += h.n;
          sumDur += h.dur;
        }
        expect(sumN).toBe(events.length);
        expect(sumN).toBe(m.calls);
        // coalescing really happened, otherwise joiners are not exercised
        expect(m.calls).toBeLessThan(10 * 3);
        expect(m.calls).toBeGreaterThanOrEqual(3);
        expect(Math.abs(sumDur - sumMs(events))).toBeLessThanOrEqual(0.05 * 10 + 0.001);
      },
      L,
    );
  });

  it('downstreamCacheTtlMs 60000: identical repeat is exactly dur=0.0;desc="0 calls" at 0 hits and 0 events', async () => {
    const events: DownstreamCallEvent[] = [];
    await withGw(
      { serverTiming: true, downstreamCacheTtlMs: 60_000, onDownstreamCall: (e) => void events.push(e) },
      async ({ gw, measure }) => {
        const a = await measure(() => post(gw, SAMPLE));
        const ha = parseHeader(a.value.st);
        expect(ha.n).toBe(3);
        expect(ha.durText).toBe(sumMs(events).toFixed(1));
        expect(ha.dur).toBeGreaterThanOrEqual(3 * L - 1);
        const before = events.length;
        const b = await measure(() => post(gw, SAMPLE));
        expect(b.value.st).toBe(ZERO);
        expect(totalOf(b.value.body)).toBe(0);
        expect(b.calls).toBe(0);
        expect(events.length).toBe(before);
        expect(b.value.body.data).toEqual(a.value.body.data);
      },
      L,
    );
  });
});

describe('EB7: RestClient settled-duration sum resets together with stats', () => {
  it('0 when fresh; grows only on a SENT call; unchanged on a budget refusal; resetStats zeros it with stats.total', async () => {
    const be = await startBackend(L);
    try {
      const client = new RestClient(be.url, 5000, 2);
      const c = client as unknown as { settledMs: number };
      expect(c.settledMs).toBe(0);
      expect(client.stats.total).toBe(0);

      await client.get('/authors', { offset: 0, limit: 1 } as any);
      const one = c.settledMs;
      expect(client.stats.total).toBe(1);
      expect(one).toBeGreaterThanOrEqual(L - 1);

      await client.get('/authors', { offset: 1, limit: 1 } as any);
      const two = c.settledMs;
      expect(client.stats.total).toBe(2);
      expect(two).toBeGreaterThanOrEqual(one + L - 1);

      // budget of 2 is spent: the third call is refused, never sent, adds nothing
      const before = (await be.stats()).total;
      const refused = await client.get('/authors', { offset: 2, limit: 1 } as any).then(
        () => null,
        (err: any) => err,
      );
      expect(refused).not.toBeNull();
      expect(refused.extensions?.code).toBe('DOWNSTREAM_BUDGET_EXCEEDED');
      expect((await be.stats()).total).toBe(before);
      expect(c.settledMs).toBe(two);
      expect(client.stats.total).toBe(2);

      client.resetStats();
      expect(c.settledMs).toBe(0);
      expect(client.stats.total).toBe(0);
    } finally {
      await be.close();
    }
  });

  it('a failed sent call (HTTP 404) still settles and adds its time', async () => {
    const be = await startBackend(L);
    try {
      const client = new RestClient(be.url, 5000);
      const c = client as unknown as { settledMs: number };
      const err = await client.get('/books/nope' as any).then(
        () => null,
        (e: unknown) => e,
      );
      expect(client.stats.total).toBe(1);
      expect(c.settledMs).toBeGreaterThan(0);
      void err;
    } finally {
      await be.close();
    }
  });

  it('the sum is not settable from outside (assignment throws in strict ESM, value unchanged)', async () => {
    const client = new RestClient('http://127.0.0.1:9', 5000);
    const c = client as unknown as { settledMs: number };
    expect(c.settledMs).toBe(0);
    expect(() => {
      c.settledMs = 123;
    }).toThrow(TypeError);
    expect(c.settledMs).toBe(0);
    expect(Object.keys(client)).not.toContain('settledMs');
  });

  it('two clients keep separate sums (per instance, never shared)', async () => {
    const be = await startBackend(L);
    try {
      const a = new RestClient(be.url, 5000);
      const b = new RestClient(be.url, 5000);
      await a.get('/authors', { offset: 0, limit: 1 } as any);
      expect((a as unknown as { settledMs: number }).settledMs).toBeGreaterThan(0);
      expect((b as unknown as { settledMs: number }).settledMs).toBe(0);
    } finally {
      await be.close();
    }
  });
});

describe('EB8: the deletion is real (static)', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  }

  it('no file under src names DownstreamTiming', () => {
    const files = walk(resolve(root, 'src')).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    const hits = files.filter((f) => readFileSync(f, 'utf8').includes('DownstreamTiming'));
    expect(hits).toEqual([]);
  });

  it('server.ts has no timings WeakMap and no .wrap(', () => {
    const s = readFileSync(resolve(root, 'src', 'gateway', 'server.ts'), 'utf8');
    expect(s.length).toBeGreaterThan(1000);
    expect(s).not.toMatch(/timings\s*=\s*new\s+WeakMap/);
    expect(s).not.toMatch(/\btimings\.(set|get)\(/);
    expect(s).not.toContain('.wrap(');
  });

  it('rest-client.ts sendCounted has no hook-free early return and no "fast path" comment', () => {
    const s = readFileSync(resolve(root, 'src', 'gateway', 'datasources', 'rest-client.ts'), 'utf8');
    expect(s).toContain('sendCounted');
    expect(s).not.toContain('if (!this.onCall) return');
    expect(s.toLowerCase()).not.toContain('hook-free fast path');
  });

  it('server-timing.ts keeps formatServerTiming and serverTimingPlugin', () => {
    const s = readFileSync(resolve(root, 'src', 'gateway', 'server-timing.ts'), 'utf8');
    expect(s).toContain('formatServerTiming');
    expect(s).toContain('serverTimingPlugin');
    expect(s).toContain('DownstreamTotals');
  });
});

describe('EB9: off is unchanged', () => {
  for (const off of [{}, { serverTiming: false }] as Array<Omit<GatewayOptions, 'restBaseUrl'>>) {
    it(`serverTiming ${JSON.stringify(off)}: no header, 3 hits, total 3, 3 events, body byte-identical to an on run`, async () => {
      const onBody = await withGw({ serverTiming: true }, async ({ gw }) => {
        const r = await post(gw, SAMPLE);
        expect(r.st).not.toBeNull();
        return r.text;
      });
      const events: DownstreamCallEvent[] = [];
      await withGw({ ...off, onDownstreamCall: (e) => void events.push(e) }, async ({ gw, measure }) => {
        const m = await measure(() => post(gw, SAMPLE));
        expect(m.value.status).toBe(200);
        expect(m.value.st).toBeNull();
        expect(m.calls).toBe(3);
        expect(totalOf(m.value.body)).toBe(3);
        expect(events).toHaveLength(3);
        expect(m.value.text).toBe(onBody);
      });
    });
  }

  it('the N+1 regression test still asserts the batched SAMPLE-shaped count', () => {
    const s = readFileSync(resolve(root, 'test', 'n-plus-1.test.ts'), 'utf8');
    expect(s.length).toBeGreaterThan(200);
    expect(s).toMatch(/toBe\(\s*3\s*\)/);
  });
});
