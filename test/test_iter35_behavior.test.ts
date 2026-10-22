import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { graphql } from 'graphql';
import type { FastifyInstance } from 'fastify';
import { buildBackend } from '../src/rest-backend/server';
import { schema } from '../src/gateway/schema';
import { createContext } from '../src/gateway/context';

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = buildBackend({ latencyMs: 0 }).app;
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
});

const REVIEWER_QUERY = /* GraphQL */ `
  query {
    book(id: "a1-b1") {
      reviews {
        reviewer
      }
    }
  }
`;

async function queryReviewer(authorization?: string) {
  const contextValue = createContext({
    restBaseUrl: baseUrl,
    ...(authorization ? { authorization } : {}),
  });
  const result = await graphql({ schema, source: REVIEWER_QUERY, contextValue });
  expect(result.errors).toBeUndefined();
  const reviewers = (result.data as any)?.book?.reviews?.map(
    (r: any) => r.reviewer,
  );
  expect(reviewers).toBeDefined();
  expect(reviewers.length).toBeGreaterThan(0);
  return reviewers as string[];
}

// EB1 — pii scope reveals reviewer
describe('EB1 — pii scope reveals reviewer', () => {
  it('Bearer user:42:pii returns actual reviewer names (not REDACTED)', async () => {
    const reviewers = await queryReviewer('Bearer user:42:pii');
    expect(reviewers.every((name) => name !== 'REDACTED')).toBe(true);
  });

  it('all returned reviewer names are non-empty strings', async () => {
    const reviewers = await queryReviewer('Bearer user:42:pii');
    expect(reviewers.every((name) => typeof name === 'string' && name.length > 0)).toBe(true);
  });
});

// EB2 — admin scope without pii → REDACTED
describe('EB2 — admin scope without pii → REDACTED', () => {
  it('Bearer user:42:admin redacts reviewer to REDACTED', async () => {
    const reviewers = await queryReviewer('Bearer user:42:admin');
    expect(reviewers.every((name) => name === 'REDACTED')).toBe(true);
  });
});

// EB3 — authenticated with no scopes → REDACTED
describe('EB3 — authenticated with no scopes → REDACTED', () => {
  it('Bearer user:42 (no scopes) redacts reviewer to REDACTED', async () => {
    const reviewers = await queryReviewer('Bearer user:42');
    expect(reviewers.every((name) => name === 'REDACTED')).toBe(true);
  });
});

// EB4 — unauthenticated → REDACTED
describe('EB4 — unauthenticated → REDACTED', () => {
  it('no Authorization header redacts reviewer to REDACTED', async () => {
    const reviewers = await queryReviewer();
    expect(reviewers.every((name) => name === 'REDACTED')).toBe(true);
  });
});

// EB5 — multiple scopes including pii → revealed
describe('EB5 — multiple scopes including pii → revealed', () => {
  it('Bearer user:42:admin,pii reveals actual reviewer names', async () => {
    const reviewers = await queryReviewer('Bearer user:42:admin,pii');
    expect(reviewers.every((name) => name !== 'REDACTED')).toBe(true);
  });

  it('pii,admin order also reveals reviewer names', async () => {
    const reviewers = await queryReviewer('Bearer user:42:pii,admin');
    expect(reviewers.every((name) => name !== 'REDACTED')).toBe(true);
  });

  it('pii,read,write multi-scope also reveals reviewer names', async () => {
    const reviewers = await queryReviewer('Bearer user:42:pii,read,write');
    expect(reviewers.every((name) => name !== 'REDACTED')).toBe(true);
  });
});

// Cross-EB contrast: same query, different auth → different visibility
describe('Cross-EB contrast', () => {
  it('pii scope and no-pii scope produce different reviewer values for same book', async () => {
    const revealed = await queryReviewer('Bearer user:42:pii');
    const redacted = await queryReviewer('Bearer user:42:admin');
    expect(revealed.length).toBe(redacted.length);
    expect(revealed.every((name) => name !== 'REDACTED')).toBe(true);
    expect(redacted.every((name) => name === 'REDACTED')).toBe(true);
  });

  it('anonymous and admin-only both produce REDACTED (same result)', async () => {
    const anonymous = await queryReviewer();
    const adminOnly = await queryReviewer('Bearer user:42:admin');
    expect(anonymous).toEqual(adminOnly);
  });
});
