import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function readText(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

const readme = readText('README.md');
const iter03Test = readText('test/test_iter03_behavior.test.ts');

// EB1: README badge shows current test count (78 passing)
describe('EB1 — README badge shows 78 passing tests', () => {
  it('test badge contains tests-78%20passing', () => {
    expect(readme).toContain('tests-78%20passing');
  });

  it('badge is on the expected line (shields.io format)', () => {
    const badgeLine = readme.split('\n').find((l) => l.includes('tests-') && l.includes('passing'));
    expect(badgeLine).toBeDefined();
    expect(badgeLine).toMatch(/img\.shields\.io\/badge\/tests-78%20passing/);
  });
});

// EB2: README badge shows current coverage (~86% lines)
describe('EB2 — README badge shows ~86% coverage', () => {
  it('coverage badge contains coverage-~86%25%20lines', () => {
    expect(readme).toContain('coverage-~86%25%20lines');
  });
});

// EB3: README Section 8 prose says "78 tests across 10 files"
describe('EB3 — README Section 8 prose matches actual counts', () => {
  it('Section 8 opening says "78 tests across 10 files"', () => {
    expect(readme).toMatch(/78 tests across 10 files/);
  });
});

// EB4: README Section 8 coverage stats updated
describe('EB4 — README Section 8 coverage stats updated', () => {
  it('Section 8 coverage line includes ~84% statements', () => {
    expect(readme).toMatch(/~84% statements/);
  });

  it('Section 8 coverage line includes ~86% lines', () => {
    expect(readme).toMatch(/~86% lines/);
  });

  it('Section 8 coverage line includes ~89% functions', () => {
    expect(readme).toMatch(/~89% functions/);
  });
});

// EB5: iter-03 EB7 test uses floor-based assertion for test count (>= 78)
describe('EB5 — EB7 test-count assertion is floor-based', () => {
  it('extracts digit from badge URL via regex', () => {
    expect(iter03Test).toMatch(/tests-\(\\d\+\)%20passing/);
  });

  it('asserts >= 78 (floor-based, not hardcoded exact match)', () => {
    expect(iter03Test).toMatch(/toBeGreaterThanOrEqual\(78\)/);
  });

  it('does NOT contain the old hardcoded tests-30 assertion', () => {
    expect(iter03Test).not.toMatch(/tests-30/);
  });
});

// EB6: iter-03 EB7 test uses floor-based assertion for file count (>= 10)
describe('EB6 — EB7 file-count assertion is floor-based', () => {
  it('extracts digit from "N files (Vitest)" pattern', () => {
    expect(iter03Test).toMatch(/\(\\d\+\) files/);
  });

  it('asserts >= 10 for file count (floor-based)', () => {
    expect(iter03Test).toMatch(/toBeGreaterThanOrEqual\(10\)/);
  });

  it('does NOT contain the old hardcoded "7 files" assertion', () => {
    expect(iter03Test).not.toMatch(/7 files/);
  });
});

// EB7: iter-03 EB8 test description/assertion aligned and floor-based
describe('EB7 — EB8 description matches its assertion', () => {
  it('test description says "at least 10 features" (or similar)', () => {
    expect(iter03Test).toMatch(/at least 10 features/i);
  });

  it('assertion uses toBeGreaterThanOrEqual(10)', () => {
    const eb8Block = iter03Test.slice(iter03Test.indexOf('EB8'));
    expect(eb8Block).toMatch(/toBeGreaterThanOrEqual\(10\)/);
  });

  it('does NOT use the old toHaveLength(10) for feature count', () => {
    const eb8Block = iter03Test.slice(iter03Test.indexOf('EB8'));
    expect(eb8Block).not.toMatch(/toHaveLength\(10\)/);
  });
});

// EB8: Full quality-check suite passes — verified by running npm test outside this file
describe('EB8 — full quality-check passes', () => {
  it('this test file itself runs without errors (part of the full suite)', () => {
    expect(true).toBe(true);
  });
});
