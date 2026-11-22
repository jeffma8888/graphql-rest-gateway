import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, Kind, type ObjectTypeDefinitionNode, type FieldDefinitionNode, type DirectiveDefinitionNode } from 'graphql';
import { buildBackend, createGateway, type GatewayOptions, type DownstreamCallEvent } from '../src/lib';
import { BENCHMARK_QUERY } from '../benchmark/benchmark';

/**
 * iter-113: scope-gated writes (PRODUCT row 135). `Mutation.addReview`
 * carries `@requiresScope(scope: "write")` in the SDL; an authenticated
 * caller without the `write` scope gets a typed `FORBIDDEN` at 0 downstream
 * calls, checked after `UNAUTHENTICATED` and before argument checks.
 *
 * Black-box: every case builds its OWN bundled Fastify backend on port 0 and
 * puts `createGateway` in front of it, driven through `gw.fetch`. Every call
 * count is a TWO-counter oracle: the backend `GET /__stats` delta must equal
 * the number of `onDownstreamCall` events in the same window.
 *
 * The SDL guard (EB11) parses `schema.graphql` with graphql's `parse`, never
 * a regex, and carries a negative control over a directive-stripped copy.
 * The codegen-drift half of EB11 is the existing test_iter71 "re-running
 * codegen reproduces src/generated/graphql.ts byte for byte" test.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SDL_TEXT = readFileSync(resolve(root, 'schema.graphql'), 'utf8');

const M = 'mutation { addReview(bookId: "a1-b1", rating: 5, body: "Great read") { id rating body reviewer } }';
const READ_IDS = '{ book(id: "a1-b1") { reviews { id } } }';
const SEED_IDS = ['a1-b1-r1', 'a1-b1-r2'];
const FORBIDDEN_MSG = 'Missing required scope: write';

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

const addReview = (bookId: string, rating: number, body: string, sel = '{ id }') =>
  `mutation { addReview(bookId: ${JSON.stringify(bookId)}, rating: ${rating}, body: ${JSON.stringify(body)}) ${sel} }`;

type GqlError = { message: string; path?: Array<string | number>; extensions?: Record<string, any> };
type Body = { data?: any; errors?: GqlError[]; extensions?: any };
type Gw = ReturnType<typeof createGateway>;
type Stats = { total: number; byRoute: Record<string, number> };
type Reply = { status: number; ctype: string; body: Body };

type Env = {
  gw: Gw;
  /** Run `fn`; return the backend hit delta, checked equal to the hook events in the same window. */
  measure: <R>(fn: () => Promise<R>) => Promise<{ calls: number; byRoute: Record<string, number>; value: R }>;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function withEnv<T>(opts: Omit<GatewayOptions, 'restBaseUrl'>, fn: (env: Env) => Promise<T>): Promise<T> {
  const app: FastifyInstance = buildBackend({ latencyMs: 0 }).app;
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  const events: DownstreamCallEvent[] = [];
  const gw = createGateway({ restBaseUrl: url, ...opts, onDownstreamCall: (e) => void events.push(e) });
  const stats = async () => (await (await fetch(`${url}/__stats`)).json()) as Stats;
  const measure: Env['measure'] = async (f) => {
    const before = await stats();
    const ev0 = events.length;
    const value = await f();
    await sleep(25);
    const after = await stats();
    const calls = after.total - before.total;
    const byRoute: Record<string, number> = {};
    for (const [k, v] of Object.entries(after.byRoute)) {
      const d = v - (before.byRoute[k] ?? 0);
      if (d !== 0) byRoute[k] = d;
    }
    // two-counter oracle: backend hits == hook events
    expect(events.length - ev0, 'onDownstreamCall events vs /__stats delta').toBe(calls);
    return { calls, byRoute, value };
  };
  try {
    return await fn({ gw, measure });
  } finally {
    await gw.close();
    const closing = app.close();
    app.server.closeAllConnections();
    await closing;
  }
}

async function post(gw: Gw, query: string, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await gw.fetch(
    new Request('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify({ query }),
    }),
  );
  const text = await res.text();
  return { status: res.status, ctype: res.headers.get('content-type') ?? '', body: JSON.parse(text) as Body };
}

async function readIds(env: Env): Promise<string[]> {
  const r = await env.measure(() => post(env.gw, READ_IDS));
  expect(r.value.body.errors).toBeUndefined();
  return (r.value.body.data.book.reviews as Array<{ id: string }>).map((x) => x.id);
}

function expectForbidden(body: Body, path: Array<string | number> = ['addReview']): void {
  expect(body.data ?? null).toBeNull();
  expect(body.errors).toHaveLength(1);
  const e = body.errors![0]!;
  expect(e.extensions?.code).toBe('FORBIDDEN');
  expect(e.extensions?.requiredScope).toBe('write');
  expect(e.path).toEqual(path);
  expect(e.message).toBe(FORBIDDEN_MSG);
}

function expectCode(body: Body, code: string): void {
  expect(body.data ?? null).toBeNull();
  expect(body.errors).toHaveLength(1);
  expect(body.errors![0]!.extensions?.code).toBe(code);
}

// ---------------------------------------------------------------- EB1-2 ----

describe.concurrent('iter-113 EB1-2: a token with the write scope writes at 1 call', () => {
  it('EB1: read,write creates a1-b1-r3 (REDACTED) at exactly 1 POST /reviews, then the read lists it', async () => {
    await withEnv({}, async (env) => {
      const m = await env.measure(() => post(env.gw, M, bearer('user:u9:read,write')));
      expect(m.value.body.errors).toBeUndefined();
      expect(m.value.body.data.addReview).toEqual({ id: 'a1-b1-r3', rating: 5, body: 'Great read', reviewer: 'REDACTED' });
      expect(m.calls).toBe(1);
      expect(Object.keys(m.byRoute)).toHaveLength(1);
      expect(Object.keys(m.byRoute)[0]).toMatch(/reviews/);
      expect(await readIds(env)).toEqual([...SEED_IDS, 'a1-b1-r3']);
    });
  });

  it('EB2: pii,write reveals the reviewer at 1 call', async () => {
    await withEnv({}, async (env) => {
      const m = await env.measure(() => post(env.gw, M, bearer('user:u9:pii,write')));
      expect(m.value.body.errors).toBeUndefined();
      expect(m.value.body.data.addReview).toEqual({ id: 'a1-b1-r3', rating: 5, body: 'Great read', reviewer: 'u9' });
      expect(m.calls).toBe(1);
    });
  });

  it('EB2: write alone succeeds at 1 call and stays REDACTED', async () => {
    await withEnv({}, async (env) => {
      const m = await env.measure(() => post(env.gw, M, bearer('user:u9:write')));
      expect(m.value.body.errors).toBeUndefined();
      expect(m.value.body.data.addReview.id).toBe('a1-b1-r3');
      expect(m.value.body.data.addReview.reviewer).toBe('REDACTED');
      expect(m.calls).toBe(1);
      expect(await readIds(env)).toEqual([...SEED_IDS, 'a1-b1-r3']);
    });
  });
});

// ---------------------------------------------------------------- EB3-5 ----

describe.concurrent('iter-113 EB3-5: a parsed token without `write` is FORBIDDEN at 0 calls', () => {
  it('EB3: read-only token -> FORBIDDEN (exact shape), 0 calls, no review created', async () => {
    await withEnv({}, async (env) => {
      const m = await env.measure(() => post(env.gw, M, bearer('user:u9:read')));
      expectForbidden(m.value.body);
      expect(m.calls).toBe(0);
      expect(await readIds(env)).toEqual(SEED_IDS);
    });
  });

  for (const token of ['user:u8', 'user:u8:']) {
    it(`EB4: scope-less token ${JSON.stringify(token)} -> FORBIDDEN at 0 calls`, async () => {
      await withEnv({}, async (env) => {
        const m = await env.measure(() => post(env.gw, M, bearer(token)));
        expectForbidden(m.value.body);
        expect(m.calls).toBe(0);
        expect(await readIds(env)).toEqual(SEED_IDS);
      });
    });
  }

  for (const token of ['user:u9:WRITE', 'user:u9:writer', 'user:u9:pii', 'user:u9:read,writes']) {
    it(`EB5: near-miss scope ${JSON.stringify(token)} -> FORBIDDEN at 0 calls`, async () => {
      await withEnv({}, async (env) => {
        const m = await env.measure(() => post(env.gw, M, bearer(token)));
        expectForbidden(m.value.body);
        expect(m.calls).toBe(0);
        expect(await readIds(env)).toEqual(SEED_IDS);
      });
    });
  }

  it('EB3 control: the same gateway still writes for a write token after a refusal', async () => {
    await withEnv({}, async (env) => {
      const r = await env.measure(() => post(env.gw, M, bearer('user:u9:read')));
      expectForbidden(r.value.body);
      expect(r.calls).toBe(0);
      const w = await env.measure(() => post(env.gw, M, bearer('user:u9:read,write')));
      expect(w.value.body.errors).toBeUndefined();
      // the refusal consumed no id: the first real write is still r3
      expect(w.value.body.data.addReview.id).toBe('a1-b1-r3');
      expect(w.calls).toBe(1);
    });
  });
});

// ---------------------------------------------------------------- EB6-7 ----

describe.concurrent('iter-113 EB6-7: ordering UNAUTHENTICATED > FORBIDDEN > argument checks', () => {
  for (const [label, headers] of [
    ['no Authorization header', {}],
    ['Bearer nonsense', bearer('nonsense')],
  ] as const) {
    it(`EB6: ${label} stays UNAUTHENTICATED (never FORBIDDEN) at 0 calls`, async () => {
      await withEnv({}, async (env) => {
        const m = await env.measure(() => post(env.gw, M, { ...headers }));
        expectCode(m.value.body, 'UNAUTHENTICATED');
        expect(JSON.stringify(m.value.body)).not.toContain('FORBIDDEN');
        expect(m.calls).toBe(0);
      });
    });
  }

  it('EB7: read token + rating 9 + empty body -> FORBIDDEN, not BAD_ARGUMENT, at 0 calls', async () => {
    await withEnv({}, async (env) => {
      const m = await env.measure(() => post(env.gw, addReview('a1-b1', 9, ''), bearer('user:u9:read')));
      expectForbidden(m.value.body);
      expect(m.calls).toBe(0);
    });
  });

  it('EB7: read token + unknown book nope-b9 -> FORBIDDEN at 0 calls, not NOT_FOUND after 1', async () => {
    await withEnv({}, async (env) => {
      const m = await env.measure(() => post(env.gw, addReview('nope-b9', 4, 'ok'), bearer('user:u9:read')));
      expectForbidden(m.value.body);
      expect(m.calls).toBe(0);
    });
  });

  it('EB7 control: write token + unknown book is still NOT_FOUND after 1 call', async () => {
    await withEnv({}, async (env) => {
      const m = await env.measure(() => post(env.gw, addReview('nope-b9', 4, 'ok'), bearer('user:u9:write')));
      expectCode(m.value.body, 'NOT_FOUND');
      expect(m.calls).toBe(1);
    });
  });

  it('EB7: write token + rating 9 is still BAD_ARGUMENT at 0 calls', async () => {
    await withEnv({}, async (env) => {
      const m = await env.measure(() => post(env.gw, addReview('a1-b1', 9, 'x'), bearer('user:u9:write')));
      expectCode(m.value.body, 'BAD_ARGUMENT');
      expect(m.calls).toBe(0);
    });
  });
});

// ------------------------------------------------------------------- EB8 ----

describe.concurrent('iter-113 EB8: no read happens behind a refusal', () => {
  it('a refused write with a nested book { reviews } selection costs 0 calls', async () => {
    await withEnv({}, async (env) => {
      const q = addReview('a1-b1', 4, 'ok', '{ id book { reviews { id } } }');
      const m = await env.measure(() => post(env.gw, q, bearer('user:u9:read')));
      expectForbidden(m.value.body);
      expect(m.calls).toBe(0);
      expect(await readIds(env)).toEqual(SEED_IDS);
    });
  });

  it('two aliased refused writes cost 0 calls and create no review', async () => {
    await withEnv({}, async (env) => {
      const q =
        'mutation { a: addReview(bookId: "a1-b1", rating: 4, body: "one") { id } ' +
        'b: addReview(bookId: "a1-b1", rating: 3, body: "two") { id } }';
      const m = await env.measure(() => post(env.gw, q, bearer('user:u9:read')));
      expect(m.value.body.data ?? null).toBeNull();
      expect(m.value.body.errors!.length).toBeGreaterThanOrEqual(1);
      for (const e of m.value.body.errors!) {
        expect(e.extensions?.code).toBe('FORBIDDEN');
        expect(e.extensions?.requiredScope).toBe('write');
        expect(e.message).toBe(FORBIDDEN_MSG);
      }
      expect(m.value.body.errors![0]!.path).toEqual(['a']);
      expect(m.calls).toBe(0);
      expect(await readIds(env)).toEqual(SEED_IDS);
    });
  });

  it('control: the same aliased pair with a write token creates r3 and r4', async () => {
    await withEnv({}, async (env) => {
      const q =
        'mutation { a: addReview(bookId: "a1-b1", rating: 4, body: "one") { id } ' +
        'b: addReview(bookId: "a1-b1", rating: 3, body: "two") { id } }';
      const m = await env.measure(() => post(env.gw, q, bearer('user:u9:read,write')));
      expect(m.value.body.errors).toBeUndefined();
      expect(m.value.body.data).toEqual({ a: { id: 'a1-b1-r3' }, b: { id: 'a1-b1-r4' } });
      expect(m.calls).toBe(2);
    });
  });
});

// ------------------------------------------------------------------- EB9 ----

describe.concurrent('iter-113 EB9: HTTP shape', () => {
  for (const accept of ['application/json', 'application/graphql-response+json']) {
    it(`FORBIDDEN reply has the same status and content-type as UNAUTHENTICATED (accept ${accept})`, async () => {
      await withEnv({}, async (env) => {
        const f = await env.measure(() => post(env.gw, M, { accept, ...bearer('user:u9:read') }));
        const u = await env.measure(() => post(env.gw, M, { accept }));
        expectForbidden(f.value.body);
        expectCode(u.value.body, 'UNAUTHENTICATED');
        expect(f.value.status).toBe(u.value.status);
        expect(f.value.ctype).toBe(u.value.ctype);
        expect(f.value.ctype).not.toBe('');
        expect(f.calls + u.calls).toBe(0);
      });
    });
  }

  it('a mutation over GET stays 405 at 0 calls regardless of token', async () => {
    await withEnv({}, async (env) => {
      for (const headers of [{}, bearer('user:u9:read'), bearer('user:u9:read,write'), bearer('user:u9:pii,write')]) {
        const m = await env.measure(async () => {
          const res = await env.gw.fetch(
            new Request(`http://gateway.local/graphql?query=${encodeURIComponent(M)}`, {
              method: 'GET',
              headers: { accept: 'application/json', ...headers },
            }),
          );
          await res.text();
          return res.status;
        });
        expect(m.value).toBe(405);
        expect(m.calls).toBe(0);
      }
      expect(await readIds(env)).toEqual(SEED_IDS);
    });
  });
});

// ------------------------------------------------------------------ EB10 ----

describe.concurrent('iter-113 EB10: reads stay open', () => {
  const READS = [
    ['book with reviewer', '{ book(id: "a1-b1") { title reviews { reviewer } } }'],
    ['benchmark / sample query', BENCHMARK_QUERY],
  ] as const;
  for (const [label, q] of READS) {
    it(`${label}: read token, scope-less token and anonymous each succeed at the same call count`, async () => {
      const run = (headers: Record<string, string>) =>
        withEnv({}, async (env) => {
          const m = await env.measure(() => post(env.gw, q, headers));
          expect(m.value.status).toBe(200);
          expect(m.value.body.errors).toBeUndefined();
          expect(m.value.body.data).toBeTruthy();
          expect(JSON.stringify(m.value.body)).not.toContain('FORBIDDEN');
          return m.calls;
        });
      const anon = await run({});
      expect(anon).toBeGreaterThan(0);
      expect(await run(bearer('user:u9:read'))).toBe(anon);
      expect(await run(bearer('user:u8'))).toBe(anon);
    });
  }
});

// ------------------------------------------------------------------ EB11 ----

type Gate = { ok: boolean; mutationFields: number; reason?: string };

/** Parse SDL text and check the scope-gate contract. Never a regex. */
function checkScopeGates(sdl: string): Gate {
  const doc = parse(sdl);
  const directive = doc.definitions.find(
    (d): d is DirectiveDefinitionNode => d.kind === Kind.DIRECTIVE_DEFINITION && d.name.value === 'requiresScope',
  );
  if (!directive) return { ok: false, mutationFields: 0, reason: 'no directive definition' };
  const args = directive.arguments ?? [];
  if (args.length !== 1 || args[0]!.name.value !== 'scope') return { ok: false, mutationFields: 0, reason: 'directive args' };
  const t = args[0]!.type;
  if (!(t.kind === Kind.NON_NULL_TYPE && t.type.kind === Kind.NAMED_TYPE && t.type.name.value === 'String')) {
    return { ok: false, mutationFields: 0, reason: 'scope arg is not String!' };
  }
  const locs = directive.locations.map((l) => l.value);
  if (locs.length !== 1 || locs[0] !== 'FIELD_DEFINITION') return { ok: false, mutationFields: 0, reason: 'locations' };

  const fields: FieldDefinitionNode[] = [];
  for (const d of doc.definitions) {
    if ((d.kind === Kind.OBJECT_TYPE_DEFINITION || d.kind === Kind.OBJECT_TYPE_EXTENSION) && d.name.value === 'Mutation') {
      fields.push(...((d as ObjectTypeDefinitionNode).fields ?? []));
    }
  }
  if (fields.length < 1) return { ok: false, mutationFields: 0, reason: 'no Mutation fields' };
  const scopeOf = (f: FieldDefinitionNode): string | undefined => {
    const dir = (f.directives ?? []).find((x) => x.name.value === 'requiresScope');
    const arg = dir?.arguments?.find((a) => a.name.value === 'scope');
    return arg && arg.value.kind === Kind.STRING ? arg.value.value : undefined;
  };
  for (const f of fields) {
    const s = scopeOf(f);
    if (s === undefined || s === '') return { ok: false, mutationFields: fields.length, reason: `${f.name.value} ungated` };
  }
  const add = fields.find((f) => f.name.value === 'addReview');
  if (!add || scopeOf(add) !== 'write') return { ok: false, mutationFields: fields.length, reason: 'addReview not write' };
  return { ok: true, mutationFields: fields.length };
}

describe('iter-113 EB11: the SDL is the contract (parsed guard)', () => {
  it('schema.graphql declares @requiresScope and gates every Mutation field; addReview needs write', () => {
    const g = checkScopeGates(SDL_TEXT);
    expect(g.reason).toBeUndefined();
    expect(g.ok).toBe(true);
    expect(g.mutationFields).toBeGreaterThanOrEqual(1);
  });

  it('negative control: stripping the directive usage from a copy of the SDL fails the same check', () => {
    // strip only usages (`@requiresScope(...)` after a field type), keep the definition
    const stripped = SDL_TEXT.replace(/\)\s*:\s*([^\n]*?)\s*@requiresScope\(scope:\s*"[^"]*"\)/g, '): $1');
    expect(stripped).not.toBe(SDL_TEXT);
    const g = checkScopeGates(stripped);
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/ungated/);
  });

  it('negative control: an added ungated Mutation field fails the check', () => {
    const extra = `${SDL_TEXT}\nextend type Mutation { deleteEverything: Boolean }\n`;
    const g = checkScopeGates(extra);
    expect(g.ok).toBe(false);
    expect(g.reason).toBe('deleteEverything ungated');
  });

  it('negative control: removing the directive definition fails the check', () => {
    const doc = parse(SDL_TEXT);
    const def = doc.definitions.find((d) => d.kind === Kind.DIRECTIVE_DEFINITION && d.name.value === 'requiresScope');
    expect(def?.loc).toBeTruthy();
    const without = SDL_TEXT.slice(0, def!.loc!.start) + SDL_TEXT.slice(def!.loc!.end);
    expect(checkScopeGates(without).ok).toBe(false);
  });

  it('negative control: addReview gated by a different scope fails the check', () => {
    const other = SDL_TEXT.replace('@requiresScope(scope: "write")', '@requiresScope(scope: "read")');
    expect(other).not.toBe(SDL_TEXT);
    const g = checkScopeGates(other);
    expect(g.ok).toBe(false);
    expect(g.reason).toBe('addReview not write');
  });

  it('the gate is live from the shipped schema: introspection still lists addReview', async () => {
    await withEnv({}, async (env) => {
      const m = await env.measure(() => post(env.gw, '{ __schema { mutationType { fields { name } } } }'));
      expect(m.value.body.errors).toBeUndefined();
      const names = (m.value.body.data.__schema.mutationType.fields as Array<{ name: string }>).map((f) => f.name);
      expect(names).toContain('addReview');
      expect(m.calls).toBe(0);
    });
  });
});

// ------------------------------------------------------------------ EB13 ----

describe('iter-113 EB13: README and SDL docstring', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  const section = (anchor: string): string => {
    const i = readme.indexOf(anchor);
    expect(i, `README anchor ${anchor}`).toBeGreaterThanOrEqual(0);
    const next = readme.indexOf('\n### ', i + anchor.length);
    return readme.slice(i, next === -1 ? undefined : next);
  };

  for (const anchor of ['<a name="write-path"></a>', '<a name="auth-context"></a>']) {
    it(`${anchor} section documents the write scope, FORBIDDEN at 0 calls, and the ordering`, () => {
      const s = section(anchor);
      expect(s).toContain('@requiresScope(scope: "write")');
      expect(s).toContain('FORBIDDEN');
      expect(s).toMatch(/0 downstream calls/);
      expect(s).toMatch(/after `UNAUTHENTICATED`/);
      expect(s).toMatch(/before (the )?argument checks/);
      expect(s).toMatch(/Bearer user:42:read,write/);
    });
  }

  it('§8 names this test file', () => {
    const i = readme.indexOf('## 8. Testing');
    const j = readme.indexOf('## 9.', i);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(readme.slice(i, j)).toContain('test_iter113_behavior.test.ts');
  });

  it('the addReview SDL docstring states the write-scope requirement and FORBIDDEN', () => {
    const doc = parse(SDL_TEXT);
    const mutation = doc.definitions.find(
      (d): d is ObjectTypeDefinitionNode => d.kind === Kind.OBJECT_TYPE_DEFINITION && d.name.value === 'Mutation',
    );
    const add = mutation?.fields?.find((f) => f.name.value === 'addReview');
    const desc = add?.description?.value ?? '';
    expect(desc).toMatch(/write/);
    expect(desc).toContain('FORBIDDEN');
  });

  it('publication-safe: no machine paths in this iteration\'s README additions', () => {
    for (const anchor of ['<a name="write-path"></a>', '<a name="auth-context"></a>']) {
      expect(section(anchor)).not.toMatch(/\/Users\/|\/home\/[a-z]/);
    }
  });
});
