import type { AuthorRow, BookRow, ReviewRow } from '../../rest-backend/data';
import type { RestClient } from './rest-client';

/**
 * REST data sources -- the ONLY layer that knows the downstream URL shapes.
 * Resolvers and services never touch fetch/URLs; they go through here.
 */

export interface AuthorPage {
  items: AuthorRow[];
  total: number;
}

export class AuthorDataSource {
  constructor(private readonly client: RestClient) {}

  listAuthors(offset: number, limit: number): Promise<AuthorPage> {
    return this.client.get<AuthorPage>('/authors', { offset, limit });
  }

  authorsByIds(ids: ReadonlyArray<string>): Promise<AuthorRow[]> {
    return this.client.get<AuthorRow[]>('/authors/by-ids', { ids });
  }
}

export class BookDataSource {
  constructor(private readonly client: RestClient) {}

  booksByAuthorIds(authorIds: ReadonlyArray<string>): Promise<BookRow[]> {
    return this.client.get<BookRow[]>('/books/by-author', { authorIds });
  }

  booksByIds(ids: ReadonlyArray<string>): Promise<BookRow[]> {
    return this.client.get<BookRow[]>('/books/by-ids', { ids });
  }
}

export class ReviewDataSource {
  constructor(private readonly client: RestClient) {}

  reviewsByBookIds(bookIds: ReadonlyArray<string>): Promise<ReviewRow[]> {
    return this.client.get<ReviewRow[]>('/reviews/by-book', { bookIds });
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
