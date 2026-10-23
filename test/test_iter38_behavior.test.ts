import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { main, type BenchmarkOutput } from '../benchmark/benchmark';

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  logSpy.mockRestore();
  process.exitCode = undefined;
});

function capturedText(): string {
  return logSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

function findJsonLine(): BenchmarkOutput {
  for (const call of logSpy.mock.calls) {
    const line = call.map(String).join(' ').trim();
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && 'factor' in parsed) return parsed;
    } catch {}
  }
  throw new Error('No valid JSON output with factor key found in console.log calls');
}

// EB1 - --json flag emits structured JSON to stdout
describe('EB1 - --json flag emits structured JSON to stdout', () => {
  it('--json produces valid JSON on stdout with naive, batched, factor', async () => {
    await main(['--json']);
    const parsed = findJsonLine();
    expect(parsed).toHaveProperty('naive');
    expect(parsed).toHaveProperty('batched');
    expect(parsed).toHaveProperty('factor');
  });

  it('naive and batched each have calls (number) and durationMs (number)', async () => {
    await main(['--json']);
    const parsed = findJsonLine();
    expect(typeof parsed.naive.calls).toBe('number');
    expect(typeof parsed.naive.durationMs).toBe('number');
    expect(typeof parsed.batched.calls).toBe('number');
    expect(typeof parsed.batched.durationMs).toBe('number');
  });

  it('factor is numeric and >= 1', async () => {
    await main(['--json']);
    const parsed = findJsonLine();
    expect(typeof parsed.factor).toBe('number');
    expect(parsed.factor).toBeGreaterThanOrEqual(1);
  });

  it('factor equals naive.calls / batched.calls (rounded to 1 decimal)', async () => {
    await main(['--json']);
    const parsed = findJsonLine();
    const expected = Math.round((parsed.naive.calls / parsed.batched.calls) * 10) / 10;
    expect(parsed.factor).toBe(expected);
  });
});

// EB2 - Human-readable output is the default (no flag)
describe('EB2 - default output is human-readable table, not JSON', () => {
  it('no flags produces non-JSON table output', async () => {
    await main([]);
    const text = capturedText();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('Downstream REST calls');
  });

  it('default output contains table headers and markdown', async () => {
    await main([]);
    const text = capturedText();
    expect(text).toContain('Naive');
    expect(text).toContain('Batched');
    expect(text).toContain('README markdown');
  });
});

// EB3 - --threshold flag controls exit code (with --json)
describe('EB3 - --threshold controls exit code', () => {
  it('--json --threshold 3 exits 0 when factor >= 3', async () => {
    const result = await main(['--json', '--threshold', '3']);
    expect(result.factor).toBeGreaterThanOrEqual(3);
    expect(process.exitCode).toBeUndefined();
  });

  it('--json --threshold 9999 exits 1 when factor < threshold', async () => {
    await main(['--json', '--threshold', '9999']);
    expect(process.exitCode).toBe(1);
  });

  it('--threshold boundary: exits 0 when factor equals threshold', async () => {
    const probe = await main(['--json']);
    const exactFactor = probe.factor;
    logSpy.mockClear();
    process.exitCode = undefined;
    await main(['--json', '--threshold', String(exactFactor)]);
    expect(process.exitCode).toBeUndefined();
  });
});

// EB4 - --threshold without --json also works
describe('EB4 - --threshold without --json prints table and sets exit code', () => {
  it('--threshold 3 (no --json) prints human-readable table', async () => {
    await main(['--threshold', '3']);
    const text = capturedText();
    expect(text).toContain('Downstream REST calls');
  });

  it('--threshold 3 (no --json) exits 0 when factor >= 3', async () => {
    const result = await main(['--threshold', '3']);
    expect(result.factor).toBeGreaterThanOrEqual(3);
    expect(process.exitCode).toBeUndefined();
  });

  it('--threshold 9999 (no --json) exits 1 when factor < threshold', async () => {
    await main(['--threshold', '9999']);
    expect(process.exitCode).toBe(1);
    const text = capturedText();
    expect(text).toContain('Downstream REST calls');
  });
});

// EB5 - Full quality-check suite stays green
describe('EB5 - suite integrity', () => {
  it('main() returns a BenchmarkOutput with correct structure', async () => {
    const result = await main([]);
    expect(result).toHaveProperty('naive');
    expect(result).toHaveProperty('batched');
    expect(result).toHaveProperty('factor');
    expect(result.naive).toHaveProperty('calls');
    expect(result.naive).toHaveProperty('durationMs');
    expect(result.batched).toHaveProperty('calls');
    expect(result.batched).toHaveProperty('durationMs');
  });
});
