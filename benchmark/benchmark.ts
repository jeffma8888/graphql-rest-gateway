import { graphql, type ExecutionResult } from 'graphql';
import { buildBackend } from '../src/rest-backend/server';
import { schema } from '../src/gateway/schema';
import { createContext } from '../src/gateway/context';
import { RestClient } from '../src/gateway/datasources/rest-client';
import { NAIVE, BATCHED } from '../src/gateway/loaders';
import { DATASET_SIZE } from '../src/rest-backend/data';

/**
 * PROVES the N+1 fix. Runs the SAME nested query two ways against the SAME
 * bundled REST backend -- once with naive per-key loading, once with batched
 * request-scoped DataLoaders -- and reports the downstream REST call counts.
 */

export const BENCHMARK_QUERY = /* GraphQL */ `
  query BenchmarkQuery {
    authors(first: 5) {
      totalCount
      edges {
        node {
          id
          name
          books {
            id
            title
            reviews {
              id
              rating
            }
          }
        }
      }
    }
  }
`;

export interface RunResult {
  total: number;
  byPath: Record<string, number>;
  ms: number;
  data: ExecutionResult['data'];
}

export interface BenchmarkOutput {
  naive: { calls: number; durationMs: number };
  batched: { calls: number; durationMs: number };
  factor: number;
}

function parseArgs(argv: string[]): { json: boolean; threshold: number | null } {
  let json = false;
  let threshold: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') json = true;
    if (argv[i] === '--threshold' && i + 1 < argv.length) {
      threshold = Number(argv[i + 1]);
      if (!Number.isFinite(threshold) || threshold < 0) {
        throw new Error(`Invalid --threshold value: ${argv[i + 1]}`);
      }
    }
  }
  return { json, threshold };
}

export async function runOnce(baseUrl: string, mode: 'naive' | 'batched'): Promise<RunResult> {
  const client = new RestClient(baseUrl);
  const contextValue = createContext({
    restClient: client,
    loaderOptions: mode === 'naive' ? NAIVE : BATCHED,
  });
  const start = performance.now();
  const result = await graphql({ schema, source: BENCHMARK_QUERY, contextValue });
  const ms = performance.now() - start;
  if (result.errors?.length) {
    throw new Error(`Query errored in ${mode} mode: ${JSON.stringify(result.errors)}`);
  }
  return { total: client.stats.total, byPath: { ...client.stats.byPath }, ms, data: result.data };
}

const ROUTES = ['/authors', '/books/by-author', '/reviews/by-book'] as const;

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}
function padStart(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function printTable(naive: RunResult, batched: RunResult): void {
  const c1 = 22;
  const c2 = 14;
  const c3 = 22;
  const line = '  ' + '-'.repeat(c1 + c2 + c3 + 2);

  console.log('');
  console.log(
    `Downstream REST calls for the sample nested query ` +
      `(${DATASET_SIZE.authors} authors x 3 books x 2 reviews):`,
  );
  console.log('');
  console.log('  ' + pad('Endpoint', c1) + padStart('Naive (N+1)', c2) + padStart('Batched (DataLoader)', c3));
  console.log(line);
  for (const route of ROUTES) {
    console.log(
      '  ' +
        pad(route, c1) +
        padStart(String(naive.byPath[route] ?? 0), c2) +
        padStart(String(batched.byPath[route] ?? 0), c3),
    );
  }
  console.log(line);
  console.log(
    '  ' + pad('TOTAL', c1) + padStart(String(naive.total), c2) + padStart(String(batched.total), c3),
  );
  console.log('');
  const factor = (naive.total / batched.total).toFixed(1);
  console.log(`  => ${factor}x fewer downstream calls (${naive.total} -> ${batched.total}).`);
  console.log(`  Wall-clock: naive ${naive.ms.toFixed(1)}ms vs batched ${batched.ms.toFixed(1)}ms`);
  console.log('  (latency=0 here to isolate call COUNT; see README on why count is the honest N+1 metric.)');
  console.log('');

  // Markdown snippet for pasting into the README.
  console.log('--- README markdown ---');
  console.log('| Downstream endpoint | Naive (N+1) | Batched (DataLoader) |');
  console.log('| --- | ---: | ---: |');
  for (const route of ROUTES) {
    console.log(`| \`${route}\` | ${naive.byPath[route] ?? 0} | ${batched.byPath[route] ?? 0} |`);
  }
  console.log(`| **Total** | **${naive.total}** | **${batched.total}** |`);
  console.log('-----------------------');
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<BenchmarkOutput> {
  const { json, threshold } = parseArgs(argv);
  const { app } = buildBackend({ latencyMs: 0 });
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const naive = await runOnce(baseUrl, 'naive');
    const batched = await runOnce(baseUrl, 'batched');
    const factor = Math.round((naive.total / batched.total) * 10) / 10;
    const output: BenchmarkOutput = {
      naive: { calls: naive.total, durationMs: Math.round(naive.ms * 10) / 10 },
      batched: { calls: batched.total, durationMs: Math.round(batched.ms * 10) / 10 },
      factor,
    };

    if (json) {
      console.log(JSON.stringify(output));
    } else {
      printTable(naive, batched);
    }

    if (threshold !== null && factor < threshold) {
      process.exitCode = 1;
    }
    return output;
  } finally {
    await app.close();
  }
}

// Run when invoked directly (tsx benchmark/benchmark.ts).
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
