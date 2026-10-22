import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { graphql } from 'graphql';
import type { FastifyInstance } from 'fastify';
import { buildBackend } from '../src/rest-backend/server';
import { schema } from '../src/gateway/schema';
import { createContext, parseAuth } from '../src/gateway/context';

describe('parseAuth (bearer-token stub)', () => {
  it('returns an anonymous context when no header is present', () => {
    expect(parseAuth(undefined)).toEqual({ userId: null, scopes: [] });
    expect(parseAuth(null)).toEqual({ userId: null, scopes: [] });
  });

  it('parses a valid bearer token into userId + scopes', () => {
    expect(parseAuth('Bearer user:42:read,write')).toEqual({
      userId: '42',
      scopes: ['read', 'write'],
    });
  });

  it('ignores a malformed token', () => {
    expect(parseAuth('Bearer garbage')).toEqual({ userId: null, scopes: [] });
    expect(parseAuth('user:42')).toEqual({ userId: null, scopes: [] });
  });
});

describe('auth context threaded into resolvers', () => {
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

  it('redacts reviewer PII for anonymous callers', async () => {
    const result = await graphql({
      schema,
      source: REVIEWER_QUERY,
      contextValue: createContext({ restClient: undefined, restBaseUrl: baseUrl }),
    });
    const reviewers = (result.data as any)?.book?.reviews?.map((r: any) => r.reviewer);
    expect(reviewers).toBeDefined();
    expect(reviewers.every((name: string) => name === 'REDACTED')).toBe(true);
  });

  it('reveals reviewer for authenticated callers', async () => {
    const result = await graphql({
      schema,
      source: REVIEWER_QUERY,
      contextValue: createContext({ restBaseUrl: baseUrl, authorization: 'Bearer user:42:pii' }),
    });
    const reviewers = (result.data as any)?.book?.reviews?.map((r: any) => r.reviewer);
    expect(reviewers).toBeDefined();
    expect(reviewers.some((name: string) => name !== 'REDACTED')).toBe(true);
  });
});
