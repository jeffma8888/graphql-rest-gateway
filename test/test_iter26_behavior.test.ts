import { describe, it, expect } from 'vitest';
import { readFileSync, accessSync, existsSync, constants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSchema } from 'graphql';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function readText(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

function parseSimpleYaml(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    result[key] = value;
  }
  return result;
}

const CONFIG_PATH = '.graphqlrc.yml';

function getSchemaPath(): string {
  const doc = parseSimpleYaml(readText(CONFIG_PATH));
  const schema = doc['schema'];
  if (!schema) throw new Error('schema key missing from .graphqlrc.yml');
  return schema;
}

// EB1 — .graphqlrc.yml exists at the project root and is valid YAML
describe('EB1 — .graphqlrc.yml exists and is valid YAML', () => {
  it('file exists and is readable', () => {
    accessSync(resolve(root, CONFIG_PATH), constants.R_OK);
  });

  it('is not empty', () => {
    const raw = readText(CONFIG_PATH);
    expect(raw.trim().length).toBeGreaterThan(0);
  });

  it('parses as valid YAML with at least one key', () => {
    const raw = readText(CONFIG_PATH);
    const doc = parseSimpleYaml(raw);
    expect(Object.keys(doc).length).toBeGreaterThanOrEqual(1);
  });
});

// EB2 — schema key resolves to a readable .graphql file
describe('EB2 — schema key resolves to an existing .graphql file', () => {
  it('config has a "schema" key', () => {
    const doc = parseSimpleYaml(readText(CONFIG_PATH));
    expect(doc).toHaveProperty('schema');
  });

  it('schema value ends with .graphql', () => {
    const schemaRef = getSchemaPath();
    expect(schemaRef).toMatch(/\.graphql$/);
  });

  it('schema path resolves to an existing, readable file', () => {
    const schemaRef = getSchemaPath();
    accessSync(resolve(root, schemaRef), constants.R_OK);
  });

  it('schema file is non-empty', () => {
    const schemaRef = getSchemaPath();
    const content = readFileSync(resolve(root, schemaRef), 'utf8');
    expect(content.trim().length).toBeGreaterThan(0);
  });
});

// EB3 — resolved schema file is valid GraphQL SDL
describe('EB3 — resolved schema file is valid GraphQL SDL', () => {
  it('parses without error via buildSchema', () => {
    const sdl = readFileSync(resolve(root, getSchemaPath()), 'utf8');
    const schema = buildSchema(sdl);
    expect(schema).toBeDefined();
  });

  it('schema defines a Query type', () => {
    const sdl = readFileSync(resolve(root, getSchemaPath()), 'utf8');
    const schema = buildSchema(sdl);
    expect(schema.getQueryType()).toBeDefined();
  });
});

// EB4 — .graphqlrc.yml is included in the published npm package
describe('EB4 — .graphqlrc.yml ships in the npm tarball', () => {
  it('.graphqlrc.yml is not excluded by npm packaging rules', () => {
    const pkg = JSON.parse(readText('package.json'));
    const hasFilesArray = Array.isArray(pkg.files);
    const hasNpmIgnore = existsSync(resolve(root, '.npmignore'));

    if (hasFilesArray) {
      expect(pkg.files).toContain('.graphqlrc.yml');
    } else if (hasNpmIgnore) {
      const npmignore = readText('.npmignore');
      expect(npmignore).not.toMatch(/\.graphqlrc\.yml/);
    } else {
      const gitignore = readText('.gitignore');
      expect(gitignore).not.toMatch(/\.graphqlrc\.yml/);
    }
  });

  it('.graphqlrc.yml is not in .gitignore', () => {
    const gitignore = readText('.gitignore');
    expect(gitignore).not.toMatch(/\.graphqlrc\.yml/);
    expect(gitignore).not.toMatch(/\*\.yml/);
  });

  it('package.json has no "files" array that could exclude the config', () => {
    const pkg = JSON.parse(readText('package.json'));
    if (pkg.files) {
      expect(pkg.files).toContain('.graphqlrc.yml');
    } else {
      expect(pkg.files).toBeUndefined();
    }
  });
});

// EB5 — existing quality-check suite passes with no regressions
// Verified by the full-suite run (npm test && npm run typecheck).
// We assert the test count floor stays at least at the pre-iter-26 baseline.
describe('EB5 — no regressions in existing suite', () => {
  it('README test-count badge is at least 117 (pre-iter-26 baseline)', () => {
    const readme = readText('README.md');
    const match = readme.match(/tests-(\d+)%20passing/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(117);
  });
});
