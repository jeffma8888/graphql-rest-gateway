import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway, type GatewayServer } from '../src/lib';

/**
 * iter-102: the `@defer` accept guard honours `@skip` / `@include` (PRODUCT row 95).
 *
 * Black-box: the bundled Fastify backend behind a default `createGateway`, driven
 * through `gateway.fetch` (in-process). Every case asserts a downstream call count,
 * read from the backend's own `/__stats` counter and, for plain replies, from
 * `extensions.downstreamCalls.total` too.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Backend = { app: FastifyInstance; url: string };
async function startBackend(latencyMs: number): Promise<Backend> {
  const app = buildBackend({ latencyMs }).app;
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, url };
}
async function backendTotal(b: Backend): Promise<number> {
  const r = await fetch(`${b.url}/__stats`);
  return ((await r.json()) as { total: number }).total;
}
async function reset(b: Backend): Promise<void> {
  const r = await fetch(`${b.url}/__stats/reset`, { method: 'POST' });
  expect(r.ok).toBe(true);
}

type Reply = { status: number; ctype: string; text: string; calls: number };

let b0: Backend;
let gw: GatewayServer;

async function send(req: Request): Promise<Reply> {
  await reset(b0);
  const res = await gw.fetch(req);
  const text = await res.text();
  await sleep(10); // let any stray downstream call land before counting
  return { status: res.status, ctype: res.headers.get('content-type') ?? '', text, calls: await backendTotal(b0) };
}

function post(query: string, variables?: Record<string, unknown>, accept = 'application/json'): Promise<Reply> {
  return send(
    new Request('http://gateway.test/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept },
      body: JSON.stringify(variables ? { query, variables } : { query }),
    }),
  );
}

const Q_BASE = '{ author(id:"a1"){ name } }';
const Q_SKIP_TRUE = '{ author(id:"a1"){ name ... @defer @skip(if: true) { books { title } } } }';
const Q_INCLUDE_FALSE = '{ author(id:"a1"){ name ... @defer @include(if: false) { books { title } } } }';
const Q_INCLUDE_VAR = 'query($s: Boolean!){ author(id:"a1"){ name ... @defer @include(if: $s) { books { title } } } }';
const Q_SKIP_VAR = 'query($k: Boolean!){ author(id:"a1"){ name ... @defer @skip(if: $k) { books { title } } } }';
const Q_INCLUDE_DEFAULT =
  'query($s: Boolean = false){ author(id:"a1"){ name ... @defer @include(if: $s) { books { title } } } }';
const Q_SKIP_FIELD = '{ author(id:"a1") @skip(if: true) { name ... @defer { books { title } } } }';
const Q_SKIP_SPREAD =
  '{ author(id:"a1"){ name ...F @skip(if: true) } } fragment F on Author { ... @defer { books { title } } }';
const Q_SKIP_WINS = '{ author(id:"a1"){ name ... @defer @skip(if: true) @include(if: true) { books { title } } } }';
const Q_SKIP_FALSE_INCLUDE_TRUE =
  '{ author(id:"a1"){ name ... @defer @skip(if: false) @include(if: true) { books { title } } } }';
const Q_SAME_FRAGMENT_TWICE =
  '{ author(id:"a1"){ name ...F @skip(if: true) ...F } } fragment F on Author { ... @defer { books { title } } }';
const Q_ACTIVE_BESIDE_EXCLUDED =
  '{ author(id:"a1"){ name ... @defer @skip(if: true) { books { title } } ... @defer { id } } }';
const Q_ACTIVE_DEFER = '{ author(id:"a1"){ name ... @defer { books { title } } } }';

let base: Reply;
let a1Name: string;

beforeAll(async () => {
  b0 = await startBackend(0);
  gw = createGateway({ restBaseUrl: b0.url });
  base = await post(Q_BASE);
  expect(base.status).toBe(200);
  a1Name = JSON.parse(base.text).data.author.name;
  expect(typeof a1Name).toBe('string');
  expect(a1Name.length).toBeGreaterThan(0);
});
afterAll(async () => {
  await gw.close();
  await b0.app.close();
});

/** Assert a "plain reply" (per the spec) and return its parsed body. */
function expectPlain(r: Reply, calls: number, ctypePrefix: RegExp = /^application\/json/): any {
  expect(r.status, r.text).toBe(200);
  expect(r.ctype).toMatch(ctypePrefix);
  const body = JSON.parse(r.text);
  expect(body).not.toHaveProperty('incremental');
  expect(body).not.toHaveProperty('hasNext');
  expect(body).not.toHaveProperty('errors');
  expect(r.calls).toBe(calls);
  expect(body.extensions?.downstreamCalls?.total).toBe(calls);
  return body;
}

function expectRefused(r: Reply): void {
  expect(r.status, r.text).toBe(406);
  expect(r.ctype).toContain('json');
  const body = JSON.parse(r.text);
  expect(body.errors?.[0]?.extensions?.code).toBe('DEFER_NOT_ACCEPTED');
  expect(body).not.toHaveProperty('data');
  expect(r.calls).toBe(0);
}

const A1 = () => ({ author: { name: a1Name } });

// ---------- EB1 ----------
describe('EB1: literal @skip(if: true) on the deferred fragment', () => {
  it('plain reply, data is only the name, 1 downstream call', async () => {
    const body = expectPlain(await post(Q_SKIP_TRUE), 1);
    expect(body.data).toEqual(A1());
  });
});

// ---------- EB2 ----------
describe('EB2: literal @include(if: false) on the deferred fragment', () => {
  it('plain reply, data is only the name, 1 downstream call', async () => {
    const body = expectPlain(await post(Q_INCLUDE_FALSE), 1);
    expect(body.data).toEqual(A1());
  });
});

// ---------- EB3 ----------
describe('EB3: @include(if: $s)', () => {
  it('s=false: plain reply at 1 call', async () => {
    const body = expectPlain(await post(Q_INCLUDE_VAR, { s: false }), 1);
    expect(body.data).toEqual(A1());
  });
  it('s=true: 406 DEFER_NOT_ACCEPTED, no data, 0 calls', async () => {
    expectRefused(await post(Q_INCLUDE_VAR, { s: true }));
  });
});

// ---------- EB4 ----------
describe('EB4: @skip(if: $k)', () => {
  it('k=true: plain reply at 1 call', async () => {
    const body = expectPlain(await post(Q_SKIP_VAR, { k: true }), 1);
    expect(body.data).toEqual(A1());
  });
  it('k=false: 406 DEFER_NOT_ACCEPTED at 0 calls', async () => {
    expectRefused(await post(Q_SKIP_VAR, { k: false }));
  });
});

// ---------- EB5 ----------
describe('EB5: variable default is honoured', () => {
  it('$s: Boolean = false, no variables sent: plain reply at 1 call', async () => {
    const body = expectPlain(await post(Q_INCLUDE_DEFAULT), 1);
    expect(body.data).toEqual(A1());
  });
  it('the same document with s=true sent is still refused (the default is not hard-wired)', async () => {
    expectRefused(await post(Q_INCLUDE_DEFAULT, { s: true }));
  });
});

// ---------- EB6 ----------
describe('EB6: a skipped ancestor field excludes the defers under it', () => {
  it('200 JSON, data deep-equals {}, no errors, 0 calls', async () => {
    const r = await post(Q_SKIP_FIELD);
    expect(r.status, r.text).toBe(200);
    expect(r.ctype).toMatch(/^application\/json/);
    const body = JSON.parse(r.text);
    expect(body.data).toEqual({});
    expect(body).not.toHaveProperty('errors');
    expect(body).not.toHaveProperty('incremental');
    expect(body).not.toHaveProperty('hasNext');
    expect(r.calls).toBe(0);
    // the reply's own counter agrees when present
    if (body.extensions?.downstreamCalls) expect(body.extensions.downstreamCalls.total).toBe(0);
  });
});

// ---------- EB7 ----------
describe('EB7: a skipped fragment spread excludes the defers inside the fragment', () => {
  it('plain reply at 1 call', async () => {
    const body = expectPlain(await post(Q_SKIP_SPREAD), 1);
    expect(body.data).toEqual(A1());
  });
});

// ---------- EB8 ----------
describe('EB8: skip wins over include', () => {
  it('@skip(if:true) @include(if:true): plain reply at 1 call', async () => {
    const body = expectPlain(await post(Q_SKIP_WINS), 1);
    expect(body.data).toEqual(A1());
  });
  it('@skip(if:false) @include(if:true): 406 DEFER_NOT_ACCEPTED at 0 calls', async () => {
    expectRefused(await post(Q_SKIP_FALSE_INCLUDE_TRUE));
  });
});

// ---------- EB9 ----------
describe('EB9: an excluded spread does not hide an included spread of the same fragment', () => {
  it('...F @skip(if:true) ...F: 406 DEFER_NOT_ACCEPTED at 0 calls', async () => {
    expectRefused(await post(Q_SAME_FRAGMENT_TWICE));
  });
  it('the opposite spread order is refused too', async () => {
    expectRefused(
      await post('{ author(id:"a1"){ name ...F ...F @skip(if: true) } } fragment F on Author { ... @defer { books { title } } }'),
    );
  });
});

// ---------- EB10 ----------
describe('EB10: an active defer beside an excluded one is still refused', () => {
  it('excluded first, active second: 406 at 0 calls', async () => {
    expectRefused(await post(Q_ACTIVE_BESIDE_EXCLUDED));
  });
  it('active first, excluded second: 406 at 0 calls', async () => {
    expectRefused(await post('{ author(id:"a1"){ name ... @defer { id } ... @defer @skip(if: true) { books { title } } } }'));
  });
});

describe('EB10 (extension): an undecidable `if` beside an active defer does not disable the guard', () => {
  // `$s: Boolean = false` sent explicitly as null makes `@include(if: $s)` undecidable for that node
  // only; the sibling active `@defer` must still be refused before any downstream call.
  const Q_NULL_FIRST =
    'query($s: Boolean = false){ author(id:"a1"){ name ... @defer @include(if: $s) { books { title } } ... @defer { id } } }';
  const Q_NULL_SECOND =
    'query($s: Boolean = false){ author(id:"a1"){ name ... @defer { id } ... @defer @include(if: $s) { books { title } } } }';
  it('null-if node first, active defer second: 406 DEFER_NOT_ACCEPTED at 0 calls', async () => {
    expectRefused(await post(Q_NULL_FIRST, { s: null }));
  });
  it('active defer first, null-if node second: 406 DEFER_NOT_ACCEPTED at 0 calls', async () => {
    expectRefused(await post(Q_NULL_SECOND, { s: null }));
  });
});

// ---------- EB11 ----------
describe('EB11: byte parity with the query that omits the excluded selection', () => {
  const stripExt = (text: string) => {
    const o = JSON.parse(text);
    const ext = o.extensions;
    delete o.extensions;
    return { rest: JSON.stringify(o), calls: ext?.downstreamCalls?.total };
  };
  const cases: Array<[string, string, Record<string, unknown> | undefined]> = [
    ['EB1 @skip(if:true)', Q_SKIP_TRUE, undefined],
    ['EB2 @include(if:false)', Q_INCLUDE_FALSE, undefined],
    ['EB3 @include(if:$s) s=false', Q_INCLUDE_VAR, { s: false }],
    ['EB7 skipped spread', Q_SKIP_SPREAD, undefined],
  ];
  it.each(cases)('%s: body minus extensions and downstreamCalls.total equal the base query', async (_n, q, v) => {
    const r = await post(q, v);
    expect(r.status, r.text).toBe(200);
    const a = stripExt(r.text);
    const b = stripExt(base.text);
    expect(a.rest).toBe(b.rest);
    expect(a.calls).toBe(b.calls);
    expect(r.calls).toBe(base.calls);
    expect(a.calls).toBe(1);
  });
});

// ---------- EB12 ----------
describe('EB12: same rule under accept: application/graphql-response+json', () => {
  const ACC = 'application/graphql-response+json';
  it('EB1 shape: plain 200 at 1 call', async () => {
    const body = expectPlain(await post(Q_SKIP_TRUE, undefined, ACC), 1, /^application\/(graphql-response\+)?json/);
    expect(body.data).toEqual(A1());
  });
  it('EB10 shape: 406 DEFER_NOT_ACCEPTED at 0 calls', async () => {
    expectRefused(await post(Q_ACTIVE_BESIDE_EXCLUDED, undefined, ACC));
  });
});

// ---------- EB13 ----------
describe('EB13: streaming clients are unchanged', () => {
  it('accept multipart/mixed: an active defer still streams, data arrives, calls counted', async () => {
    const r = await post(Q_ACTIVE_DEFER, undefined, 'multipart/mixed');
    expect(r.status).toBe(200);
    expect(r.ctype).toMatch(/^multipart\/mixed/);
    expect(r.text).toContain(a1Name);
    expect(r.text).toContain('"incremental"');
    expect(r.calls).toBeGreaterThanOrEqual(1);
  });
  it('accept multipart/mixed: an excluded defer is not delivered incrementally', async () => {
    const r = await post(Q_SKIP_TRUE, undefined, 'multipart/mixed');
    expect(r.status).toBe(200);
    expect(r.text).toContain(a1Name);
    expect(r.text).not.toContain('"incremental"');
    expect(r.calls).toBe(1);
  });
});

// ---------- EB14 ----------
describe('EB14: GET works the same way', () => {
  it('GET ?query=<EB2> with accept application/json: 200 JSON with EB2 data at 1 call', async () => {
    const r = await send(
      new Request(`http://gateway.test/graphql?query=${encodeURIComponent(Q_INCLUDE_FALSE)}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
      }),
    );
    const body = expectPlain(r, 1);
    expect(body.data).toEqual(A1());
  });
  it('GET with an active defer beside an excluded one is still refused at 0 calls', async () => {
    expectRefused(
      await send(
        new Request(`http://gateway.test/graphql?query=${encodeURIComponent(Q_ACTIVE_BESIDE_EXCLUDED)}`, {
          method: 'GET',
          headers: { accept: 'application/json' },
        }),
      ),
    );
  });
});

// ---------- README ----------
describe('README documents the rule', () => {
  it('§Incremental delivery says @skip/@include-excluded defers count as inactive', () => {
    const start = readme.search(/^#+ .*Incremental delivery/m);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = readme.slice(readme.indexOf('\n', start) + 1);
    const next = rest.search(/^#{1,3} /m);
    const section = next < 0 ? rest : rest.slice(0, next);
    expect(section).toContain('@skip(if: true)');
    expect(section).toContain('@include(if: false)');
    expect(section).toMatch(/inactive/);
  });
  it('§8 lists test_iter102_behavior.test.ts', () => {
    expect(readme).toContain('test_iter102_behavior.test.ts');
  });
});
