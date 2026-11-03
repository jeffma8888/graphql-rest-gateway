import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend } from '../src/rest-backend/server';
import { AUTHORS, BOOKS, REVIEWS } from '../src/rest-backend/data';
import { createGateway } from '../src/lib';
import * as lib from '../src/lib';
import { checkBackend, runCheckBackend } from '../src/check-backend';

/**
 * iter-67: `npm run check-backend`, a REST-contract pre-flight check.
 *
 * Black-box: tiny in-process node:http fakes serve the contract built from the
 * bundled dataset rows (AUTHORS/BOOKS/REVIEWS). Each test breaks exactly one
 * thing through a per-route hook. The checker is driven only through its
 * public API (checkBackend / runCheckBackend) and one spawned npm script run.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const ROUTES = ['/authors', '/authors/by-ids', '/books/by-author', '/books/by-ids', '/reviews/by-book'] as const;
type Route = (typeof ROUTES)[number];
type Row = Record<string, unknown>;
type Reply = { status?: number; raw?: string; body?: unknown };
type Hook = (q: URLSearchParams, correct: unknown) => Reply;
type Seen = { path: string; query: Record<string, string> };
type Fake = { url: string; seen: Seen[]; close(): Promise<void> };
type RouteResult = { route: string; ok: boolean; problem: string | null };
type Report = { baseUrl: string; ok: boolean; routes: RouteResult[] };
type Io = { out: string[]; err: string[]; io: { out(l: string): void; err(l: string): void } };

type Running = { url: string; close(): Promise<void> };
type StartFromEnv = (env: Record<string, string | undefined>, log?: (line: string) => void) => Promise<Running>;

function correctBody(route: Route, q: URLSearchParams): unknown {
  const list = (k: string): string[] => (q.get(k) ?? '').split(',').filter(Boolean);
  switch (route) {
    case '/authors': {
      const o = Number(q.get('offset') ?? 0);
      const l = Number(q.get('limit') ?? 10);
      return { items: AUTHORS.slice(o, o + l), total: AUTHORS.length };
    }
    case '/authors/by-ids': {
      const ids = list('ids');
      return AUTHORS.filter((a) => ids.includes(a.id));
    }
    case '/books/by-author': {
      const ids = list('authorIds');
      return BOOKS.filter((b) => ids.includes(b.authorId));
    }
    case '/books/by-ids': {
      const ids = list('ids');
      return BOOKS.filter((b) => ids.includes(b.id));
    }
    case '/reviews/by-book': {
      const ids = list('bookIds');
      return REVIEWS.filter((r) => ids.includes(r.bookId));
    }
  }
}

function first<T>(xs: readonly T[]): T {
  if (xs.length === 0) throw new Error('expected a non-empty list');
  return xs[0] as T;
}
const A0 = first(AUTHORS);
const B0 = first(BOOKS);
const R0 = first(REVIEWS);

const fakes: Fake[] = [];

async function fake(hooks: Partial<Record<Route, Hook>> = {}, prefix = ''): Promise<Fake> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://fake.local');
    seen.push({ path: u.pathname, query: Object.fromEntries(u.searchParams) });
    let p: string | null = u.pathname;
    if (prefix) p = u.pathname.startsWith(prefix + '/') ? u.pathname.slice(prefix.length) : null;
    const route = ROUTES.find((r) => r === p);
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    const c = structuredClone(correctBody(route, u.searchParams));
    const hook = hooks[route];
    const r: Reply = hook ? hook(u.searchParams, c) : { body: c };
    res.writeHead(r.status ?? 200, {
      'content-type': r.raw !== undefined ? 'text/plain' : 'application/json',
    });
    res.end(r.raw ?? JSON.stringify(r.body));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  const f: Fake = {
    url: `http://127.0.0.1:${addr.port}`,
    seen,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
  fakes.push(f);
  return f;
}

/** Map every row of an array body (or `items` of the /authors page). */
function mapRows(fn: (r: Row) => Row): Hook {
  return (_q, c) => {
    if (Array.isArray(c)) return { body: c.map((r) => fn(r as Row)) };
    const page = c as { items: Row[]; total: number };
    return { body: { ...page, items: page.items.map(fn) } };
  };
}

function without(key: string): (r: Row) => Row {
  return (r) => {
    const copy = { ...r };
    delete copy[key];
    return copy;
  };
}

function mkIo(): Io {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l) => out.push(l), err: (l) => err.push(l) } };
}

/** checkBackend plus the spec-wide invariants (5 routes, fixed order, never "Unexpected error."). */
async function check(url: string): Promise<Report> {
  const rep = (await checkBackend(url)) as Report;
  expect(rep.routes.map((r) => r.route)).toEqual([...ROUTES]);
  for (const r of rep.routes) {
    expect(r.problem).not.toBe('Unexpected error.');
    if (r.ok) expect(r.problem).toBeNull();
    else expect(typeof r.problem).toBe('string');
  }
  expect(rep.ok).toBe(rep.routes.every((r) => r.ok));
  return rep;
}

function at(rep: Report, route: Route): RouteResult {
  const r = rep.routes.find((x) => x.route === route);
  expect(r).toBeDefined();
  return r as RouteResult;
}

async function closedUrl(): Promise<string> {
  const f = await fake();
  await f.close();
  fakes.splice(fakes.indexOf(f), 1);
  return f.url;
}

async function loadStart(): Promise<StartFromEnv> {
  const mod = (await import('../src/cli')) as unknown as { startFromEnv: StartFromEnv };
  return mod.startFromEnv;
}

let app: FastifyInstance;
let bundledUrl: string;
let spawned: Promise<{ code: number; stdout: string; stderr: string }>;

beforeAll(async () => {
  // EB13's single spawned run starts first so it overlaps the in-process tests.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.REST_BASE_URL;
  spawned = new Promise((ok) => {
    execFile(
      'npm',
      ['run', '--silent', 'check-backend'],
      { cwd: root, env, timeout: 30_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 99) : 0;
        ok({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
  app = buildBackend({ latencyMs: 0 }).app;
  bundledUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
  await Promise.all(fakes.map((f) => f.close()));
});

describe('EB1: the bundled backend passes with exactly 5 downstream calls', () => {
  it('ok, 5 routes in order, each ok/null, and stats.total grows by exactly 5 (1 per route)', async () => {
    const reset = await fetch(`${bundledUrl}/__stats/reset`, { method: 'POST' });
    expect(reset.ok).toBe(true);
    const rep = await check(bundledUrl);
    expect(rep.ok).toBe(true);
    expect(rep.routes).toEqual(ROUTES.map((route) => ({ route, ok: true, problem: null })));
    const stats = (await (await fetch(`${bundledUrl}/__stats`)).json()) as {
      total: number;
      byRoute: Record<string, number>;
    };
    expect(stats.total).toBe(5);
    expect(stats.byRoute).toEqual(Object.fromEntries(ROUTES.map((r) => [r, 1])));
  });

  it('the correct-contract fake built from the dataset also passes (sanity for every later test)', async () => {
    const f = await fake();
    const rep = await check(f.url);
    expect(rep.ok).toBe(true);
  });
});

describe('EB2: each call is seeded from the previous answer', () => {
  it('exactly the 5 seeded requests, in order, with exactly the spec query keys', async () => {
    const f = await fake();
    await check(f.url);
    const authorIds = AUTHORS.slice(0, 10).map((a) => a.id);
    const books = BOOKS.filter((b) => authorIds.includes(b.authorId));
    expect(f.seen).toEqual([
      { path: '/authors', query: { offset: '0', limit: '10' } },
      { path: '/authors/by-ids', query: { ids: authorIds[0] } },
      { path: '/books/by-author', query: { authorIds: authorIds.join(',') } },
      { path: '/books/by-ids', query: { ids: first(books).id } },
      { path: '/reviews/by-book', query: { bookIds: books.map((b) => b.id).join(',') } },
    ]);
  });

  it('"first" means first RETURNED: reversed answers move the by-id seeds', async () => {
    const reverse: Hook = (_q, c) => {
      if (Array.isArray(c)) return { body: [...c].reverse() };
      const page = c as { items: Row[]; total: number };
      return { body: { ...page, items: [...page.items].reverse() } };
    };
    const f = await fake({ '/authors': reverse, '/books/by-author': reverse });
    const rep = await check(f.url);
    expect(rep.ok).toBe(true);
    const authorIds = AUTHORS.slice(0, 10).map((a) => a.id).reverse();
    const books = BOOKS.filter((b) => authorIds.includes(b.authorId)).reverse();
    expect(f.seen.map((s) => s.query)).toEqual([
      { offset: '0', limit: '10' },
      { ids: authorIds[0] },
      { authorIds: authorIds.join(',') },
      { ids: first(books).id },
      { bookIds: books.map((b) => b.id).join(',') },
    ]);
  });
});

describe('EB3: /authors page shape', () => {
  const a0 = A0;
  it.each([
    ['bare array', [a0]],
    ['{ data, count }', { data: [a0], count: 1 }],
    ['{ items } without total', { items: [a0] }],
  ])('%s fails /authors with a problem naming items or total', async (_name, body) => {
    const f = await fake({ '/authors': () => ({ body }) });
    const rep = await check(f.url);
    expect(rep.ok).toBe(false);
    const r = at(rep, '/authors');
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/items|total/);
  });

  it('{ items: [], total: 0 } fails /authors saying no authors were returned', async () => {
    const f = await fake({ '/authors': () => ({ body: { items: [], total: 0 } }) });
    const rep = await check(f.url);
    expect(rep.ok).toBe(false);
    const r = at(rep, '/authors');
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/no authors/i);
  });
});

describe('EB4: every row field is checked (table-driven from the dataset rows)', () => {
  const cases: Array<[string, string, Route, Route[]]> = [
    ...Object.keys(A0).map(
      (k): [string, string, Route, Route[]] => ['author', k, '/authors', ['/authors', '/authors/by-ids']],
    ),
    ...Object.keys(B0).map(
      (k): [string, string, Route, Route[]] => ['book', k, '/books/by-author', ['/books/by-author', '/books/by-ids']],
    ),
    ...Object.keys(R0).map(
      (k): [string, string, Route, Route[]] => ['review', k, '/reviews/by-book', ['/reviews/by-book']],
    ),
  ];

  it('the table covers 3 + 4 + 5 = 12 keys', () => {
    expect(cases.length).toBe(12);
  });

  it.each(cases)('%s key %j deleted fails %s naming the key', async (_entity, key, failing, served) => {
    const hooks: Partial<Record<Route, Hook>> = {};
    for (const r of served) hooks[r] = mapRows(without(key));
    const f = await fake(hooks);
    const rep = await check(f.url);
    expect(rep.ok).toBe(false);
    const r = at(rep, failing);
    expect(r.ok).toBe(false);
    expect(r.problem).toContain(key);
    // every route before the failing one still passes
    for (const before of ROUTES.slice(0, ROUTES.indexOf(failing))) expect(at(rep, before).ok).toBe(true);
  });

  it('year: "1999" (a string) fails /books/by-author naming year', async () => {
    const f = await fake({
      '/books/by-author': mapRows((r) => ({ ...r, year: '1999' })),
      '/books/by-ids': mapRows((r) => ({ ...r, year: '1999' })),
    });
    const r = at(await check(f.url), '/books/by-author');
    expect(r.ok).toBe(false);
    expect(r.problem).toContain('year');
  });

  it('rating: null fails /reviews/by-book naming rating', async () => {
    const f = await fake({ '/reviews/by-book': mapRows((r) => ({ ...r, rating: null })) });
    const rep = await check(f.url);
    expect(rep.ok).toBe(false);
    const r = at(rep, '/reviews/by-book');
    expect(r.ok).toBe(false);
    expect(r.problem).toContain('rating');
  });

  it('name: 42 (a number) fails /authors naming name', async () => {
    const f = await fake({ '/authors': mapRows((r) => ({ ...r, name: 42 })) });
    const r = at(await check(f.url), '/authors');
    expect(r.ok).toBe(false);
    expect(r.problem).toContain('name');
  });
});

describe('EB5: join keys and by-id lookups', () => {
  it('/books/by-author rows with an unrequested authorId fail naming authorId', async () => {
    const f = await fake({ '/books/by-author': mapRows((r) => ({ ...r, authorId: 'zz-unrequested' })) });
    const rep = await check(f.url);
    const r = at(rep, '/books/by-author');
    expect(r.ok).toBe(false);
    expect(r.problem).toContain('authorId');
  });

  it('/reviews/by-book rows with an unrequested bookId fail naming bookId', async () => {
    const f = await fake({ '/reviews/by-book': mapRows((r) => ({ ...r, bookId: 'zz-unrequested' })) });
    const rep = await check(f.url);
    expect(rep.ok).toBe(false);
    const r = at(rep, '/reviews/by-book');
    expect(r.ok).toBe(false);
    expect(r.problem).toContain('bookId');
  });

  it('/authors/by-ids returning [] fails naming the requested id', async () => {
    const f = await fake({ '/authors/by-ids': () => ({ body: [] }) });
    const rep = await check(f.url);
    const r = at(rep, '/authors/by-ids');
    expect(r.ok).toBe(false);
    expect(r.problem).toContain(A0.id);
  });

  it('/books/by-ids returning [] fails naming the requested id', async () => {
    const f = await fake({ '/books/by-ids': () => ({ body: [] }) });
    const rep = await check(f.url);
    const r = at(rep, '/books/by-ids');
    expect(r.ok).toBe(false);
    expect(r.problem).toContain(B0.id);
  });

  it('/authors/by-ids returning a different author fails naming the requested id', async () => {
    const f = await fake({ '/authors/by-ids': () => ({ body: AUTHORS.slice(1, 2) }) });
    const r = at(await check(f.url), '/authors/by-ids');
    expect(r.ok).toBe(false);
    expect(r.problem).toContain(A0.id);
  });

  it('/authors/by-ids returning { data: [...] } fails, not crash', async () => {
    const f = await fake({ '/authors/by-ids': (_q, c) => ({ body: { data: c } }) });
    const rep = await check(f.url);
    expect(rep.ok).toBe(false);
    expect(at(rep, '/authors/by-ids').ok).toBe(false);
    expect(at(rep, '/authors').ok).toBe(true);
  });
});

describe('EB6: empty results', () => {
  it('/books/by-author [] fails ("no books"); /books/by-ids and /reviews/by-book are skipped', async () => {
    const f = await fake({ '/books/by-author': () => ({ body: [] }) });
    const rep = await check(f.url);
    expect(rep.ok).toBe(false);
    expect(at(rep, '/authors').ok).toBe(true);
    expect(at(rep, '/authors/by-ids').ok).toBe(true);
    const b = at(rep, '/books/by-author');
    expect(b.ok).toBe(false);
    expect(b.problem).toMatch(/no books/i);
    for (const r of ['/books/by-ids', '/reviews/by-book'] as const) {
      expect(at(rep, r).ok).toBe(false);
      expect(at(rep, r).problem).toMatch(/^skipped/);
    }
    // skipped routes make no request
    expect(f.seen.map((s) => s.path)).toEqual(['/authors', '/authors/by-ids', '/books/by-author']);
  });

  it('/reviews/by-book [] is ok (reviews are the leaf)', async () => {
    const f = await fake({ '/reviews/by-book': () => ({ body: [] }) });
    const rep = await check(f.url);
    expect(rep.ok).toBe(true);
    expect(at(rep, '/reviews/by-book')).toEqual({ route: '/reviews/by-book', ok: true, problem: null });
  });

  it('when /authors fails, all 4 later routes are skipped and the array still has 5 entries', async () => {
    const f = await fake({ '/authors': () => ({ status: 500, body: { error: 'boom' } }) });
    const rep = await check(f.url);
    expect(rep.ok).toBe(false);
    expect(rep.routes.length).toBe(5);
    expect(at(rep, '/authors').ok).toBe(false);
    expect(at(rep, '/authors').problem).not.toMatch(/^skipped/);
    for (const r of ROUTES.slice(1)) {
      expect(at(rep, r).ok).toBe(false);
      expect(at(rep, r).problem).toMatch(/^skipped/);
    }
  });
});

describe('EB7: transport failures stay per route', () => {
  it('a 404 route fails with a problem containing 404, earlier routes still pass', async () => {
    const f = await fake({ '/books/by-ids': () => ({ status: 404, body: { error: 'nope' } }) });
    const rep = await check(f.url);
    expect(rep.ok).toBe(false);
    const r = at(rep, '/books/by-ids');
    expect(r.ok).toBe(false);
    expect(r.problem).toContain('404');
    for (const before of ['/authors', '/authors/by-ids', '/books/by-author'] as const) {
      expect(at(rep, before).ok).toBe(true);
    }
  });

  it('a non-JSON 200 body fails that route with a problem containing JSON', async () => {
    const f = await fake({ '/authors/by-ids': () => ({ raw: 'hello' }) });
    const rep = await check(f.url);
    const r = at(rep, '/authors/by-ids');
    expect(r.ok).toBe(false);
    expect(r.problem).toContain('JSON');
    expect(at(rep, '/authors').ok).toBe(true);
  });

  it('nothing listening: every route fails, checkBackend resolves and runCheckBackend resolves 1', async () => {
    const url = await closedUrl();
    const rep = await check(url);
    expect(rep.ok).toBe(false);
    expect(rep.routes.every((r) => !r.ok)).toBe(true);
    const { io } = mkIo();
    await expect(runCheckBackend([], { REST_BASE_URL: url }, io)).resolves.toBe(1);
  });
});

describe('EB8: a REST_BASE_URL path prefix is honoured', () => {
  it.each(['/api/v1', '/api/v1/'])('prefix %j passes all 5 routes (API and CLI)', async (suffix) => {
    const f = await fake({}, '/api/v1');
    const rep = await check(f.url + suffix);
    expect(rep.ok).toBe(true);
    expect(f.seen.map((s) => s.path)).toEqual(ROUTES.map((r) => '/api/v1' + r));
    const { io, out } = mkIo();
    await expect(runCheckBackend([], { REST_BASE_URL: f.url + suffix }, io)).resolves.toBe(0);
    expect(out[out.length - 1]).toBe('5/5 routes match the REST contract');
  });

  it('without the prefix /authors fails with 404', async () => {
    const f = await fake({}, '/api/v1');
    const rep = await check(f.url);
    expect(rep.ok).toBe(false);
    const r = at(rep, '/authors');
    expect(r.ok).toBe(false);
    expect(r.problem).toContain('404');
  });
});

describe('EB9: human output', () => {
  const routeLines = (out: string[]): string[] => out.filter((l) => /^(PASS|FAIL) /.test(l));

  it('bundled (REST_BASE_URL unset): 5 PASS lines in order, then 5/5, resolves 0', async () => {
    const { io, out } = mkIo();
    await expect(runCheckBackend([], {}, io)).resolves.toBe(0);
    expect(routeLines(out)).toEqual(ROUTES.map((r) => expect.stringMatching(new RegExp(`^PASS ${r}(\\s|$)`))));
    expect(out[out.length - 1]).toBe('5/5 routes match the REST contract');
  });

  it('the bundled backend is closed afterwards (follow-up fetch to its URL fails)', async () => {
    const { io, out } = mkIo();
    await expect(runCheckBackend(['--json'], {}, io)).resolves.toBe(0);
    const doc = JSON.parse(first(out)) as { baseUrl: string; backend: string };
    expect(doc.backend).toBe('bundled');
    expect(doc.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
    await expect(fetch(`${doc.baseUrl.replace(/\/$/, '')}/authors?offset=0&limit=1`)).rejects.toThrow();
  });

  it('with FAILs: resolves 1, FAIL lines carry the problem, count line shows 3/5', async () => {
    const hooks: Partial<Record<Route, Hook>> = {
      '/books/by-ids': () => ({ status: 404, body: {} }),
      '/reviews/by-book': () => ({ status: 404, body: {} }),
    };
    const f = await fake(hooks);
    const rep = await check(f.url);
    const { io, out } = mkIo();
    await expect(runCheckBackend([], { REST_BASE_URL: f.url }, io)).resolves.toBe(1);
    const lines = routeLines(out);
    expect(lines.length).toBe(5);
    rep.routes.forEach((r, i) => {
      expect(String(lines[i]).startsWith(`${r.ok ? 'PASS' : 'FAIL'} ${r.route}`)).toBe(true);
      if (!r.ok) expect(String(lines[i])).toContain(r.problem as string);
    });
    expect(lines.map((l) => l.slice(0, 4))).toEqual(['PASS', 'PASS', 'PASS', 'FAIL', 'FAIL']);
    expect(out[out.length - 1]).toBe('3/5 routes match the REST contract');
  });
});

describe('EB10: --json', () => {
  it.each([
    ['passing', {}, 0],
    ['failing', { '/books/by-author': () => ({ body: [] }) }, 1],
  ] as Array<[string, Partial<Record<Route, Hook>>, number]>)(
    '%s external backend: one io.out JSON document matching checkBackend, same exit code as human mode',
    async (_n, hooks, code) => {
      const f = await fake(hooks);
      const rep = await check(f.url);
      const j = mkIo();
      await expect(runCheckBackend(['--json'], { REST_BASE_URL: f.url }, j.io)).resolves.toBe(code);
      expect(j.out.length).toBe(1);
      const doc = JSON.parse(first(j.out)) as Record<string, unknown>;
      expect(Object.keys(doc).sort()).toEqual(['backend', 'baseUrl', 'ok', 'routes']);
      expect(doc).toEqual({ baseUrl: rep.baseUrl, backend: 'external', ok: rep.ok, routes: rep.routes });
      const h = mkIo();
      await expect(runCheckBackend([], { REST_BASE_URL: f.url }, h.io)).resolves.toBe(code);
    },
  );
});

describe('EB11: config errors resolve 2 with no downstream request', () => {
  it.each(['localhost:4001', 'ftp://h', 'http://h/?x=1', 'http://h/#f'])(
    'REST_BASE_URL=%j: one io.err line naming REST_BASE_URL, the same message npm start gives',
    async (bad) => {
      const startFromEnv = await loadStart();
      let startMsg = '';
      try {
        const r = await startFromEnv({ REST_BASE_URL: bad, PORT: '0' }, () => {});
        await r.close();
      } catch (e) {
        startMsg = (e as Error).message;
      }
      expect(startMsg).toContain('REST_BASE_URL');
      const { io, err } = mkIo();
      await expect(runCheckBackend([], { REST_BASE_URL: bad }, io)).resolves.toBe(2);
      expect(err.length).toBe(1);
      expect(err[0]).toContain('REST_BASE_URL');
      expect(err[0]).toContain(startMsg);
    },
  );

  it('invalid URLs pointing at a live recording fake make no request', async () => {
    const f = await fake();
    const hostPort = f.url.replace('http://', '');
    for (const bad of [hostPort, `ftp://${hostPort}`, `${f.url}/?x=1`, `${f.url}/#f`]) {
      const { io, err } = mkIo();
      await expect(runCheckBackend([], { REST_BASE_URL: bad }, io)).resolves.toBe(2);
      expect(err.length).toBe(1);
    }
    expect(f.seen).toEqual([]);
  });

  it('an unknown argument resolves 2, names the argument, makes no request', async () => {
    const f = await fake();
    const { io, err } = mkIo();
    await expect(runCheckBackend(['--bogus'], { REST_BASE_URL: f.url }, io)).resolves.toBe(2);
    expect(err.length).toBe(1);
    expect(err[0]).toContain('--bogus');
    expect(f.seen).toEqual([]);
  });

  it.each([[{}], [{ REST_BASE_URL: '' }]] as Array<[Record<string, string>]>)(
    'env %j means the bundled backend',
    async (env) => {
      const { io, out } = mkIo();
      await expect(runCheckBackend(['--json'], env, io)).resolves.toBe(0);
      const doc = JSON.parse(first(out)) as { backend: string; ok: boolean };
      expect(doc.backend).toBe('bundled');
      expect(doc.ok).toBe(true);
    },
  );
});

describe('EB12: the motivating case (author_id instead of authorId)', () => {
  const Q = '{ authors(first:1){ edges { node { books { title } } } } }';
  const snake = mapRows((r) => {
    const { authorId, ...rest } = r;
    return { ...rest, author_id: authorId };
  });

  // Until iter-73 this pinned the defect (200, books: [], no errors); the gateway now
  // checks every 2xx body against the same row specs and refuses the snake_case rows.
  it('createGateway answers 200 with a DOWNSTREAM_BAD_RESPONSE naming /books/by-author and author_id', async () => {
    const f = await fake({ '/books/by-author': snake, '/books/by-ids': snake });
    const gw = createGateway({ restBaseUrl: f.url });
    const res = await gw.fetch('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: Q }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: any; errors?: Array<{ message: string; extensions: any }> };
    expect(body.errors).toHaveLength(1);
    const [err] = body.errors ?? [];
    expect(err?.extensions).toEqual({ code: 'DOWNSTREAM_BAD_RESPONSE', status: 200, route: '/books/by-author' });
    expect(err?.message).toContain('found "author_id"');
  });

  it('checkBackend reports /books/by-author FAIL naming authorId', async () => {
    const f = await fake({ '/books/by-author': snake, '/books/by-ids': snake });
    const rep = await check(f.url);
    expect(rep.ok).toBe(false);
    expect(at(rep, '/authors').ok).toBe(true);
    expect(at(rep, '/authors/by-ids').ok).toBe(true);
    const r = at(rep, '/books/by-author');
    expect(r.ok).toBe(false);
    expect(r.problem).toContain('authorId');
  });
});

describe('EB13: script and drift guards', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('scripts["check-backend"] runs a tiny tsx entry file', () => {
    const script = pkg.scripts['check-backend'] ?? '';
    expect(script).toMatch(/^tsx \S+\.ts$/);
    const entry = resolve(root, script.replace(/^tsx /, ''));
    expect(existsSync(entry)).toBe(true);
    const lines = readFileSync(entry, 'utf8').split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(25);
  });

  it('one spawned `npm run check-backend` with REST_BASE_URL unset exits 0 and prints 5/5', { timeout: 30_000 }, async () => {
    const r = await spawned;
    expect(r.stderr).not.toContain('Error');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('5/5 routes match the REST contract');
    expect(r.stdout.match(/^PASS /gm)?.length).toBe(5);
  });

  it("the checker's route list equals the route literals in src/gateway/datasources/index.ts", async () => {
    const src = readFileSync(resolve(root, 'src/gateway/datasources/index.ts'), 'utf8');
    const literals = new Set([...src.matchAll(/['"`](\/[A-Za-z][\w-]*(?:\/[\w-]+)*)/g)].map((m) => m[1]));
    expect(literals.size).toBeGreaterThan(0);
    const rep = await check(bundledUrl);
    expect(new Set(rep.routes.map((r) => r.route))).toEqual(literals);
  });

  it('README documents npm run check-backend, exit codes 0/1/2 and --json next to the routes note', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
    const i = readme.indexOf('must serve the same REST routes');
    expect(i).toBeGreaterThan(-1);
    const near = readme.slice(i, i + 4000);
    expect(near).toContain('npm run check-backend');
    expect(near).toContain('--json');
    expect(near).toMatch(/`0`[^]*`1`[^]*`2`/);
    expect(near).toContain('books: []');
  });

  it('the package entry does not export the checker', () => {
    const keys = Object.keys(lib);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).not.toContain('checkBackend');
    expect(keys).not.toContain('runCheckBackend');
  });
});
