import { GraphQLError } from 'graphql';

/**
 * Minimal, spec-shaped Relay cursor pagination.
 *
 * Cursors are opaque base64 of an offset. Opaqueness matters: clients must not
 * parse them, which lets you swap offset for a keyset/seek cursor later without
 * a breaking change. `after` means "the item AFTER this cursor".
 */

export interface Edge<T> {
  node: T;
  cursor: string;
}

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface Connection<T> {
  edges: Edge<T>[];
  pageInfo: PageInfo;
  totalCount: number;
}

const CURSOR_PREFIX = 'offset:';

export function encodeCursor(offset: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${offset}`, 'utf8').toString('base64');
}

export function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64').toString('utf8');
  if (!decoded.startsWith(CURSOR_PREFIX)) {
    throw new GraphQLError(`Invalid cursor: ${cursor}`, { extensions: { code: 'BAD_CURSOR' } });
  }
  const offset = Number.parseInt(decoded.slice(CURSOR_PREFIX.length), 10);
  if (Number.isNaN(offset) || offset < 0) {
    throw new GraphQLError(`Invalid cursor: ${cursor}`, { extensions: { code: 'BAD_CURSOR' } });
  }
  return offset;
}

export function offsetFromCursor(after?: string | null): number {
  return after ? decodeCursor(after) : 0;
}

/**
 * Build a connection from a slice of `items` that starts at `offset` within a
 * collection of size `total`. Each edge's cursor points at the position AFTER
 * that node, so `after: endCursor` continues cleanly.
 */
export function buildConnection<T>(items: T[], offset: number, total: number): Connection<T> {
  const edges: Edge<T>[] = items.map((node, i) => ({
    node,
    cursor: encodeCursor(offset + i + 1),
  }));
  const end = offset + items.length;
  return {
    edges,
    totalCount: total,
    pageInfo: {
      hasNextPage: end < total,
      hasPreviousPage: offset > 0,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges.at(-1)?.cursor ?? null,
    },
  };
}
