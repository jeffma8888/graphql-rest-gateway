import type { AuthorRow, BookRow, ReviewRow } from '../rest-backend/data';
import type { DataSources } from './datasources';
import type { Loaders } from './loaders';
import { buildConnection, offsetFromCursor, type Connection } from './pagination/relay';

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
    return buildConnection(items, offset, total);
  }
}

export class BookService {
  constructor(private readonly loaders: Loaders) {}

  getBook(id: string): Promise<BookRow | null> {
    return this.loaders.bookById.load(id);
  }

  booksForAuthor(authorId: string): Promise<BookRow[]> {
    return this.loaders.booksByAuthorId.load(authorId);
  }
}

export class ReviewService {
  constructor(private readonly loaders: Loaders) {}

  reviewsForBook(bookId: string): Promise<ReviewRow[]> {
    return this.loaders.reviewsByBookId.load(bookId);
  }
}

export interface Services {
  author: AuthorService;
  book: BookService;
  review: ReviewService;
}

export function buildServices(ds: DataSources, loaders: Loaders): Services {
  return {
    author: new AuthorService(ds, loaders),
    book: new BookService(loaders),
    review: new ReviewService(loaders),
  };
}
