import { readRestBaseUrl } from './cli.js';
import {
  AUTHOR_FIELDS,
  BOOK_FIELDS,
  ContractMismatch,
  REVIEW_FIELDS,
  describeValue,
  readAuthorPage,
  readRows as readContractRows,
  type RowSpec,
} from './gateway/datasources/contract.js';
import { DownstreamBadResponse, DownstreamUnreachable, RestClient } from './gateway/datasources/rest-client.js';
import type { AuthorRow, BookRow, ReviewRow } from './rest-backend/data.js';
import { buildBackend } from './rest-backend/server.js';

/**
 * `npm run check-backend`: a REST-contract pre-flight for the strangler-fig
 * on-ramp. WHY it exists: the gateway refuses a contract-breaking body (a
 * snake_case `author_id`, a wrapped list) only when a client query hits it,
 * and it does not check join keys or ids at all, which answer HTTP 200 with
 * silently wrong data (`books: []`, a false `NOT_FOUND`). This check calls each
 * contract route once, seeded from the previous route's answer, and names the
 * first wrong field, so the operator learns about the mismatch before a client
 * does. The row specs are the gateway's own (`./gateway/datasources/contract`).
 *
 * Side-effect free like `./cli`: no listeners, no `process.exit`. The process
 * concerns live in `./check-backend-main`.
 */

/** One line of the report: a contract route and why it failed (`null` when it passed). */
export interface RouteResult {
  route: string;
  ok: boolean;
  problem: string | null;
}

export interface CheckReport {
  baseUrl: string;
  ok: boolean;
  routes: RouteResult[];
}

/** Output sink, injectable so tests capture lines instead of patching `console`. */
export interface CheckIo {
  out(line: string): void;
  err(line: string): void;
}

type Env = Record<string, string | undefined>;

/** The routes the gateway's data sources call, in the order the check seeds them. */
export const CONTRACT_ROUTES = [
  '/authors',
  '/authors/by-ids',
  '/books/by-author',
  '/books/by-ids',
  '/reviews/by-book',
] as const;

type ContractRoute = (typeof CONTRACT_ROUTES)[number];

/** Fixed, not configurable: a pre-flight that hangs is worse than one that reports a timeout. */
const CHECK_TIMEOUT_MS = 5000;
/** Page size for the seeding `/authors` call; one page is enough to exercise every join. */
const SEED_LIMIT = 10;

/** The shared row reader, with values echoed: this report goes to the backend's owner. */
function readRows<R>(body: unknown, spec: RowSpec<R>): R[] {
  return readContractRows(body, spec, describeValue);
}

/** `GET /authors` must match the page contract AND hold at least one author to seed from. */
function seedAuthorIds(body: unknown): string[] {
  const { items } = readAuthorPage(body, describeValue);
  if (items.length === 0) {
    throw new ContractMismatch('no authors were returned (items is empty); the later routes need one to check');
  }
  return unique(items.map((row) => row.id));
}

/** By-id lookups must echo the requested row; a missing one is what surfaces as a false `NOT_FOUND`. */
function requireId(rows: ReadonlyArray<{ id: string }>, id: string): void {
  if (!rows.some((row) => row.id === id)) {
    throw new ContractMismatch(`requested id "${id}" is missing from the response`);
  }
}

/**
 * Batch-by-parent routes must key every row by a requested parent id. WHY this
 * matters: the gateway groups rows by that key, so a row keyed otherwise is
 * silently dropped and the parent shows an empty list.
 */
function requireJoin<R>(rows: R[], key: keyof R & string, requested: ReadonlyArray<string>): void {
  const wanted = new Set(requested);
  rows.forEach((row, i) => {
    const value = row[key];
    if (typeof value !== 'string' || !wanted.has(value)) {
      throw new ContractMismatch(
        `row ${i}: ${key} ${JSON.stringify(value)} is not one of the requested ids (${requested.join(',')})`,
      );
    }
  });
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Problem text for a transport/parse failure. WHY read `cause`: fetch reports
 * every network failure as a bare "fetch failed"; the actionable part
 * (`ECONNREFUSED`, "bad port") is only on the cause.
 */
function describeError(thrown: unknown): string {
  // The client already typed the failure; unwrap to the underlying parse or
  // fetch error, whose text (incl. `ECONNREFUSED`) is what the operator needs.
  const err = thrown instanceof DownstreamBadResponse || thrown instanceof DownstreamUnreachable ? thrown.detail : thrown;
  if (err instanceof ContractMismatch) return err.message;
  if (err instanceof SyntaxError) return `response body is not valid JSON (${err.message})`;
  if (!(err instanceof Error)) return String(err);
  const cause: unknown = err.cause;
  if (!(cause instanceof Error)) return err.message;
  const code: unknown = (cause as Error & { code?: unknown }).code;
  return `request failed: ${err.message} (${typeof code === 'string' ? code : cause.message})`;
}

/**
 * Runs the contract routes in order against `baseUrl` (path prefix honoured via
 * the gateway's own `RestClient` join). Never throws: every failure, including
 * nothing listening, becomes a per-route problem, and routes whose seed ids are
 * unavailable are reported as `skipped`.
 */
export async function checkBackend(baseUrl: string): Promise<CheckReport> {
  const client = new RestClient(baseUrl, CHECK_TIMEOUT_MS);
  const routes: RouteResult[] = [];

  /** Calls one route, records the verdict, and returns the validated value (undefined on FAIL). */
  async function step<T>(route: ContractRoute, call: () => Promise<unknown>, read: (body: unknown) => T) {
    try {
      const value = read(await call());
      routes.push({ route, ok: true, problem: null });
      return value;
    } catch (err) {
      routes.push({ route, ok: false, problem: describeError(err) });
      return undefined;
    }
  }
  const skip = (needs: ContractRoute, ...skipped: ContractRoute[]): void => {
    for (const route of skipped) routes.push({ route, ok: false, problem: `skipped: needs a passing ${needs}` });
  };
  const report = (): CheckReport => ({ baseUrl, ok: routes.every((r) => r.ok), routes });

  const authorIds = await step(
    '/authors',
    () => client.get('/authors', { offset: 0, limit: SEED_LIMIT }),
    seedAuthorIds,
  );
  if (authorIds === undefined) {
    skip('/authors', '/authors/by-ids', '/books/by-author', '/books/by-ids', '/reviews/by-book');
    return report();
  }
  const firstAuthor = authorIds[0] as string;
  await step('/authors/by-ids', () => client.get('/authors/by-ids', { ids: [firstAuthor] }), (body) => {
    requireId(readRows<AuthorRow>(body, AUTHOR_FIELDS), firstAuthor);
  });

  const bookIds = await step('/books/by-author', () => client.get('/books/by-author', { authorIds }), (body) => {
    const rows = readRows<BookRow>(body, BOOK_FIELDS);
    if (rows.length === 0) {
      throw new ContractMismatch(`no books were returned for the ${authorIds.length} requested author id(s)`);
    }
    requireJoin(rows, 'authorId', authorIds);
    return unique(rows.map((row) => row.id));
  });
  if (bookIds === undefined) {
    skip('/books/by-author', '/books/by-ids', '/reviews/by-book');
    return report();
  }
  const firstBook = bookIds[0] as string;
  await step('/books/by-ids', () => client.get('/books/by-ids', { ids: [firstBook] }), (body) => {
    requireId(readRows<BookRow>(body, BOOK_FIELDS), firstBook);
  });
  // Reviews are the leaf of the graph, so an empty list is legal; only shape and join are checked.
  await step('/reviews/by-book', () => client.get('/reviews/by-book', { bookIds }), (body) => {
    requireJoin(readRows<ReviewRow>(body, REVIEW_FIELDS), 'bookId', bookIds);
  });
  return report();
}

const defaultIo: CheckIo = {
  // eslint-disable-next-line no-console
  out: (line) => console.log(line),
  // eslint-disable-next-line no-console
  err: (line) => console.error(line),
};

function formatHuman(report: CheckReport, bundled: boolean): string[] {
  // Name the target first: a mistyped variable (`REST_BASEURL=…`) silently falls
  // back to the bundled backend, and a green 5/5 must not hide that.
  const target = bundled ? 'the bundled backend (REST_BASE_URL is unset)' : 'REST_BASE_URL';
  const lines = [`Checking ${report.baseUrl} -- ${target}`];
  lines.push(...report.routes.map((r) => (r.ok ? `PASS ${r.route}` : `FAIL ${r.route} -- ${r.problem ?? ''}`)));
  const passed = report.routes.filter((r) => r.ok).length;
  lines.push(`${passed}/${CONTRACT_ROUTES.length} routes match the REST contract`);
  return lines;
}

/**
 * CLI composition for `npm run check-backend [--json]`. Checks `REST_BASE_URL`
 * (validated by the same parser `npm start` uses, so both reject the same
 * values with the same message), or a bundled backend booted in-process and
 * closed afterwards when it is unset. Resolves the exit code: 0 all routes
 * pass, 1 any mismatch, 2 a configuration error (no request is made).
 */
export async function runCheckBackend(argv: string[], env: Env, io: CheckIo = defaultIo): Promise<number> {
  const unknown = argv.find((arg) => arg !== '--json');
  if (unknown !== undefined) {
    io.err(`check-backend: unknown argument ${JSON.stringify(unknown)} (supported: --json)`);
    return 2;
  }
  let externalBaseUrl: string | undefined;
  try {
    externalBaseUrl = readRestBaseUrl(env.REST_BASE_URL);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const bundled = externalBaseUrl === undefined ? buildBackend({ latencyMs: 0, forceCloseConnections: true }).app : undefined;
  let report: CheckReport;
  try {
    const baseUrl = bundled ? await bundled.listen({ port: 0, host: '127.0.0.1' }) : (externalBaseUrl as string);
    report = await checkBackend(baseUrl);
  } finally {
    await bundled?.close();
  }

  if (argv.includes('--json')) {
    const { baseUrl, ok, routes } = report;
    io.out(JSON.stringify({ baseUrl, backend: bundled ? 'bundled' : 'external', ok, routes }, null, 2));
  } else {
    for (const line of formatHuman(report, bundled !== undefined)) io.out(line);
  }
  return report.ok ? 0 : 1;
}
