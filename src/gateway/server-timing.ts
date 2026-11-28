import type { Plugin } from 'graphql-yoga';
import { JSON_CONTENT_TYPE } from './compression.js';

/**
 * Opt-in W3C `Server-Timing` (`serverTiming: true`): one aggregate
 * `downstream` metric per non-streamed GraphQL JSON reply, e.g.
 * `downstream;dur=12.3;desc="3 calls"`. WHY: devtools, RUM/APM agents and CDN
 * logs already display this header, so a client team can see a query's REST
 * cost without parsing `extensions`. WHY aggregate only: per-route data is
 * backend topology, which clients must not see (see `onDownstreamCall`).
 */

/** The downstream cost one edge request has paid so far. */
export interface DownstreamTotals {
  /** Calls sent (the same counter as `extensions.downstreamCalls.total`). */
  calls: number;
  /** `RestClient.settledMs`: the settled calls' `durationMs` sum, total backend time, not wall-clock. */
  durationMs: number;
}

/** `downstream;dur=<ms, 1 decimal>;desc="<N> call(s)"`. */
export function formatServerTiming({ calls, durationMs }: DownstreamTotals): string {
  return `downstream;dur=${durationMs.toFixed(1)};desc="${calls} ${calls === 1 ? 'call' : 'calls'}"`;
}

/**
 * Sets `server-timing` on GraphQL JSON replies. `totals` returns undefined
 * when the request never got a context (a parse or validation refusal), which
 * is reported as 0 calls. WHY marked in `onResultProcess`, as compression
 * does: only GraphQL results pass it, so `/healthz`, `/readyz` and GraphiQL
 * are never touched; the JSON check leaves `@defer` multipart and SSE alone,
 * whose headers leave before the count is final.
 */
export function serverTimingPlugin(totals: (request: Request) => DownstreamTotals | undefined): Plugin {
  const graphqlRequests = new WeakSet<Request>();
  return {
    onResultProcess({ request }) {
      graphqlRequests.add(request);
    },
    onResponse({ request, response }) {
      if (!graphqlRequests.delete(request)) return;
      if (!JSON_CONTENT_TYPE.test(response.headers.get('content-type') ?? '')) return;
      response.headers.set('server-timing', formatServerTiming(totals(request) ?? { calls: 0, durationMs: 0 }));
    },
  };
}
