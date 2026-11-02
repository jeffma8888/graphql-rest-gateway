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
| 4 | Downstream request timeout with typed error mapping | done | 18 |
| 5 | Health-check endpoint and graceful shutdown | done | 19 |
| 6 | Structured NOT_FOUND errors for root-level entity queries | done | 29 |
| 7 | Machine-readable benchmark output (--json, CI exit code) | done | 38 |
| 8 | GraphQL config file (.graphqlrc.yml) for editor/codegen discovery | done | 26 |
| 9 | Response caching layer (per-request + optional shared TTL cache) | planned | — |
| 10 | OpenTelemetry tracing spans per resolver and downstream call | planned | — |
| 11 | Extension-code README drift guard + doc backfill | done | 34 |
| 12 | Scope-based field authorization (pii scope on Review.reviewer) | done | 35 |
| 13 | Typed DOWNSTREAM_ERROR for non-OK HTTP responses | done | 36 |
| 14 | Query cost and depth in response extensions | done | 37 |
| 15 | Deduplicate validation-phase AST walks (shared cache) | done | 40 |
| 16 | GatewayOptions/BackendOptions API reference + drift guard | done | 41 |
| 17 | SDL Review.reviewer doc-comment pii scope fix + drift guard | done | 52 |
| 18 | Per-response downstream call count (`extensions.downstreamCalls.total`) | done | 53 |
| 19 | Complexity limit honours variable `first`/`last` + non-negative cost clamp | done | 54 |
| 20 | `npm start` fronts an external REST service (`REST_BASE_URL`) + limit env vars, fail-fast validated | done | 55 |
| 21 | Downstream base URL honours a path prefix (`/api/v1`); `REST_BASE_URL` rejects query/fragment | done | 57 |
| 22 | Root-by-id lookahead prefetch (`author(id){books}`, `book(id){reviews}`): child batch starts with the root fetch | done | 58 |
| 23 | Per-request downstream call budget (`maxDownstreamCalls` / `MAX_DOWNSTREAM_CALLS`) → typed `DOWNSTREAM_BUDGET_EXCEEDED` | done | 59 |
| 24 | Edge header forwarding allowlist (`forwardHeaders` / `FORWARD_HEADERS`) for authenticated downstream REST | done | 60 |
| 25 | `npm start` serves through the drain path: SIGTERM → 503 + `connection: close`, in-flight drain, prompt keep-alive shutdown | done | 61 |
| 26 | Built package imports under plain Node ESM + NodeNext TS (`.js` specifiers, layout-independent SDL lookup, `files`/`prepack`) | done | 62 |
| 27 | Multi-root by-id lookahead prefetch (aliased `author(id)`/`book(id)` roots skip one serial hop; call counts unchanged) | done | 63 |
| 28 | Package entry exports `NAIVE`/`BATCHED` (frozen) + `type LoaderOptions`; README export list computed-guarded; `requireAuth` prose corrected | done | 64 |
| 29 | README cost figures derived from a live run (stale "351"; benchmark query costs 356) | planned | — |
| 30 | `close()` clears its drain-bound timer and shares one drain across repeated calls | planned | — |
| 31 | Edge lookahead on `Book.author` → `Author.books` (gated on a `maxDownstreamCalls` interaction decision) | planned | — |
| 32 | Opt-in HTTP request batching (`maxBatchSize` / `MAX_BATCH_SIZE`): ops in one POST share one loader set + one call budget | done | 65 |
| 33 | Hostile-document refusal: fixed 2000-token parser cap → `QUERY_TOO_LARGE`; depth/complexity rules run first and short-circuit (7 s stall → ms) | done | 66 |
| 34 | Relay backward pagination on `Query.authors` (`last`/`before`, one downstream call per page) | planned | — |
| 35 | Request-body byte cap with HTTP 413 (`maxRequestBytes`) | planned | — |
| 36 | `npm run check-backend`: REST-contract pre-flight for `REST_BASE_URL` (5 routes, PASS/FAIL per field, exit 0/1/2, `--json`) | done | 67 |
| 37 | Token cap budgeted per edge HTTP request under `maxBatchSize` (200 cap-sized batched docs stall 6.5 s) | planned | — |
| 38 | Numeric library options fail fast (`maxDepth`/`maxComplexity`/`downstreamTimeoutMs` NaN/0/2.5 → `RangeError`) | planned | — |
| 39 | Downstream response byte cap → typed `DOWNSTREAM_RESPONSE_TOO_LARGE` (200 MB body = +704 MB RSS) | planned | — |
