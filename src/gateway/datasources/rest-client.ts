import { GraphQLError } from 'graphql';

/**
 * Thin HTTP client for the downstream REST service.
 *
 * It also *counts* outbound calls. That counter is the instrument behind the
 * whole repo: the benchmark and the N+1 regression test read `stats.total` to
 * prove that DataLoader collapses many logical loads into few real HTTP calls.
 */

export interface RestClientStats {
  total: number;
  byPath: Record<string, number>;
}

export type QueryParams = Record<string, string | number | ReadonlyArray<string> | undefined>;

/** Default downstream timeout when none is configured (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;

export class RestClient {
  readonly stats: RestClientStats = { total: 0, byPath: {} };
  /** Per-request deadline in milliseconds for every downstream call. */
  readonly timeoutMs: number;

  constructor(private readonly baseUrl: string, timeoutMs?: number) {
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private track(path: string): void {
    this.stats.total += 1;
    this.stats.byPath[path] = (this.stats.byPath[path] ?? 0) + 1;
  }

  async get<T>(path: string, params?: QueryParams): Promise<T> {
    this.track(path);

    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined) continue;
        url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
      }
    }

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new GraphQLError(`Downstream request to ${path} timed out after ${this.timeoutMs}ms`, {
          extensions: { code: 'DOWNSTREAM_TIMEOUT' },
        });
      }
      throw err;
    }

    if (!res.ok) {
      throw new GraphQLError(`Downstream REST error ${res.status} ${res.statusText} for ${path}`, {
        extensions: { code: 'DOWNSTREAM_ERROR', status: res.status },
      });
    }
    return (await res.json()) as T;
  }

  resetStats(): void {
    this.stats.total = 0;
    this.stats.byPath = {};
  }
}
