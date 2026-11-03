import type { AuthorRow, BookRow, ReviewRow } from '../../rest-backend/data.js';

/**
 * The REST contract's response shapes, defined ONCE. WHY one module: the
 * gateway's data sources check every 2xx body against these specs at runtime,
 * and `npm run check-backend` checks a backend against them before cut-over.
 * If the two kept separate copies, the pre-flight could pass a backend the
 * gateway then refuses (or the reverse).
 */

/** `GET /authors` answers one page of authors plus the unpaged total. */
export interface AuthorPage {
  items: AuthorRow[];
  total: number;
}

type FieldKind = 'string' | 'number';

/**
 * Expected JSON type per row field. WHY a mapped type: `satisfies RowSpec<AuthorRow>`
 * fails to compile if a row type gains, loses or retypes a field, so the runtime
 * contract cannot drift from the one the resolvers are typed against.
 */
export type RowSpec<R> = { readonly [K in keyof R]: R[K] extends number ? 'number' : 'string' };

export const AUTHOR_FIELDS = { id: 'string', name: 'string', bio: 'string' } as const satisfies RowSpec<AuthorRow>;
export const BOOK_FIELDS = { id: 'string', authorId: 'string', title: 'string', year: 'number' } as const satisfies RowSpec<BookRow>;
export const REVIEW_FIELDS = {
  id: 'string',
  bookId: 'string',
  body: 'string',
  reviewer: 'string',
  rating: 'number',
} as const satisfies RowSpec<ReviewRow>;

/** A contract deviation found in a response body (as opposed to a transport failure). */
export class ContractMismatch extends Error {}

/** Renders a JSON value inside a mismatch message. */
export type Describe = (value: unknown) => string;

type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Operator-facing description that echoes keys and primitive values. Used by
 * check-backend, whose report goes to the person who owns the backend.
 */
export const describeValue: Describe = (value) => {
  if (value === undefined) return 'nothing (field absent)';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (isRecord(value)) return `an object with keys [${Object.keys(value).join(', ')}]`;
  return `${typeof value} ${JSON.stringify(value)}`;
};

/**
 * Client-facing description: the JSON type only. WHY no keys or values: the
 * gateway's error goes to API clients, and a downstream body (row data, an
 * error page) is never theirs to see; the field NAME comes from the contract.
 */
export const describeKind: Describe = (value) => {
  if (value === undefined) return 'nothing (field absent)';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
};

/** `authorId` → `author_id`: the most common legacy spelling, worth pointing out by name. */
function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function checkField(row: JsonObject, key: string, kind: FieldKind, label: string, show: Describe): void {
  if (!(key in row)) {
    const snake = snakeCase(key);
    const hint = snake !== key && snake in row ? ` (found "${snake}"; the contract uses camelCase)` : '';
    throw new ContractMismatch(`${label}: field "${key}" is missing${hint}`);
  }
  if (typeof row[key] !== kind) {
    throw new ContractMismatch(`${label}: field "${key}" must be a ${kind}, got ${show(row[key])}`);
  }
}

/**
 * Validates a JSON array of rows field by field and returns it typed. Extra
 * fields are allowed: a legacy backend may well send more than the contract.
 */
export function readRows<R>(body: unknown, spec: RowSpec<R>, show: Describe, label = 'row'): R[] {
  if (!Array.isArray(body)) throw new ContractMismatch(`expected a JSON array of rows, got ${show(body)}`);
  const fields = Object.entries(spec) as Array<[string, FieldKind]>;
  body.forEach((row: unknown, i) => {
    if (!isRecord(row)) throw new ContractMismatch(`${label} ${i}: expected an object, got ${show(row)}`);
    for (const [key, kind] of fields) checkField(row, key, kind, `${label} ${i}`, show);
  });
  return body as R[];
}

/** `GET /authors` must be `{ items: AuthorRow[], total: number }`; an empty page is valid. */
export function readAuthorPage(body: unknown, show: Describe): AuthorPage {
  if (!isRecord(body)) throw new ContractMismatch(`expected an object { items, total }, got ${show(body)}`);
  // The body is described too because a wrapped page ({ data, count }) is the usual cause.
  if (!Array.isArray(body.items)) {
    throw new ContractMismatch(`field "items" must be an array of authors, got ${show(body.items)}; body is ${show(body)}`);
  }
  if (typeof body.total !== 'number') {
    throw new ContractMismatch(`field "total" must be a number, got ${show(body.total)}; body is ${show(body)}`);
  }
  return { items: readRows<AuthorRow>(body.items, AUTHOR_FIELDS, show, 'items'), total: body.total };
}
