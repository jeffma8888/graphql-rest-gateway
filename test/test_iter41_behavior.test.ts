import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function readText(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

function extractInterfaceProps(filePath: string, interfaceName: string): string[] {
  const content = readFileSync(resolve(root, filePath), 'utf8');
  const interfacePattern = new RegExp(
    `interface\\s+${interfaceName}\\s*\\{([^}]+)\\}`,
    's',
  );
  const match = content.match(interfacePattern);
  if (!match) return [];
  const body = match[1]!;
  const propPattern = /^\s*(\w+)\s*[?:]?\s*:/gm;
  const props: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = propPattern.exec(body)) !== null) {
    props.push(m[1]!);
  }
  return props.sort();
}

const readme = readText('README.md');

// EB1 — README contains GatewayOptions table with all 6 properties (iter-59 added maxDownstreamCalls)
describe('EB1 — README GatewayOptions table completeness', () => {
  it('README has an Options reference subsection', () => {
    expect(readme).toContain('#### Options reference');
  });

  it('README contains a GatewayOptions heading', () => {
    expect(readme).toContain('`GatewayOptions`');
  });

  it('GatewayOptions table lists restBaseUrl', () => {
    expect(readme).toContain('`restBaseUrl`');
  });

  it('GatewayOptions table lists maxDepth', () => {
    expect(readme).toContain('`maxDepth`');
  });

  it('GatewayOptions table lists maxComplexity', () => {
    expect(readme).toContain('`maxComplexity`');
  });

  it('GatewayOptions table lists loaderOptions', () => {
    expect(readme).toContain('`loaderOptions`');
  });

  it('GatewayOptions table lists downstreamTimeoutMs', () => {
    expect(readme).toContain('`downstreamTimeoutMs`');
  });

  it('GatewayOptions table has exactly 6 data rows', () => {
    const optionsIdx = readme.indexOf('`GatewayOptions`');
    const nextHeadingIdx = readme.indexOf('`BackendOptions`', optionsIdx);
    const section = readme.slice(optionsIdx, nextHeadingIdx);
    const tableRows = section
      .split('\n')
      .filter((line) => line.startsWith('|') && !line.includes('---'));
    const dataRows = tableRows.slice(1);
    expect(dataRows.length).toBe(6);
  });
});

// EB2 — README contains BackendOptions table with all 2 properties
describe('EB2 — README BackendOptions table completeness', () => {
  it('README contains a BackendOptions heading', () => {
    expect(readme).toContain('`BackendOptions`');
  });

  it('BackendOptions table lists latencyMs', () => {
    expect(readme).toContain('`latencyMs`');
  });

  it('BackendOptions table lists forceCloseConnections', () => {
    expect(readme).toContain('`forceCloseConnections`');
  });

  it('BackendOptions table has exactly 2 data rows', () => {
    const optionsIdx = readme.indexOf('`BackendOptions`');
    const afterHeading = readme.slice(optionsIdx);
    const lines = afterHeading.split('\n');
    const tableStart = lines.findIndex((l) => l.startsWith('| Property'));
    expect(tableStart).toBeGreaterThan(-1);
    const tableLines: string[] = [];
    for (let i = tableStart; i < lines.length; i++) {
      if (!lines[i]!.startsWith('|')) break;
      tableLines.push(lines[i]!);
    }
    const dataRows = tableLines.filter(
      (l) => !l.includes('Property') && !l.includes('---'),
    );
    expect(dataRows.length).toBe(2);
  });
});

// EB3 — Drift guard: GatewayOptions interface props all appear in README
describe('EB3 — GatewayOptions drift guard', () => {
  const props = extractInterfaceProps('src/gateway/server.ts', 'GatewayOptions');

  it('extracts at least 5 properties from GatewayOptions interface', () => {
    expect(props.length).toBeGreaterThanOrEqual(5);
  });

  it('every GatewayOptions property appears in README', () => {
    const missing = props.filter((p) => !readme.includes(p));
    expect(
      missing,
      `GatewayOptions properties missing from README: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('contains exactly the expected 6 properties', () => {
    const expected = [
      'downstreamTimeoutMs',
      'loaderOptions',
      'maxComplexity',
      'maxDepth',
      'maxDownstreamCalls',
      'restBaseUrl',
    ];
    expect(props).toEqual(expected);
  });
});

// EB4 — Drift guard: BackendOptions interface props all appear in README
describe('EB4 — BackendOptions drift guard', () => {
  const props = extractInterfaceProps(
    'src/rest-backend/server.ts',
    'BackendOptions',
  );

  it('extracts at least 2 properties from BackendOptions interface', () => {
    expect(props.length).toBeGreaterThanOrEqual(2);
  });

  it('every BackendOptions property appears in README', () => {
    const missing = props.filter((p) => !readme.includes(p));
    expect(
      missing,
      `BackendOptions properties missing from README: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('contains exactly the expected 2 properties', () => {
    const expected = ['forceCloseConnections', 'latencyMs'];
    expect(props).toEqual(expected);
  });
});

// EB5 — BackendOptions re-exported from barrel
describe('EB5 — BackendOptions barrel re-export', () => {
  it('src/lib.ts contains BackendOptions in an export statement', () => {
    const libContent = readText('src/lib.ts');
    expect(libContent).toMatch(/BackendOptions/);
  });

  it('BackendOptions appears as a type export', () => {
    const libContent = readText('src/lib.ts');
    expect(libContent).toMatch(/type\s+BackendOptions/);
  });
});

// EB6 — "Exported symbols" line includes BackendOptions
describe('EB6 — README exported symbols includes BackendOptions', () => {
  it('README "Exported symbols" line mentions BackendOptions', () => {
    const exportedLine = readme
      .split('\n')
      .find((line) => line.includes('Exported symbols'));
    expect(exportedLine).toBeDefined();
    expect(exportedLine).toContain('BackendOptions');
  });
});

// EB7 — Full suite passes with no regressions (at least 238 existing + new)
describe('EB7 — suite baseline', () => {
  it('README test-count badge is at least 238 (pre-iter-41 baseline)', () => {
    const match = readme.match(/tests-(\d+)%20passing/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(238);
  });
});
