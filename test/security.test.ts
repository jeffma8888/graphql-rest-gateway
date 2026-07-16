import { describe, it, expect } from 'vitest';
import { parse, validate, specifiedRules } from 'graphql';
import { schema } from '../src/gateway/schema';
import { depthLimit } from '../src/gateway/security/depth-limit';
import { complexityLimit } from '../src/gateway/security/complexity';

function check(query: string, rule: ReturnType<typeof depthLimit>) {
  return validate(schema, parse(query), [...specifiedRules, rule]);
}

describe('query depth limiting', () => {
  it('accepts a query within the depth limit', () => {
    const errors = check(
      `query { authors(first: 2) { edges { node { id name } } } }`,
      depthLimit(10),
    );
    expect(errors).toHaveLength(0);
  });

  it('rejects a query that nests beyond the depth limit', () => {
    // authors -> edges -> node -> books -> author -> books -> author -> books -> reviews ...
    const deep = `
      query {
        authors(first: 1) {
          edges {
            node {
              books {
                author {
                  books {
                    author {
                      books {
                        reviews { id }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    const errors = check(deep, depthLimit(6));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.extensions?.code).toBe('QUERY_TOO_DEEP');
  });

  it('ignores introspection depth so tooling still works', () => {
    const errors = check(`query { __schema { types { name } } }`, depthLimit(2));
    expect(errors).toHaveLength(0);
  });
});

describe('query complexity limiting', () => {
  it('accepts the normal sample query', () => {
    const errors = check(
      `query {
        authors(first: 5) {
          totalCount
          edges { node { id name books { id title reviews { id rating } } } }
        }
      }`,
      complexityLimit(1000),
    );
    expect(errors).toHaveLength(0);
  });

  it('rejects a shallow-but-very-wide query', () => {
    const errors = check(
      `query { authors(first: 5000) { edges { node { id books { id reviews { id } } } } } }`,
      complexityLimit(1000),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX');
    expect(errors[0]?.extensions?.cost).toBeGreaterThan(1000);
  });
});
