import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import http, { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway, NAIVE, type GatewayServer, type DownstreamCallEvent } from '../src/lib';

/**
 * iter-97: `gateway.nodeListener` inside a host framework (PRODUCT row 97).
 *
 * Black-box: the bundled Fastify REST backend behind `createGateway`, mounted
 * (a) in a Fastify 4 host via `reply.hijack()` + `Object.assign(req.raw, { body: req.body })`,
 * (b) in an "Express-shaped" plain `http.createServer` that reads the whole request
 * stream itself, sets `req.body`, and only then calls `gateway.nodeListener(req, res)`,
 * (c) directly as `createServer(gateway.nodeListener)`.
 * Every case asserts a downstream call count read from the backend own `/__stats`.
 * Latency cases (EB8, EB9) own their backends and run in a concurrent describe.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

const Q = '{ authors(first: 2) { edges { node { name books { title } } } } }';
const NQ = '{ authors(first: 5) { edges { node { name books { title reviews { rating } } } } } }';
const NQ_DEFER = '{ authors(first: 5) { edges { node { name ... @defer { books { reviews { rating } } } } } } }';
const Q_AUTHOR = 'query($id: ID!){ author(id: $id){ name } }';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Backend = { app: FastifyInstance; url: string };
type Stats = { total: number; byRoute: Record<string, number> };
async function startBackend(latencyMs?: number): Promise<Backend> {
  const app = buildBackend(latencyMs === undefined ? {} : { latencyMs }).app;
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, url };
}
async function stopBackend(b: Backend): Promise<void> {
  const closing = b.app.close();
  b.app.server.closeAllConnections();
  await closing;
}
async function stats(b: Backend): Promise<Stats> {
  return (await (await fetch(`${b.url}/__stats`)).json()) as Stats;
}
async function reset(b: Backend): Promise<void> {
  const r = await fetch(`${b.url}/__stats/reset`, { method: 'POST' });
  if (!r.ok) throw new Error('reset failed');
}

type Host = { port: number; close: () => Promise<void> };

/** Fastify 4 host; `assign: false` mounts WITHOUT handing over `req.body` (EB4a). */
async function fastifyHost(gw: GatewayServer, assign = true): Promise<Host> {
  const app = Fastify();
  app.route({
    method: ['GET', 'POST'],
    url: '/graphql',
    handler: (req, reply) => {
      reply.hijack();
      const raw = assign ? Object.assign(req.raw, { body: req.body }) : req.raw;
      gw.nodeListener(raw, reply.raw);
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  return {
    port,
    close: async () => {
      app.server.closeAllConnections();
      await app.close();
    },
  };
}

async function listen(server: Server): Promise<Host> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Express-shaped host: reads the whole stream, sets `req.body`, then calls the listener. */
async function expressHost(
  gw: GatewayServer,
  toBody: (raw: Buffer) => unknown,
  mutate?: (req: IncomingMessage) => void,
): Promise<Host> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      (req as IncomingMessage & { body?: unknown }).body = toBody(Buffer.concat(chunks));
      mutate?.(req);
      gw.nodeListener(req, res);
    });
  });
  return listen(server);
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; text: string; times: number[]; t0: number; tEnd: number };

/** Raw HTTP client over a keep-alive agent (so `connection: close` is the server own choice). */
function send(
  agent: http.Agent,
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string | Buffer,
): Promise<Reply> {
  return new Promise((resolveP, reject) => {
    const h: Record<string, string> = { ...headers };
    if (body !== undefined && h['content-length'] === undefined) h['content-length'] = String(Buffer.byteLength(body));
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h, agent }, (res) => {
      const chunks: Buffer[] = [];
      const times: number[] = [];
      res.on('data', (c: Buffer) => {
        chunks.push(c);
        times.push(Date.now());
      });
      res.on('end', () =>
        resolveP({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
          times,
          t0,
          tEnd: Date.now(),
        }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const JSON_CT = { 'content-type': 'application/json' };

async function viaFetch(gw: GatewayServer, wire: string, ct = 'application/json'): Promise<{ status: number; json: any }> {
  const res = await gw.fetch(
    new Request('http://gateway.test/graphql', { method: 'POST', headers: { 'content-type': ct }, body: wire }),
  );
  const text = await res.text();
  return { status: res.status, json: text === '' ? null : JSON.parse(text) };
}

function expectConsumed500(r: Reply): void {
  expect(r.status).toBe(500);
  expect(String(r.headers['content-type'])).toContain('application/json');
  expect(String(r.headers.connection).toLowerCase()).toBe('close');
  const body = JSON.parse(r.text) as { data?: unknown; errors: Array<{ message: string; extensions?: { code?: string } }> };
  expect(Object.keys(body)).toEqual(['errors']);
  expect(body).not.toHaveProperty('data');
  expect(body.errors).toHaveLength(1);
  expect(body.errors[0]!.extensions?.code).toBe('REQUEST_BODY_CONSUMED');
  expect(body.errors[0]!.message).toContain('already consumed');
}

// ---------------------------------------------------------------------------
describe('in-process cases (shared default-latency backend)', () => {
  let b: Backend;
  let agent: http.Agent;
  beforeAll(async () => {
    b = await startBackend();
    agent = new http.Agent({ keepAlive: true });
  });
  afterAll(async () => {
    agent.destroy();
    await stopBackend(b);
  });

  /** gateway.fetch reference for the same wire bytes, with its call count. */
  async function reference(wire: string, opts: Parameters<typeof createGateway>[0] = { restBaseUrl: '' }) {
    const gw = createGateway({ ...opts, restBaseUrl: b.url });
    try {
      await reset(b);
      const r = await viaFetch(gw, wire);
      const s = await stats(b);
      return { ...r, calls: s.total };
    } finally {
      await gw.close();
    }
  }

  // ---------- EB1 ----------
  it('EB1: Fastify mount POST Q -> 200, data equals gateway.fetch, 2 calls; NQ -> 3 calls', async () => {
    const wireQ = JSON.stringify({ query: Q });
    const wireNQ = JSON.stringify({ query: NQ });
    const refQ = await reference(wireQ);
    const refNQ = await reference(wireNQ);
    expect(refQ.status).toBe(200);
    expect(refQ.calls).toBe(2);
    const gw = createGateway({ restBaseUrl: b.url });
    const host = await fastifyHost(gw);
    try {
      await reset(b);
      const r = await send(agent, host.port, 'POST', '/graphql', JSON_CT, wireQ);
      expect(r.status).toBe(200);
      const body = JSON.parse(r.text);
      expect(body.errors).toBeUndefined();
      expect(body.data).toEqual(refQ.json.data);
      expect(body.data.authors.edges).toHaveLength(2);
      expect((await stats(b)).total).toBe(2);

      await reset(b);
      const r2 = await send(agent, host.port, 'POST', '/graphql', JSON_CT, wireNQ);
      expect(r2.status).toBe(200);
      expect(JSON.parse(r2.text).data).toEqual(refNQ.json.data);
      expect((await stats(b)).total).toBe(3);
    } finally {
      await host.close();
      await gw.close();
    }
  });

  it('EB1: Fastify mount with loaderOptions NAIVE -> 200 at 3 calls', async () => {
    const wireQ = JSON.stringify({ query: Q });
    const ref = await reference(wireQ);
    const gw = createGateway({ restBaseUrl: b.url, loaderOptions: NAIVE });
    const host = await fastifyHost(gw);
    try {
      await reset(b);
      const r = await send(agent, host.port, 'POST', '/graphql', JSON_CT, wireQ);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.text).data).toEqual(ref.json.data);
      expect((await stats(b)).total).toBe(3);
    } finally {
      await host.close();
      await gw.close();
    }
  });

  // ---------- EB2 ----------
  it.each([
    ['(a) parsed JSON object', (raw: Buffer) => JSON.parse(raw.toString('utf8'))],
    ['(b) raw JSON string', (raw: Buffer) => raw.toString('utf8')],
    ['(c) Buffer of the raw bytes', (raw: Buffer) => Buffer.from(raw)],
  ])('EB2: Express-shaped req.body %s -> 200, same data, 2 calls', async (_label, toBody) => {
    const wireQ = JSON.stringify({ query: Q });
    const ref = await reference(wireQ);
    const gw = createGateway({ restBaseUrl: b.url });
    const host = await expressHost(gw, toBody);
    try {
      await reset(b);
      const r = await send(agent, host.port, 'POST', '/graphql', JSON_CT, wireQ);
      expect(r.status).toBe(200);
      const body = JSON.parse(r.text);
      expect(body.errors).toBeUndefined();
      expect(body.data).toEqual(ref.json.data);
      expect((await stats(b)).total).toBe(2);
    } finally {
      await host.close();
      await gw.close();
    }
  });

  it('EB2: a parsed object with content-type "application/json; charset=utf-8" is rebuilt (200, 2 calls)', async () => {
    const wireQ = JSON.stringify({ query: Q });
    const ref = await reference(wireQ);
    const gw = createGateway({ restBaseUrl: b.url });
    const host = await expressHost(gw, (raw) => JSON.parse(raw.toString('utf8')));
    try {
      await reset(b);
      const r = await send(agent, host.port, 'POST', '/graphql', { 'content-type': 'application/json; charset=utf-8' }, wireQ);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.text).data).toEqual(ref.json.data);
      expect((await stats(b)).total).toBe(2);
    } finally {
      await host.close();
      await gw.close();
    }
  });

  it('EB2: a parsed object under an application/<x>+json type is handed on like gateway.fetch with the same bytes (never REQUEST_BODY_CONSUMED)', async () => {
    // Yoga itself answers this content type with 415 via gateway.fetch; the rebuilt request must reach Yoga
    // the same way (same status, same calls), rather than being refused as an unrebuildable body.
    const wireQ = JSON.stringify({ query: Q });
    const ct = 'application/vnd.example+json';
    const refGw = createGateway({ restBaseUrl: b.url });
    await reset(b);
    const ref = await viaFetch(refGw, wireQ, ct);
    const refCalls = (await stats(b)).total;
    await refGw.close();
    expect(ref.status).not.toBe(500);
    const gw = createGateway({ restBaseUrl: b.url });
    const host = await expressHost(gw, (raw) => JSON.parse(raw.toString('utf8')));
    try {
      await reset(b);
      const r = await send(agent, host.port, 'POST', '/graphql', { 'content-type': ct }, wireQ);
      expect(r.status).toBe(ref.status);
      expect(r.text).not.toContain('REQUEST_BODY_CONSUMED');
      expect(r.text === '' ? null : JSON.parse(r.text)).toEqual(ref.json);
      expect((await stats(b)).total).toBe(refCalls);
    } finally {
      await host.close();
      await gw.close();
    }
  });

  it('EB2: a parsed JSON batch array of 2 ops with maxBatchSize 2 -> 200, 2-element array equal to gateway.fetch', async () => {
    const wire = JSON.stringify([{ query: Q }, { query: Q_AUTHOR, variables: { id: 'a1' } }]);
    const ref = await reference(wire, { restBaseUrl: '', maxBatchSize: 2 });
    expect(ref.status).toBe(200);
    expect(Array.isArray(ref.json)).toBe(true);
    const gw = createGateway({ restBaseUrl: b.url, maxBatchSize: 2 });
    const host = await expressHost(gw, (raw) => JSON.parse(raw.toString('utf8')));
    try {
      await reset(b);
      const r = await send(agent, host.port, 'POST', '/graphql', JSON_CT, wire);
      expect(r.status).toBe(200);
      const body = JSON.parse(r.text);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
      expect(body.map((x: any) => x.data)).toEqual(ref.json.map((x: any) => x.data));
      expect((await stats(b)).total).toBe(ref.calls);
    } finally {
      await host.close();
      await gw.close();
    }
  });

  // ---------- EB3 ----------
  const ID = 'é😀';
  // wire bytes longer than the re-serialised form (escapes + whitespace)
  const WIRE_LONG = `{ "query" : ${JSON.stringify(Q_AUTHOR)} ,  "variables" : { "id" : "\\u00e9\\ud83d\\ude00" }   }`;

  it('EB3: re-serialised non-ASCII body under the wire content-length -> NOT_FOUND with the exact id, calls equal gateway.fetch', async () => {
    expect(JSON.parse(WIRE_LONG).variables.id).toBe(ID);
    const ref = await reference(WIRE_LONG);
    expect(ref.json.errors[0].extensions.id).toBe(ID);
    const gw = createGateway({ restBaseUrl: b.url });
    const host = await expressHost(gw, (raw) => JSON.parse(raw.toString('utf8')));
    try {
      await reset(b);
      const r = await send(agent, host.port, 'POST', '/graphql', JSON_CT, WIRE_LONG);
      expect(r.status).toBe(200);
      const body = JSON.parse(r.text);
      expect(body.data.author).toBeNull();
      expect(body.errors[0].extensions.code).toBe('NOT_FOUND');
      expect(body.errors[0].extensions.id).toBe(ID);
      expect((await stats(b)).total).toBe(ref.calls);
    } finally {
      await host.close();
      await gw.close();
    }
  });

  it('EB3: a stale content-length SHORTER than the rebuilt bytes never truncates (same result)', async () => {
    const ref = await reference(WIRE_LONG);
    const gw = createGateway({ restBaseUrl: b.url });
    const host = await expressHost(
      gw,
      (raw) => JSON.parse(raw.toString('utf8')),
      (req) => {
        req.headers['content-length'] = '12';
      },
    );
    try {
      await reset(b);
      const r = await send(agent, host.port, 'POST', '/graphql', JSON_CT, WIRE_LONG);
      expect(r.status).toBe(200);
      const body = JSON.parse(r.text);
      expect(body.data.author).toBeNull();
      expect(body.errors[0].extensions.code).toBe('NOT_FOUND');
      expect(body.errors[0].extensions.id).toBe(ID);
      expect((await stats(b)).total).toBe(ref.calls);
    } finally {
      await host.close();
      await gw.close();
    }
  });

  it('EB3: a rebuilt batch of 2 ops answers Ada Lovelace / Alan Turing for a1 / a2', async () => {
    const wire = `[ { "query": ${JSON.stringify(Q_AUTHOR)}, "variables": { "id": "\\u0061\\u0031" } } ,
      { "query": ${JSON.stringify(Q_AUTHOR)}, "variables": { "id": "a2" } } ]`;
    const ref = await reference(wire, { restBaseUrl: '', maxBatchSize: 2 });
    const gw = createGateway({ restBaseUrl: b.url, maxBatchSize: 2 });
    const host = await expressHost(gw, (raw) => JSON.parse(raw.toString('utf8')));
    try {
      await reset(b);
      const r = await send(agent, host.port, 'POST', '/graphql', JSON_CT, wire);
      expect(r.status).toBe(200);
      const body = JSON.parse(r.text);
      expect(body).toHaveLength(2);
      expect(body[0].data.author.name).toBe('Ada Lovelace');
      expect(body[1].data.author.name).toBe('Alan Turing');
      expect((await stats(b)).total).toBe(ref.calls);
    } finally {
      await host.close();
      await gw.close();
    }
  });

  // ---------- EB4 ----------
  it('EB4(a): Fastify mount WITHOUT Object.assign -> named JSON 500 REQUEST_BODY_CONSUMED, connection: close, 0 calls', async () => {
    const gw = createGateway({ restBaseUrl: b.url });
    const host = await fastifyHost(gw, false);
    try {
      await reset(b);
      const r = await send(agent, host.port, 'POST', '/graphql', JSON_CT, JSON.stringify({ query: Q }));
      expectConsumed500(r);
      expect((await stats(b)).total).toBe(0);
    } finally {
      await host.close();
      await gw.close();
    }
  });

  it.each([
    ['(a) undefined', () => undefined, 'application/json'],
    ['(b) null', () => null, 'application/json'],
    ['(c) a number', () => 42, 'application/json'],
    ['(d) a plain object under application/x-www-form-urlencoded', () => ({ query: Q }), 'application/x-www-form-urlencoded'],
    ['(d) a plain object under text/plain', () => ({ query: Q }), 'text/plain'],
  ])('EB4: Express-shaped consumed stream with req.body %s -> 500 REQUEST_BODY_CONSUMED at 0 calls', async (_l, toBody, ct) => {
    const gw = createGateway({ restBaseUrl: b.url });
    const host = await expressHost(gw, toBody);
    const wire = ct === 'application/x-www-form-urlencoded' ? `query=${encodeURIComponent(Q)}` : JSON.stringify({ query: Q });
    try {
      await reset(b);
      const r = await send(agent, host.port, 'POST', '/graphql', { 'content-type': ct }, wire);
      expectConsumed500(r);
      expect((await stats(b)).total).toBe(0);
    } finally {
      await host.close();
      await gw.close();
    }
  });

  // ---------- EB5 ----------
  it('EB5: createServer(gateway.nodeListener) POST Q -> 200 at 2 calls, body bytes identical to gateway.fetch', async () => {
    const wireQ = JSON.stringify({ query: Q });
    const gw = createGateway({ restBaseUrl: b.url });
    const host = await listen(createServer(gw.nodeListener));
    try {
      await reset(b);
      const ref = await gw.fetch(
        new Request('http://gateway.test/graphql', { method: 'POST', headers: JSON_CT, body: wireQ }),
      );
      const refText = await ref.text();
      expect((await stats(b)).total).toBe(2);
      await reset(b);
      const r = await send(agent, host.port, 'POST', '/graphql', JSON_CT, wireQ);
      expect(r.status).toBe(200);
      expect(r.text).toBe(refText);
      expect(r.headers['content-type']).toBe(ref.headers.get('content-type'));
      expect((await stats(b)).total).toBe(2);
    } finally {
      await host.close();
      await gw.close();
    }
  });

  it.each([
    ['{} (as express.json() leaves a non-JSON request)', {}],
    ['a DIFFERENT query object', { query: '{ __typename }' }],
    ['a different JSON string', JSON.stringify({ query: '{ __typename }' })],
  ])('EB5: req.body = %s on an UNCONSUMED stream -> the stream wins (Q data, 2 calls)', async (_l, preset) => {
    const wireQ = JSON.stringify({ query: Q });
    const ref = await reference(wireQ);
    const gw = createGateway({ restBaseUrl: b.url });
    const host = await listen(
      createServer((req, res) => {
        (req as IncomingMessage & { body?: unknown }).body = preset;
        gw.nodeListener(req, res);
      }),
    );
    try {
      await reset(b);
      const r = await send(agent, host.port, 'POST', '/graphql', JSON_CT, wireQ);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.text).data).toEqual(ref.json.data);
      expect((await stats(b)).total).toBe(2);
    } finally {
      await host.close();
      await gw.close();
    }
  });

  // ---------- EB6 ----------
  it('EB6: GET through the Fastify mount -> 200 with Q data at 2 calls', async () => {
    const ref = await reference(JSON.stringify({ query: Q }));
    const gw = createGateway({ restBaseUrl: b.url });
    const host = await fastifyHost(gw);
    try {
      await reset(b);
      const r = await send(agent, host.port, 'GET', `/graphql?query=${encodeURIComponent(Q)}`, { accept: 'application/json' });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.text).data).toEqual(ref.json.data);
      expect((await stats(b)).total).toBe(2);
    } finally {
      await host.close();
      await gw.close();
    }
  });

  // ---------- EB7 ----------
  it('EB7: after close(), POST through the Fastify mount -> 503 connection: close at 0 calls (with and without the body hand-over)', async () => {
    const gw = createGateway({ restBaseUrl: b.url });
    const withBody = await fastifyHost(gw, true);
    const noBody = await fastifyHost(gw, false);
    const nullBody = await expressHost(gw, () => null);
    try {
      // sanity: before close the no-body mount is the EB4 500
      await reset(b);
      expectConsumed500(await send(agent, noBody.port, 'POST', '/graphql', JSON_CT, JSON.stringify({ query: Q })));
      await gw.close();
      await reset(b);
      for (const host of [withBody, noBody, nullBody]) {
        const r = await send(agent, host.port, 'POST', '/graphql', JSON_CT, JSON.stringify({ query: Q }));
        expect(r.status).toBe(503);
        expect(String(r.headers.connection).toLowerCase()).toBe('close');
        expect(r.text).not.toContain('REQUEST_BODY_CONSUMED');
      }
      expect((await stats(b)).total).toBe(0);
    } finally {
      await withBody.close();
      await noBody.close();
      await nullBody.close();
      await gw.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe.concurrent('latency cases (each owns its backend)', () => {
  // ---------- EB8 ----------
  it('EB8: @defer through the Fastify mount streams multipart/mixed, first part >= 60 ms before the final, 3 calls', async () => {
    const b = await startBackend(50);
    const agent = new http.Agent({ keepAlive: true });
    const gw = createGateway({ restBaseUrl: b.url });
    const host = await fastifyHost(gw);
    try {
      await reset(b);
      const r = await send(
        agent,
        host.port,
        'POST',
        '/graphql',
        { 'content-type': 'application/json', accept: 'multipart/mixed' },
        JSON.stringify({ query: NQ_DEFER }),
      );
      expect(r.status).toBe(200);
      expect(String(r.headers['content-type'])).toMatch(/^multipart\/mixed/);
      expect(r.times.length).toBeGreaterThanOrEqual(2);
      expect(r.text).toContain('"incremental"');
      expect(r.text).toContain('rating');
      const first = r.times[0]!;
      const last = r.times[r.times.length - 1]!;
      expect(last - first).toBeGreaterThanOrEqual(60);
      expect((await stats(b)).total).toBe(3);
    } finally {
      await host.close();
      await gw.close();
      agent.destroy();
      await stopBackend(b);
    }
  });

  // ---------- EB9 ----------
  async function runNQ(abortAfterAuthors: boolean): Promise<{ total: number; aborted: boolean }> {
    const latency = 300;
    const b = await startBackend(latency);
    const ac = new AbortController();
    const gw = createGateway({
      restBaseUrl: b.url,
      onDownstreamCall: (e: DownstreamCallEvent) => {
        if (abortAfterAuthors && e.route === '/authors' && e.outcome === 'ok') ac.abort();
      },
    });
    const host = await fastifyHost(gw);
    try {
      await reset(b);
      await fetch(`http://127.0.0.1:${host.port}/graphql`, {
        method: 'POST',
        headers: JSON_CT,
        body: JSON.stringify({ query: NQ }),
        signal: ac.signal,
      }).then(
        (res) => res.text(),
        () => undefined,
      ).catch(() => undefined);
      await sleep(2 * latency + 50);
      return { total: (await stats(b)).total, aborted: ac.signal.aborted };
    } finally {
      await host.close();
      await gw.close();
      await stopBackend(b);
    }
  }

  it('EB9: a client that disconnects through the Fastify mount after /authors costs at most 2 calls, fewer than the unaborted 3', async () => {
    const [aborted, control] = await Promise.all([runNQ(true), runNQ(false)]);
    expect(control.aborted).toBe(false);
    expect(control.total).toBe(3);
    expect(aborted.aborted).toBe(true);
    expect(aborted.total).toBeLessThanOrEqual(2);
    expect(aborted.total).toBeLessThan(control.total);
  });
});

// ---------------------------------------------------------------------------
describe('EB10 + acceptance: docs and structure', () => {
  function section(): string {
    const prog = readme.indexOf('### Programmatic usage');
    const start = readme.indexOf('Embed in an existing server', prog < 0 ? 0 : prog);
    if (prog < 0 || start < 0) return '';
    const next = readme.indexOf('\n## ', start);
    const nextSub = readme.indexOf('\n#### ', start + 10);
    const end = [next, nextSub].filter((i) => i > 0).reduce((a, c) => Math.min(a, c), readme.length);
    return readme.slice(start, end);
  }

  it('README has an "Embed in an existing server" subsection under Programmatic usage, before §4', () => {
    const prog = readme.indexOf('### Programmatic usage');
    const embed = readme.indexOf('Embed in an existing server');
    const s4 = readme.indexOf('## 4.');
    expect(prog).toBeGreaterThan(0);
    expect(embed).toBeGreaterThan(prog);
    expect(embed).toBeLessThan(s4);
  });

  it('README subsection carries the Fastify recipe, the Express rule and the REQUEST_BODY_CONSUMED 500', () => {
    const s = section();
    expect(s).toContain('reply.hijack()');
    expect(s).toContain('Object.assign(req.raw, { body: req.body })');
    expect(s).toMatch(/Express/);
    expect(s).toMatch(/string/);
    expect(s).toMatch(/Buffer/);
    expect(s).toMatch(/JSON object/);
    expect(s).toContain('REQUEST_BODY_CONSUMED');
    expect(s).toMatch(/\b500\b/);
  });

  it('README §8 lists test_iter97_behavior.test.ts and the badge matches the "N tests across" line', () => {
    const s8 = readme.slice(readme.indexOf('## 8. Testing'), readme.indexOf('## 9.'));
    expect(s8).toContain('test_iter97_behavior.test.ts');
    const badge = /badge\/tests-(\d+)%20passing/.exec(readme);
    const line = /(\d+) tests across (\d+) files/.exec(readme);
    expect(badge?.[1]).toBeDefined();
    expect(badge?.[1]).toBe(line?.[1]);
    expect(Number(badge?.[1])).toBeGreaterThan(1618);
  });

  it('src stays framework-neutral: no Fastify/Express import in the HTTP adapter, no express dependency', () => {
    const adapter = readFileSync(resolve(root, 'src', 'http-adapter.ts'), 'utf8');
    expect(adapter).not.toMatch(/from\s+['"](fastify|express)['"]/);
    expect(adapter).not.toMatch(/require\(\s*['"](fastify|express)['"]\s*\)/);
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    expect(deps).not.toHaveProperty('express');
  });
});
