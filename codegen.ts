import type { CodegenConfig } from '@graphql-codegen/cli';

/**
 * Schema-first codegen: the SDL in `schema.graphql` is the single source of
 * truth; TypeScript resolver types are DERIVED from it. `mappers` tell codegen
 * that resolver *parents* are the raw REST row shapes (AuthorRow, BookRow, ...),
 * not the GraphQL output types -- this is the idiomatic "wrap REST behind a
 * graph" pattern and it makes the resolver signatures type-check against the
 * downstream data model.
 */
const config: CodegenConfig = {
  schema: './schema.graphql',
  generates: {
    './src/generated/graphql.ts': {
      plugins: ['typescript', 'typescript-resolvers'],
      config: {
        useIndexSignature: true,
        skipTypename: true,
        enumsAsTypes: true,
        contextType: '../gateway/context.js#GatewayContext',
        mappers: {
          Author: '../rest-backend/data.js#AuthorRow',
          Book: '../rest-backend/data.js#BookRow',
          Review: '../rest-backend/data.js#ReviewRow',
          AuthorConnection: '../gateway/models.js#AuthorConnectionModel',
          AuthorEdge: '../gateway/models.js#AuthorEdgeModel',
        },
      },
    },
  },
};

export default config;
