import DataLoader from 'dataloader';
import type { AuthorRow, BookRow, ReviewRow } from '../rest-backend/data';
import type { DataSources } from './datasources';

/**
 * Request-scoped DataLoaders.
 *
 * WHY REQUEST-SCOPED: a DataLoader keeps a per-instance cache. If you shared
 * one across requests you'd leak one user's data into another's response and
 * serve stale rows forever -- the classic senior footgun. `buildLoaders` is
 * therefore called fresh inside `createContext` for every request.
 *
 * The `LoaderOptions` flag is what powers the N+1 demo:
 *   BATCHED = { batch: true,  cache: true }  -> keys in a tick collapse to ONE call
 *   NAIVE   = { batch: false, cache: false } -> DataLoader calls the batch fn per key,
 *                                               reproducing the N+1 explosion on purpose.
 */

export interface LoaderOptions {
  batch: boolean;
  cache: boolean;
}

export const BATCHED: LoaderOptions = { batch: true, cache: true };
export const NAIVE: LoaderOptions = { batch: false, cache: false };

export interface Loaders {
  authorById: DataLoader<string, AuthorRow | null>;
  bookById: DataLoader<string, BookRow | null>;
  booksByAuthorId: DataLoader<string, BookRow[]>;
  reviewsByBookId: DataLoader<string, ReviewRow[]>;
}

function indexBy<T, K>(rows: ReadonlyArray<T>, key: (row: T) => K): Map<K, T> {
  const map = new Map<K, T>();
  for (const row of rows) map.set(key(row), row);
  return map;
}

function groupBy<T>(
  keys: ReadonlyArray<string>,
  rows: ReadonlyArray<T>,
  key: (row: T) => string,
): T[][] {
  const groups = new Map<string, T[]>();
  for (const k of keys) groups.set(k, []);
  for (const row of rows) groups.get(key(row))?.push(row);
  return keys.map((k) => groups.get(k) ?? []);
}

export function buildLoaders(ds: DataSources, options: LoaderOptions = BATCHED): Loaders {
  const authorById = new DataLoader<string, AuthorRow | null>(async (ids) => {
    const rows = await ds.author.authorsByIds(ids);
    const byId = indexBy(rows, (r) => r.id);
    // Contract: return exactly one value per key, in the same order.
    return ids.map((id) => byId.get(id) ?? null);
  }, options);

  const bookById = new DataLoader<string, BookRow | null>(async (ids) => {
    const rows = await ds.book.booksByIds(ids);
    const byId = indexBy(rows, (r) => r.id);
    return ids.map((id) => byId.get(id) ?? null);
  }, options);

  const booksByAuthorId = new DataLoader<string, BookRow[]>(async (authorIds) => {
    const rows = await ds.book.booksByAuthorIds(authorIds);
    for (const book of rows) bookById.prime(book.id, book);
    return groupBy(authorIds, rows, (b) => b.authorId);
  }, options);

  const reviewsByBookId = new DataLoader<string, ReviewRow[]>(async (bookIds) => {
    const rows = await ds.review.reviewsByBookIds(bookIds);
    return groupBy(bookIds, rows, (r) => r.bookId);
  }, options);

  return { authorById, bookById, booksByAuthorId, reviewsByBookId };
}
