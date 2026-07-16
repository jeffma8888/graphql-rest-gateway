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

export class RestClient {
  readonly stats: RestClientStats = { total: 0, byPath: {} };

  constructor(private readonly baseUrl: string) {}

  private track(path: string): void {
    this.stats.total += 1;
    this.stats.byPath[path] = (this.stats.byPath[path] ?? 0) + 1;
  }

  async get<T>(path: string, params?: QueryParams): Promise<T> {
    // Count by canonical path (without querystring) so batched vs naive is
    // an apples-to-apples "how many times did we hit /books/by-author" figure.
    this.track(path);

    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined) continue;
        url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
      }
    }

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Downstream REST error ${res.status} ${res.statusText} for ${path}`);
    }
    return (await res.json()) as T;
  }

  resetStats(): void {
    this.stats.total = 0;
    this.stats.byPath = {};
  }
}
