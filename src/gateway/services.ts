import { GraphQLError } from 'graphql';
import type { AuthorBooksArgs, BookReviewsArgs } from '../generated/graphql.js';
import type { AuthorRow, BookRow, ReviewRow } from '../rest-backend/data.js';
import type { AuthorPage, DataSources } from './datasources/index.js';
import type { Loaders } from './loaders.js';
import { MAX_PAGE_SIZE } from './pagination/page-size.js';
import { buildConnection, decodeCursor, offsetFromCursor, type Connection } from './pagination/relay.js';

/**
 * Service layer: the business-logic seam between thin resolvers and the data
 * access layer. Resolvers call services; services decide whether a fetch goes
 * through a batched DataLoader (per-key lookups) or a datasource (list/page
 * queries). No HTTP or fetch logic lives above this line.
 */

/** Applied in the service, not as an SDL default, so `last` alone is not read as `first` + `last`. */
const DEFAULT_PAGE_SIZE = 10;

const clamp = (n: number): number => Math.min(Math.max(n, 0), MAX_PAGE_SIZE);

/**
 * Nested-list `first` (`Author.books`, `Book.reviews`): the first `first` rows
 * in downstream order, under the same clamp as `authors`. Applied AFTER the
 * batched by-key load, never as part of the loader key, so aliases with
 * different bounds (and the lookahead prefetch, which ignores arguments) share
 * one cached list and one downstream call. `slice` returns a new array, so the
 * DataLoader-cached list is never mutated. Omitted/null keeps the whole list.
 */
function takeFirst<T>(rows: T[], first: number | null | undefined): T[] {
  return first == null ? rows : rows.slice(0, clamp(first));
}

export interface PageArgs {
  first?: number | null;
  after?: string | null;
  last?: number | null;
  before?: string | null;
}

/** A page fetched for `[offset, offset + limit)`; `page.items` may exceed `limit`. */
interface PageWindow {
  offset: number;
  limit: number;
  page: AuthorPage;
}

export class AuthorService {
  /**
   * Request-scoped memo of `/authors` pages keyed by the exact page sent
   * downstream (`offset:limit`, after cursor decode and clamp). By-key loaders
   * already dedupe across a batch, but the list root calls the datasource
   * directly, so without this N identical batched ops (or a `list`/`count`
   * alias pair) would each re-fetch the same page. The promise is stored
   * before it settles so concurrent ops share the in-flight call, and a
   * rejection is kept so a failing page is called once, not retried per op.
   * `null` when the loaders run without a cache (NAIVE): no dedupe at all.
   * Safe only because the graph is read-only (no `Mutation` type): a future
   * write path must clear `pages`, or later ops in a batch see stale pages.
   */
  private readonly pages: Map<string, Promise<AuthorPage>> | null;

  constructor(
    private readonly ds: DataSources,
    private readonly loaders: Loaders,
    dedupePages: boolean,
  ) {
    this.pages = dedupePages ? new Map() : null;
  }

  getAuthor(id: string): Promise<AuthorRow | null> {
    return this.loaders.authorById.load(id);
  }

  /**
   * Relay `first`/`after` (forward) and `last`/`before` (backward) over the
   * offset-paged `/authors` route. Both cursors are validated before any
   * downstream call, and the page is truncated to its clamped size because the
   * backend's `limit` is not trusted (the bundled one maps `limit=0` to 10),
   * which keeps a 0-row page at complexity cost 1 truthful and also enforces
   * the end of a window cut short by `before`.
   */
  async listConnection(args: PageArgs): Promise<Connection<AuthorRow>> {
    const { first, last, after, before } = args;
    if (first != null && last != null) {
      throw new GraphQLError('Pass `first` or `last`, not both', {
        extensions: { code: 'BAD_PAGINATION_ARGS' },
      });
    }
    const start = offsetFromCursor(after);
    // An edge cursor encodes "position after this node", so `before: c` ends the
    // window just before the node whose cursor is c (never before `start`).
    const end = before ? Math.max(start, decodeCursor(before) - 1) : undefined;
    const { offset, limit, page } =
      last == null
        ? await this.forwardWindow(start, end, clamp(first ?? DEFAULT_PAGE_SIZE))
        : await this.backwardWindow(start, end, clamp(last));
    const items = page.items.slice(0, limit);
    for (const author of items) this.loaders.authorById.prime(author.id, author);
    return buildConnection(items, offset, page.total);
  }

  /** The first `limit` items from `start`, cut short by a known `end`. */
  private async forwardWindow(start: number, end: number | undefined, limit: number): Promise<PageWindow> {
    const size = end === undefined ? limit : Math.min(limit, end - start);
    return { offset: start, limit: size, page: await this.fetchPage(start, size) };
  }

  /**
   * The last `limit` items of `[start, end)`. With a known `end` that is one
   * call. Without one the list length is unknown until a page returns `total`
   * (the REST contract has no count or tail route), so read from `start` and,
   * only when the tail does not fit in that page, re-read the last `limit`
   * items: 1 call when the tail fits, 2 when it does not.
   */
  private async backwardWindow(start: number, end: number | undefined, limit: number): Promise<PageWindow> {
    if (end !== undefined) {
      const offset = Math.max(start, end - limit);
      return { offset, limit: end - offset, page: await this.fetchPage(offset, end - offset) };
    }
    const head = await this.fetchPage(start, limit);
    if (head.total - start <= limit) return { offset: start, limit, page: head };
    const offset = head.total - limit;
    // A 0-size tail needs no rows, only the `total` already in hand.
    const page = limit > 0 ? await this.fetchPage(offset, limit) : head;
    return { offset, limit, page };
  }

  /** One downstream call per distinct (offset, limit) page per context. */
  private fetchPage(offset: number, limit: number): Promise<AuthorPage> {
    if (this.pages === null) return this.ds.author.listAuthors(offset, limit);
    const key = `${offset}:${limit}`;
    let page = this.pages.get(key);
    if (page === undefined) {
      page = this.ds.author.listAuthors(offset, limit);
      this.pages.set(key, page);
    }
    return page;
  }
}

/** Normalise a rejection reason so it can be primed into a DataLoader cache. */
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export class BookService {
  constructor(
    private readonly loaders: Loaders,
    private readonly prefetch: boolean,
  ) {}

  /**
   * Speculatively start `booksForAuthor` so it runs in parallel with the root
   * by-id fetch. DataLoader clears a key whose batch rejects, so a downstream
   * failure that lands before the root fetch returns would otherwise make
   * `Author.books`' own load() re-issue the failing call. The catch therefore
   * re-primes the key with the error (prime only writes when the key is
   * absent and attaches its own no-op catch): the child load reuses that
   * rejection and the failing route is still called exactly once.
   * No-op without a loader cache: the child load could not reuse the result.
   */
  prefetchBooksForAuthor(authorId: string): void {
    if (!this.prefetch) return;
    const loader = this.loaders.booksByAuthorId;
    loader.load(authorId).catch((err: unknown) => {
      loader.prime(authorId, toError(err));
    });
  }

  getBook(id: string): Promise<BookRow | null> {
    return this.loaders.bookById.load(id);
  }

  async booksForAuthor(authorId: string, first?: AuthorBooksArgs['first']): Promise<BookRow[]> {
    return takeFirst(await this.loaders.booksByAuthorId.load(authorId), first);
  }
}

export class ReviewService {
  constructor(
    private readonly loaders: Loaders,
    private readonly prefetch: boolean,
  ) {}

  /** Same contract as `BookService.prefetchBooksForAuthor`, for `Book.reviews`. */
  prefetchReviewsForBook(bookId: string): void {
    if (!this.prefetch) return;
    const loader = this.loaders.reviewsByBookId;
    loader.load(bookId).catch((err: unknown) => {
      loader.prime(bookId, toError(err));
    });
  }

  async reviewsForBook(bookId: string, first?: BookReviewsArgs['first']): Promise<ReviewRow[]> {
    return takeFirst(await this.loaders.reviewsByBookId.load(bookId), first);
  }
}

export interface Services {
  author: AuthorService;
  book: BookService;
  review: ReviewService;
}

/**
 * `prefetch` must mirror the loaders' `cache` option: a speculative load only
 * pays off when the child resolver's later load() is served from that cache.
 * The same flag gates the author page memo, so NAIVE stays a true no-cache
 * baseline (every resolver call is a downstream call).
 */
export function buildServices(ds: DataSources, loaders: Loaders, prefetch: boolean): Services {
  return {
    author: new AuthorService(ds, loaders, prefetch),
    book: new BookService(loaders, prefetch),
    review: new ReviewService(loaders, prefetch),
  };
}
