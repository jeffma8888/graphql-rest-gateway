import { describe, it, expect } from 'vitest';
import {
  encodeCursor,
  decodeCursor,
  offsetFromCursor,
  buildConnection,
} from '../src/gateway/pagination/relay';

describe('Relay cursor pagination', () => {
  it('round-trips an offset through an opaque cursor', () => {
    const cursor = encodeCursor(7);
    expect(cursor).not.toContain('7'); // opaque, not a raw number
    expect(decodeCursor(cursor)).toBe(7);
  });

  it('treats a missing `after` as offset 0', () => {
    expect(offsetFromCursor(null)).toBe(0);
    expect(offsetFromCursor(undefined)).toBe(0);
  });

  it('rejects a malformed cursor', () => {
    expect(() => decodeCursor('not-a-real-cursor')).toThrow(/Invalid cursor/);
  });

  it('builds a first page with hasNextPage and no previous page', () => {
    const conn = buildConnection(['x', 'y'], 0, 5);
    expect(conn.totalCount).toBe(5);
    expect(conn.edges).toHaveLength(2);
    expect(conn.pageInfo.hasPreviousPage).toBe(false);
    expect(conn.pageInfo.hasNextPage).toBe(true);
    // endCursor of a page should decode to the offset to resume AFTER it
    expect(decodeCursor(conn.pageInfo.endCursor!)).toBe(2);
  });

  it('builds a last page with hasPreviousPage and no next page', () => {
    const conn = buildConnection(['d', 'e'], 3, 5);
    expect(conn.pageInfo.hasPreviousPage).toBe(true);
    expect(conn.pageInfo.hasNextPage).toBe(false);
  });

  it('chains: endCursor of page 1 is the `after` for page 2', () => {
    const page1 = buildConnection(['a', 'b'], 0, 4);
    const nextOffset = offsetFromCursor(page1.pageInfo.endCursor);
    expect(nextOffset).toBe(2);
    const page2 = buildConnection(['c', 'd'], nextOffset, 4);
    expect(page2.pageInfo.hasNextPage).toBe(false);
    expect(page2.pageInfo.hasPreviousPage).toBe(true);
  });
});
