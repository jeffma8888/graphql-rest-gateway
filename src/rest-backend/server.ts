import Fastify, { type FastifyInstance } from 'fastify';
import { AUTHORS, BOOKS, REVIEWS, type AuthorRow, type BookRow, type ReviewRow } from './data.js';

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
  /** Destroy idle keep-alive sockets on close instead of waiting for timeout. */
  forceCloseConnections?: boolean;
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
  const app = Fastify({ logger: false, forceCloseConnections: opts.forceCloseConnections });

  // Pre-built indexes: O(1) lookups instead of O(n) Array.filter per request.
  const authorById = new Map<string, AuthorRow>(AUTHORS.map((a) => [a.id, a]));
  const bookById = new Map<string, BookRow>(BOOKS.map((b) => [b.id, b]));
  const booksByAuthorId = new Map<string, BookRow[]>();
  for (const b of BOOKS) {
    const list = booksByAuthorId.get(b.authorId);
    if (list) list.push(b);
    else booksByAuthorId.set(b.authorId, [b]);
  }
  // Per-instance lists: `POST /reviews` appends here, so a write is visible to
  // this backend only and never mutates the shared, exported REVIEWS seed.
  const reviewsByBookId = new Map<string, ReviewRow[]>();
  for (const r of REVIEWS) {
    const list = reviewsByBookId.get(r.bookId);
    if (list) list.push(r);
    else reviewsByBookId.set(r.bookId, [r]);
  }

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
    const ids = parseIds(req.query.ids);
    const result: AuthorRow[] = [];
    for (const id of ids) {
      const row = authorById.get(id);
      if (row) result.push(row);
    }
    return result;
  });

  // --- books ---------------------------------------------------------------

  // Batch-by-author: GET /books/by-author?authorIds=a1,a2 -> BookRow[]
  app.get<{ Querystring: { authorIds?: string } }>('/books/by-author', async (req) => {
    const ids = parseIds(req.query.authorIds);
    const result: BookRow[] = [];
    for (const id of ids) {
      const rows = booksByAuthorId.get(id);
      if (rows) result.push(...rows);
    }
    return result;
  });

  // Batch-by-id: GET /books/by-ids?ids=b1,b2 -> BookRow[]
  app.get<{ Querystring: { ids?: string } }>('/books/by-ids', async (req) => {
    const ids = parseIds(req.query.ids);
    const result: BookRow[] = [];
    for (const id of ids) {
      const row = bookById.get(id);
      if (row) result.push(row);
    }
    return result;
  });

  // --- reviews -------------------------------------------------------------

  // Batch-by-book: GET /reviews/by-book?bookIds=b1,b2 -> ReviewRow[]
  app.get<{ Querystring: { bookIds?: string } }>('/reviews/by-book', async (req) => {
    const ids = parseIds(req.query.bookIds);
    const result: ReviewRow[] = [];
    for (const id of ids) {
      const rows = reviewsByBookId.get(id);
      if (rows) result.push(...rows);
    }
    return result;
  });

  // Create: POST /reviews { bookId, rating, body, reviewer } -> 201 ReviewRow.
  // 400 for an off-contract body, 404 for an unknown book. The id is
  // `<bookId>-r<n>`, n being the book's review count after the append.
  app.post('/reviews', async (req, reply) => {
    const input = readNewReview(req.body);
    if (!input) return reply.code(400).send({ error: 'invalid review' });
    if (!bookById.has(input.bookId)) return reply.code(404).send({ error: 'book not found' });
    const list = reviewsByBookId.get(input.bookId) ?? [];
    const row: ReviewRow = { id: `${input.bookId}-r${list.length + 1}`, ...input };
    reviewsByBookId.set(input.bookId, [...list, row]);
    return reply.code(201).send(row);
  });

  return { app, stats };
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * The `POST /reviews` body, or null when it breaks the contract: `rating` an
 * integer 1..5, and `bookId`, `body` and `reviewer` non-empty strings. WHY the
 * backend re-checks what the gateway already validated: it is the system of
 * record, and other (legacy) clients write to it without the gateway.
 */
function readNewReview(raw: unknown): Omit<ReviewRow, 'id'> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { bookId, rating, body, reviewer } = raw as Record<string, unknown>;
  if (!nonEmpty(bookId) || !nonEmpty(body) || !nonEmpty(reviewer)) return null;
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) return null;
  return { bookId, rating, body, reviewer };
}
