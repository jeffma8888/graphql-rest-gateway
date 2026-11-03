import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway, NAIVE, BATCHED, type LoaderOptions } from '../src/lib';
import { checkBackend } from '../src/check-backend';

/**
 * iter-73: a 2xx downstream body that breaks the REST contract fails as a typed
 * `DOWNSTREAM_BAD_RESPONSE` naming the route (PRODUCT row 51).
 *
 * Black-box: a node:http proxy stub in front of the bundled Fastify backend
 * corrupts exactly ONE named route (status + raw body); every other path is
 * forwarded byte-for-byte. The stub counts hits per path, which is how the
 * per-route call count of EB11/EB13 is observed (the client-facing extension
 * carries only `total`, by design).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

type Bad = { route: string; body: string; status?: number; contentType?: string };
type GqlError = { message: string; path?: Array<string | number>; extensions?: Record<string, unknown> };
type GqlBody = { data?: any; errors?: GqlError[]; extensions?: any };

let backend: FastifyInstance;
let realUrl: string;
let stub: Server;
let stubUrl: string;
let bad: Bad | null = null;
let hits: Record<string, number> = {};

beforeAll(async () => {
  backend = buildBackend({ latencyMs: 0 }).app;
  realUrl = await backend.listen({ port: 0, host: '127.0.0.1' });
  stub = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://stub.local');
    hits[u.pathname] = (hits[u.pathname] ?? 0) + 1;
    if (bad && u.pathname === bad.route) {
      res.writeHead(bad.status ?? 200, { 'content-type': bad.contentType ?? 'application/json' });
      res.end(bad.body);
      return;
    }
    fetch(realUrl + (req.url ?? '/'))
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
  await new Promise<void>((ok) => stub.listen(0, '127.0.0.1', () => ok()));
  const addr = stub.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  stubUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  stub.closeAllConnections();
  await new Promise<void>((ok) => stub.close(() => ok()));
  await backend.close();
});

async function run(
  query: string,
  b: Bad | null,
  loaderOptions: LoaderOptions = BATCHED,
): Promise<{ status: number; body: GqlBody; text: string; hits: Record<string, number> }> {
  bad = b;
  hits = {};
  const gw = createGateway({ restBaseUrl: stubUrl, loaderOptions });
  try {
    const res = await gw.fetch('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as GqlBody, text, hits: { ...hits } };
  } finally {
    await gw.close();
    bad = null;
  }
}

/** The spec's "BAD_RESPONSE error" predicate, asserted field by field. */
function expectBadResponse(e: GqlError | undefined, route: string): GqlError {
  expect(e, 'expected an error entry').toBeDefined();
  const err = e as GqlError;
  expect(err.extensions?.code).toBe('DOWNSTREAM_BAD_RESPONSE');
  expect(err.extensions?.status).toBe(200);
  expect(err.extensions?.route).toBe(route);
  expect(err.message.startsWith(`Downstream REST response for ${route} `), err.message).toBe(true);
  return err;
}

function noUntyped(body: GqlBody): void {
  for (const e of body.errors ?? []) {
    expect(e.extensions?.code).not.toBe('INTERNAL_SERVER_ERROR');
    expect(e.message).not.toBe('Unexpected error.');
  }
}

const HTML = '<html>maintenance</html>';
const Q_AUTHOR = '{ author(id:"a1"){ id name } }';
const Q_AUTHOR_ID = '{ author(id:"a1"){ id } }';

// ---------- EB1 ----------
describe('EB1 - non-JSON 2xx body', () => {
  it('html on /authors/by-ids -> one BAD_RESPONSE error at ["author"], data.author null', async () => {
    const r = await run(Q_AUTHOR, { route: '/authors/by-ids', body: HTML, contentType: 'text/html' });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ author: null });
    expect(r.body.errors).toHaveLength(1);
    const e = expectBadResponse(r.body.errors?.[0], '/authors/by-ids');
    expect(e.message).toContain('is not valid JSON');
    expect(e.path).toEqual(['author']);
    noUntyped(r.body);
    expect(r.text).not.toContain('Unexpected error.');
    expect(r.text).not.toContain('INTERNAL_SERVER_ERROR');
  });
});

// ---------- EB2 ----------
describe('EB2 - empty 2xx body', () => {
  it('zero-byte 200 on /authors/by-ids -> same as EB1', async () => {
    const r = await run(Q_AUTHOR, { route: '/authors/by-ids', body: '' });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ author: null });
    expect(r.body.errors).toHaveLength(1);
    const e = expectBadResponse(r.body.errors?.[0], '/authors/by-ids');
    expect(e.message).toContain('is not valid JSON');
    expect(e.path).toEqual(['author']);
    noUntyped(r.body);
  });
});

// ---------- EB3 ----------
describe('EB3 - the downstream body is never echoed', () => {
  it('neither "maintenance" nor "<html>" appears anywhere in the serialized response', async () => {
    const r = await run(Q_AUTHOR, { route: '/authors/by-ids', body: HTML, contentType: 'text/html' });
    expectBadResponse(r.body.errors?.[0], '/authors/by-ids');
    expect(r.text).not.toContain('maintenance');
    expect(r.text).not.toContain('<html>');
    // JSON-escaped forms too
    expect(r.text).not.toContain('\\u003chtml');
    expect(r.text).not.toContain('html>');
  });

  it('distinctive values and keys of a contract-breaking body are not echoed', async () => {
    const body = '[{"id":"a1","name":"SECRETNAME_zq","bio":12345678,"zzSecretKey":"SECRETVAL_qz"}]';
    const r = await run(Q_AUTHOR, { route: '/authors/by-ids', body });
    const e = expectBadResponse(r.body.errors?.[0], '/authors/by-ids');
    const all = JSON.stringify(e);
    for (const leak of ['SECRETNAME_zq', '12345678', 'zzSecretKey', 'SECRETVAL_qz']) {
      expect(all).not.toContain(leak);
      expect(r.text).not.toContain(leak);
    }
  });

  it('a wrapped body leaks neither its keys nor its values', async () => {
    const r = await run(Q_AUTHOR_ID, { route: '/authors/by-ids', body: '{"wrapKeyQ7":"wrapValQ7"}' });
    expectBadResponse(r.body.errors?.[0], '/authors/by-ids');
    expect(r.text).not.toContain('wrapKeyQ7');
    expect(r.text).not.toContain('wrapValQ7');
  });
});

// ---------- EB4 ----------
describe('EB4 - wrong top-level shape', () => {
  for (const body of ['{"rows":[]}', '{"oops":true}']) {
    it(`${body} on /authors/by-ids -> BAD_RESPONSE "breaks the contract ... expected a JSON array of rows"`, async () => {
      const r = await run(Q_AUTHOR_ID, { route: '/authors/by-ids', body });
      expect(r.body.errors).toHaveLength(1);
      const e = expectBadResponse(r.body.errors?.[0], '/authors/by-ids');
      expect(e.message).toContain('breaks the contract');
      expect(e.message).toContain('expected a JSON array of rows');
      expect(r.body.data).toEqual({ author: null });
      noUntyped(r.body);
    });
  }
});

// ---------- EB5 ----------
describe('EB5 - non-object row', () => {
  it('[null] -> BAD_RESPONSE naming row 0 and "expected an object"', async () => {
    const r = await run(Q_AUTHOR_ID, { route: '/authors/by-ids', body: '[null]' });
    expect(r.body.errors).toHaveLength(1);
    const e = expectBadResponse(r.body.errors?.[0], '/authors/by-ids');
    expect(e.message).toContain('row 0');
    expect(e.message).toContain('expected an object');
    noUntyped(r.body);
  });
});

// ---------- EB6 ----------
describe('EB6 - missing or mistyped row field', () => {
  it('author row without bio -> field "bio" is missing', async () => {
    const r = await run(Q_AUTHOR_ID, { route: '/authors/by-ids', body: '[{"id":"a1","name":"Ada"}]' });
    expect(r.body.errors).toHaveLength(1);
    const e = expectBadResponse(r.body.errors?.[0], '/authors/by-ids');
    expect(e.message).toContain('field "bio" is missing');
    noUntyped(r.body);
  });

  it('book row with year as a string -> field "year" must be a number, route /books/by-ids', async () => {
    const r = await run('{ book(id:"a1-b1"){ id } }', {
      route: '/books/by-ids',
      body: '[{"id":"a1-b1","authorId":"a1","title":"T","year":"1990"}]',
    });
    expect(r.body.errors).toHaveLength(1);
    const e = expectBadResponse(r.body.errors?.[0], '/books/by-ids');
    expect(e.message).toContain('field "year" must be a number');
    expect(r.text).not.toContain('1990');
    expect(r.body.data).toEqual({ book: null });
    noUntyped(r.body);
  });
});

// ---------- EB7 ----------
describe('EB7 - snake_case hint survives', () => {
  it('author_id on /books/by-author -> BAD_RESPONSE mentioning found "author_id"', async () => {
    const r = await run('{ author(id:"a1"){ books{ id } } }', {
      route: '/books/by-author',
      body: '[{"id":"a1-b1","author_id":"a1","title":"T","year":1990}]',
    });
    const errs = r.body.errors ?? [];
    expect(errs.length).toBeGreaterThanOrEqual(1);
    const e = expectBadResponse(errs[0], '/books/by-author');
    expect(e.message).toContain('found "author_id"');
    noUntyped(r.body);
  });
});

// ---------- EB8 ----------
describe('EB8 - the /authors page shape', () => {
  const Q = '{ authors(first:2){ totalCount edges{ node{ id } } } }';
  for (const body of ['[]', '{"data":[],"count":0}', '{"items":[{"id":1}],"total":1}']) {
    it(`${body} on /authors -> BAD_RESPONSE route /authors`, async () => {
      const r = await run(Q, { route: '/authors', body });
      const errs = r.body.errors ?? [];
      expect(errs.length).toBeGreaterThanOrEqual(1);
      expectBadResponse(errs[0], '/authors');
      noUntyped(r.body);
    });
  }

  it('a valid empty page {"items":[],"total":0} is not an error', async () => {
    const r = await run(Q, { route: '/authors', body: '{"items":[],"total":0}' });
    expect(r.status).toBe(200);
    expect('errors' in r.body).toBe(false);
    expect(r.body.data.authors.totalCount).toBe(0);
    expect(r.body.data.authors.edges).toEqual([]);
  });
});

// ---------- EB9 ----------
describe('EB9 - every contract route is checked', () => {
  const table: Array<[string, string]> = [
    ['/authors', '{ authors(first:2){ totalCount } }'],
    ['/authors/by-ids', '{ author(id:"a1"){ id } }'],
    ['/books/by-ids', '{ book(id:"a1-b1"){ id } }'],
    ['/books/by-author', '{ author(id:"a1"){ books{ id } } }'],
    ['/reviews/by-book', '{ book(id:"a1-b1"){ reviews{ id } } }'],
  ];
  for (const [route, query] of table) {
    it(`{"oops":true} on ${route} -> a BAD_RESPONSE error with route ${route}`, async () => {
      const r = await run(query, { route, body: '{"oops":true}' });
      expect(r.hits[route] ?? 0).toBeGreaterThanOrEqual(1);
      const errs = r.body.errors ?? [];
      const match = errs.filter(
        (e) => e.extensions?.code === 'DOWNSTREAM_BAD_RESPONSE' && e.extensions?.route === route,
      );
      expect(match.length, JSON.stringify(errs)).toBeGreaterThanOrEqual(1);
      expectBadResponse(match[0], route);
      noUntyped(r.body);
    });
  }

  it('the same query against the uncorrupted stub has no errors (control)', async () => {
    for (const [, query] of table) {
      const r = await run(query, null);
      expect(r.body.errors, query).toBeUndefined();
    }
  });
});

// ---------- EB10 ----------
describe('EB10 - partial data survives', () => {
  it('only /books/by-ids corrupted: a intact, b null, exactly one BAD_RESPONSE at ["b"]', async () => {
    const r = await run('{ a: author(id:"a1"){ id name } b: book(id:"a1-b1"){ id } }', {
      route: '/books/by-ids',
      body: '{"oops":true}',
    });
    expect(r.status).toBe(200);
    expect(r.body.data.a).toEqual({ id: 'a1', name: 'Ada Lovelace' });
    expect(r.body.data.b).toBeNull();
    expect(r.body.errors).toHaveLength(1);
    const e = expectBadResponse(r.body.errors?.[0], '/books/by-ids');
    expect(e.path).toEqual(['b']);
  });
});

// ---------- EB11 ----------
describe('EB11 - the rejected call is counted once and not retried', () => {
  it('EB1 case: downstreamCalls.total 1 and the stub saw exactly one /authors/by-ids hit', async () => {
    const r = await run(Q_AUTHOR, { route: '/authors/by-ids', body: HTML, contentType: 'text/html' });
    expectBadResponse(r.body.errors?.[0], '/authors/by-ids');
    expect(r.body.extensions?.downstreamCalls?.total).toBe(1);
    expect(r.hits).toEqual({ '/authors/by-ids': 1 });
  });
});

// ---------- EB12 ----------
describe('EB12 - non-2xx still behaves as before', () => {
  it('503 + html on /authors/by-ids -> DOWNSTREAM_ERROR status 503, unchanged message, body not parsed', async () => {
    const r = await run(Q_AUTHOR_ID, {
      route: '/authors/by-ids',
      body: HTML,
      status: 503,
      contentType: 'text/html',
    });
    expect(r.body.errors).toHaveLength(1);
    const e = r.body.errors?.[0] as GqlError;
    expect(e.extensions?.code).toBe('DOWNSTREAM_ERROR');
    expect(e.extensions?.status).toBe(503);
    expect(e.message).toMatch(/^Downstream REST error 503 .*for \/authors\/by-ids$/);
    expect(e.message).toBe('Downstream REST error 503 Service Unavailable for /authors/by-ids');
    expect(e.message).not.toContain('JSON');
    expect(r.text).not.toContain('DOWNSTREAM_BAD_RESPONSE');
    expect(r.text).not.toContain('maintenance');
  });
});

// ---------- EB13 ----------
describe('EB13 - the bundled backend is unaffected (N+1 counts)', () => {
  const NESTED = `query { authors(first: 5) { edges { node { id name books { id title reviews { id rating } } } } } }`;

  it('BATCHED 3 (1/1/1), NAIVE 21 (1/5/15), identical data', async () => {
    const b = await run(NESTED, null, BATCHED);
    const n = await run(NESTED, null, NAIVE);
    expect(b.body.errors).toBeUndefined();
    expect(n.body.errors).toBeUndefined();
    expect(b.body.extensions?.downstreamCalls?.total).toBe(3);
    expect(b.hits).toEqual({ '/authors': 1, '/books/by-author': 1, '/reviews/by-book': 1 });
    expect(n.body.extensions?.downstreamCalls?.total).toBe(21);
    expect(n.hits).toEqual({ '/authors': 1, '/books/by-author': 5, '/reviews/by-book': 15 });
    expect(n.body.data).toEqual(b.body.data);
    expect(b.body.data.authors.edges).toHaveLength(5);
  });

  it('test/n-plus-1.test.ts is not edited relative to HEAD', () => {
    let out: string | null = null;
    try {
      out = execFileSync('git', ['status', '--porcelain', '--', 'test/n-plus-1.test.ts'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      out = null; // not a git checkout (e.g. an archive): nothing to compare against
    }
    if (out !== null) expect(out.trim()).toBe('');
  });
});

// ---------- EB14 ----------
describe('EB14 - check-backend wording unchanged', () => {
  it('html 200 on /authors -> ok:false, "response body is not valid JSON...", 4 routes skipped', async () => {
    bad = { route: '/authors', body: '<html>', contentType: 'text/html' };
    try {
      const rep = (await checkBackend(stubUrl)) as {
        ok: boolean;
        routes: Array<{ route: string; ok: boolean; problem: string | null }>;
      };
      expect(rep.ok).toBe(false);
      expect(rep.routes.map((x) => x.route)).toEqual([
        '/authors',
        '/authors/by-ids',
        '/books/by-author',
        '/books/by-ids',
        '/reviews/by-book',
      ]);
      const [authors, ...rest] = rep.routes;
      expect(authors?.ok).toBe(false);
      expect(authors?.problem?.startsWith('response body is not valid JSON'), authors?.problem ?? '').toBe(true);
      expect(authors?.problem).not.toContain('Downstream REST response');
      expect(rest).toHaveLength(4);
      for (const r of rest) expect(r.problem).toBe('skipped: needs a passing /authors');
    } finally {
      bad = null;
    }
  });

  it('a mistyped field keeps check-backend operator wording (value-level detail, no gateway prefix)', async () => {
    bad = {
      route: '/authors',
      body: '{"items":[{"id":"a1","name":"Ada","bio":5}],"total":1}',
    };
    try {
      const rep = (await checkBackend(stubUrl)) as {
        routes: Array<{ route: string; ok: boolean; problem: string | null }>;
      };
      const a = rep.routes[0];
      expect(a?.ok).toBe(false);
      expect(a?.problem).toContain('"bio"');
      expect(a?.problem).not.toContain('Downstream REST response');
      expect(a?.problem).not.toContain('Unexpected error');
    } finally {
      bad = null;
    }
  });

  /**
   * Spec ambiguity: EB14 says test_iter67 must pass "unedited", but iter-67's EB12
   * pinned the very defect EB7 removes (author_id rows -> 200, books: [], no errors).
   * Most reasonable reading: the ONLY permitted edit is that one pinned `it` (which
   * must now assert the new typed error); everything else is byte-identical to HEAD.
   */
  it('test_iter67 differs from HEAD only inside the pinned EB12 createGateway test', () => {
    let head: string | null = null;
    try {
      head = execFileSync('git', ['show', 'HEAD:test/test_iter67_behavior.test.ts'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      head = null;
    }
    if (head === null) return;
    const now = readFileSync(join(root, 'test/test_iter67_behavior.test.ts'), 'utf8');
    const cut = (s: string): string => {
      const start = s.indexOf("describe('EB12: the motivating case");
      expect(start).toBeGreaterThan(0);
      const itStart = s.indexOf('  it(', start);
      const next = s.indexOf("  it('checkBackend reports /books/by-author FAIL", itStart);
      expect(itStart).toBeGreaterThan(start);
      expect(next).toBeGreaterThan(itStart);
      // drop comment lines immediately above the pinned `it` as well
      const pre = s.slice(0, itStart).replace(/(\n[ \t]*\/\/[^\n]*)+\n?$/, '\n');
      return pre + s.slice(next);
    };
    expect(cut(now)).toBe(cut(head));
    // and the edited test now asserts the new typed error, not the old defect
    const edited = now.slice(now.indexOf("describe('EB12: the motivating case"));
    expect(edited.slice(0, 2000)).toContain('DOWNSTREAM_BAD_RESPONSE');
  });
});

// ---------- EB15 ----------
describe('EB15 - one contract definition', () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (/\.(ts|mts|cts|js)$/.test(name)) out.push(p);
    }
    return out;
  }

  it("the literal `bio: 'string'` occurs in exactly one file under src/", () => {
    const hits = walk(join(root, 'src'))
      .filter((f) => readFileSync(f, 'utf8').includes("bio: 'string'"))
      .map((f) => relative(root, f));
    expect(hits).toHaveLength(1);
    // and it is neither check-backend itself nor generated code
    expect(hits[0]).not.toBe(join('src', 'check-backend.ts'));
    expect(hits[0]).not.toMatch(/generated/);
  });

  it('src/generated/ and schema.graphql are untouched relative to HEAD', () => {
    let out: string | null = null;
    try {
      out = execFileSync('git', ['status', '--porcelain', '--', 'src/generated', 'schema.graphql', 'src/gateway/schema.graphql'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      out = null;
    }
    if (out !== null) expect(out.trim()).toBe('');
  });
});
