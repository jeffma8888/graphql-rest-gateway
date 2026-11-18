import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Content guard for THE N+1 REGRESSION TEST (`test/n-plus-1.test.ts`).
 *
 * Why a content guard and not a "byte-identical to HEAD" check: a git comparison
 * needs a checkout (it fails in a tarball / ZIP export) and stops seeing a
 * weakening once the weakening is committed. Pinning the oracle's titles and
 * exact assertions as text works in any copy of the repo and keeps biting after
 * every commit. Pure file read, no subprocess.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORACLE = readFileSync(resolve(__dirname, 'n-plus-1.test.ts'), 'utf8');

const TITLES = [
  'naive (no batching) makes 1 + N + M downstream calls',
  'batched (request-scoped DataLoader) makes exactly 3 downstream calls',
  'batching strictly reduces downstream load and returns identical data',
] as const;

const ASSERTIONS = [
  'expect(total).toBe(21);',
  'expect(total).toBe(3);',
  "expect(byPath['/authors']).toBe(1);",
  "expect(byPath['/books/by-author']).toBe(5);",
  "expect(byPath['/reviews/by-book']).toBe(15);",
  "expect(byPath['/books/by-author']).toBe(1);",
  "expect(byPath['/reviews/by-book']).toBe(1);",
  'expect(batched.total).toBeLessThan(naive.total);',
  'expect(batched.data).toEqual(naive.data);',
] as const;

/** Modifiers that would silently disable or invert an oracle test. */
const DISABLERS = ['.skip', '.only', '.todo', '.fails', '.skipIf', '.runIf', 'xit(', 'xdescribe('] as const;

describe('N+1 oracle content guard (git-free)', () => {
  it.each(TITLES)('declares the plain it() test %j', (title) => {
    expect(ORACLE).toContain(`it('${title}'`);
  });

  it.each(ASSERTIONS)('keeps the exact assertion %s', (assertion) => {
    expect(ORACLE).toContain(assertion);
  });

  it('uses no skip/only/todo/fails/skipIf/runIf modifier and no xit/xdescribe', () => {
    const found = DISABLERS.filter((d) => ORACLE.includes(d));
    expect(found).toEqual([]);
  });
});
