import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend, createGateway, NAIVE, type GatewayOptions, type DownstreamCallEvent } from '../src/lib';

/**
 * iter-100: opt-in in-flight coalescing of identical downstream GETs across
 * concurrent edge requests (`coalesceInFlight`, PRODUCT row 65).
 *
 * Black-box: the bundled Fastify backend (`latencyMs: 50`) behind
 * `createGateway`, driven through `gateway.fetch`. "backend calls" is the
 * delta of the backend's own `GET /__stats` `total`. EB9-EB11 put a node:http
 * stub in front of the backend: it counts hits per path and either fails
 * `/authors` with a 500 (EB9) or HOLDS every `/authors` response until the
 * test releases it (EB4 join, EB10, EB11), so ordering is driven by events
 * (the stub's hit counter), never by a timer racing the backend.
 *
 * No assertion depends on which concurrent request "led": counts are summed
 * across responses, as the spec's accounting rule requires.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(resolve(__dirname, '..', 'README.md'), 'utf8');

const SAMPLE = `query Sample {
  authors(first: 5) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges {
      cursor
      node {
        id
        name
        books {
          id
          title
          reviews { id rating reviewer }
        }
      }
    }
  }
}`;
const ONE_CALL = '{ authors(first: 2) { edges { node { name } } } }';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Body = { data?: any; errors?: Array<{ message: string; extensions?: Record<string, unknown> }>; extensions?: any };
type Gw = ReturnType<typeof createGateway>;

let backend: FastifyInstance;
let backendUrl: string;

beforeAll(async () => {
  backend = buildBackend({ latencyMs: 50 }).app;
  backendUrl = await backend.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  const closing = backend.close();
  backend.server.closeAllConnections();
  await closing;
});

async function total(): Promise<number> {
  const s = (await (await fetch(`${backendUrl}/__stats`)).json()) as { total: number };
  return s.total;
}
/** Run `fn` and return the backend-call delta it caused (with a settle wait for stragglers). */
async function delta<T>(fn: () => Promise<T>): Promise<{ calls: number; value: T }> {
  const before = await total();
  const value = await fn();
  await sleep(120);
  return { calls: (await total()) - before, value };
}

async function post(
  gw: Gw,
  query: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<{ status: number; body: Body }> {
  const res = await gw.fetch(
    new Request('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ query }),
      signal,
    }),
  );
  return { status: res.status, body: (await res.json()) as Body };
}

async function withGw<T>(opts: Omit<GatewayOptions, 'restBaseUrl'> & { restBaseUrl?: string }, fn: (gw: Gw) => Promise<T>): Promise<T> {
  const gw = createGateway({ restBaseUrl: backendUrl, ...opts });
  try {
    return await fn(gw);
  } finally {
    await gw.close();
  }
}

let referenceData: unknown;
beforeAll(async () => {
  referenceData = await withGw({}, async (gw) => {
    const r = await post(gw, SAMPLE);
    expect(r.status).toBe(200);
    return r.body.data;
  });
});

// ---------------------------------------------------------------- stub ----

type Stub = {
  url: string;
  hits: () => number;
  release: () => void;
  close: () => Promise<void>;
};

/**
 * A stub in front of the bundled backend. `mode: 'fail'` answers `/authors`
 * with HTTP 500 after `failDelayMs`; `mode: 'hold'` holds every `/authors`
 * response until `release()` is called, then proxies it. Every other path is
 * proxied straight through. `hits()` counts `/authors` requests received.
 */
async function startStub(mode: 'fail' | 'hold', failDelayMs = 60): Promise<Stub> {
  let authorsHits = 0;
  let released = false;
  const held: Array<() => void> = [];
  const proxy = (path: string, res: ServerResponse) => {
    fetch(backendUrl + path)
      .then(async (r) => {
        const text = await r.text();
        if (res.destroyed) return;
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
        res.end(text);
      })
      .catch(() => {
        if (!res.destroyed) {
          res.writeHead(502);
          res.end();
        }
      });
  };
  const server: Server = createServer((req, res) => {
    res.on('error', () => {});
    const path = req.url ?? '/';
    const isAuthors = new URL(path, 'http://stub.local').pathname === '/authors';
    if (!isAuthors) return proxy(path, res);
    authorsHits += 1;
    if (mode === 'fail') {
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"boom"}');
      }, failDelayMs);
      return;
    }
    const go = () => proxy(path, res);
    if (released) go();
    else held.push(go);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    hits: () => authorsHits,
    release: () => {
      released = true;
      for (const go of held.splice(0)) go();
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

async function until(pred: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Fire a request that may be aborted: resolves to the parsed reply, or `'rejected'` when fetch/json rejects. */
function fireAbortable(gw: Gw, query: string, signal: AbortSignal): Promise<{ status: number; body: Body } | 'rejected'> {
  return post(gw, query, {}, signal).catch(() => 'rejected' as const);
}

// ---------------------------------------------------------------- EBs -----

describe('EB1: default off is unchanged', () => {
  for (const [label, opts] of [
    ['option omitted', {}],
    ['coalesceInFlight: false', { coalesceInFlight: false }],
  ] as const) {
    it(`${label}: 2 concurrent SAMPLE requests cost 6 backend calls, each total 3`, async () => {
      await withGw(opts as GatewayOptions, async (gw) => {
        const { calls, value } = await delta(() => Promise.all([post(gw, SAMPLE), post(gw, SAMPLE)]));
        expect(calls).toBe(6);
        for (const r of value) {
          expect(r.status).toBe(200);
          expect(r.body.extensions?.downstreamCalls?.total).toBe(3);
        }
      });
    });
  }
});

describe('EB2: two concurrent identical requests share calls', () => {
  it('2 SAMPLE requests started together cost exactly 3 backend calls with identical data', async () => {
    await withGw({ coalesceInFlight: true }, async (gw) => {
      const { calls, value } = await delta(() => Promise.all([post(gw, SAMPLE), post(gw, SAMPLE)]));
      expect(calls).toBe(3);
      for (const r of value) {
        expect(r.status).toBe(200);
        expect(r.body.errors).toBeUndefined();
        expect(r.body.data).toEqual(referenceData);
      }
    });
  });
});

describe('EB3: a burst collapses', () => {
  it('option off: 50 concurrent SAMPLE requests cost exactly 150 backend calls (control)', async () => {
    await withGw({}, async (gw) => {
      const { calls } = await delta(() => Promise.all(Array.from({ length: 50 }, () => post(gw, SAMPLE))));
      expect(calls).toBe(150);
    });
  });
  it('option on: 50 concurrent SAMPLE requests cost at most 6 backend calls, all 200 with identical data', async () => {
    await withGw({ coalesceInFlight: true }, async (gw) => {
      const { calls, value } = await delta(() => Promise.all(Array.from({ length: 50 }, () => post(gw, SAMPLE))));
      expect(calls).toBeGreaterThanOrEqual(3);
      expect(calls).toBeLessThanOrEqual(6);
      expect(value).toHaveLength(50);
      for (const r of value) {
        expect(r.status).toBe(200);
        expect(r.body.errors).toBeUndefined();
        expect(r.body.data).toEqual(referenceData);
      }
    });
  });
});

describe('EB4: accounting — whoever sends, counts', () => {
  it('EB2 run: totals sum to 3 and the hook fires exactly 3 events == backend calls', async () => {
    const events: DownstreamCallEvent[] = [];
    await withGw({ coalesceInFlight: true, onDownstreamCall: (e) => events.push(e) }, async (gw) => {
      const { calls, value } = await delta(() => Promise.all([post(gw, SAMPLE), post(gw, SAMPLE)]));
      expect(calls).toBe(3);
      const sum = value.reduce((s, r) => s + (r.body.extensions?.downstreamCalls?.total as number), 0);
      expect(sum).toBe(3);
      expect(events).toHaveLength(3);
      expect(events.length).toBe(calls);
      for (const e of events) expect(e.outcome).toBe('ok');
    });
  });

  it('50-burst: totals sum to the backend calls and the hook events equal them too', async () => {
    const events: DownstreamCallEvent[] = [];
    await withGw({ coalesceInFlight: true, onDownstreamCall: (e) => events.push(e) }, async (gw) => {
      const { calls, value } = await delta(() => Promise.all(Array.from({ length: 50 }, () => post(gw, SAMPLE))));
      const sum = value.reduce((s, r) => s + (r.body.extensions?.downstreamCalls?.total as number), 0);
      expect(sum).toBe(calls);
      expect(events.length).toBe(calls);
      expect(calls).toBeLessThanOrEqual(6);
    });
  });

  it('a request whose every call was joined reports total 0 (sender reports 1)', async () => {
    const stub = await startStub('hold');
    const events: DownstreamCallEvent[] = [];
    try {
      const gw = createGateway({ restBaseUrl: stub.url, coalesceInFlight: true, onDownstreamCall: (e) => events.push(e) });
      try {
        const a = post(gw, ONE_CALL);
        await until(() => stub.hits() === 1, 'sender hit');
        const b = post(gw, ONE_CALL); // starts while the sender's call is held: must join
        await sleep(100);
        expect(stub.hits()).toBe(1);
        stub.release();
        const [ra, rb] = await Promise.all([a, b]);
        expect(ra.status).toBe(200);
        expect(rb.status).toBe(200);
        expect(rb.body.data).toEqual(ra.body.data);
        expect(ra.body.data.authors.edges).toHaveLength(2);
        expect(ra.body.extensions?.downstreamCalls?.total).toBe(1);
        expect(rb.body.extensions?.downstreamCalls?.total).toBe(0);
        await sleep(50);
        expect(stub.hits()).toBe(1);
        expect(events).toHaveLength(1);
      } finally {
        await gw.close();
      }
    } finally {
      await stub.close();
    }
  });
});

describe('EB5: not a cache', () => {
  it('2 SAMPLE requests run one after the other cost exactly 6 backend calls', async () => {
    await withGw({ coalesceInFlight: true }, async (gw) => {
      const { calls } = await delta(async () => {
        const first = await post(gw, SAMPLE);
        expect(first.status).toBe(200);
        const second = await post(gw, SAMPLE);
        expect(second.status).toBe(200);
        expect(second.body.extensions?.downstreamCalls?.total).toBe(3);
      });
      expect(calls).toBe(6);
    });
  });
});

describe('EB6: different forwarded headers never share', () => {
  const opts = { coalesceInFlight: true, forwardHeaders: ['authorization'] } as const;
  it('different authorization values: 6 backend calls', async () => {
    await withGw(opts, async (gw) => {
      const { calls, value } = await delta(() =>
        Promise.all([
          post(gw, SAMPLE, { authorization: 'Bearer user:1:read' }),
          post(gw, SAMPLE, { authorization: 'Bearer user:2:read' }),
        ]),
      );
      expect(calls).toBe(6);
      for (const r of value) expect(r.status).toBe(200);
    });
  });
  it('same authorization value: 3 backend calls', async () => {
    await withGw(opts, async (gw) => {
      const { calls, value } = await delta(() =>
        Promise.all([
          post(gw, SAMPLE, { authorization: 'Bearer user:1:read' }),
          post(gw, SAMPLE, { authorization: 'Bearer user:1:read' }),
        ]),
      );
      expect(calls).toBe(3);
      for (const r of value) expect(r.status).toBe(200);
    });
  });
  it('no header vs a header: 6 backend calls', async () => {
    await withGw(opts, async (gw) => {
      const { calls } = await delta(() =>
        Promise.all([post(gw, SAMPLE), post(gw, SAMPLE, { authorization: 'Bearer user:1:read' })]),
      );
      expect(calls).toBe(6);
    });
  });
});

describe('EB7: different arguments never share', () => {
  it('first:2 and first:3 concurrently cost 2 backend calls and return 2 and 3 edges', async () => {
    await withGw({ coalesceInFlight: true }, async (gw) => {
      const { calls, value } = await delta(() =>
        Promise.all([
          post(gw, '{ authors(first: 2) { edges { node { name } } } }'),
          post(gw, '{ authors(first: 3) { edges { node { name } } } }'),
        ]),
      );
      expect(calls).toBe(2);
      expect(value[0].body.data.authors.edges).toHaveLength(2);
      expect(value[1].body.data.authors.edges).toHaveLength(3);
    });
  });
});

describe('EB8: NAIVE is untouched', () => {
  for (const [label, lo] of [
    ['NAIVE preset', NAIVE],
    ['literal { batch: false, cache: false }', { batch: false, cache: false }],
  ] as const) {
    it(`${label} + coalesceInFlight: 2 concurrent SAMPLE requests cost exactly 42, each total 21`, async () => {
      await withGw({ coalesceInFlight: true, loaderOptions: lo }, async (gw) => {
        const { calls, value } = await delta(() => Promise.all([post(gw, SAMPLE), post(gw, SAMPLE)]));
        expect(calls).toBe(42);
        for (const r of value) {
          expect(r.status).toBe(200);
          expect(r.body.extensions?.downstreamCalls?.total).toBe(21);
        }
      });
    });
  }
});

describe('EB9: a shared failure reaches every waiter, sent once', () => {
  it('2 concurrent requests on a failing /authors both get DOWNSTREAM_ERROR from 1 hit; a later one sends afresh', async () => {
    const stub = await startStub('fail');
    try {
      const gw = createGateway({ restBaseUrl: stub.url, coalesceInFlight: true });
      try {
        const both = await Promise.all([post(gw, ONE_CALL), post(gw, ONE_CALL)]);
        for (const r of both) {
          const codes = (r.body.errors ?? []).map((e) => e.extensions?.code);
          expect(codes).toContain('DOWNSTREAM_ERROR');
        }
        expect(stub.hits()).toBe(1);
        const third = await post(gw, ONE_CALL);
        expect((third.body.errors ?? []).map((e) => e.extensions?.code)).toContain('DOWNSTREAM_ERROR');
        expect(stub.hits()).toBe(2);
      } finally {
        await gw.close();
      }
    } finally {
      await stub.close();
    }
  });
});

function isClientClosed(r: { status: number; body: Body } | 'rejected'): boolean {
  if (r === 'rejected') return true;
  return (r.body.errors ?? []).some((e) => e.extensions?.code === 'CLIENT_CLOSED_REQUEST');
}

describe('EB10: one waiter leaving does not hurt the other', () => {
  for (const which of ['first-started (A)', 'second-started (B)'] as const) {
    it(`aborting the ${which} request leaves the other with full data, 1 hit, hook outcome ok`, async () => {
      const stub = await startStub('hold');
      const events: DownstreamCallEvent[] = [];
      try {
        const gw = createGateway({ restBaseUrl: stub.url, coalesceInFlight: true, onDownstreamCall: (e) => events.push(e) });
        try {
          const acA = new AbortController();
          const acB = new AbortController();
          const pA = fireAbortable(gw, ONE_CALL, acA.signal);
          const pB = fireAbortable(gw, ONE_CALL, acB.signal);
          await until(() => stub.hits() === 1, 'first hit');
          await sleep(100);
          expect(stub.hits()).toBe(1);
          const [leaver, stayerP] = which.startsWith('first') ? [acA, pB] : [acB, pA];
          const leaverP = which.startsWith('first') ? pA : pB;
          leaver.abort();
          const left = await leaverP;
          expect(isClientClosed(left)).toBe(true);
          stub.release();
          const stayed = await stayerP;
          expect(stayed).not.toBe('rejected');
          if (stayed === 'rejected') return;
          expect(stayed.status).toBe(200);
          expect(stayed.body.errors).toBeUndefined();
          expect(stayed.body.data.authors.edges).toHaveLength(2);
          for (const e of stayed.body.data.authors.edges) expect(typeof e.node.name).toBe('string');
          await sleep(100);
          expect(stub.hits()).toBe(1);
          const authorsEvents = events.filter((e) => e.route === '/authors');
          expect(authorsEvents).toHaveLength(1);
          expect(authorsEvents[0]?.outcome).toBe('ok');
        } finally {
          await gw.close();
        }
      } finally {
        await stub.close();
      }
    });
  }
});

describe('EB11: everyone leaving cancels the call', () => {
  it('when both waiters abort, the held fetch is cancelled: outcome aborted, CLIENT_CLOSED_REQUEST, no further calls', async () => {
    const stub = await startStub('hold');
    const events: DownstreamCallEvent[] = [];
    try {
      const gw = createGateway({ restBaseUrl: stub.url, coalesceInFlight: true, onDownstreamCall: (e) => events.push(e) });
      try {
        const acA = new AbortController();
        const acB = new AbortController();
        const pA = fireAbortable(gw, ONE_CALL, acA.signal);
        const pB = fireAbortable(gw, ONE_CALL, acB.signal);
        await until(() => stub.hits() === 1, 'first hit');
        await sleep(100);
        acA.abort();
        acB.abort();
        const [ra, rb] = await Promise.all([pA, pB]);
        expect(isClientClosed(ra)).toBe(true);
        expect(isClientClosed(rb)).toBe(true);
        // the shared fetch is cancelled BEFORE the backend answers: its event arrives while still held
        await until(() => events.length >= 1, 'aborted hook event');
        expect(events).toHaveLength(1);
        expect(events[0]?.route).toBe('/authors');
        expect(events[0]?.outcome).toBe('aborted');
        expect(events[0]?.errorCode).toBe('CLIENT_CLOSED_REQUEST');
        stub.release();
        await sleep(150);
        expect(stub.hits()).toBe(1);
        expect(events).toHaveLength(1);
      } finally {
        await gw.close();
      }
    } finally {
      await stub.close();
    }
  });
});

describe('EB12: validation', () => {
  for (const bad of ['yes', 1, null] as unknown[]) {
    it(`coalesceInFlight: ${JSON.stringify(bad)} throws a TypeError naming the option (not "Unknown option")`, () => {
      let err: unknown;
      try {
        createGateway({ restBaseUrl: backendUrl, coalesceInFlight: bad as boolean });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TypeError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/coalesceInFlight/);
      expect(msg).not.toMatch(/^Unknown createGateway option/);
    });
  }
  for (const [label, opts] of [
    ['true', { coalesceInFlight: true }],
    ['false', { coalesceInFlight: false }],
    ['omitted', {}],
  ] as const) {
    it(`coalesceInFlight ${label} is accepted`, async () => {
      const gw = createGateway({ restBaseUrl: backendUrl, ...(opts as Partial<GatewayOptions>) });
      try {
        const r = await post(gw, ONE_CALL);
        expect(r.status).toBe(200);
        expect(r.body.data.authors.edges).toHaveLength(2);
      } finally {
        await gw.close();
      }
    });
  }
});

describe('EB13: docs', () => {
  const row = readme.split('\n').find((l) => l.startsWith('| `coalesceInFlight`')) ?? '';
  it('the options table has a coalesceInFlight row with default false', () => {
    expect(row).not.toBe('');
    const cells = row.split('|').map((c) => c.trim());
    expect(cells[2]).toMatch(/boolean/);
    expect(cells[3]).toBe('`false`');
  });
  it('the row states the key (URL plus forwarded header values)', () => {
    expect(row).toMatch(/URL/);
    expect(row).toMatch(/header/i);
  });
  it('the row states it has no effect under NAIVE loaders', () => {
    expect(row).toMatch(/no effect under NAIVE/i);
  });
  it('the row states a joined call counts 0 in downstreamCalls', () => {
    expect(row).toMatch(/joined call counts 0 in `downstreamCalls`/);
  });
  it('"Nothing is shared between separate HTTP requests" is qualified with coalesceInFlight in the same sentence', () => {
    const i = readme.indexOf('Nothing is shared between separate HTTP requests');
    expect(i).toBeGreaterThan(-1);
    const rest = readme.slice(i);
    const end = rest.search(/\.(\s|$)/);
    const sentence = end === -1 ? rest : rest.slice(0, end);
    expect(sentence).toMatch(/coalesceInFlight/);
  });
});
