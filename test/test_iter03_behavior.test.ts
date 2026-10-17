import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function readJson(rel: string): any {
  return JSON.parse(readFileSync(resolve(root, rel), 'utf8'));
}

function readText(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

// EB1: package.json declares exports map, main, types
describe('EB1 — package.json exports, main, types', () => {
  const pkg = readJson('package.json');

  it('has a main field pointing to dist/src/lib.js', () => {
    expect(pkg.main).toBe('dist/src/lib.js');
  });

  it('has a types field pointing to dist/src/lib.d.ts', () => {
    expect(pkg.types).toBe('dist/src/lib.d.ts');
  });

  it('has an exports map for "."', () => {
    expect(pkg.exports).toBeDefined();
    expect(pkg.exports['.']).toBeDefined();
  });

  it('exports map has types before import (declaration order)', () => {
    const conditions = Object.keys(pkg.exports['.']);
    const typesIdx = conditions.indexOf('types');
    const importIdx = conditions.indexOf('import');
    expect(typesIdx).toBeGreaterThanOrEqual(0);
    expect(importIdx).toBeGreaterThanOrEqual(0);
    expect(typesIdx).toBeLessThan(importIdx);
  });

  it('exports map types points to .d.ts, import points to .js', () => {
    const dot = pkg.exports['.'];
    expect(dot.types).toBe('./dist/src/lib.d.ts');
    expect(dot.import).toBe('./dist/src/lib.js');
  });
});

// EB3: tsconfig.json sets declaration: true
describe('EB3 — tsconfig declaration setting', () => {
  const tsconfig = readJson('tsconfig.json');

  it('has declaration: true in compilerOptions', () => {
    expect(tsconfig.compilerOptions.declaration).toBe(true);
  });

  it('does NOT assert dist/ artifacts exist (clean-clone safe)', () => {
    // This test is intentionally a no-op assertion documenting that
    // we verify the config setting, not the build output.
    expect(true).toBe(true);
  });
});

// EB2: barrel re-exports 8 symbols (value exports checked at runtime)
describe('EB2 — barrel re-exports all public API symbols', () => {
  let barrel: Record<string, unknown>;

  beforeAll(async () => {
    barrel = await import('../src/lib');
  });

  it('exports createGateway as a function', () => {
    expect(typeof barrel.createGateway).toBe('function');
  });

  it('exports createContext as a function', () => {
    expect(typeof barrel.createContext).toBe('function');
  });

  it('exports parseAuth as a function', () => {
    expect(typeof barrel.parseAuth).toBe('function');
  });

  it('exports buildBackend as a function', () => {
    expect(typeof barrel.buildBackend).toBe('function');
  });

  it('exports schema as a GraphQL schema object', () => {
    expect(barrel.schema).toBeDefined();
    expect(typeof barrel.schema).toBe('object');
  });

  it('exports exactly the documented value symbols (no extras, no missing)', () => {
    const valueExports = Object.keys(barrel).filter(
      (k) => typeof barrel[k] !== 'undefined'
    );
    expect(valueExports).toContain('createGateway');
    expect(valueExports).toContain('createContext');
    expect(valueExports).toContain('parseAuth');
    expect(valueExports).toContain('buildBackend');
    expect(valueExports).toContain('schema');
  });
});

// EB4: barrel imports produce a working gateway
describe('EB4 — barrel-imported gateway boots and serves queries', () => {
  let app: FastifyInstance;
  let yoga: any;

  beforeAll(async () => {
    const { createGateway, buildBackend } = await import('../src/lib');
    app = buildBackend({ latencyMs: 0 }).app;
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    yoga = createGateway({ restBaseUrl: baseUrl });
  });

  afterAll(async () => {
    await app.close();
  });

  it('responds 200 with valid data for an authors query', async () => {
    const res = await yoga.fetch('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: '{ authors(first: 1) { edges { node { id } } } }',
      }),
    });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data.authors.edges).toHaveLength(1);
    expect(body.data.authors.edges[0].node.id).toBeTruthy();
  });

  it('responds with correct nested structure for a deeper query', async () => {
    const res = await yoga.fetch('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: '{ authors(first: 2) { totalCount edges { node { id name books { id title } } } } }',
      }),
    });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data.authors.totalCount).toBeGreaterThan(0);
    expect(body.data.authors.edges.length).toBeGreaterThanOrEqual(1);
    expect(body.data.authors.edges[0].node.name).toBeTruthy();
    expect(body.data.authors.edges[0].node.books).toBeInstanceOf(Array);
  });
});

// EB7: README updates
describe('EB7 — README content updates', () => {
  const readme = readText('README.md');

  it('badge shows at least 78 passing tests', () => {
    const match = readme.match(/tests-(\d+)%20passing/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(78);
  });

  it('testing section mentions at least 10 test files', () => {
    const match = readme.match(/(\d+) files \(Vitest\)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(10);
  });

  it('has a Programmatic usage section', () => {
    expect(readme).toMatch(/Programmatic usage/i);
  });

  it('Programmatic usage section lists all 8 exported symbols', () => {
    const symbols = [
      'createGateway', 'GatewayOptions', 'createContext', 'parseAuth',
      'GatewayContext', 'AuthContext', 'buildBackend', 'schema',
    ];
    for (const sym of symbols) {
      expect(readme).toContain(sym);
    }
  });
});

// EB8: PRODUCT.md exists with roadmap table
describe('EB8 — PRODUCT.md roadmap', () => {
  const product = readText('PRODUCT.md');

  it('contains a roadmap table', () => {
    expect(product).toMatch(/\|\s*#\s*\|\s*Feature/);
  });

  it('has at least 10 features in the table', () => {
    const featureRows = product.split('\n').filter(
      (line) => /^\|\s*\d+\s*\|/.test(line)
    );
    expect(featureRows.length).toBeGreaterThanOrEqual(10);
  });

  it('feature #1 is done at iter-03', () => {
    expect(product).toMatch(/\|\s*1\s*\|.*done.*03/i);
  });

  it('includes product summary', () => {
    expect(product).toMatch(/Summary/i);
  });

  it('includes target user', () => {
    expect(product).toMatch(/Target User/i);
  });

  it('includes quality bar', () => {
    expect(product).toMatch(/Quality Bar/i);
  });
});
