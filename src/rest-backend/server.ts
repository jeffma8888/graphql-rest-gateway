import Fastify, { type FastifyInstance } from 'fastify';
import { AUTHORS, BOOKS, REVIEWS, type AuthorRow, type BookRow, type ReviewRow } from './data';

/**
 * Bundled downstream REST service -- the "legacy" system the GraphQL gateway
 * wraps (strangler-fig migration story). It exposes plain resource endpoints
 * with an artificial per-request latency so you can *see* the cost of N+1.
 *
 * Endpoints are intentionally batch-friendly (`?ids=`, `?authorIds=`) so a
 * well-written gateway can collapse many keys into one call. A naive gateway
 * hitting them one id at a time is the N+1 problem in the flesh.
 */

export interface BackendOptions {
  /** Artificial latency added to every data request (ms). Default 10. */
  latencyMs?: number;
}

export interface BackendStats {
  total: number;
  byRoute: Record<string, number>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function parseIds(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function buildBackend(opts: BackendOptions = {}): {
  app: FastifyInstance;
  stats: BackendStats;
} {
  const latencyMs = opts.latencyMs ?? 10;
  const stats: BackendStats = { total: 0, byRoute: {} };
  const app = Fastify({ logger: false });

  // Count every data request and apply artificial latency. `/__*` and
  // `/health` are excluded so observability endpoints don't pollute counts.
  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0] ?? req.url;
    if (path.startsWith('/__') || path === '/health') return;
    stats.total += 1;
    stats.byRoute[path] = (stats.byRoute[path] ?? 0) + 1;
    if (latencyMs > 0) await sleep(latencyMs);
  });

  app.get('/health', async () => ({ ok: true }));

  // --- observability: expose + reset the downstream call counter -----------
  app.get('/__stats', async () => stats);
  app.post('/__stats/reset', async () => {
    stats.total = 0;
    stats.byRoute = {};
    return stats;
  });

  // --- authors -------------------------------------------------------------

  // Paginated list: GET /authors?offset=0&limit=10 -> { items, total }
  app.get<{ Querystring: { offset?: string; limit?: string } }>('/authors', async (req) => {
    const offset = Math.max(0, Number.parseInt(req.query.offset ?? '0', 10) || 0);
    const limit = Math.max(0, Number.parseInt(req.query.limit ?? '10', 10) || 10);
    const items: AuthorRow[] = AUTHORS.slice(offset, offset + limit);
    return { items, total: AUTHORS.length };
  });

  // Batch-by-id: GET /authors/by-ids?ids=a1,a2 -> AuthorRow[]
  app.get<{ Querystring: { ids?: string } }>('/authors/by-ids', async (req) => {
    const ids = new Set(parseIds(req.query.ids));
    return AUTHORS.filter((a) => ids.has(a.id));
  });

  // --- books ---------------------------------------------------------------

  // Batch-by-author: GET /books/by-author?authorIds=a1,a2 -> BookRow[]
  app.get<{ Querystring: { authorIds?: string } }>('/books/by-author', async (req) => {
    const ids = new Set(parseIds(req.query.authorIds));
    return BOOKS.filter((b) => ids.has(b.authorId));
  });

  // Batch-by-id: GET /books/by-ids?ids=b1,b2 -> BookRow[]
  app.get<{ Querystring: { ids?: string } }>('/books/by-ids', async (req) => {
    const ids = new Set(parseIds(req.query.ids));
    return BOOKS.filter((b) => ids.has(b.id));
  });

  // --- reviews -------------------------------------------------------------

  // Batch-by-book: GET /reviews/by-book?bookIds=b1,b2 -> ReviewRow[]
  app.get<{ Querystring: { bookIds?: string } }>('/reviews/by-book', async (req) => {
    const ids = new Set(parseIds(req.query.bookIds));
    return REVIEWS.filter((r) => ids.has(r.bookId)) as ReviewRow[];
  });

  return { app, stats };
}
