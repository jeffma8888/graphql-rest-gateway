import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function readText(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

const schema = readText('schema.graphql');

function extractDocComment(sdl: string, fieldPattern: RegExp): string | null {
  const lines = sdl.split('\n');
  const fieldIdx = lines.findIndex((l) => fieldPattern.test(l));
  if (fieldIdx === -1) return null;

  // Walk backwards from the field line to find the closing """ then the opening """
  let end = -1;
  let start = -1;
  for (let i = fieldIdx - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (end === -1) {
      if (trimmed === '"""' || trimmed.endsWith('"""')) {
        end = i;
      } else if (trimmed === '') {
        continue;
      } else {
        break;
      }
    } else {
      if (trimmed === '"""' || trimmed.startsWith('"""')) {
        start = i;
        break;
      }
    }
  }
  if (start === -1 || end === -1) return null;
  return lines.slice(start, end + 1).join('\n');
}

const reviewerDocComment = extractDocComment(schema, /^\s*reviewer:\s*String!/);

// EB1 — SDL doc-comment for `reviewer` mentions the string `pii`
describe('EB1 — SDL reviewer doc-comment mentions pii', () => {
  it('doc-comment block exists for reviewer field', () => {
    expect(reviewerDocComment).not.toBeNull();
  });

  it('doc-comment contains the literal substring "pii"', () => {
    expect(reviewerDocComment).toContain('pii');
  });
});

// EB2 — SDL doc-comment still mentions redaction to "REDACTED"
describe('EB2 — SDL reviewer doc-comment mentions REDACTED', () => {
  it('doc-comment contains the literal substring "REDACTED"', () => {
    expect(reviewerDocComment).toContain('REDACTED');
  });

  it('doc-comment describes redaction behavior', () => {
    expect(reviewerDocComment).toMatch(/redacted/i);
  });
});

// EB3 — Drift-guard: SDL doc-comment for reviewer contains "pii"
describe('EB3 — drift-guard: SDL doc-comment for reviewer contains pii', () => {
  it('schema.graphql is readable', () => {
    expect(schema.length).toBeGreaterThan(0);
  });

  it('reviewer field line exists in schema.graphql', () => {
    expect(schema).toMatch(/reviewer:\s*String!/);
  });

  it('doc-comment immediately preceding reviewer: String! contains "pii"', () => {
    const comment = extractDocComment(schema, /^\s*reviewer:\s*String!/);
    expect(comment, 'doc-comment block not found for reviewer field').not.toBeNull();
    expect(comment).toContain('pii');
  });
});

// EB4 — Drift-guard: cross-reference resolver scope string with SDL doc-comment
describe('EB4 — drift-guard: resolver scope string matches SDL doc-comment', () => {
  const resolverSrc = readText('src/gateway/resolvers.ts');

  it('resolvers.ts contains a scopes.includes(...) call', () => {
    expect(resolverSrc).toMatch(/scopes\.includes\(/);
  });

  it('extracts the scope string from scopes.includes(...)', () => {
    const match = resolverSrc.match(/scopes\.includes\(\s*['"]([^'"]+)['"]\s*\)/);
    expect(match, 'could not find scopes.includes("...") pattern').not.toBeNull();
    expect(match![1]!.length).toBeGreaterThan(0);
  });

  it('SDL doc-comment for reviewer contains the resolver scope string', () => {
    const match = resolverSrc.match(/scopes\.includes\(\s*['"]([^'"]+)['"]\s*\)/);
    expect(match).not.toBeNull();
    const scopeString = match![1]!;
    const comment = extractDocComment(schema, /^\s*reviewer:\s*String!/);
    expect(comment, 'doc-comment block not found for reviewer field').not.toBeNull();
    expect(
      comment,
      `SDL doc-comment does not contain resolver scope "${scopeString}"`,
    ).toContain(scopeString);
  });
});

// EB5 — Full suite passes: verified by running `npm test --silent && npm run typecheck --silent`
// (not a test-internal assertion; the quality-check command output is the evidence).
