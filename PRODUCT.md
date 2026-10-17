# graphql-rest-gateway — Product Roadmap

## Summary

A production-shaped GraphQL gateway that fronts REST backends and resolves nested queries through request-scoped DataLoaders, eliminating the N+1 call explosion. The canonical strangler-fig migration layer: stand it up in front of legacy REST, move clients over query by query, and never expose the fan-out to callers.

## Target User

Backend engineers migrating REST estates to a graph who need batching, pagination shape, depth/complexity limiting, and per-request auth handled once at the edge, with proof (benchmarks, regression tests) rather than promises.

## Quality Bar

- TypeScript strict on Node >=20; vitest + tsc --noEmit must stay green and fast
- Everything boots in-process with the bundled Fastify REST backend (no network, Docker, or accounts in tests)
- Schema-first: SDL is the contract, generated types via codegen never hand-edited
- Resolver/loader changes ship a downstream call-count assertion; the N+1 regression test may never be weakened
- MIT, publication-safe (generic identifiers, no machine paths)

## Roadmap

| # | Feature | Status | Iteration |
|---|---------|--------|-----------|
| 1 | Programmatic library entry point (exports map, barrel, .d.ts) | done | 03 |
| 2 | Cross-loader priming (eliminate redundant back-edge fetches) | done | 15 |
| 3 | Index-based lookups in REST backend batch endpoints | done | 16 |
| 4 | Downstream request timeout with typed error mapping | planned | — |
| 5 | Health-check endpoint and graceful shutdown | planned | — |
| 6 | Structured NOT_FOUND errors for root-level entity queries | planned | — |
| 7 | Machine-readable benchmark output (--json, CI exit code) | planned | — |
| 8 | GraphQL config file (.graphqlrc.yml) for editor/codegen discovery | planned | — |
| 9 | Response caching layer (per-request + optional shared TTL cache) | planned | — |
| 10 | OpenTelemetry tracing spans per resolver and downstream call | planned | — |
