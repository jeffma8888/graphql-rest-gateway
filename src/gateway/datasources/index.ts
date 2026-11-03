import type { AuthorRow, BookRow, ReviewRow } from '../../rest-backend/data.js';
import {
  AUTHOR_FIELDS,
  BOOK_FIELDS,
  REVIEW_FIELDS,
  describeKind,
  readAuthorPage,
  readRows,
  type AuthorPage,
} from './contract.js';
import type { RestClient } from './rest-client.js';

export type { AuthorPage } from './contract.js';

/**
 * REST data sources -- the ONLY layer that knows the downstream URL shapes.
 * Resolvers and services never touch fetch/URLs; they go through here. Every
 * 2xx body is checked against the shared contract (`./contract`) before it is
 * returned, so a contract-breaking backend fails as `DOWNSTREAM_BAD_RESPONSE`.
 */

const authorPage = (body: unknown): AuthorPage => readAuthorPage(body, describeKind);
const authorRows = (body: unknown): AuthorRow[] => readRows<AuthorRow>(body, AUTHOR_FIELDS, describeKind);
const bookRows = (body: unknown): BookRow[] => readRows<BookRow>(body, BOOK_FIELDS, describeKind);
const reviewRows = (body: unknown): ReviewRow[] => readRows<ReviewRow>(body, REVIEW_FIELDS, describeKind);

export class AuthorDataSource {
  constructor(private readonly client: RestClient) {}

  listAuthors(offset: number, limit: number): Promise<AuthorPage> {
    return this.client.get('/authors', { offset, limit }, authorPage);
  }

  authorsByIds(ids: ReadonlyArray<string>): Promise<AuthorRow[]> {
    return this.client.get('/authors/by-ids', { ids }, authorRows);
  }
}

export class BookDataSource {
  constructor(private readonly client: RestClient) {}

  booksByAuthorIds(authorIds: ReadonlyArray<string>): Promise<BookRow[]> {
    return this.client.get('/books/by-author', { authorIds }, bookRows);
  }

  booksByIds(ids: ReadonlyArray<string>): Promise<BookRow[]> {
    return this.client.get('/books/by-ids', { ids }, bookRows);
  }
}

export class ReviewDataSource {
  constructor(private readonly client: RestClient) {}

  reviewsByBookIds(bookIds: ReadonlyArray<string>): Promise<ReviewRow[]> {
    return this.client.get('/reviews/by-book', { bookIds }, reviewRows);
  }
}

export interface DataSources {
  author: AuthorDataSource;
  book: BookDataSource;
  review: ReviewDataSource;
}

export function buildDataSources(client: RestClient): DataSources {
  return {
    author: new AuthorDataSource(client),
    book: new BookDataSource(client),
    review: new ReviewDataSource(client),
  };
}
