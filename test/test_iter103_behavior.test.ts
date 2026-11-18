import { describe, it, expect, expectTypeOf, afterEach } from 'vitest';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, type GatewayOptions } from '../src/lib';
import { OPTION_ENV } from '../src/cli';

/**
 * iter-103: `npm start` reaches `coalesceInFlight` / `compressMinBytes` via
 * `COALESCE_IN_FLIGHT` / `COMPRESS_MIN_BYTES`, plus the exported, tsc-enforced
 * `OPTION_ENV` option→env map (PRODUCT row 100).
 *
 * Black-box: every boot is `startFromEnv(env, log)` in-process with the
 * bundled backend (`PORT=0`, `REST_LATENCY_MS=50`) and is closed afterwards.
 * "Summed total" is the sum of `extensions.downstreamCalls.total` over a
 * 50-request `Promise.all` burst; "backend hits" is the delta of the bundled
 * backend's own `GET <restBaseUrl>/__stats` `total` across the burst.
 * Compression cases read raw bytes over node:http so `content-encoding` and
 * the gzip body are observed exactly as sent.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const cliSrc = readFileSync(resolve(root, 'src', 'cli.ts'), 'utf8');

const SAMPLE = `query Sample {
  authors(first: 5) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges { cursor node { id name books { id title reviews { id rating reviewer } } } }
  }
}`;
const SMALL = '{ author(id: "a1") { name } }';
const BURST = 50;

type Running = { url: string; restBaseUrl: string; backend: string; close(): Promise<void> };
type StartFromEnv = (env: Record<string, string | undefined>, log?: (line: string) => void) => Promise<Running>;
type Body = { data?: unknown; errors?: unknown[]; extensions?: { downstreamCalls?: { total: number } } };

async function loadStart(): Promise<StartFromEnv> {
  return ((await import('../src/cli')) as unknown as { startFromEnv: StartFromEnv }).startFromEnv;
}

const open: Running[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function boot(extra: Record<string, string | undefined>): Promise<Running> {
  const startFromEnv = await loadStart();
  const r = await startFromEnv({ PORT: '0', REST_LATENCY_MS: '50', ...extra }, () => {});
  open.push(r);
  return r;
}

async function hits(r: Running): Promise<number> {
  const res = await fetch(`${r.restBaseUrl.replace(/\/$/, '')}/__stats`);
  return ((await res.json()) as { total: number }).total;
}

async function post(url: string, query: string): Promise<{ status: number; body: Body }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

async function burst(r: Running): Promise<{ statuses: number[]; totals: number[]; sum: number; backendHits: number; bodies: Body[] }> {
  const before = await hits(r);
  const replies = await Promise.all(Array.from({ length: BURST }, () => post(r.url, SAMPLE)));
  const after = await hits(r);
  const totals = replies.map((x) => x.body.extensions?.downstreamCalls?.total ?? NaN);
  return {
    statuses: replies.map((x) => x.status),
    totals,
    sum: totals.reduce((a, b) => a + b, 0),
    backendHits: after - before,
    bodies: replies.map((x) => x.body),
  };
}

function rawPost(url: string, query: string, headers: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; raw: Buffer }> {
  return new Promise((resolveP, reject) => {
    const payload = JSON.stringify({ query });
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolveP({ status: res.statusCode ?? 0, headers: res.headers, raw: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const GZ = { 'accept-encoding': 'gzip' };

function expectUncompressed(h: http.IncomingHttpHeaders): void {
  const ce = h['content-encoding'];
  expect(ce === undefined || ce === 'identity').toBe(true);
}

async function expectReject(env: Record<string, string>, name: string, raw: string): Promise<void> {
  const startFromEnv = await loadStart();
  const lines: string[] = [];
  let err: unknown;
  let running: Running | undefined;
  try {
    running = await startFromEnv({ PORT: '0', REST_LATENCY_MS: '50', ...env }, (l) => lines.push(l));
  } catch (e) {
    err = e;
  }
  if (running) await running.close();
  expect(running).toBeUndefined();
  expect(err).toBeInstanceOf(Error);
  const msg = (err as Error).message;
  expect(msg).toContain(name);
  expect(msg).toContain(JSON.stringify(raw));
  // nothing listened: no startup log line was emitted
  expect(lines).toEqual([]);
}

describe('EB1: COALESCE_IN_FLIGHT unset keeps the default (no coalescing)', () => {
  it('burst → 50×200, each total 3, summed 150, backend hits 150', async () => {
    const r = await boot({});
    const b = await burst(r);
    expect(b.statuses).toEqual(Array(BURST).fill(200));
    expect(b.totals).toEqual(Array(BURST).fill(3));
    expect(b.sum).toBe(150);
    expect(b.backendHits).toBe(150);
  });
});

describe('EB2: COALESCE_IN_FLIGHT=1 coalesces the burst', () => {
  it('burst → 50×200, data deep-equal to a single reply, summed ≤ 15 and === backend hits', async () => {
    const r = await boot({ COALESCE_IN_FLIGHT: '1' });
    const single = await post(r.url, SAMPLE);
    expect(single.status).toBe(200);
    expect(single.body.errors).toBeUndefined();
    expect(single.body.extensions?.downstreamCalls?.total).toBe(3);
    const b = await burst(r);
    expect(b.statuses).toEqual(Array(BURST).fill(200));
    for (const body of b.bodies) {
      expect(body.errors).toBeUndefined();
      expect(body.data).toEqual(single.body.data);
    }
    expect(b.sum).toBeLessThanOrEqual(15);
    expect(b.sum).toBeGreaterThanOrEqual(3);
    expect(b.sum).toBe(b.backendHits);
  });
});

describe('EB3: COALESCE_IN_FLIGHT accepted spellings', () => {
  it('COALESCE_IN_FLIGHT=true behaves like 1 (summed ≤ 15, === backend hits)', async () => {
    const r = await boot({ COALESCE_IN_FLIGHT: 'true' });
    const b = await burst(r);
    expect(b.statuses).toEqual(Array(BURST).fill(200));
    expect(b.sum).toBeLessThanOrEqual(15);
    expect(b.sum).toBe(b.backendHits);
  });
  for (const v of ['0', 'false', '']) {
    it(`COALESCE_IN_FLIGHT=${JSON.stringify(v)} behaves like unset (summed 150, backend hits 150)`, async () => {
      const r = await boot({ COALESCE_IN_FLIGHT: v });
      const b = await burst(r);
      expect(b.statuses).toEqual(Array(BURST).fill(200));
      expect(b.totals).toEqual(Array(BURST).fill(3));
      expect(b.sum).toBe(150);
      expect(b.backendHits).toBe(150);
    });
  }
});

describe('EB4: invalid COALESCE_IN_FLIGHT rejects before listening', () => {
  for (const v of ['banana', 'yes', 'TRUE', '2', ' 1']) {
    it(`COALESCE_IN_FLIGHT=${JSON.stringify(v)} rejects naming the variable and the quoted raw value`, async () => {
      await expectReject({ COALESCE_IN_FLIGHT: v }, 'COALESCE_IN_FLIGHT', v);
    });
  }
});

describe('EB5: COMPRESS_MIN_BYTES=0 compresses even a small reply', () => {
  it('COMPRESS_MIN_BYTES=0 → small reply is content-encoding gzip and gunzips to valid JSON', async () => {
    const r = await boot({ COMPRESS_MIN_BYTES: '0' });
    const res = await rawPost(r.url, SMALL, GZ);
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    const body = JSON.parse(gunzipSync(res.raw).toString('utf8')) as { data?: { author?: { name?: unknown } }; errors?: unknown };
    expect(body.errors).toBeUndefined();
    expect(typeof body.data?.author?.name).toBe('string');
  });
  it('unset → the same small reply is not compressed (default 1024 unchanged)', async () => {
    const r = await boot({});
    const res = await rawPost(r.url, SMALL, GZ);
    expect(res.status).toBe(200);
    expectUncompressed(res.headers);
    const body = JSON.parse(res.raw.toString('utf8')) as { data?: { author?: { name?: unknown } } };
    expect(typeof body.data?.author?.name).toBe('string');
  });
});

describe('EB6: COMPRESS_MIN_BYTES=off disables compression', () => {
  it('COMPRESS_MIN_BYTES=off → nested sample (≥ 1024 identity bytes) is not gzip', async () => {
    const r = await boot({ COMPRESS_MIN_BYTES: 'off' });
    const res = await rawPost(r.url, SAMPLE, GZ);
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).not.toBe('gzip');
    expectUncompressed(res.headers);
    expect(res.raw.length).toBeGreaterThanOrEqual(1024);
    const body = JSON.parse(res.raw.toString('utf8')) as Body;
    expect(body.errors).toBeUndefined();
    expect(body.extensions?.downstreamCalls?.total).toBe(3);
  });
  it('unset → the same nested sample IS gzip', async () => {
    const r = await boot({});
    const res = await rawPost(r.url, SAMPLE, GZ);
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    const body = JSON.parse(gunzipSync(res.raw).toString('utf8')) as Body;
    expect(body.errors).toBeUndefined();
    expect(body.extensions?.downstreamCalls?.total).toBe(3);
  });
});

describe('EB7: COMPRESS_MIN_BYTES=5000 raises the threshold', () => {
  it('COMPRESS_MIN_BYTES=5000 → nested sample (identity < 5000 bytes) comes back uncompressed', async () => {
    const r = await boot({ COMPRESS_MIN_BYTES: '5000' });
    const res = await rawPost(r.url, SAMPLE, GZ);
    expect(res.status).toBe(200);
    expectUncompressed(res.headers);
    expect(res.raw.length).toBeLessThan(5000);
    expect(res.raw.length).toBeGreaterThanOrEqual(1024);
    const body = JSON.parse(res.raw.toString('utf8')) as Body;
    expect(body.errors).toBeUndefined();
  });
});

describe('EB8: invalid COMPRESS_MIN_BYTES rejects before listening; empty = unset', () => {
  for (const v of ['-1', '1.5', '10abc', 'OFF', 'false', 'banana']) {
    it(`COMPRESS_MIN_BYTES=${JSON.stringify(v)} rejects naming the variable and the quoted raw value`, async () => {
      await expectReject({ COMPRESS_MIN_BYTES: v }, 'COMPRESS_MIN_BYTES', v);
    });
  }
  it('COMPRESS_MIN_BYTES="" behaves like unset: small reply plain, nested sample gzip', async () => {
    const r = await boot({ COMPRESS_MIN_BYTES: '' });
    const small = await rawPost(r.url, SMALL, GZ);
    expect(small.status).toBe(200);
    expectUncompressed(small.headers);
    const big = await rawPost(r.url, SAMPLE, GZ);
    expect(big.status).toBe(200);
    expect(big.headers['content-encoding']).toBe('gzip');
  });
});

const EXPECTED_MAP: Record<keyof GatewayOptions, string | null> = {
  restBaseUrl: 'REST_BASE_URL',
  maxDepth: 'MAX_DEPTH',
  maxComplexity: 'MAX_COMPLEXITY',
  loaderOptions: null,
  downstreamTimeoutMs: 'DOWNSTREAM_TIMEOUT_MS',
  maxDownstreamCalls: 'MAX_DOWNSTREAM_CALLS',
  forwardHeaders: 'FORWARD_HEADERS',
  maxBatchSize: 'MAX_BATCH_SIZE',
  onDownstreamCall: null,
  graphqlEndpoint: 'GRAPHQL_PATH',
  compressMinBytes: 'COMPRESS_MIN_BYTES',
  coalesceInFlight: 'COALESCE_IN_FLIGHT',
  downstreamCacheTtlMs: 'DOWNSTREAM_CACHE_TTL_MS',
};

describe('EB9: OPTION_ENV is exported and typed Record<keyof GatewayOptions, string | null>', () => {
  it('is typed exactly Record<keyof GatewayOptions, string | null> (tsc-checked)', () => {
    expectTypeOf(OPTION_ENV).toEqualTypeOf<Record<keyof GatewayOptions, string | null>>();
    const typed: Record<keyof GatewayOptions, string | null> = OPTION_ENV;
    expect(typed).toBe(OPTION_ENV);
  });
  it('maps the 11 env-reachable options to their variables and nulls exactly loaderOptions / onDownstreamCall', () => {
    expect({ ...OPTION_ENV }).toEqual(EXPECTED_MAP);
    expect(Object.keys(OPTION_ENV).sort()).toEqual(Object.keys(EXPECTED_MAP).sort());
    const nulls = Object.entries(OPTION_ENV)
      .filter(([, v]) => v === null)
      .map(([k]) => k)
      .sort();
    expect(nulls).toEqual(['loaderOptions', 'onDownstreamCall']);
  });
});

/** Data rows of the first markdown table that follows `anchor` (header + separator skipped). */
function tableAfter(anchor: string): string[] {
  const at = readme.indexOf(anchor);
  expect(at).toBeGreaterThanOrEqual(0);
  const lines = readme.slice(at).split('\n');
  const start = lines.findIndex((l) => l.startsWith('|'));
  expect(start).toBeGreaterThan(0);
  const rows: string[] = [];
  for (let i = start + 2; i < lines.length && lines[i]!.startsWith('|'); i++) rows.push(lines[i]!);
  return rows;
}
function cells(row: string): string[] {
  // split on unescaped pipes (the options table escapes `\|` inside type cells)
  return row
    .replace(/\\\|/g, '\u0000')
    .split('|')
    .slice(1, -1)
    .map((c) => c.replace(/\u0000/g, '|').trim());
}
const optionRows = () => tableAfter('**`GatewayOptions`**');
const envRows = () => tableAfter('### Front your own REST service');

describe('EB10: drift guard OPTION_ENV ↔ README ↔ cli.ts', () => {
  it('OPTION_ENV keys === the first-column option names of the README GatewayOptions table', () => {
    const names = optionRows().map((r) => /^`([A-Za-z]+)`$/.exec(cells(r)[0]!)?.[1]);
    expect(names.every((n) => typeof n === 'string')).toBe(true);
    expect([...(names as string[])].sort()).toEqual(Object.keys(OPTION_ENV).sort());
  });
  it('every non-null value has its own README env-table row whose rule cell names the option in backticks', () => {
    const rows = envRows();
    const mapped = Object.entries(OPTION_ENV).filter((e): e is [string, string] => e[1] !== null);
    expect(mapped).toHaveLength(11);
    for (const [opt, name] of mapped) {
      const own = rows.filter((l) => l.startsWith(`| \`${name}\` |`));
      expect(own, name).toHaveLength(1);
      expect(cells(own[0]!)[1], `${name} rule cell`).toContain(`\`${opt}\``);
    }
  });
  it('every non-null value is read in src/cli.ts as env.NAME', () => {
    for (const name of Object.values(OPTION_ENV)) {
      if (name === null) continue;
      expect(new RegExp(`\\benv\\.${name}\\b`).test(cliSrc), name).toBe(true);
    }
  });
});

describe('EB11: README env table rows and library-only sentence', () => {
  it('env table has 13 rows (10 prior + COALESCE_IN_FLIGHT + COMPRESS_MIN_BYTES + DOWNSTREAM_CACHE_TTL_MS, iter-105), each exactly once', () => {
    const rows = envRows();
    expect(rows).toHaveLength(13);
    expect(rows.filter((r) => r.startsWith('| `COALESCE_IN_FLIGHT` |'))).toHaveLength(1);
    expect(rows.filter((r) => r.startsWith('| `COMPRESS_MIN_BYTES` |'))).toHaveLength(1);
  });
  it('COALESCE_IN_FLIGHT row: 1/true or 0/false → coalesceInFlight, default 0 (off)', () => {
    const [name, rule, def] = cells(envRows().find((r) => r.startsWith('| `COALESCE_IN_FLIGHT` |'))!);
    expect(name).toBe('`COALESCE_IN_FLIGHT`');
    for (const tok of ['`1`', '`true`', '`0`', '`false`', '`coalesceInFlight`']) expect(rule).toContain(tok);
    expect(rule).toContain('→');
    expect(def).toContain('`0`');
    expect(def).toMatch(/off/);
  });
  it('COMPRESS_MIN_BYTES row: non-negative integer or off → compressMinBytes, default 1024', () => {
    const [name, rule, def] = cells(envRows().find((r) => r.startsWith('| `COMPRESS_MIN_BYTES` |'))!);
    expect(name).toBe('`COMPRESS_MIN_BYTES`');
    expect(rule).toMatch(/non-negative integer/);
    expect(rule).toContain('`off`');
    expect(rule).toContain('`compressMinBytes`');
    expect(def).toContain('1024');
  });
  it('the env section says loaderOptions and onDownstreamCall are library-only', () => {
    const at = readme.indexOf('### Front your own REST service');
    const section = readme.slice(at, readme.indexOf('\n### ', at + 5));
    const sentence = section.split(/(?<=\.)\s/).find((s) => s.includes('`loaderOptions`') && s.includes('`onDownstreamCall`'));
    expect(sentence).toBeDefined();
    expect(sentence).toMatch(/library-only/);
  });
  it('the GatewayOptions options table keeps exactly 13 data rows', () => {
    expect(optionRows()).toHaveLength(13);
  });
});

describe('EB12: library surface unchanged', () => {
  it('createGateway still rejects an unknown key with the did-you-mean TypeError', () => {
    expect(() =>
      createGateway({ restBaseUrl: 'http://127.0.0.1:1', coalesceInFlite: true } as unknown as GatewayOptions),
    ).toThrow(/^Unknown createGateway option "coalesceInFlite"/);
  });
  it('createGateway validators still name the camelCase option, not the env variable', () => {
    for (const [opt, bad] of [
      ['coalesceInFlight', 'yes'],
      ['compressMinBytes', -1],
    ] as const) {
      let err: unknown;
      try {
        createGateway({ restBaseUrl: 'http://127.0.0.1:1', [opt]: bad } as unknown as GatewayOptions);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TypeError);
      const msg = (err as Error).message;
      expect(msg).toContain(opt);
      expect(msg).not.toMatch(/^Unknown createGateway option/);
      expect(msg).not.toMatch(/COALESCE_IN_FLIGHT|COMPRESS_MIN_BYTES/);
    }
  });
});
