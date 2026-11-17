import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway, NAIVE, type GatewayServer } from '../src/lib';

/**
 * iter-98: `graphqlEndpoint` option / `GRAPHQL_PATH` (PRODUCT row 98).
 *
 * Black-box: the bundled Fastify REST backend runs in-process on port 0
 * (latencyMs 0); gateways are driven through `gw.fetch`, through a Fastify
 * host that mounts the README "Embed in an existing server" route under
 * `{ prefix: '/api' }`, and through the CLI's `startFromEnv` / entry file.
 * Every served query asserts a downstream call count read from the backend's
 * own `/__stats` (reset before each probe).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

const Q = '{ authors(first:2){ edges{ node{ id books{ id } } } } }';
const BENCH = '{ authors(first:5){ edges{ node{ id books{ id reviews{ id } } } } } }';
const EP = '/api/graphql';
const H = 'http://localhost';

type Body = {
  data?: { authors?: { edges: unknown[] } };
  errors?: unknown[];
  extensions?: { downstreamCalls?: { total: number } };
};

let backend: FastifyInstance;
let base: string;

async function calls(b = base): Promise<number> {
  const r = await fetch(`${b}/__stats`);
  const s = (await r.json()) as { total: number };
  return s.total;
}
async function reset(b = base): Promise<void> {
  const r = await fetch(`${b}/__stats/reset`, { method: 'POST' });
  if (!r.ok) throw new Error('stats reset failed');
}

const gateways: GatewayServer[] = [];
function gw(extra: Record<string, unknown> = {}): GatewayServer {
  const g = createGateway({ restBaseUrl: base, ...extra } as Parameters<typeof createGateway>[0]);
  gateways.push(g);
  return g;
}

function getReq(path: string, query: string, accept = 'application/json'): Request {
  return new Request(`${H}${path}?query=${encodeURIComponent(query)}`, { headers: { accept } });
}
function postReq(path: string, query: string): Request {
  return new Request(`${H}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query }),
  });
}

beforeAll(async () => {
  backend = buildBackend({ latencyMs: 0 }).app;
  base = await backend.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  while (gateways.length) await gateways.pop()!.close();
  await backend.close();
});

function expectQ(body: Body): void {
  expect(body.errors).toBeUndefined();
  expect(body.data?.authors?.edges).toHaveLength(2);
  expect(body.extensions?.downstreamCalls?.total).toBe(2);
}

describe('EB1: a custom endpoint serves every method', () => {
  it('GET /api/graphql (JSON) → 200, 2 edges, downstreamCalls 2, backend 2', async () => {
    const g = gw({ graphqlEndpoint: EP });
    await reset();
    const res = await g.fetch(getReq(EP, Q));
    expect(res.status).toBe(200);
    expectQ((await res.json()) as Body);
    expect(await calls()).toBe(2);
  });

  it('POST /api/graphql (JSON body) → 200, 2 edges, downstreamCalls 2, backend 2', async () => {
    const g = gw({ graphqlEndpoint: EP });
    await reset();
    const res = await g.fetch(postReq(EP, Q));
    expect(res.status).toBe(200);
    expectQ((await res.json()) as Body);
    expect(await calls()).toBe(2);
  });

  it('SSE GET /api/graphql → 200 text/event-stream with event: next and the authors data, backend 2', async () => {
    const g = gw({ graphqlEndpoint: EP });
    await reset();
    const res = await g.fetch(getReq(EP, Q, 'text/event-stream'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/^text\/event-stream/);
    const text = await res.text();
    expect(text).toContain('event: next');
    expect(text).toContain('"authors"');
    expect(text).toContain('"edges"');
    expect(await calls()).toBe(2);
  });

  it('GET /api/graphql with accept text/html → 200 GraphiQL page', async () => {
    const g = gw({ graphqlEndpoint: EP });
    await reset();
    const res = await g.fetch(new Request(`${H}${EP}`, { headers: { accept: 'text/html' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/^text\/html/);
    expect((await res.text()).toLowerCase()).toContain('graphiql');
    expect(await calls()).toBe(0);
  });
});

describe('EB2: batching is unchanged at the custom endpoint', () => {
  it('BENCH batched → backend 3 and downstreamCalls 3', async () => {
    const g = gw({ graphqlEndpoint: EP });
    await reset();
    const res = await g.fetch(postReq(EP, BENCH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.errors).toBeUndefined();
    expect(body.data?.authors?.edges).toHaveLength(5);
    expect(body.extensions?.downstreamCalls?.total).toBe(3);
    expect(await calls()).toBe(3);
  });

  it('BENCH with loaderOptions NAIVE → backend 21', async () => {
    const g = gw({ graphqlEndpoint: EP, loaderOptions: NAIVE });
    await reset();
    const res = await g.fetch(postReq(EP, BENCH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.errors).toBeUndefined();
    expect(body.extensions?.downstreamCalls?.total).toBe(21);
    expect(await calls()).toBe(21);
  });
});

describe('EB3: the old /graphql path is gone when the option is set', () => {
  it('GET /graphql → 404 at 0 calls', async () => {
    const g = gw({ graphqlEndpoint: EP });
    await reset();
    const res = await g.fetch(getReq('/graphql', Q));
    expect(res.status).toBe(404);
    await res.arrayBuffer();
    expect(await calls()).toBe(0);
  });

  it('POST /graphql → 404 at 0 calls', async () => {
    const g = gw({ graphqlEndpoint: EP });
    await reset();
    const res = await g.fetch(postReq('/graphql', Q));
    expect(res.status).toBe(404);
    await res.arrayBuffer();
    expect(await calls()).toBe(0);
  });
});

describe('EB4: probes stay at the root', () => {
  it('GET /healthz → 200 {"status":"ok"}', async () => {
    const g = gw({ graphqlEndpoint: EP });
    const res = await g.fetch(new Request(`${H}/healthz`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz → 200 with a body identical to a default gateway /readyz', async () => {
    const g = gw({ graphqlEndpoint: EP });
    const d = gw();
    const a = await g.fetch(new Request(`${H}/readyz`));
    const b = await d.fetch(new Request(`${H}/readyz`));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ta = await a.text();
    const tb = await b.text();
    expect(JSON.parse(ta)).toEqual(JSON.parse(tb));
    expect(ta).toBe(tb);
  });

  it('GET /api/healthz → 404', async () => {
    const g = gw({ graphqlEndpoint: EP });
    const res = await g.fetch(new Request(`${H}/api/healthz`));
    expect(res.status).toBe(404);
    await res.arrayBuffer();
  });
});

type Reply = { status: number; headers: http.IncomingHttpHeaders; text: string };
function send(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', fail);
    });
    req.on('error', fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('EB5: Fastify { prefix: "/api" } mount of the README recipe', () => {
  let host: FastifyInstance;
  let port: number;
  let g: GatewayServer;

  beforeAll(async () => {
    g = createGateway({ restBaseUrl: base, graphqlEndpoint: EP } as Parameters<typeof createGateway>[0]);
    host = Fastify();
    await host.register(
      async (app) => {
        app.route({
          method: ['GET', 'POST'],
          url: '/graphql',
          handler: (req, reply) => {
            reply.hijack();
            g.nodeListener(Object.assign(req.raw, { body: req.body }), reply.raw);
          },
        });
      },
      { prefix: '/api' },
    );
    await host.listen({ port: 0, host: '127.0.0.1' });
    port = (host.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await g.close();
    host.server.closeAllConnections();
    await host.close();
  });

  it('GET (JSON accept) /api/graphql over HTTP → 200 at 2 calls', async () => {
    await reset();
    const r = await send(port, 'GET', `${EP}?query=${encodeURIComponent(Q)}`, { accept: 'application/json' });
    expect(r.status).toBe(200);
    expectQ(JSON.parse(r.text) as Body);
    expect(await calls()).toBe(2);
  });

  it('SSE GET /api/graphql over HTTP → 200 event stream at 2 calls', async () => {
    await reset();
    const r = await send(port, 'GET', `${EP}?query=${encodeURIComponent(Q)}`, { accept: 'text/event-stream' });
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toMatch(/^text\/event-stream/);
    expect(r.text).toContain('event: next');
    expect(r.text).toContain('"authors"');
    expect(await calls()).toBe(2);
  });

  it('POST /api/graphql over HTTP → 200 at 2 calls', async () => {
    await reset();
    const r = await send(
      port,
      'POST',
      EP,
      { 'content-type': 'application/json', accept: 'application/json' },
      JSON.stringify({ query: Q }),
    );
    expect(r.status).toBe(200);
    expectQ(JSON.parse(r.text) as Body);
    expect(await calls()).toBe(2);
  });

  it('after await gw.close(), /api/graphql → 503 with connection: close at 0 calls', async () => {
    await g.close();
    await reset();
    const r = await send(port, 'GET', `${EP}?query=${encodeURIComponent(Q)}`, { accept: 'application/json' });
    expect(r.status).toBe(503);
    expect(String(r.headers['connection']).toLowerCase()).toBe('close');
    expect(await calls()).toBe(0);
  });
});

describe('EB6: the default endpoint is unchanged', () => {
  for (const [label, opts] of [
    ['omitted', {}],
    ['explicit undefined', { graphqlEndpoint: undefined }],
  ] as const) {
    it(`${label}: GET and POST /graphql → 200 at 2 calls each`, async () => {
      const g = gw(opts);
      await reset();
      const a = await g.fetch(getReq('/graphql', Q));
      expect(a.status).toBe(200);
      expectQ((await a.json()) as Body);
      expect(await calls()).toBe(2);
      await reset();
      const b = await g.fetch(postReq('/graphql', Q));
      expect(b.status).toBe(200);
      expectQ((await b.json()) as Body);
      expect(await calls()).toBe(2);
    });

    it(`${label}: GET /api/graphql → 404, POST /api/graphql → 200 (HEAD leniency)`, async () => {
      const g = gw(opts);
      await reset();
      const a = await g.fetch(getReq(EP, Q));
      expect(a.status).toBe(404);
      await a.arrayBuffer();
      expect(await calls()).toBe(0);
      const b = await g.fetch(postReq(EP, Q));
      expect(b.status).toBe(200);
      expectQ((await b.json()) as Body);
    });
  }
});

describe('EB7: construction-time validation', () => {
  const BAD: unknown[] = ['', 'graphql', '/', '/api/graphql/', '/a?b', '/a#b', '/a b', 42, null, '/healthz', '/readyz'];
  for (const v of BAD) {
    it(`graphqlEndpoint ${JSON.stringify(v)} throws TypeError naming the option and the value, 0 calls`, async () => {
      await reset();
      let err: unknown;
      try {
        createGateway({ restBaseUrl: base, graphqlEndpoint: v } as unknown as Parameters<typeof createGateway>[0]);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TypeError);
      const msg = (err as Error).message;
      expect(msg).toContain('graphqlEndpoint');
      if (typeof v === 'string') expect(msg).toContain(`got ${JSON.stringify(v)}`);
      else expect(msg).toContain(String(v));
      expect(await calls()).toBe(0);
    });
  }

  for (const v of ['/api/graphql', '/graphql', '/v1/gql']) {
    it(`graphqlEndpoint ${v} is accepted and serves Q there`, async () => {
      const g = gw({ graphqlEndpoint: v });
      await reset();
      const res = await g.fetch(postReq(v, Q));
      expect(res.status).toBe(200);
      expectQ((await res.json()) as Body);
      expect(await calls()).toBe(2);
    });
  }

  it('the typo key graphqlEndPoint throws the did-you-mean TypeError', () => {
    expect(() =>
      createGateway({ restBaseUrl: base, graphqlEndPoint: '/api/graphql' } as unknown as Parameters<typeof createGateway>[0]),
    ).toThrow(new TypeError('Unknown createGateway option "graphqlEndPoint" (did you mean graphqlEndpoint?)'));
  });
});

type Running = { url: string; restBaseUrl: string; backend: string; close(): Promise<void> };
type StartFromEnv = (env: Record<string, string | undefined>, log?: (line: string) => void) => Promise<Running>;
async function loadStart(): Promise<StartFromEnv> {
  return ((await import('../src/cli')) as { startFromEnv: StartFromEnv }).startFromEnv;
}

describe('EB8: the CLI honours GRAPHQL_PATH', () => {
  const open: Running[] = [];
  afterEach(async () => {
    while (open.length) await open.pop()!.close();
  });
  async function start(env: Record<string, string | undefined>) {
    const startFromEnv = await loadStart();
    const lines: string[] = [];
    const r = await startFromEnv(env, (l) => lines.push(l));
    open.push(r);
    return { r, lines };
  }

  it('GRAPHQL_PATH=/api/graphql: url ends in /api/graphql and the startup log names it', async () => {
    const { r, lines } = await start({ PORT: '0', GRAPHQL_PATH: EP });
    expect(r.url).toMatch(/^http:\/\/localhost:\d+\/api\/graphql$/);
    const port = new URL(r.url).port;
    expect(lines).toContain(`GraphQL gateway + GraphiQL: http://localhost:${port}/api/graphql`);
  });

  it('GRAPHQL_PATH=/api/graphql (bundled): GET Q at url → 200 at 2 calls; /graphql on the port → 404', async () => {
    const { r } = await start({ PORT: '0', GRAPHQL_PATH: EP });
    await reset(r.restBaseUrl);
    const res = await fetch(`${r.url}?query=${encodeURIComponent(Q)}`, { headers: { accept: 'application/json' } });
    expect(res.status).toBe(200);
    expectQ((await res.json()) as Body);
    expect(await calls(r.restBaseUrl)).toBe(2);
    const port = new URL(r.url).port;
    await reset(r.restBaseUrl);
    const old = await fetch(`http://localhost:${port}/graphql?query=${encodeURIComponent(Q)}`, {
      headers: { accept: 'application/json' },
    });
    expect(old.status).toBe(404);
    await old.arrayBuffer();
    expect(await calls(r.restBaseUrl)).toBe(0);
  });

  it('GRAPHQL_PATH with REST_BASE_URL (external): GET Q → 200 at 2 calls on the user backend', async () => {
    const { r } = await start({ PORT: '0', GRAPHQL_PATH: EP, REST_BASE_URL: base });
    expect(r.backend).toBe('external');
    expect(r.url).toMatch(/^http:\/\/localhost:\d+\/api\/graphql$/);
    await reset();
    const res = await fetch(`${r.url}?query=${encodeURIComponent(Q)}`, { headers: { accept: 'application/json' } });
    expect(res.status).toBe(200);
    expectQ((await res.json()) as Body);
    expect(await calls()).toBe(2);
  });

  it('unset and GRAPHQL_PATH="" give url ending /graphql and identical log line shapes', async () => {
    const a = await start({ PORT: '0' });
    const b = await start({ PORT: '0', GRAPHQL_PATH: '' });
    for (const { r, lines } of [a, b]) {
      expect(r.url).toMatch(/^http:\/\/localhost:\d+\/graphql$/);
      const port = new URL(r.url).port;
      expect(lines).toContain(`GraphQL gateway + GraphiQL: http://localhost:${port}/graphql`);
    }
    const norm = (ls: string[]) => ls.map((l) => l.replace(/:\d+/g, ':<port>'));
    expect(norm(b.lines)).toEqual(norm(a.lines));
    expect(a.lines).toHaveLength(2);
  });
});

describe('EB9: the CLI rejects a bad GRAPHQL_PATH up front', () => {
  for (const v of ['graphql', '/x?y', '/healthz']) {
    it(`startFromEnv GRAPHQL_PATH=${JSON.stringify(v)} rejects naming GRAPHQL_PATH with no log line`, async () => {
      const startFromEnv = await loadStart();
      const lines: string[] = [];
      let err: unknown;
      let running: Running | undefined;
      try {
        running = await startFromEnv({ PORT: '0', GRAPHQL_PATH: v }, (l) => lines.push(l));
      } catch (e) {
        err = e;
      }
      if (running) await running.close();
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('GRAPHQL_PATH');
      expect(lines).toEqual([]);
    });
  }

  it('the CLI entry with GRAPHQL_PATH=graphql exits with code 1', { timeout: 30_000 }, async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: '0', GRAPHQL_PATH: 'graphql' };
    delete env.REST_BASE_URL;
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    const killer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    clearTimeout(killer);
    expect(code).toBe(1);
    expect(out).toContain('GRAPHQL_PATH');
    expect(out).not.toContain('GraphQL gateway + GraphiQL');
  });
});

function section(heading: string): string {
  const i = readme.indexOf(heading);
  if (i < 0) return '';
  const rest = readme.slice(i + heading.length);
  const j = rest.search(/\n#{1,4} /);
  return j < 0 ? rest : rest.slice(0, j);
}

describe('EB10: the README documents it', () => {
  it('the GatewayOptions table has a graphqlEndpoint row (string, default /graphql) and exactly 12 keys', () => {
    const opts = section('**`GatewayOptions`**').split('**`BackendOptions`**')[0] ?? '';
    const rows = opts.split('\n').filter((l) => /^\| `[A-Za-z]+` \|/.test(l));
    expect(rows).toHaveLength(12);
    const row = rows.find((l) => l.startsWith('| `graphqlEndpoint` |')) ?? '';
    const cells = row.split('|').map((c) => c.trim());
    expect(cells[2]).toBe('`string`');
    expect(cells[3]).toBe('`/graphql`');
  });

  it('test_iter72 KNOWN lists graphqlEndpoint and its title says "twelve" (compressMinBytes, iter-99; coalesceInFlight, iter-100)', () => {
    const t72 = readFileSync(resolve(root, 'test/test_iter72_behavior.test.ts'), 'utf8');
    const known = /const KNOWN = \[([\s\S]*?)\]/.exec(t72)?.[1] ?? '';
    expect(known).toContain("'graphqlEndpoint'");
    expect(t72).toMatch(/\btwelve\b/);
    expect(t72).not.toMatch(/\b(nine|ten|eleven)\b/);
  });

  it('the npm start env table has a GRAPHQL_PATH row defaulting to /graphql', () => {
    const env = section('### Front your own REST service');
    const row = env.split('\n').find((l) => l.startsWith('| `GRAPHQL_PATH` |')) ?? '';
    expect(row).toContain('graphqlEndpoint');
    expect(row.trim().endsWith('| `/graphql` |')).toBe(true);
  });

  it('the Embed subsection explains the host prefix needs graphqlEndpoint and probes stay at the root', () => {
    const embed = section('#### Embed in an existing server');
    expect(embed).toContain("prefix: '/api'");
    expect(embed).toContain("graphqlEndpoint: '/api/graphql'");
    expect(embed).toMatch(/`\/healthz` and `\/readyz` stay at the root/);
  });
});
