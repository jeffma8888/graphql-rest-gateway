import type { AuthorRow, BookRow, ReviewRow } from '../rest-backend/data.js';
import type { DataSources } from './datasources/index.js';
import type { Loaders } from './loaders.js';
import { buildConnection, offsetFromCursor, type Connection } from './pagination/relay.js';

/**
 * Service layer: the business-logic seam between thin resolvers and the data
 * access layer. Resolvers call services; services decide whether a fetch goes
 * through a batched DataLoader (per-key lookups) or a datasource (list/page
 * queries). No HTTP or fetch logic lives above this line.
 */

const MAX_PAGE_SIZE = 100;

export class AuthorService {
  constructor(
    private readonly ds: DataSources,
    private readonly loaders: Loaders,
  ) {}

  getAuthor(id: string): Promise<AuthorRow | null> {
    return this.loaders.authorById.load(id);
  }

  async listConnection(first: number, after?: string | null): Promise<Connection<AuthorRow>> {
    const limit = Math.min(Math.max(first, 0), MAX_PAGE_SIZE);
    const offset = offsetFromCursor(after);
    const { items, total } = await this.ds.author.listAuthors(offset, limit);
    for (const author of items) this.loaders.authorById.prime(author.id, author);
    return buildConnection(items, offset, total);
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

  booksForAuthor(authorId: string): Promise<BookRow[]> {
    return this.loaders.booksByAuthorId.load(authorId);
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

  reviewsForBook(bookId: string): Promise<ReviewRow[]> {
    return this.loaders.reviewsByBookId.load(bookId);
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
 */
export function buildServices(ds: DataSources, loaders: Loaders, prefetch: boolean): Services {
  return {
    author: new AuthorService(ds, loaders),
    book: new BookService(loaders, prefetch),
    review: new ReviewService(loaders, prefetch),
  };
}
