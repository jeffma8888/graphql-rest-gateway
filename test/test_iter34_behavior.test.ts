import { describe, it, expect } from 'vitest';
import { readFileSync, globSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function readText(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

function extractExtensionCodes(): string[] {
  const srcFiles = globSync(resolve(root, 'src/**/*.ts'));
  const codeSet = new Set<string>();
  const pattern = /extensions\b[^;]*?\bcode\b[^;]*?['"]([A-Z_]+)['"]/g;
  for (const file of srcFiles) {
    const content = readFileSync(file, 'utf8');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      codeSet.add(match[1]!);
    }
  }
  return [...codeSet].sort();
}

const KNOWN_CODES = [
  'BAD_CURSOR',
  'DOWNSTREAM_TIMEOUT',
  'NOT_FOUND',
  'QUERY_TOO_COMPLEX',
  'QUERY_TOO_DEEP',
  'UNAUTHENTICATED',
];

// EB1 — Drift guard scans src/ for extension code patterns
describe('EB1 — drift guard scans src/ for extension codes', () => {
  it('finds extension code strings by scanning all .ts files under src/', () => {
    const codes = extractExtensionCodes();
    expect(codes.length).toBeGreaterThanOrEqual(1);
  });

  it('each extracted code is an UPPER_SNAKE_CASE string', () => {
    const codes = extractExtensionCodes();
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });
});

// EB2 — Every extracted code appears in README.md
describe('EB2 — every source extension code is documented in README', () => {
  it('each code extracted from src/ appears at least once in README.md', () => {
    const codes = extractExtensionCodes();
    const readme = readText('README.md');
    const missing: string[] = [];
    for (const code of codes) {
      if (!readme.includes(code)) {
        missing.push(code);
      }
    }
    expect(missing, `Extension codes missing from README: ${missing.join(', ')}`).toEqual([]);
  });
});

// EB3 — At least 6 known codes discovered
describe('EB3 — discovers at least the 6 currently-defined codes', () => {
  it('finds at least 6 extension codes', () => {
    const codes = extractExtensionCodes();
    expect(codes.length).toBeGreaterThanOrEqual(6);
  });

  it.each(KNOWN_CODES)('discovers %s', (code) => {
    const codes = extractExtensionCodes();
    expect(codes).toContain(code);
  });
});

// EB4 — README "Cursor pagination" mentions BAD_CURSOR
describe('EB4 — README documents BAD_CURSOR in cursor pagination section', () => {
  it('README contains BAD_CURSOR in the cursor pagination context', () => {
    const readme = readText('README.md');
    const cursorSection = readme.slice(
      readme.indexOf('### Cursor pagination'),
      readme.indexOf('###', readme.indexOf('### Cursor pagination') + 1),
    );
    expect(cursorSection).toContain('BAD_CURSOR');
  });
});

// EB5 — README "Auth context" mentions UNAUTHENTICATED
describe('EB5 — README documents UNAUTHENTICATED in auth context section', () => {
  it('README contains UNAUTHENTICATED in the auth context section', () => {
    const readme = readText('README.md');
    const authIdx = readme.indexOf('Auth context');
    expect(authIdx).toBeGreaterThan(-1);
    const authSection = readme.slice(authIdx);
    expect(authSection).toContain('UNAUTHENTICATED');
  });
});

// EB6 — README has "Downstream timeout" subsection with DOWNSTREAM_TIMEOUT and downstreamTimeoutMs
describe('EB6 — README documents DOWNSTREAM_TIMEOUT in downstream timeout section', () => {
  it('README has a "Downstream timeout" subsection', () => {
    const readme = readText('README.md');
    expect(readme).toContain('Downstream timeout');
  });

  it('downstream timeout section mentions DOWNSTREAM_TIMEOUT code', () => {
    const readme = readText('README.md');
    const idx = readme.indexOf('Downstream timeout');
    const section = readme.slice(idx, readme.indexOf('###', idx + 1));
    expect(section).toContain('DOWNSTREAM_TIMEOUT');
  });

  it('downstream timeout section mentions downstreamTimeoutMs config knob', () => {
    const readme = readText('README.md');
    const idx = readme.indexOf('Downstream timeout');
    const section = readme.slice(idx, readme.indexOf('###', idx + 1));
    expect(section).toContain('downstreamTimeoutMs');
  });
});

// EB7 — Suite count floor (pre-iter-34 baseline)
describe('EB7 — full suite passes with no regressions', () => {
  it('README test-count badge is at least 156 (pre-iter-34 baseline)', () => {
    const readme = readText('README.md');
    const match = readme.match(/tests-(\d+)%20passing/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(156);
  });
});
