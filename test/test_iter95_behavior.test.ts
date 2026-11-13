import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import http, { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway, NAIVE, type GatewayServer } from '../src/lib';

/**
 * iter-95: `@defer` incremental delivery (PRODUCT row 93).
 *
 * Black-box: the bundled Fastify backend behind `createGateway`, driven through
 * `gateway.fetch` (in-process) and, for EB12, `http.createServer(gateway.nodeListener)`.
 * Every call-count assertion reads the backend's own `/__stats` counter.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const sdl = readFileSync(resolve(root, 'schema.graphql'), 'utf8');

const Q_PLAIN = '{ authors(first:5){ edges { node { name books { reviews { rating } } } } } }';
const Q_DEFER = '{ authors(first:5){ edges { node { name ... @defer { books { reviews { rating } } } } } } }';
const Q_DEFER_FALSE = '{ authors(first:5){ edges { node { name ... @defer(if: false) { books { reviews { rating } } } } } } }';
const Q_DEFER_VAR = 'query($d: Boolean!){ authors(first:5){ edges { node { name ... @defer(if: $d) { books { reviews { rating } } } } } } }';
const Q_STREAM = '{ authors(first:5){ edges @stream { node { name } } } }';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Backend = { app: FastifyInstance; url: string };
async function startBackend(latencyMs: number): Promise<Backend> {
  const app = buildBackend({ latencyMs }).app;
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, url };
}
type Stats = { total: number; byRoute: Record<string, number> };
async function stats(b: Backend): Promise<Stats> {
  const r = await fetch(`${b.url}/__stats`);
  return (await r.json()) as Stats;
}
async function reset(b: Backend): Promise<void> {
  const r = await fetch(`${b.url}/__stats/reset`, { method: 'POST' });
  expect(r.ok).toBe(true);
}

type Reply = { status: number; ctype: string; text: string };
async function post(
  gw: GatewayServer,
  query: string,
  accept: string | undefined,
  variables?: Record<string, unknown>,
): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (accept !== undefined) headers.accept = accept;
  const res = await gw.fetch(
    new Request('http://gateway.test/graphql', {
      method: 'POST',
      headers,
      body: JSON.stringify(variables ? { query, variables } : { query }),
    }),
  );
  return { status: res.status, ctype: res.headers.get('content-type') ?? '', text: await res.text() };
}

/** Parse a multipart/mixed body into its JSON parts. */
function parseMultipart(ctype: string, text: string): any[] {
  const m = /boundary="?([^";]+)"?/.exec(ctype);
  expect(m, `no boundary in ${ctype}`).not.toBeNull();
  const delim = `--${m![1]}`;
  const parts: any[] = [];
  for (const raw of text.split(delim)) {
    const seg = raw.trim();
    if (seg === '' || seg === '--') continue;
    const sep = raw.indexOf('\r\n\r\n');
    if (sep < 0) continue;
    const body = raw.slice(sep + 4).trim();
    if (body === '') continue;
    parts.push(JSON.parse(body));
  }
  return parts;
}

type SseMsg = { event: string; data: string };
function parseSse(text: string): SseMsg[] {
  const out: SseMsg[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (block.trim() === '') continue;
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    out.push({ event, data: data.join('\n') });
  }
  return out;
}

/** Any reply → its payload sequence (one element for a JSON reply). */
function payloads(r: Reply): any[] {
  if (r.ctype.startsWith('multipart/mixed')) return parseMultipart(r.ctype, r.text);
  if (r.ctype.startsWith('text/event-stream'))
    return parseSse(r.text)
      .filter((m) => m.event === 'next')
      .map((m) => JSON.parse(m.data));
  return [JSON.parse(r.text)];
}

/** Merge every incremental `data` into a deep copy of the first part's data at its path. */
function merge(parts: any[]): any {
  const data = structuredClone(parts[0].data);
  for (const p of parts.slice(1)) {
    for (const inc of p.incremental ?? []) {
      let target = data;
      for (const k of inc.path) target = target[k];
      Object.assign(target, inc.data);
    }
  }
  return data;
}

let b0: Backend;
let b50: Backend;
let gw: GatewayServer;
let plainJson: Reply; // Q_PLAIN under accept: application/json

beforeAll(async () => {
  [b0, b50] = await Promise.all([startBackend(0), startBackend(50)]);
  gw = createGateway({ restBaseUrl: b0.url });
  plainJson = await post(gw, Q_PLAIN, 'application/json');
});
afterAll(async () => {
  await gw.close();
  await Promise.all([b0.app.close(), b50.app.close()]);
});

// ---------- EB1 ----------
describe('EB1: SDL contract', () => {
  it('schema.graphql declares exactly the @defer directive and no @stream', () => {
    expect(sdl).toContain(
      'directive @defer(label: String, if: Boolean! = true) on FRAGMENT_SPREAD | INLINE_FRAGMENT',
    );
    expect(sdl.match(/directive @defer\b/g)?.length).toBe(1);
    expect(sdl).not.toMatch(/directive @stream\b/);
  });

  it('introspection lists defer and not stream', async () => {
    const r = await post(gw, '{ __schema { directives { name } } }', 'application/json');
    expect(r.status).toBe(200);
    const names = (JSON.parse(r.text).data.__schema.directives as { name: string }[]).map((d) => d.name);
    expect(names).toContain('defer');
    expect(names).not.toContain('stream');
  });

  it('@stream fails validation with Unknown directive "@stream" at 0 backend calls', async () => {
    for (const accept of ['application/json', 'multipart/mixed']) {
      await reset(b0);
      const r = await post(gw, Q_STREAM, accept);
      const body = payloads(r)[0];
      expect(body.data).toBeUndefined();
      expect((body.errors as { message: string }[]).map((e) => e.message)).toContain('Unknown directive "@stream".');
      expect((await stats(b0)).total).toBe(0);
    }
  });

  it('src/generated/graphql.ts carries the defer directive args type (codegen output)', () => {
    // Byte-for-byte codegen reproducibility is pinned repo-wide by test_iter78; here we
    // check the regenerated file reflects the new SDL directive.
    const gen = readFileSync(resolve(root, 'src/generated/graphql.ts'), 'utf8');
    expect(gen).toMatch(/[Dd]efer/);
  });
});

// ---------- EB2 ----------
describe('EB2: multipart shape', () => {
  let r: Reply;
  let parts: any[];
  beforeAll(async () => {
    r = await post(gw, Q_DEFER, 'multipart/mixed');
    parts = payloads(r);
  });

  it('answers 200 multipart/mixed with at least 2 parts', () => {
    expect(r.status).toBe(200);
    expect(r.ctype.startsWith('multipart/mixed')).toBe(true);
    expect(parts.length).toBeGreaterThanOrEqual(2);
  });

  it('first part: hasNext true, 5 nodes with name and no books', () => {
    expect(parts[0].hasNext).toBe(true);
    const edges = parts[0].data.authors.edges as { node: Record<string, unknown> }[];
    expect(edges).toHaveLength(5);
    for (const e of edges) {
      expect(typeof e.node.name).toBe('string');
      expect('books' in e.node).toBe(false);
    }
  });

  it('later parts carry data.books at ["authors","edges",i,"node"] for i in 0..4', () => {
    const incs = parts.slice(1).flatMap((p) => p.incremental ?? []);
    for (let i = 0; i < 5; i++) {
      const hit = incs.find((x: any) => JSON.stringify(x.path) === JSON.stringify(['authors', 'edges', i, 'node']));
      expect(hit, `no incremental for edge ${i}`).toBeDefined();
      expect(Array.isArray(hit.data.books)).toBe(true);
      expect(hit.data.books.length).toBeGreaterThan(0);
    }
  });

  it('last part has hasNext false', () => {
    expect(parts[parts.length - 1].hasNext).toBe(false);
  });

  it('merged data deep-equals Q_PLAIN data', () => {
    expect(merge(parts)).toEqual(JSON.parse(plainJson.text).data);
  });
});

// ---------- EB3 ----------
describe('EB3: calls unchanged under deferral (BATCHED)', () => {
  it('Q_DEFER and Q_PLAIN each cost 3 calls, 1 per route', async () => {
    const expected = { '/authors': 1, '/books/by-author': 1, '/reviews/by-book': 1 };
    await reset(b0);
    await post(gw, Q_PLAIN, 'application/json');
    const plain = await stats(b0);
    await reset(b0);
    const r = await post(gw, Q_DEFER, 'multipart/mixed');
    expect(r.status).toBe(200);
    const deferred = await stats(b0);
    expect(plain.total).toBe(3);
    expect(deferred.total).toBe(3);
    expect(deferred.byRoute).toEqual(expected);
    expect(plain.byRoute).toEqual(expected);
  });
});

// ---------- EB4 ----------
describe('EB4: calls unchanged under deferral (NAIVE)', () => {
  it('Q_DEFER total equals Q_PLAIN total under NAIVE, both > 3', async () => {
    const naive = createGateway({ restBaseUrl: b0.url, loaderOptions: NAIVE });
    try {
      await reset(b0);
      const p = await post(naive, Q_PLAIN, 'application/json');
      expect(p.status).toBe(200);
      const plainTotal = (await stats(b0)).total;
      await reset(b0);
      const d = await post(naive, Q_DEFER, 'multipart/mixed');
      expect(d.status).toBe(200);
      const parts = payloads(d);
      expect(merge(parts)).toEqual(JSON.parse(p.text).data);
      const deferTotal = (await stats(b0)).total;
      expect(plainTotal).toBeGreaterThan(3);
      expect(deferTotal).toBeGreaterThan(3);
      expect(deferTotal).toBe(plainTotal);
    } finally {
      await naive.close();
    }
  });
});

// ---------- EB5 ----------
describe('EB5: streamed extensions', () => {
  it('first payload has Q_PLAIN queryComplexity; last has downstreamCalls.total 3; none earlier has downstreamCalls', async () => {
    const plainExt = JSON.parse(plainJson.text).extensions;
    expect(plainExt.queryComplexity).toEqual({ cost: 171, depth: 6 });
    const parts = payloads(await post(gw, Q_DEFER, 'multipart/mixed'));
    expect(parts[0].extensions?.queryComplexity).toEqual(plainExt.queryComplexity);
    const last = parts[parts.length - 1];
    expect(last.hasNext).toBe(false);
    expect(last.extensions?.downstreamCalls?.total).toBe(3);
    for (const p of parts.slice(0, -1)) expect(p.extensions?.downstreamCalls).toBeUndefined();
  });
});

// ---------- EB6 ----------
describe('EB6: SSE', () => {
  it('text/event-stream carries the same payload sequence, ends with complete, costs 3 calls', async () => {
    await reset(b0);
    const r = await post(gw, Q_DEFER, 'text/event-stream');
    expect((await stats(b0)).total).toBe(3);
    expect(r.status).toBe(200);
    expect(r.ctype.startsWith('text/event-stream')).toBe(true);
    const msgs = parseSse(r.text);
    const next = msgs.filter((m) => m.event === 'next').map((m) => JSON.parse(m.data));
    expect(next.length).toBeGreaterThanOrEqual(2);
    expect(next[0].hasNext).toBe(true);
    expect(next[0].extensions?.queryComplexity).toEqual({ cost: 171, depth: 6 });
    const last = next[next.length - 1];
    expect(last.hasNext).toBe(false);
    expect(last.extensions?.downstreamCalls?.total).toBe(3);
    for (const p of next.slice(0, -1)) expect(p.extensions?.downstreamCalls).toBeUndefined();
    expect(merge(next)).toEqual(JSON.parse(plainJson.text).data);
    // same sequence as multipart
    const mp = payloads(await post(gw, Q_DEFER, 'multipart/mixed'));
    expect(next).toEqual(mp);
    expect(msgs[msgs.length - 1]?.event).toBe('complete');
  });
});

// ---------- EB7 ----------
describe('EB7: an inactive defer is a plain reply', () => {
  it('@defer(if:false) is byte-identical to Q_PLAIN under application/json, 3 calls', async () => {
    await reset(b0);
    const r = await post(gw, Q_DEFER_FALSE, 'application/json');
    expect((await stats(b0)).total).toBe(3);
    expect(r.status).toBe(plainJson.status);
    expect(r.ctype).toBe(plainJson.ctype);
    expect(r.text).toBe(plainJson.text);
    expect(JSON.parse(r.text).extensions.downstreamCalls.total).toBe(3);
  });

  it('@defer(if:$d) with d=false is byte-identical to Q_PLAIN under application/json, 3 calls', async () => {
    await reset(b0);
    const r = await post(gw, Q_DEFER_VAR, 'application/json', { d: false });
    expect((await stats(b0)).total).toBe(3);
    expect(r.status).toBe(plainJson.status);
    expect(r.ctype).toBe(plainJson.ctype);
    expect(r.text).toBe(plainJson.text);
  });
});

// ---------- EB8 ----------
describe('EB8: a JSON-only client gets a typed refusal', () => {
  const cases: [string, string, Record<string, unknown> | undefined][] = [];
  for (const accept of ['application/json', 'application/graphql-response+json']) {
    cases.push([accept, Q_DEFER, undefined]);
    cases.push([accept, Q_DEFER_VAR, { d: true }]);
  }
  it.each(cases)('accept %s, query %#: 406 JSON DEFER_NOT_ACCEPTED at 0 calls', async (accept, q, vars) => {
    await reset(b0);
    const r = await post(gw, q, accept, vars);
    await sleep(20); // let any stray downstream call land before counting
    expect((await stats(b0)).total).toBe(0);
    expect(r.status).toBe(406);
    expect(r.ctype).toContain('json');
    const body = JSON.parse(r.text);
    expect('data' in body).toBe(false);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].extensions?.code).toBe('DEFER_NOT_ACCEPTED');
    expect(body.errors[0].message).toContain('multipart/mixed');
    expect(body.errors[0].message).toContain('text/event-stream');
  });
});

// ---------- EB9 ----------
describe('EB9: streaming accepts are not refused', () => {
  it.each([[undefined], ['*/*'], ['multipart/mixed, application/json']])('accept %s streams', async (accept) => {
    await reset(b0);
    const r = await post(gw, Q_DEFER, accept as string | undefined);
    expect(r.status).toBe(200);
    const parts = payloads(r);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts[0].hasNext).toBe(true);
    expect(parts[parts.length - 1].hasNext).toBe(false);
    for (const p of parts) expect(p.errors).toBeUndefined();
    expect(merge(parts)).toEqual(JSON.parse(plainJson.text).data);
    expect((await stats(b0)).total).toBe(3);
  });
});

// ---------- EB10 ----------
describe('EB10: deferral does not discount admission', () => {
  const firstError = (r: Reply) => {
    const body = payloads(r)[0];
    expect(body.data ?? null).toBeNull();
    expect(body.errors?.length).toBeGreaterThan(0);
    return { code: body.errors[0].extensions?.code, message: body.errors[0].message };
  };
  it.each([
    ['maxComplexity: 100', { maxComplexity: 100 }],
    ['maxDepth: 3', { maxDepth: 3 }],
  ])('%s rejects Q_DEFER exactly like Q_PLAIN at 0 calls', async (_n, opts) => {
    const g = createGateway({ restBaseUrl: b0.url, ...opts });
    try {
      for (const accept of ['multipart/mixed', undefined]) {
        await reset(b0);
        const p = firstError(await post(g, Q_PLAIN, accept));
        const d = firstError(await post(g, Q_DEFER, accept));
        expect(typeof p.code).toBe('string');
        expect(d).toEqual(p);
        expect((await stats(b0)).total).toBe(0);
      }
    } finally {
      await g.close();
    }
  });
});

// ---------- EB11 ----------
describe('EB11: by-id roots', () => {
  it('author(id) with @defer costs the same as without; first part has name, later part books', async () => {
    const plainQ = '{ author(id:"a1"){ name books { title } } }';
    const deferQ = '{ author(id:"a1"){ name ... @defer { books { title } } } }';
    await reset(b0);
    const p = await post(gw, plainQ, 'application/json');
    expect(p.status).toBe(200);
    const plainTotal = (await stats(b0)).total;
    await reset(b0);
    const parts = payloads(await post(gw, deferQ, 'multipart/mixed'));
    const deferTotal = (await stats(b0)).total;
    expect(plainTotal).toBeGreaterThan(0);
    expect(deferTotal).toBe(plainTotal);
    expect(parts[0].hasNext).toBe(true);
    expect(parts[0].data.author.name).toBe('Ada Lovelace');
    expect('books' in parts[0].data.author).toBe(false);
    const incs = parts.slice(1).flatMap((x) => x.incremental ?? []);
    const hit = incs.find((x: any) => JSON.stringify(x.path) === JSON.stringify(['author']));
    expect(hit?.data?.books).toEqual(JSON.parse(p.text).data.author.books);
  });
});

// ---------- EB12 ----------
describe('EB12: the edge listener streams', () => {
  let g: GatewayServer;
  let server: Server;
  let url: string;
  beforeAll(async () => {
    g = createGateway({ restBaseUrl: b50.url });
    server = createServer(g.nodeListener);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await g.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  function run(): Promise<{ gap: number; ctype: string; text: string }> {
    return new Promise((res, rej) => {
      const payload = JSON.stringify({ query: Q_DEFER });
      const r = http.request(
        `${url}/graphql`,
        {
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/json',
            accept: 'multipart/mixed',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (m) => {
          const chunks: Buffer[] = [];
          let tFirst = -1;
          let tLast = -1;
          let seen = '';
          m.on('data', (c: Buffer) => {
            const now = performance.now();
            chunks.push(c);
            seen += c.toString('utf8');
            if (tFirst < 0 && seen.includes('"hasNext":true')) tFirst = now;
            if (tLast < 0 && seen.includes('"hasNext":false')) tLast = now;
          });
          m.on('end', () =>
            res({
              gap: tFirst >= 0 && tLast >= 0 ? tLast - tFirst : -1,
              ctype: String(m.headers['content-type'] ?? ''),
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          m.on('error', rej);
        },
      );
      r.on('error', rej);
      r.end(payload);
    });
  }

  it('first part arrives >= 60 ms before the last (best of 3); body parses like yoga.fetch', async () => {
    const gaps: number[] = [];
    let last: { ctype: string; text: string } | undefined;
    for (let i = 0; i < 3; i++) {
      const out = await run();
      expect(out.gap).toBeGreaterThanOrEqual(0);
      gaps.push(out.gap);
      last = out;
    }
    expect(Math.max(...gaps), `gaps ${gaps.map((x) => x.toFixed(1)).join(',')}`).toBeGreaterThanOrEqual(60);
    const viaListener = parseMultipart(last!.ctype, last!.text);
    const ref = await g.yoga.fetch(
      new Request('http://gateway.test/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'multipart/mixed' },
        body: JSON.stringify({ query: Q_DEFER }),
      }),
    );
    const viaYoga = parseMultipart(ref.headers.get('content-type') ?? '', await ref.text());
    expect(viaListener).toEqual(viaYoga);
    expect(viaListener[0].hasNext).toBe(true);
    expect(viaListener[viaListener.length - 1].hasNext).toBe(false);
  });
});

// ---------- EB13 ----------
describe('EB13: docs', () => {
  const section = (() => {
    const start = readme.indexOf('### Incremental delivery (@defer)');
    if (start < 0) return '';
    const rest = readme.slice(start + 5);
    const end = rest.search(/\n#{2,3} /);
    return rest.slice(0, end < 0 ? undefined : end);
  })();

  it('§7 subsection exists inside section 7', () => {
    const s7 = readme.indexOf('## 7.');
    const s8 = readme.indexOf('## 8.');
    const at = readme.indexOf('### Incremental delivery (@defer)');
    expect(at).toBeGreaterThan(s7);
    expect(at).toBeLessThan(s8);
  });
  it('names both media types', () => {
    expect(section).toContain('multipart/mixed');
    expect(section).toContain('text/event-stream');
  });
  it('says @stream is not supported', () => {
    expect(section).toMatch(/`@stream` is not supported/);
  });
  it('states extension placement: queryComplexity on the first payload, downstreamCalls on the last', () => {
    expect(section).toMatch(/queryComplexity`?[^.]*first payload/);
    expect(section).toMatch(/downstreamCalls`?[^.]*last/);
  });
  it('documents the DEFER_NOT_ACCEPTED 406 at 0 calls', () => {
    expect(section).toContain('DEFER_NOT_ACCEPTED');
    expect(section).toContain('406');
    expect(section).toMatch(/0 downstream calls/);
  });
  it('says call counts are unchanged', () => {
    expect(section).toMatch(/[Cc]all counts are unchanged/);
  });
  it('README mentions DEFER_NOT_ACCEPTED (extension-code drift guard)', () => {
    expect(readme).toContain('DEFER_NOT_ACCEPTED');
  });
  it('badge total equals the "N tests across M files" prose and M equals the test file count', () => {
    const badge = /tests-(\d+)%20passing/.exec(readme);
    const line = /(\d+) tests across (\d+) files/.exec(readme);
    expect(badge).not.toBeNull();
    expect(line).not.toBeNull();
    expect(badge![1]).toBe(line![1]);
    const files = readdirSync(resolve(root, 'test')).filter((f) => f.endsWith('.test.ts'));
    expect(Number(line![2])).toBe(files.length);
    expect(Number(line![1])).toBeGreaterThan(1566);
  });
});

// ---------- EB14 ----------
describe('EB14: the oracle is untouched', () => {
  it('test/n-plus-1.test.ts is byte-identical to HEAD', () => {
    const out = execFileSync('git', ['diff', 'HEAD', '--', 'test/n-plus-1.test.ts'], { cwd: root, encoding: 'utf8' });
    expect(out).toBe('');
    const status = execFileSync('git', ['status', '--porcelain', '--', 'test/n-plus-1.test.ts'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(status).toBe('');
  });
});
