import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildBackend } from '../src/rest-backend/server';
import { createGateway } from '../src/gateway/server';

/**
 * End-to-end over the real Yoga HTTP handler (no port needed -- `yoga.fetch`
 * exercises the full request pipeline: parse -> validate (depth/complexity) ->
 * context creation -> execute -> downstream REST).
 */
describe('gateway integration (HTTP via yoga.fetch)', () => {
  let app: FastifyInstance;
  let yoga: ReturnType<typeof createGateway>;

  beforeAll(async () => {
    app = buildBackend({ latencyMs: 0 }).app;
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    yoga = createGateway({ restBaseUrl: baseUrl, maxDepth: 10, maxComplexity: 1000 });
  });
  afterAll(async () => {
    await app.close();
  });

  async function gql(query: string, headers: Record<string, string> = {}) {
    const res = await yoga.fetch('http://gateway.local/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ query }),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  it('resolves a nested query end-to-end', async () => {
    const { status, body } = await gql(`
      query {
        authors(first: 2) {
          totalCount
          pageInfo { hasNextPage endCursor }
          edges { cursor node { id name books { id title reviews { id rating } } } }
        }
      }
    `);
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data.authors.totalCount).toBe(5);
    expect(body.data.authors.edges).toHaveLength(2);
    expect(body.data.authors.pageInfo.hasNextPage).toBe(true);
    expect(body.data.authors.edges[0].node.books[0].reviews).toHaveLength(2);
  });

  it('paginates: page 2 fetched via endCursor differs from page 1', async () => {
    const page1 = await gql(`query { authors(first: 2) { pageInfo { endCursor } edges { node { id } } } }`);
    const after = page1.body.data.authors.pageInfo.endCursor;
    const page2 = await gql(
      `query { authors(first: 2, after: "${after}") { edges { node { id } } } }`,
    );
    const ids1 = page1.body.data.authors.edges.map((e: any) => e.node.id);
    const ids2 = page2.body.data.authors.edges.map((e: any) => e.node.id);
    expect(ids2).not.toEqual(ids1);
    expect(ids2).toEqual(['a3', 'a4']);
  });

  it('rejects an over-deep query at validation time', async () => {
    const { body } = await gql(`
      query {
        authors(first: 1) {
          edges { node { books { author { books { author { books { reviews { book { id } } } } } } } } }
        }
      }
    `);
    expect(body.errors?.[0]?.extensions?.code).toBe('QUERY_TOO_DEEP');
  });

  it('rejects an over-wide query at validation time', async () => {
    const { body } = await gql(
      `query { authors(first: 9999) { edges { node { books { reviews { id } } } } } }`,
    );
    expect(body.errors?.[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX');
  });

  it('threads auth: reviewer is redacted anonymously, revealed with a token', async () => {
    const q = `query { book(id: "a1-b1") { reviews { reviewer } } }`;
    const anon = await gql(q);
    const authed = await gql(q, { authorization: 'Bearer user:7' });
    const anonNames = anon.body.data.book.reviews.map((r: any) => r.reviewer);
    const authedNames = authed.body.data.book.reviews.map((r: any) => r.reviewer);
    expect(anonNames.every((n: string) => n === 'REDACTED')).toBe(true);
    expect(authedNames.some((n: string) => n !== 'REDACTED')).toBe(true);
  });
});
