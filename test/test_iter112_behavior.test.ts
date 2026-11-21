import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend, createGateway, NAIVE, type GatewayOptions } from '../src/lib';
import { OPTION_ENV } from '../src/cli';

/**
 * iter-112: README §6 architecture map + §10 "what's next" bullets re-told to
 * match the shipped cross-request layers (PRODUCT rows 80 + 120, merged).
 *
 * Black-box: EB1/EB2 drive the bundled Fastify backend behind `createGateway`
 * through `gateway.fetch` and count backend calls as the delta of the
 * backend's own `GET /__stats` `total`. EB3-EB11 read README.md at test time,
 * anchored on headings (never line numbers or shas), and resolve the names it
 * uses against the file system, `src/**` text, `schema.graphql` and the
 * exported `OPTION_ENV` map. EB12 re-asserts the N+1 oracle (21 naive vs 3
 * batched) live and in the regression test's text.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const readmeLines = readme.split('\n');

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

// ------------------------------------------------------------- helpers ----

/** Lines from the heading line `heading` (exclusive) up to the next `## ` line. */
function section(heading: string): string[] {
  const start = readmeLines.findIndex((l) => l === heading);
  expect(start, `heading ${JSON.stringify(heading)} must exist`).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (let i = start + 1; i < readmeLines.length; i++) {
    if (readmeLines[i]!.startsWith('## ')) break;
    out.push(readmeLines[i]!);
  }
  return out;
}

const S6_HEADING = '## 6. Architecture';
const S10_HEADING = "## 10. What I'd do next in production";

function s6Map(): string[] {
  const s6 = section(S6_HEADING);
  const open = s6.findIndex((l) => l.trimStart().startsWith('```'));
  expect(open, '§6 must contain a fenced code block').toBeGreaterThanOrEqual(0);
  const close = s6.findIndex((l, i) => i > open && l.trimStart().startsWith('```'));
  expect(close, '§6 map fence must close').toBeGreaterThan(open);
  return s6.slice(open + 1, close);
}

const s10 = () => section(S10_HEADING);
const s10Bullets = () => s10().filter((l) => l.startsWith('- '));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const srcFiles = walk(resolve(root, 'src'));
const srcBasenames = new Set(srcFiles.map((p) => basename(p)));
const srcTsText = srcFiles.filter((p) => p.endsWith('.ts')).map((p) => readFileSync(p, 'utf8'));
const sdlText = readFileSync(resolve(root, 'schema.graphql'), 'utf8');
const backendText = walk(resolve(root, 'src', 'rest-backend'))
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function isWholeWordInSrcOrSdl(word: string): boolean {
  const re = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRe(word)}([^A-Za-z0-9_$]|$)`);
  return re.test(sdlText) || srcTsText.some((t) => re.test(t));
}

const backticks = (line: string): string[] => [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

type SpanVerdict = 'route' | 'path' | 'ident' | 'fail';
/** EB9 resolution rule for a backticked span in §10. */
function resolveSpan(span: string): { kind: SpanVerdict; ok: boolean } {
  if (span.startsWith('/')) return { kind: 'route', ok: backendText.includes(span) };
  if (span.includes('/') || span.endsWith('.ts')) return { kind: 'path', ok: existsSync(resolve(root, span)) };
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(span)) {
    return { kind: 'ident', ok: span.split('.').every((seg) => isWholeWordInSrcOrSdl(seg)) };
  }
  return { kind: 'fail', ok: false };
}

// ------------------------------------------------------------- live -------

type Body = { data?: any; errors?: Array<{ message: string; extensions?: Record<string, unknown> }>; extensions?: any };
type Gw = ReturnType<typeof createGateway>;

let backend: FastifyInstance;
let backendUrl: string;

beforeAll(async () => {
  backend = buildBackend({ latencyMs: 0 }).app;
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
async function delta<T>(fn: () => Promise<T>): Promise<{ calls: number; value: T }> {
  const before = await total();
  const value = await fn();
  return { calls: (await total()) - before, value };
}
async function post(gw: Gw, query: string): Promise<{ status: number; body: Body }> {
  const res = await gw.fetch(
    new Request('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Body };
}
async function withGw<T>(opts: Omit<GatewayOptions, 'restBaseUrl'>, fn: (gw: Gw) => Promise<T>): Promise<T> {
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
    expect(r.body.errors).toBeUndefined();
    return r.body.data;
  });
  expect((referenceData as any).authors.edges).toHaveLength(5);
});

describe('EB1: downstreamCacheTtlMs — first SAMPLE 3 calls, identical repeat 0 calls', () => {
  it('first SAMPLE costs 3 backend calls and reports total 3; repeat costs 0 and reports total 0 with the same data', async () => {
    await withGw({ downstreamCacheTtlMs: 60_000 }, async (gw) => {
      const first = await delta(() => post(gw, SAMPLE));
      expect(first.value.status).toBe(200);
      expect(first.value.body.errors).toBeUndefined();
      expect(first.calls).toBe(3);
      expect(first.value.body.extensions?.downstreamCalls?.total).toBe(3);
      expect(first.value.body.data).toEqual(referenceData);

      const repeat = await delta(() => post(gw, SAMPLE));
      expect(repeat.value.status).toBe(200);
      expect(repeat.value.body.errors).toBeUndefined();
      expect(repeat.calls).toBe(0);
      expect(repeat.value.body.extensions?.downstreamCalls?.total).toBe(0);
      expect(repeat.value.body.data).toEqual(first.value.body.data);
    });
  });

  it('control: without the option the repeat SAMPLE costs 3 calls again', async () => {
    await withGw({}, async (gw) => {
      expect((await delta(() => post(gw, SAMPLE))).calls).toBe(3);
      const again = await delta(() => post(gw, SAMPLE));
      expect(again.calls).toBe(3);
      expect(again.value.body.extensions?.downstreamCalls?.total).toBe(3);
    });
  });
});

describe('EB2: coalesceInFlight — 2 concurrent SAMPLEs cost 3 calls in total', () => {
  it('both 200 with identical data; backend delta 3; downstreamCalls totals sum to 3', async () => {
    await withGw({ coalesceInFlight: true }, async (gw) => {
      const { calls, value } = await delta(() => Promise.all([post(gw, SAMPLE), post(gw, SAMPLE)]));
      const [a, b] = value;
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.errors).toBeUndefined();
      expect(b.body.errors).toBeUndefined();
      expect(a.body.data).toEqual(b.body.data);
      expect(a.body.data).toEqual(referenceData);
      expect(calls).toBe(3);
      const ta = a.body.extensions?.downstreamCalls?.total;
      const tb = b.body.extensions?.downstreamCalls?.total;
      expect(typeof ta).toBe('number');
      expect(typeof tb).toBe('number');
      expect(ta + tb).toBe(3);
    });
  });

  it('control: without coalescing 2 concurrent SAMPLEs cost 6 calls', async () => {
    await withGw({}, async (gw) => {
      const { calls } = await delta(() => Promise.all([post(gw, SAMPLE), post(gw, SAMPLE)]));
      expect(calls).toBe(6);
    });
  });
});

// ------------------------------------------------------------- §6 map -----

describe('EB3: "one HTTP call per invocation" only survives as "at most one ..."', () => {
  it('no README line has the bare phrase without "at most"', () => {
    const offenders = readmeLines.filter(
      (l) => l.includes('one HTTP call per invocation') && !l.includes('at most one HTTP call per invocation'),
    );
    expect(offenders).toEqual([]);
  });

  it('the map line starting with rest-client.ts says "at most one HTTP call per invocation"', () => {
    const map = s6Map();
    const idx = map.filter((l) => l.trimStart().startsWith('rest-client.ts'));
    expect(idx).toHaveLength(1);
    expect(idx[0]).toContain('at most one HTTP call per invocation');
  });

  it('that line or the map line directly beneath has 0 + (join|coalesced) + (hit|TTL)', () => {
    const map = s6Map();
    const i = map.findIndex((l) => l.trimStart().startsWith('rest-client.ts'));
    expect(i).toBeGreaterThanOrEqual(0);
    const ok = (l: string | undefined) =>
      l !== undefined && /0/.test(l) && /\b(join|coalesced)\b/.test(l) && /\b(hit|TTL)\b/.test(l);
    expect(ok(map[i]) || ok(map[i + 1]), `lines:\n${map[i]}\n${map[i + 1]}`).toBe(true);
  });
});

describe('EB4: the map names both cross-request layers as opt-in', () => {
  it('contains coalesceInFlight, downstreamCacheTtlMs and opt-in', () => {
    const text = s6Map().join('\n');
    expect(text).toContain('coalesceInFlight');
    expect(text).toContain('downstreamCacheTtlMs');
    expect(text).toContain('opt-in');
  });

  it('both names in the map are real GatewayOptions keys (OPTION_ENV)', () => {
    expect(Object.keys(OPTION_ENV)).toContain('coalesceInFlight');
    expect(Object.keys(OPTION_ENV)).toContain('downstreamCacheTtlMs');
  });
});

describe('EB5: the map names the write path', () => {
  it('a map line whose first token is writes.ts or datasources/writes.ts; it or the next line names addReview', () => {
    const map = s6Map();
    const i = map.findIndex((l) => {
      const tok = l.trim().split(/\s+/)[0];
      return tok === 'writes.ts' || tok === 'datasources/writes.ts';
    });
    expect(i, map.join('\n')).toBeGreaterThanOrEqual(0);
    expect(`${map[i]}\n${map[i + 1] ?? ''}`).toContain('addReview');
  });

  it('addReview is a real Mutation field in the SDL', () => {
    expect(sdlText).toMatch(/\baddReview\s*\(/);
  });
});

describe('EB6: every file the map names exists; older pins hold', () => {
  it('each X.ts token in the map is the basename of an existing file under src/', () => {
    const tokens = [...new Set([...s6Map().join('\n').matchAll(/[A-Za-z0-9_-]+\.ts\b/g)].map((m) => m[0]))];
    for (const expected of ['resolvers.ts', 'lookahead.ts', 'services.ts', 'loaders.ts', 'rest-client.ts', 'writes.ts']) {
      expect(tokens).toContain(expected);
    }
    const missing = tokens.filter((t) => !srcBasenames.has(t));
    expect(missing).toEqual([]);
  });

  it('the guard rejects a made-up file name (control)', () => {
    expect(srcBasenames.has('cache-layer-that-does-not-exist.ts')).toBe(false);
    expect(srcBasenames.has('resolvers.ts')).toBe(true);
  });

  it('exactly one map line starts with resolvers.ts and it mentions lookahead', () => {
    const lines = s6Map().filter((l) => l.trimStart().startsWith('resolvers.ts'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('lookahead');
  });

  it('the Lookahead prefetch paragraph appears exactly once', () => {
    expect(readme.split('**Lookahead prefetch on by-id roots.**').length - 1).toBe(1);
  });
});

// ------------------------------------------------------------- §10 --------

describe('EB7: the §10 OTel bullet names onDownstreamCall, not /__stats', () => {
  it('exactly one §10 bullet contains OpenTelemetry; it names `onDownstreamCall` and not /__stats', () => {
    const otel = s10Bullets().filter((b) => b.includes('OpenTelemetry'));
    expect(otel).toHaveLength(1);
    expect(otel[0]).toContain('`onDownstreamCall`');
    expect(otel[0]).not.toContain('/__stats');
  });

  it('§10 contains neither /__stats nor "placeholder seam"', () => {
    const text = s10().join('\n');
    expect(text.length).toBeGreaterThan(100);
    expect(text).not.toContain('/__stats');
    expect(text).not.toContain('placeholder seam');
  });
});

describe('EB8: the §10 cache bullet says what shipped and what is next', () => {
  it('exactly one §10 bullet contains Redis; it names `downstreamCacheTtlMs`, process and replica', () => {
    const redis = s10Bullets().filter((b) => b.includes('Redis'));
    expect(redis).toHaveLength(1);
    expect(redis[0]).toContain('`downstreamCacheTtlMs`');
    expect(redis[0]).toMatch(/process/i);
    expect(redis[0]).toMatch(/replica/i);
  });
});

describe('EB9: every backticked span in §10 resolves to a real thing', () => {
  it('§10 has backticked spans and every one resolves', () => {
    const spans = s10().flatMap(backticks);
    expect(spans).toEqual(expect.arrayContaining(['onDownstreamCall', 'downstreamCacheTtlMs']));
    const bad = spans.map((s) => ({ s, ...resolveSpan(s) })).filter((r) => !r.ok);
    expect(bad).toEqual([]);
  });

  it('controls: the resolver accepts real names and rejects invented ones', () => {
    expect(resolveSpan('onDownstreamCall').ok).toBe(true);
    expect(resolveSpan('Review.reviewer').ok).toBe(true);
    expect(resolveSpan('/__stats')).toEqual({ kind: 'route', ok: true });
    expect(resolveSpan('src/cli.ts')).toEqual({ kind: 'path', ok: true });
    expect(resolveSpan('redisCacheUrl').ok).toBe(false);
    expect(resolveSpan('Review.nonexistentFieldXyz').ok).toBe(false);
    expect(resolveSpan('/no-such-route-xyz').ok).toBe(false);
    expect(resolveSpan('src/no-such-file.ts').ok).toBe(false);
    expect(resolveSpan('npm run otel')).toEqual({ kind: 'fail', ok: false });
  });
});

describe('EB10: no shipped option is presented as future work', () => {
  it('every §10 bullet naming an OPTION_ENV key in backticks says already/today/shipped', () => {
    const keys = new Set(Object.keys(OPTION_ENV));
    expect(keys.has('onDownstreamCall')).toBe(true);
    expect(keys.has('downstreamCacheTtlMs')).toBe(true);
    const naming = s10Bullets().filter((b) => backticks(b).some((s) => keys.has(s)));
    // The OTel bullet (EB7) and the cache bullet (EB8) both name a key.
    expect(naming.length).toBeGreaterThanOrEqual(2);
    const offenders = naming.filter((b) => !/\b(already|today|shipped)\b/i.test(b));
    expect(offenders).toEqual([]);
  });
});

describe('EB11: the §7 → §10 cross-reference stays intact', () => {
  it('the §10 heading is byte-for-byte unchanged', () => {
    expect(readmeLines.filter((l) => l === S10_HEADING)).toHaveLength(1);
  });

  it('§7 Observability still links to #10-what-id-do-next-in-production and names onDownstreamCall', () => {
    const s7 = section('## 7. Senior-concern coverage').join('\n');
    const obsAt = s7.indexOf('Observability');
    expect(obsAt).toBeGreaterThanOrEqual(0);
    const link = "(see [what's next](#10-what-id-do-next-in-production))";
    expect(s7).toContain(link);
    const linkLine = s7.split('\n').find((l) => l.includes(link));
    expect(linkLine).toContain('onDownstreamCall');
  });

  it('the bullet the link lands on (OTel) names the same seam', () => {
    const otel = s10Bullets().find((b) => b.includes('OpenTelemetry'));
    expect(otel).toContain('onDownstreamCall');
  });
});

describe('EB12: nothing else moves — the N+1 oracle still reads 21 naive vs 3 batched', () => {
  it('live: NAIVE SAMPLE costs 21 calls, default costs 3, same data', async () => {
    const naive = await withGw({ loaderOptions: NAIVE }, (gw) => delta(() => post(gw, SAMPLE)));
    const batched = await withGw({}, (gw) => delta(() => post(gw, SAMPLE)));
    expect(naive.calls).toBe(21);
    expect(batched.calls).toBe(3);
    expect(naive.value.body.data).toEqual(batched.value.body.data);
  });

  it('the N+1 regression test still pins toBe(21) and toBe(3)', () => {
    const n1 = readFileSync(resolve(root, 'test', 'n-plus-1.test.ts'), 'utf8');
    expect(n1).toContain('expect(total).toBe(21)');
    expect(n1).toContain('expect(total).toBe(3)');
    expect(n1).not.toMatch(/\b(it|describe|test)\.(skip|only|todo)\b/);
  });

  it('README §8 count line agrees with the badge', () => {
    const badge = /tests-(\d+)%20passing/.exec(readme);
    const line = /`npm test` — (\d+) tests across (\d+) files/.exec(readme);
    expect(badge).not.toBeNull();
    expect(line).not.toBeNull();
    expect(badge![1]).toBe(line![1]);
    const files = readdirSync(__dirname).filter((f) => f.endsWith('.test.ts')).length;
    expect(Number(line![2])).toBe(files);
  });

  it('README §8 lists this iteration\'s guard file', () => {
    expect(section('## 8. Testing').join('\n')).toContain('test_iter112_behavior.test.ts');
  });
});
