import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ValidationContext, GraphQLError } from 'graphql';
import * as lib from '../src/lib';
import { createGateway, buildBackend, NAIVE } from '../src/lib';

/**
 * iter-106: repeated-selection cap. An operation in which more than 32 field
 * selections merge into one response position is refused with a typed
 * QUERY_TOO_REPETITIVE at 0 downstream calls, before graphql-js's quadratic
 * OverlappingFieldsCanBeMergedRule runs.
 *
 * Black-box: the bundled backend runs in-process on port 0 and the gateway is
 * driven through createGateway(...).fetch. "Calls" are the backend /__stats
 * delta across one gateway request. No wall-clock bound is asserted: EB9's
 * linearity is checked by a generous per-test timeout (an exponential walk
 * would take hours), and EB8 uses a spy on graphql-js's ValidationContext.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const README = readFileSync(resolve(root, 'README.md'), 'utf8');

type Gateway = ReturnType<typeof createGateway>;
type Stats = { total: number; byRoute: Record<string, number> };
type GqlError = { message: string; extensions?: Record<string, unknown> };
type GqlResult = {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
  extensions?: Record<string, unknown>;
};
type Sent = { status: number; body: unknown; calls: number };

const REPETITIVE = 'QUERY_TOO_REPETITIVE';
const BOOK = 'book(id:"a1-b1"){ id }';
const rep = (s: string, n: number): string => Array.from({ length: n }, () => s).join(' ');

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

/** EB3: book×5 { author×5 { books(first:1)×5 { id×5 } } } */
const NESTED = `{ ${rep(
  `book(id:"a1-b1"){ ${rep(`author{ ${rep(`books(first:1){ ${rep('id', 5)} }`, 5)} }`, 5)} }`,
  5,
)} }`;

let app: FastifyInstance;
let base: string;
let gw: Gateway;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function resetStats(): Promise<void> {
  const r = await fetch(`${base}/__stats/reset`, { method: 'POST' });
  expect(r.ok).toBe(true);
}

async function readStats(): Promise<Stats> {
  const r = await fetch(`${base}/__stats`);
  return (await r.json()) as Stats;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function post(g: Gateway, payload: unknown, path = '/graphql'): Promise<Sent> {
  await resetStats();
  const res = await g.fetch(`http://gateway.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await parseBody(res);
  await sleep(20);
  const stats = await readStats();
  return { status: res.status, body, calls: stats.total };
}

async function get(g: Gateway, query: string, path = '/graphql'): Promise<Sent> {
  await resetStats();
  const res = await g.fetch(`http://gateway.local${path}?query=${encodeURIComponent(query)}`, {
    method: 'GET',
  });
  const body = await parseBody(res);
  await sleep(20);
  const stats = await readStats();
  return { status: res.status, body, calls: stats.total };
}

function single(s: Sent): GqlResult {
  expect(Array.isArray(s.body)).toBe(false);
  expect(typeof s.body).toBe('object');
  return s.body as GqlResult;
}

function codes(r: GqlResult): unknown[] {
  return (r.errors ?? []).map((e) => e.extensions?.code);
}

/** Full shape of one QUERY_TOO_REPETITIVE refusal. */
function expectRepetitive(r: GqlResult, path: string, selections: number): void {
  expect(r.errors).toBeDefined();
  expect(r.errors).toHaveLength(1);
  const e = r.errors![0]!;
  expect(e.extensions?.code).toBe(REPETITIVE);
  expect(e.extensions?.path).toBe(path);
  expect(e.extensions?.selections).toBe(selections);
  expect(e.extensions?.maxSelections).toBe(32);
  expect(e.message).toBe(
    `Query repeats a field too often: ${selections} selections merge into "${path}", above the maximum of 32.`,
  );
  expect(r.data ?? null).toBeNull();
  expect(r.extensions?.queryComplexity).toBeUndefined();
  expect(r.extensions?.downstreamCalls).toBeUndefined();
}

function expectAdmitted(r: GqlResult): void {
  expect(r.errors).toBeUndefined();
  expect(r.data).toBeTruthy();
}

/** Lexical token count, the iter-66 way (names, punctuators, strings, numbers). */
function tokens(doc: string): number {
  const m = doc.match(/\.\.\.|"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*|-?\d+(?:\.\d+)?|[!$&()\:=@\[\]{|}]/g);
  return m ? m.length : 0;
}

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  gw = createGateway({ restBaseUrl: base });
});

afterAll(async () => {
  await app.close();
});

// ---------- EB1 ----------
describe('EB1 - refused flat repeat', () => {
  const DOC = `{ ${rep(BOOK, 220)} }`;

  it('the document is within the 2000-token cap (precondition)', () => {
    expect(tokens(DOC)).toBeLessThanOrEqual(2000);
  });

  it('220 x book(id){ id } is one QUERY_TOO_REPETITIVE (path book, 220/32), no data, 0 calls', async () => {
    const s = await post(gw, { query: DOC });
    expectRepetitive(single(s), 'book', 220);
    expect(s.calls).toBe(0);
  });

  it('HTTP status equals that of a QUERY_TOO_COMPLEX refusal (200)', async () => {
    const s = await post(gw, { query: DOC });
    const complex = await post(gw, { query: `{ author(id:"a1"){ id ${'name '.repeat(1800)}} }` });
    expect(codes(single(complex))).toContain('QUERY_TOO_COMPLEX');
    expect(s.status).toBe(complex.status);
    expect(s.status).toBe(200);
  });
});

// ---------- EB2 ----------
describe('EB2 - leaf repeat refused', () => {
  it('__typename x1998 (2000 tokens) is QUERY_TOO_REPETITIVE path __typename, 1998, 0 calls', async () => {
    const DOC = '{ ' + '__typename '.repeat(1998) + '}';
    expect(tokens(DOC)).toBe(2000);
    const s = await post(gw, { query: DOC });
    expectRepetitive(single(s), '__typename', 1998);
    expect(s.calls).toBe(0);
  });
});

// ---------- EB3 ----------
describe('EB3 - nested multiplication refused', () => {
  it('book x5 { author x5 { books(first:1) x5 { id x5 } } } reports book.author.books = 125 at 0 calls', async () => {
    expect(tokens(NESTED)).toBeLessThanOrEqual(2000);
    const s = await post(gw, { query: NESTED });
    expectRepetitive(single(s), 'book.author.books', 125);
    expect(s.calls).toBe(0);
  });

  it('no single selection set in it has more than 5 same-name siblings (the shape a sibling cap would miss)', () => {
    // Structural fact about the document under test: each `{ ... }` body is 5 copies of one field.
    expect(NESTED.match(/book\(/g)).toHaveLength(5);
    expect(NESTED.match(/author\{/g)).toHaveLength(25);
  });
});

// ---------- EB4 ----------
describe('EB4 - leafy composite refused', () => {
  it('{ book(id){ id x20 } x2 } reports book.id = 40', async () => {
    const DOC = `{ ${rep(`book(id:"a1-b1"){ ${rep('id', 20)} }`, 2)} }`;
    const s = await post(gw, { query: DOC });
    expectRepetitive(single(s), 'book.id', 40);
    expect(s.calls).toBe(0);
  });
});

// ---------- EB5 ----------
describe('EB5 - boundary', () => {
  const ONE = 'book(id:"a1-b1"){ id title }';

  it('32 copies are admitted: no errors, data.book byte-identical to the single reply, 1 call', async () => {
    const one = single(await post(gw, { query: `{ ${ONE} }` }));
    expectAdmitted(one);
    const s = await post(gw, { query: `{ ${rep(ONE, 32)} }` });
    const r = single(s);
    expect(s.status).toBe(200);
    expectAdmitted(r);
    expect(JSON.stringify(r.data!.book)).toBe(JSON.stringify(one.data!.book));
    expect((r.data!.book as { id: string }).id).toBe('a1-b1');
    expect(s.calls).toBe(1);
  });

  it('33 copies are refused with selections = 33 at 0 calls', async () => {
    const s = await post(gw, { query: `{ ${rep(ONE, 33)} }` });
    expectRepetitive(single(s), 'book', 33);
    expect(s.calls).toBe(0);
  });
});

// ---------- EB6 ----------
describe('EB6 - fragments counted like the executor', () => {
  it('one fragment F spread 40 times is admitted (the same name counts once)', async () => {
    const DOC = `{ ${rep('...F', 40)} } fragment F on Query { ${BOOK} }`;
    const s = await post(gw, { query: DOC });
    const r = single(s);
    expectAdmitted(r);
    expect((r.data!.book as { id: string }).id).toBe('a1-b1');
    expect(s.calls).toBe(1);
  });

  it('33 distinct fragments F0..F32 each holding book(id){ id } are refused (book, 33)', async () => {
    const names = Array.from({ length: 33 }, (_, i) => `F${i}`);
    const DOC =
      `{ ${names.map((n) => `...${n}`).join(' ')} } ` +
      names.map((n) => `fragment ${n} on Query { ${BOOK} }`).join(' ');
    const s = await post(gw, { query: DOC });
    expectRepetitive(single(s), 'book', 33);
    expect(s.calls).toBe(0);
  });

  it('32 distinct fragments are admitted (control at the boundary)', async () => {
    const names = Array.from({ length: 32 }, (_, i) => `F${i}`);
    const DOC =
      `{ ${names.map((n) => `...${n}`).join(' ')} } ` +
      names.map((n) => `fragment ${n} on Query { ${BOOK} }`).join(' ');
    const s = await post(gw, { query: DOC });
    expectAdmitted(single(s));
    expect(s.calls).toBe(1);
  });

  it('33 inline fragments `... on Query { book(id){ id } }` are refused (book, 33)', async () => {
    const s = await post(gw, { query: `{ ${rep(`... on Query { ${BOOK} }`, 33)} }` });
    expectRepetitive(single(s), 'book', 33);
    expect(s.calls).toBe(0);
  });

  it('33 inline fragments with no type condition are refused too', async () => {
    const s = await post(gw, { query: `{ ${rep(`... { ${BOOK} }`, 33)} }` });
    expectRepetitive(single(s), 'book', 33);
  });

  it('@skip/@include are ignored: 33 copies all under @skip(if: true) are still refused', async () => {
    const s = await post(gw, { query: `{ ${rep('book(id:"a1-b1") @skip(if: true) { id }', 33)} }` });
    expectRepetitive(single(s), 'book', 33);
    expect(s.calls).toBe(0);
  });

  it('children are the union of merged subselections: { book{ author author } x2 } gives book.author = 4', async () => {
    // 2 x book (2 <= 32) each with 17 author copies -> book.author = 34 > 32.
    const DOC = `{ ${rep(`book(id:"a1-b1"){ ${rep('author{ id }', 17)} }`, 2)} }`;
    const s = await post(gw, { query: DOC });
    expectRepetitive(single(s), 'book.author', 34);
  });

  it('control: 2 x book{ 16 x author } = 32 merged is admitted', async () => {
    const DOC = `{ ${rep(`book(id:"a1-b1"){ ${rep('author{ id }', 16)} }`, 2)} }`;
    const s = await post(gw, { query: DOC });
    expectAdmitted(single(s));
  });

  it('an unused fragment holding 220 repeats does not reach the spec rules unbounded (refused, 0 calls)', async () => {
    const s = await post(gw, { query: `{ __typename } fragment U on Query { ${rep(BOOK, 220)} }` });
    const r = single(s);
    expect(codes(r)).toEqual([REPETITIVE]);
    expect(s.calls).toBe(0);
  });
});

// ---------- EB7 ----------
describe('EB7 - distinct aliases untouched', () => {
  it('600 distinct aliases aN: __typename are admitted with all 600 keys', async () => {
    const DOC = `{ ${Array.from({ length: 600 }, (_, i) => `a${i}: __typename`).join(' ')} }`;
    expect(tokens(DOC)).toBeLessThanOrEqual(2000);
    const s = await post(gw, { query: DOC });
    const r = single(s);
    expectAdmitted(r);
    expect(Object.keys(r.data!)).toHaveLength(600);
    expect(r.data!.a599).toBe('Query');
    expect(s.calls).toBe(0);
  });

  it('5 distinct aliases each repeated 32 times (the worst admitted shape) is admitted', async () => {
    const DOC = `{ ${Array.from({ length: 5 }, (_, i) => rep(`b${i}: ${BOOK}`, 32)).join(' ')} }`;
    expect(tokens(DOC)).toBeLessThanOrEqual(2000);
    const s = await post(gw, { query: DOC });
    const r = single(s);
    expectAdmitted(r);
    expect(Object.keys(r.data!)).toHaveLength(5);
    expect(s.calls).toBe(1);
  });

  it('100 aliased authors(first: 0){ totalCount } (the alias-budget shape) is admitted, no repetitive error', async () => {
    const DOC = `{ ${Array.from({ length: 100 }, (_, i) => `p${i}: authors(first: 0) { totalCount }`).join(' ')} }`;
    const s = await post(gw, { query: DOC });
    const r = single(s);
    expect(codes(r)).not.toContain(REPETITIVE);
    expectAdmitted(r);
    expect(Object.keys(r.data!)).toHaveLength(100);
  });

  it('README nested sample query is admitted unchanged', async () => {
    const s = await post(gw, { query: SAMPLE });
    const r = single(s);
    expectAdmitted(r);
    expect(s.calls).toBe(3);
  });

  it('iter-66 token boundary holds for a distinct-alias document: 2000 admitted, 2001 QUERY_TOO_LARGE', async () => {
    const aliases = Array.from({ length: 665 }, (_, i) => `a${i}: __typename `).join('');
    const DOC_2000 = `query Q { __typename ${aliases}}`;
    const DOC_2001 = `query Q { __typename __typename ${aliases}}`;
    expect(tokens(DOC_2000)).toBe(2000);
    expect(tokens(DOC_2001)).toBe(2001);
    const ok = single(await post(gw, { query: DOC_2000 }));
    expectAdmitted(ok);
    expect(ok.data!.__typename).toBe('Query');
    const big = single(await post(gw, { query: DOC_2001 }));
    expect(codes(big)).toEqual(['QUERY_TOO_LARGE']);
  });
});

// ---------- EB8 ----------
describe('EB8 - ordering with the existing limits', () => {
  it('iter-66 author(id){ id name x1800 } stays QUERY_TOO_COMPLEX only', async () => {
    const s = await post(gw, { query: `{ author(id:"a1"){ id ${'name '.repeat(1800)}} }` });
    const r = single(s);
    expect(codes(r)).toEqual(['QUERY_TOO_COMPLEX']);
    expect(s.calls).toBe(0);
  });

  it('a too-deep document with a repeated leaf gets QUERY_TOO_DEEP and no QUERY_TOO_REPETITIVE', async () => {
    // depth 12 chain author/books/author/... with 40 x title at the leaf.
    let inner = rep('title', 40);
    for (let i = 10; i >= 1; i--) inner = `${i % 2 === 1 ? 'books' : 'author'} { ${inner} }`;
    const s = await post(gw, { query: `{ author(id:"a1"){ ${inner} } }` });
    const r = single(s);
    expect(codes(r)).toContain('QUERY_TOO_DEEP');
    expect(codes(r)).not.toContain(REPETITIVE);
    expect(s.calls).toBe(0);
  });

  it('33 x book(id){ nope } gets only QUERY_TOO_REPETITIVE, no GRAPHQL_VALIDATION_FAILED', async () => {
    const s = await post(gw, { query: `{ ${rep('book(id:"a1-b1"){ nope }', 33)} }` });
    expectRepetitive(single(s), 'book', 33);
  });

  it('control: 2 x book(id){ nope } is GRAPHQL_VALIDATION_FAILED (spec rules still run within the cap)', async () => {
    const s = await post(gw, { query: `{ ${rep('book(id:"a1-b1"){ nope }', 2)} }` });
    const r = single(s);
    expect(codes(r)).not.toContain(REPETITIVE);
    expect(codes(r)).toContain('GRAPHQL_VALIDATION_FAILED');
    expect(s.calls).toBe(0);
  });

  it('spy: graphql-js overlap validation does not run for a refused document (and does for an admitted one)', async () => {
    // A conflicting `book(id:"a1-b2")` makes OverlappingFieldsCanBeMergedRule report
    // "Fields "book" conflict ...". The spy sees every reportError on graphql-js's
    // ValidationContext, even if the gateway would later filter the error.
    const proto = ValidationContext.prototype as unknown as { reportError: (e: GraphQLError) => void };
    const original = proto.reportError;
    const seen: string[] = [];
    proto.reportError = function (this: unknown, e: GraphQLError): void {
      seen.push(e.message);
      return original.call(this, e);
    };
    try {
      const conflict = 'book(id:"a1-b2"){ id }';
      seen.length = 0;
      const admitted = single(await post(gw, { query: `{ ${rep(BOOK, 2)} ${conflict} }` }));
      expect(codes(admitted)).toContain('GRAPHQL_VALIDATION_FAILED');
      expect(seen.some((m) => m.includes('"book" conflict'))).toBe(true);

      seen.length = 0;
      const refused = await post(gw, { query: `{ ${rep(BOOK, 40)} ${conflict} }` });
      expectRepetitive(single(refused), 'book', 41);
      expect(seen.filter((m) => m.includes('conflict'))).toEqual([]);
      expect(seen).toEqual([]);
    } finally {
      proto.reportError = original;
    }
  });
});

// ---------- EB9 ----------
describe('EB9 - linear walk', () => {
  it(
    'the 150-level doubling fragment chain answers (any verdict) without exploding',
    async () => {
      const defs = Array.from({ length: 150 }, (_, i) =>
        i === 149 ? `fragment F${i} on Query { __typename }` : `fragment F${i} on Query { ...F${i + 1} ...F${i + 1} }`,
      ).join(' ');
      const DOC = `{ ...F0 } ${defs}`;
      expect(tokens(DOC)).toBeLessThanOrEqual(2000);
      const s = await post(gw, { query: DOC });
      expect(s.status).toBe(200);
      const r = single(s);
      expect(r.data !== undefined || r.errors !== undefined).toBe(true);
      expect(s.calls).toBe(0);
    },
    15_000,
  );

  it(
    'the zero-cost 30-alias x 4-level fan-out chain reaches the rule and is admitted with data',
    async () => {
      const level = (i: number): string =>
        `fragment F${i} on Author { ${Array.from(
          { length: 30 },
          (_, k) => `a${k + 1}: books(first:0){ author { ...F${i + 1} } }`,
        ).join(' ')} }`;
      const DOC = `{ author(id:"a1"){ ...F0 } } ${[0, 1, 2, 3].map(level).join(' ')} fragment F4 on Author { id }`;
      expect(tokens(DOC)).toBeLessThanOrEqual(2000);
      const s = await post(gw, { query: DOC });
      expect(s.status).toBe(200);
      const r = single(s);
      expect(r.errors).toBeUndefined();
      expect(r.data).toBeTruthy();
      expect((r.data!.author as Record<string, unknown>).a1).toEqual([]);
    },
    15_000,
  );
});

// ---------- EB10 ----------
describe('EB10 - every transport and batch element', () => {
  const DOC = `{ ${rep(BOOK, 33)} }`;

  it('GET /graphql?query=... gives the same refusal at 0 calls', async () => {
    const post1 = single(await post(gw, { query: DOC }));
    const s = await get(gw, DOC);
    const r = single(s);
    expectRepetitive(r, 'book', 33);
    expect(r).toEqual(post1);
    expect(s.calls).toBe(0);
  });

  it('the graphqlEndpoint path refuses identically over POST and GET', async () => {
    const g = createGateway({ restBaseUrl: base, graphqlEndpoint: '/api/gql' });
    const p = await post(g, { query: DOC }, '/api/gql');
    expectRepetitive(single(p), 'book', 33);
    expect(p.calls).toBe(0);
    const q = await get(g, DOC, '/api/gql');
    expectRepetitive(single(q), 'book', 33);
    expect(q.calls).toBe(0);
  });

  it('batch [refused, SAMPLE] with maxBatchSize 3: element 0 refused, element 1 answers, 3 calls total', async () => {
    const g = createGateway({ restBaseUrl: base, maxBatchSize: 3 });
    const s = await post(g, [{ query: DOC }, { query: SAMPLE }]);
    expect(s.status).toBe(200);
    expect(Array.isArray(s.body)).toBe(true);
    const [a, b] = s.body as GqlResult[];
    expectRepetitive(a!, 'book', 33);
    expect(b!.errors).toBeUndefined();
    expect(b!.data?.authors).toBeTruthy();
    expect(s.calls).toBe(3);
  });
});

// ---------- EB11 ----------
describe('EB11 - oracle and README', () => {
  it('the nested sample query costs 3 calls batched and 21 under NAIVE', async () => {
    const batched = await post(gw, { query: SAMPLE });
    expectAdmitted(single(batched));
    expect(batched.calls).toBe(3);
    const naive = createGateway({ restBaseUrl: base, loaderOptions: NAIVE });
    const n = await post(naive, { query: SAMPLE });
    expectAdmitted(single(n));
    expect(n.calls).toBe(21);
  });

  it('README §7 has a Repeated-selection cap bullet naming 32, the code and the three extensions', () => {
    const s7 = README.slice(README.indexOf('## 7.'), README.indexOf('## 8.'));
    const bullet = s7.split('\n').find((l) => l.startsWith('- **Repeated-selection cap.**'));
    expect(bullet).toBeDefined();
    for (const needle of ['**32**', 'QUERY_TOO_REPETITIVE', 'extensions.path', 'extensions.selections', 'extensions.maxSelections', 'MAX_MERGED_SELECTIONS', 'merge']) {
      expect(bullet).toContain(needle);
    }
  });

  it('README §7 no longer says "about 150 ms" and states the ~15 ms bound', () => {
    const s7 = README.slice(README.indexOf('## 7.'), README.indexOf('## 8.'));
    expect(s7).not.toMatch(/about 150\s?ms/);
    expect(s7).toMatch(/about 1[0-9]\s?ms/);
  });

  it('README §8 has a bullet for test_iter106_behavior.test.ts', () => {
    const s8 = README.slice(README.indexOf('## 8.'), README.indexOf('## 9.'));
    expect(s8).toMatch(/^- \*\*[^*]+\*\* \(`test_iter106_behavior\.test\.ts`\)/m);
  });

  it('the test-count line names a file count that includes this file', () => {
    const m = README.match(/`npm test` — (\d+) tests across (\d+) files/);
    expect(m).not.toBeNull();
    expect(Number(m![2])).toBeGreaterThanOrEqual(76);
    expect(README).toContain(`tests-${m![1]}%20passing`);
  });

  it('test/n-plus-1.test.ts still holds the 3-call / 21-call oracle', () => {
    const oracle = readFileSync(resolve(root, 'test', 'n-plus-1.test.ts'), 'utf8');
    expect(oracle).toMatch(/\b3\b/);
    expect(oracle).toMatch(/\b21\b/);
  });
});

// ---------- EB12 ----------
describe('EB12 - exported constant', () => {
  it('MAX_MERGED_SELECTIONS is exported from the package entry with value 32', () => {
    expect((lib as Record<string, unknown>).MAX_MERGED_SELECTIONS).toBe(32);
  });

  it('the README export list names MAX_MERGED_SELECTIONS', () => {
    const line = README.split('\n').find((l) => l.startsWith('Exported symbols:'));
    expect(line).toBeDefined();
    expect(line).toContain('`MAX_MERGED_SELECTIONS`');
  });

  it('README extension-code coverage includes QUERY_TOO_REPETITIVE', () => {
    expect(README.split('QUERY_TOO_REPETITIVE').length - 1).toBeGreaterThanOrEqual(2);
  });
});
