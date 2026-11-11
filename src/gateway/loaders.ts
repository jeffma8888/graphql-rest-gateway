import DataLoader from 'dataloader';
import type { AuthorRow, BookRow, ReviewRow } from '../rest-backend/data.js';
import type { DataSources } from './datasources/index.js';

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

/**
 * Frozen because both constants are public (re-exported from `src/lib.ts`) and
 * shared by every gateway in the process: one caller mutating `BATCHED` would
 * silently flip the default mode of every other gateway.
 */
export const BATCHED: Readonly<LoaderOptions> = Object.freeze({ batch: true, cache: true });
export const NAIVE: Readonly<LoaderOptions> = Object.freeze({ batch: false, cache: false });

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
  // Only keys that were actually sent get a group: a row keyed to an unsendable
  // key was never requested, so that key stays `[]` whatever the backend says.
  for (const k of keys) if (isSendableKey(k)) groups.set(k, []);
  for (const row of rows) groups.get(key(row))?.push(row);
  return keys.map((k) => groups.get(k) ?? []);
}

/**
 * Longest id the gateway forwards downstream, counted in UTF-16 code units
 * (`String.length`), not encoded bytes. WHY: every by-id key lands in a URL
 * query string, and one oversized key would get the whole batched request
 * refused (431), failing every honest key DataLoader put beside it.
 * This bounds a SINGLE key only: the aggregate batched URL is not bounded
 * (e.g. 100 sendable ids x 256 chars can exceed a 16 KiB request line).
 */
export const MAX_ID_LENGTH = 256;

/**
 * True when the REST list syntax (`?ids=a,b`) carries `key` as exactly ONE id:
 * not empty, no `,` (which would smuggle extra ids past the 100-id cap and the
 * cost model), no leading/trailing whitespace (the backend trims, so a padded
 * key would match a different row), and at most MAX_ID_LENGTH chars. Any other
 * key is never sent; it resolves as missing, which the resolvers turn into the
 * usual NOT_FOUND.
 */
export function isSendableKey(key: string): boolean {
  return key.length > 0 && key.length <= MAX_ID_LENGTH && !key.includes(',') && key.trim() === key;
}

/**
 * Calls `fetch` with only the sendable keys, and skips the call entirely when
 * none are left, so an all-unsendable batch costs 0 downstream requests.
 * Callers still map results over ALL keys; a filtered key just finds no row.
 */
async function fetchSendable<T>(
  keys: ReadonlyArray<string>,
  fetch: (keys: ReadonlyArray<string>) => Promise<T[]>,
): Promise<T[]> {
  const sendable = keys.filter(isSendableKey);
  return sendable.length > 0 ? fetch(sendable) : [];
}

export function buildLoaders(ds: DataSources, options: LoaderOptions = BATCHED): Loaders {
  const authorById = new DataLoader<string, AuthorRow | null>(async (ids) => {
    const rows = await fetchSendable(ids, (ok) => ds.author.authorsByIds(ok));
    const byId = indexBy(rows, (r) => r.id);
    // Contract: return exactly one value per key, in the same order.
    // A key that was never sent is missing even if a misbehaving backend
    // returns a row with that exact id.
    return ids.map((id) => (isSendableKey(id) ? byId.get(id) ?? null : null));
  }, options);

  const bookById = new DataLoader<string, BookRow | null>(async (ids) => {
    const rows = await fetchSendable(ids, (ok) => ds.book.booksByIds(ok));
    const byId = indexBy(rows, (r) => r.id);
    return ids.map((id) => (isSendableKey(id) ? byId.get(id) ?? null : null));
  }, options);

  const booksByAuthorId = new DataLoader<string, BookRow[]>(async (authorIds) => {
    const rows = await fetchSendable(authorIds, (ok) => ds.book.booksByAuthorIds(ok));
    for (const book of rows) bookById.prime(book.id, book);
    return groupBy(authorIds, rows, (b) => b.authorId);
  }, options);

  const reviewsByBookId = new DataLoader<string, ReviewRow[]>(async (bookIds) => {
    const rows = await fetchSendable(bookIds, (ok) => ds.review.reviewsByBookIds(ok));
    return groupBy(bookIds, rows, (r) => r.bookId);
  }, options);

  return { authorById, bookById, booksByAuthorId, reviewsByBookId };
}
