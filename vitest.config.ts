import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Force a single instance/realm of `graphql`. Vite otherwise serves the ESM
  // build (.mjs) to transformed modules while Node hands the CJS build (.js) to
  // externalized ones, producing two GraphQLSchema realms and the runtime error
  // "Cannot use GraphQLSchema from another module or realm". Deduping plus
  // inlining the whole graphql/envelop/graphql-tools chain keeps everyone on
  // the same instance.
  resolve: {
    dedupe: ['graphql'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 15000,
    hookTimeout: 20000,
    server: {
      deps: {
        inline: [/graphql/i, /@envelop/i, /@graphql-tools/i, /@whatwg-node/i],
      },
    },
    coverage: {
      // istanbul (source instrumentation) maps correctly through Vite's
      // transform of inlined deps; v8 coverage under-reports here.
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/**/standalone.ts', 'src/index.ts'],
      reporter: ['text', 'html'],
    },
  },
});
