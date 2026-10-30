# Foundry directions

foundry directions -- graphql-rest-gateway
  iter-63
    lenses: simplification-and-deletion, performance-and-throughput
    - Candidate A1 -- One selection-set walk yields both cost and depth (delete depth-limit.ts's private walker and `measureDepth`)
    - Candidate A2 -- One `prefetchKey` helper and one `byIdLoader` factory (services.ts / loaders.ts)
    - Candidate A3 -- One in-flight tracker for `GatewayServer.close()`: a Set of pending requests replaces the counter + single `drainResolve` slot (and fixes the double-close stall it hides)
    - Candidate B1 -- Multi-root by-id lookahead: aliased `a: author(id) b: author(id)` / `author(id) + book(id)` operations start their child batches in tick 0 (one serial round trip removed, same call count)
    - Candidate B2 -- Opt-in cross-request in-flight coalescing of identical downstream GETs (`coalesceDownstream: true`), keyed by URL + forwarded headers
    - Candidate B3 -- Cut the QC suite's critical path from 15.5 s to about 6 s by splitting `test_iter61_behavior.test.ts` along its describe blocks (zero assertion edits)
    winner: B1
    ship: pending (not yet decided)
  iter-62
    lenses: integration-and-adoption, simplification-and-deletion
    - Candidate A1 -- The published library entry point actually imports: built `dist/` loads under plain Node ESM and NodeNext TypeScript, and finds `schema.graphql`
    - Candidate A2 -- Opt-in structured access log for `npm start` (`ACCESS_LOG=json`): one JSON line per GraphQL request with cost, depth, downstreamCalls and error codes
    - Candidate A3 -- `npm start -- --check` / `--help`: validate and print the resolved config as JSON, then exit without listening
    - Candidate B1 -- One selection-set walk yields both cost and depth (delete depth-limit.ts's private walker and `measureDepth`)
    - Candidate B2 -- One generic `prefetchKey` helper and one `byIdLoader` factory (services.ts / loaders.ts)
    - Candidate B3 -- Collapse the execute-phase special cases: `getRootType` for the triplicated root ternary, one extensions writer
    winner: A1
    ship: PUSHED 5f0e523
  iter-61
    lenses: hardening/DX, integration-and-adoption
    - Candidate A1 -- Charge introspection/meta fields in the complexity and depth walkers (each `__schema`/`__type`/`__typename` node costs 1, never list-multiplied)
    - Candidate A2 -- Typed `DOWNSTREAM_BAD_RESPONSE` when a 2xx downstream body isn't the contract shape (non-JSON, empty, wrong top-level type, null rows)
    - Candidate A3 -- Parser token cap (`maxTokens`, default ~10k, plus a `MAX_TOKENS` env) so oversized documents are refused before parse/validate allocate
    - Candidate B1 -- `npm start` serves through the gateway's drain path, so SIGTERM gets the shipped 503 / in-flight drain instead of bypassing it
    - Candidate B2 -- Opt-in structured access log for `npm start`: one JSON line per GraphQL request (`ACCESS_LOG=json`)
    - Candidate B3 -- `npm start -- --check` / `--help`: validate and print the resolved config as JSON, then exit without listening
    winner: B1
    ship: PUSHED ff41240
  iter-60
    lenses: new-capability, hardening/DX
    - Candidate A1 -- Caller identity propagation: opt-in `forwardHeaders` allowlist so downstream REST calls carry the edge request's `authorization` / `x-request-id`
    - Candidate A2 -- `addReview` mutation: the gateway's first write path (REST POST), with request-scoped loader invalidation so the same response shows the write
    - Candidate A3 -- Opt-in per-request downstream trace: `extensions.downstreamCalls.calls[]` with `{ route, startMs, durationMs, status }` behind `traceDownstream: true` (roadmap row 10, dependency-free first slice)
    - Candidate B1 -- Close the zero-cost meta-field hole: each `__schema` / `__type` / `__typename` field node costs 1 (never list-multiplied), so aliasing introspection can't amplify past `maxComplexity`
    - Candidate B2 -- Typed `OPERATION_NOT_SUPPORTED` for `mutation` / `subscription` operations, rejected at validation with 0 downstream calls
    - Candidate B3 -- Typed `DOWNSTREAM_UNAVAILABLE` for refused/reset/DNS downstream failures (no more `"Unexpected error."` + logged stack)
    winner: A1
    ship: PUSHED 3548755
  iter-59
    lenses: narrative-and-docs, new-capability
    - Candidate A1 -- Write the downstream REST contract down: an external `REST_BASE_URL` service must match query encodings and response shapes that only exist in code comments today
    - Candidate A2 -- The README presents four symbols as public API that a package consumer cannot import (`BATCHED`, `NAIVE`, `LoaderOptions`, `requireAuth`)
    - Candidate A3 -- §6 Architecture still describes the pre-iter-53 layering: "resolvers: one field → one service call" is false since iter-58, and the diagram omits the edge layer
    - Candidate B1 -- Per-request downstream call budget `maxDownstreamCalls` -> typed `DOWNSTREAM_BUDGET_EXCEEDED` (+ `MAX_DOWNSTREAM_CALLS` env)
    - Candidate B2 -- `addReview` mutation: the gateway's first write path, with loader invalidation so the response shows the write
    - Candidate B3 -- Variable-driven bulk lookup `Query.books(ids: [ID!]!): [Book]!` (order-preserving, null for a missing id, one downstream call, max 100 ids)
    winner: B1
    ship: PUSHED d248cfe
  iter-58
    lenses: performance-and-throughput, narrative-and-docs
    - Candidate A1 -- Root-by-id lookahead prefetch: `author(id){ books }` and `book(id){ reviews }` start the child batch in the same tick as the root fetch
    - Candidate A2 -- Opt-in shared TTL cache for by-id entity rows (`entityCacheTtlMs`), roadmap row 9
    - Candidate A3 -- Request-scoped dedupe of identical list pages (`a: authors(first:5)` + `b: authors(first:5)` → one `/authors` call)
    - Candidate B1 -- Coverage figures are 9 points stale and a test pins the stale numbers: tie README, badge and a vitest coverage threshold together
    - Candidate B2 -- The pagination contract (README section 7 + the SDL description of `first`) promises behaviour the code does not have
    - Candidate B3 -- "The cost model is a conservative upper bound" is stated in three places and is false by about 10× on the default query shape
    winner: A1
    ship: PUSHED b30c7fb
  iter-57
    lenses: simplification-and-deletion, performance-and-throughput
    - Candidate A1 -- One `operationCost` + one execute-phase extensions writer (collapse iter-54's duplicated cost path and fold `downstreamCallsPlugin`)
    - Candidate A2 -- One selection-set walk yields both cost and depth (delete `depth-limit.ts`'s private walker and `measureDepth`)
    - Candidate A3 -- One integer-env rule for both entry points: `npm run backend` reuses `cli.ts`'s strict parser
    - Candidate B1 -- Root-entity lookahead prefetch: `author(id){ books }` starts the books batch in parallel with the author fetch (cut one serial round trip)
    - Candidate B2 -- Opt-in cross-request in-flight coalescing of identical downstream GETs (`coalesceDownstream: true`)
    - Candidate B3 -- Request-scoped dedupe of identical list pages (`a: authors(first:5)` + `b: authors(first:5)` share one `/authors` call)
    winner: A1
    ship: PUSHED e39c496
  iter-56
    lenses: integration-and-adoption, simplification-and-deletion
    - Candidate A1 -- `REST_BASE_URL` honours a path prefix (`http://legacy/api/v1`) instead of silently dropping it
    - Candidate A2 -- `/readyz` that actually consults the downstream REST service (keep `/healthz` as liveness)
    - Candidate A3 -- `npm run benchmark -- --query <file.graphql> --max-calls N`: measure a user's own operation through the real gateway pipeline, against `REST_BASE_URL`
    - Candidate B1 -- One `operationCost(schema, op, fragments, resolveVariable?)` for both the validation and execute phases
    - Candidate B2 -- Fold `downstreamCallsPlugin` into the single execute-phase extensions writer
    - Candidate B3 -- One selection-set walk yields both cost and depth (delete `depth-limit.ts`'s private walker and `measureDepth`)
    winner: A1
    ship: unknown
  iter-55
    lenses: hardening/DX, integration-and-adoption
    - Candidate A1 -- The cost estimate is not an upper bound: it ignores the SDL default `first: 10` and under-counts `first <= 0`, which the backend serves as a full page
    - Candidate A2 -- Typed `DOWNSTREAM_UNAVAILABLE` for refused/reset/DNS failures (finish the downstream error taxonomy)
    - Candidate A3 -- Strict canonical cursor decoding: reject non-canonical and out-of-range cursors with BAD_CURSOR
    - Candidate B1 -- `npm start` honours `REST_BASE_URL` so the gateway can front a REST service the user already runs (the strangler-fig on-ramp)
    - Candidate B2 -- Benchmark drives the real gateway and reads `extensions.downstreamCalls.total`, plus a `--max-calls N` CI gate for a user's own operation
    - Candidate B3 -- Export the error-code contract (`GatewayErrorCode` + response-extension types) from the library entry point, and make the README drift guard consult it
    winner: B1
    ship: PUSHED d140c32
  iter-54
    lenses: new-capability, hardening/DX
    - Candidate A1 -- Per-request downstream call budget: `maxDownstreamCalls` → typed `DOWNSTREAM_BUDGET_EXCEEDED`
    - Candidate A2 -- `Book.reviewCount: Int!` and `Book.averageRating: Float` aggregates that cost zero extra downstream calls
    - Candidate A3 -- Declarative `@requiresScope(scope: String!)` SDL directive replacing the hard-coded `pii` check
    - Candidate B1 -- Complexity limit honours `first` passed as a variable (close the variables bypass)
    - Candidate B2 -- Validate `first` (reject negative, clamp the estimator) so negative aliases can't cancel out cost
    - Candidate B3 -- Typed `DOWNSTREAM_UNAVAILABLE` for refused/reset/DNS failures (finish the downstream error taxonomy)
    winner: B1
    ship: PUSHED a698cd2
  iter-53
    lenses: narrative-and-docs, new-capability
    - Candidate A1 -- Correct the pagination contract prose: false "out-of-range cursor → BAD_CURSOR" claim + undocumented 100-item page cap
    - Candidate A2 -- README promises a `requireAuth(ctx)` helper that the public API doesn't export and nothing calls
    - Candidate A3 -- Stale coverage figures (README section 8 + badge) pinned by a vitest coverage threshold
    - Candidate B1 -- Per-response downstream call count in `extensions.downstreamCalls`
    - Candidate B2 -- Aggregate fields `Book.reviewCount: Int!` and `Book.averageRating: Float` with zero extra downstream calls
    - Candidate B3 -- Opt-in shared TTL entity cache behind the request-scoped loaders (roadmap item 9)
    winner: B1
    ship: PUSHED 75459ca
  iter-52
    lenses: unknown
    - Candidate A1 — Replace Buffer-based cursor encoding with native btoa/atob
    - Candidate A2 — Healthz fast-path: skip URL parsing on non-healthz requests
    - Candidate A3 — Benchmark warm-up isolation and multi-run percentile statistics
    - Candidate B1 — README "Error contract" quick-reference table with drift guard
    - Candidate B2 — Fix stale README coverage figures (badge + section 8 text)
    - Candidate B3 — SDL `Review.reviewer` description: add `pii` scope requirement
    winner: B3
    ship: PUSHED e18cfb7
  iter-41
    lenses: unknown
    - Candidate A1 — Document GatewayOptions/BackendOptions in README programmatic-usage section with drift guard
    - Candidate A2 — README section 9 post-launch design decisions (cross-loader priming, validation cache, scope-based auth)
    - Candidate A3 — README "Error contract" reference table with drift guard
    - Candidate B1 — Root-level Query.review(id) entry point
    - Candidate B2 — Paginated Query.books(first, after) Relay connection
    - Candidate B3 — Query.search(term) union-type cross-entity search
    winner: A1
    ship: PUSHED 065a2ad
  iter-40
    lenses: unknown
    - Candidate A1 — Deduplicate validation-phase AST walks (share computed cost+depth with the metrics plugin)
    - Candidate A2 — Pre-build downstream URLs in RestClient (avoid per-call `new URL()` construction)
    - Candidate A3 — Benchmark multi-run statistics (p50/p95/p99 wall-clock with warm-up isolation)
    - Candidate A1 — GatewayOptions and BackendOptions API reference in README programmatic usage
    - Candidate B1 — Document cross-loader priming and index-based lookups in README section 7
    - Candidate C1 — Expand README section 9 with post-launch design decisions
    winner: A1
    ship: PUSHED 9b0ebeb
  iter-38
    lenses: unknown
    - Candidate A1 -- Machine-readable benchmark output (--json flag + CI exit code)
    - Candidate A2 -- SDL sub-path export for downstream codegen consumers
    - Candidate A3 -- `bin` entry for `npx graphql-rest-gateway` as an adoption on-ramp
    - Candidate B1 -- Remove dead `requireAuth` export and unused `BackendStats` interface
    - Candidate B2 -- Remove REST backend `/__stats` and `/__stats/reset` endpoints
    - Candidate B3 -- Collapse duplicate fragment-parsing boilerplate across depth-limit, complexity, and queryComplexityPlugin
    winner: A1
    ship: PUSHED 712f450
  iter-37
    lenses: unknown
    - Candidate B1 -- Expose computed query cost and depth in response extensions
    - Candidate B2 -- Machine-readable benchmark output (--json flag + CI exit code)
    - Candidate B3 -- Configurable maxPageSize on GatewayOptions
    - Candidate B1 -- Export extension codes as a typed constant from the library entry point
    - Candidate B2 -- SDL sub-path export for downstream codegen consumers
    - Candidate B3 -- `bin` entry for `npx graphql-rest-gateway` as an adoption on-ramp
    winner: B1
    ship: PUSHED 93a6e1c
  iter-36
    lenses: new-capability, hardening/DX
    - Candidate A1 -- Root-level Query.review(id) entry point
    - Candidate B1 -- Filtered nested field: Book.reviews(minRating: Int)
    - Candidate C1 -- Union-type search: Query.search(term) returning Author | Book
    - Candidate B1 -- Typed DOWNSTREAM_ERROR for non-OK HTTP responses
    - Candidate B2 -- Expose computed query cost and depth in response extensions
    - Candidate B3 -- Configurable maxPageSize on GatewayOptions
    winner: B1
    ship: PUSHED 1e6ee54
  iter-35
    lenses: unknown
    - Candidate A1 -- Document the iter-behavior test pattern in README section 8
    - Candidate B1 -- Expand README programmatic-usage section to document GatewayOptions and BackendOptions
    - Candidate C1 -- Fix README requireAuth documentation vs public-API omission
    - Candidate B1 -- Root-level Query.review(id) entry point
    - Candidate B2 -- Paginated Query.books(first, after) Relay connection
    - Candidate B3 -- Scope-based field authorization on Review.reviewer
    winner: B3
    ship: PUSHED f870ff9
  iter-34
    lenses: unknown
    - Candidate A1 — reviewsByBookId primes bookById for back-edge traversals
    - Candidate A2 — Benchmark multi-run percentile reporting (p50/p95/p99)
    - Candidate A3 — ETag-based conditional fetch for downstream REST calls
    - Candidate B1 — Document downstream timeout and cross-loader priming in README section 7
    - Candidate B2 — Expand README programmatic usage to show full GatewayOptions
    - Candidate B3 — CI drift guard: README must mention every GraphQL extension code the code defines
    winner: B3
    ship: PUSHED ce89ddc
  iter-29
    lenses: unknown
    - Candidate A1 -- Update README section 10 to remove shipped features and add new planned items
    - Candidate A2 -- Fix README exported-symbols list and document BackendOptions in programmatic usage
    - Candidate A3 -- Document cross-loader priming and timeout in README architecture section
    - Candidate B1 — Structured NOT_FOUND errors for root-level entity queries
    - Candidate B2 — Root-level Query.review(id) entry point
    - Candidate B3 — Paginated book listing Query.books(first, after)
    winner: B1
    ship: PUSHED 9c733af
  iter-27
    lenses: unknown
    - Candidate A1 -- Remove three prose-only functions: `requireAuth`, `estimateComplexity`, `resetStats`
    - Candidate A2 -- Remove BackendStats tracking and `/__stats` endpoint from the REST backend
    - Candidate A3 -- Inline `models.ts` type aliases into codegen config
    - Candidate B1 — Eliminate 4-second keep-alive drain stall in iter-18 test teardown
    - Candidate B2 — Benchmark multi-run percentile reporting (p50/p95/p99)
    - Candidate B3 — Response caching layer for repeated identical queries (per-request scope)
    winner: B1
    ship: PUSHED a72cdf6
  iter-26
    lenses: unknown
    - Candidate A1 -- `.graphqlrc.yml` for editor and codegen schema discovery
    - Candidate A2 -- Machine-readable benchmark output (`--json` flag + CI exit code)
    - Candidate A3 -- SDL sub-path export for downstream codegen consumers
    - Candidate B1 -- Remove three prose-only exports: `requireAuth`, `estimateComplexity`, `resetStats`
    - Candidate B2 -- Remove BackendStats tracking and `/__stats` endpoints from the REST backend
    - Candidate B3 -- Inline the `models.ts` mapper aliases into codegen config
    winner: A1
    ship: PUSHED 481b4d9
  iter-19
    lenses: unknown
    - Candidate A1 — Health-check endpoint and graceful shutdown for the gateway process
    - Candidate A2 — Structured NOT_FOUND errors for root-level entity queries
    - Candidate A3 — GraphQL config file (.graphqlrc.yml) for editor and codegen discovery
    - Candidate B1 — `.graphqlrc.yml` for editor/codegen/tool discovery
    - Candidate B2 — SDL sub-path export for downstream codegen consumers
    - Candidate B3 — Machine-readable benchmark output (`--json` flag + CI exit code)
    winner: A1
    ship: PUSHED a76f8c3
  iter-18
    lenses: new-capability
    - Candidate A1 — Downstream request timeout with typed error mapping
    - Candidate A2 — Root-level Query.review entry point
    - Candidate A3 — Health-check endpoint on the GraphQL gateway
    - Candidate B1 — Downstream request timeout with typed error mapping
    - Candidate B2 — GraphQL config file (.graphqlrc.yml) for editor/codegen discovery
    - Candidate B3 — Graceful shutdown with in-flight request draining
    winner: A1
    ship: PUSHED 10705ed
  iter-17
    lenses: unknown
    - Candidate A1 — Fix stale README stats and decouple EB7 from hardcoded counts
    - Candidate A2 — Document cross-loader priming and index-based lookups in README
    - Candidate A3 — Add a CI-friendly README-stats drift guard
    - Candidate B1 — Downstream request timeout with typed error mapping
    - Candidate B2 — Root-level review lookup (Query.review)
    - Candidate B3 — Write-through mutation (Mutation.addReview)
    winner: A1
    ship: PUSHED 2aa20cc
  iter-16
    lenses: unknown
    - Candidate A1 — Index-based lookups in REST backend batch endpoints
    - Candidate A2 — Expose yoga's parse+validate cache hit rate in benchmark output
    - Candidate A3 — reviewsByBookId primes bookById for back-edge traversals
    - Candidate B1 — Fix stale test count and coverage stats in README + badges
    - Candidate B2 — Document cross-loader priming in README and update PRODUCT.md roadmap
    - Candidate B3 — Add a CI drift guard that fails when README test count disagrees with vitest output
    winner: A1
    ship: PUSHED 6f8c1de
  iter-15
    lenses: unknown
    - Candidate A1 -- Dead-export sweep: remove requireAuth, estimateComplexity, and RestClient.resetStats
    - Candidate A2 -- Remove BackendStats tracking and /__stats endpoints from the REST backend
    - Candidate A3 -- Replace hand-rolled pad/padStart with String.prototype builtins in benchmark
    - Candidate B1 -- Cross-loader priming to eliminate redundant back-edge fetches
    - Candidate B2 -- Parsed-operation document cache to amortize parse and validation cost
    - Candidate B3 -- Index-based lookups in REST backend batch endpoints
    winner: B1
    ship: PUSHED 41e106f
  iter-03
    lenses: unknown
    - Candidate A1 — Remove uncalled exports: requireAuth, estimateComplexity, resetStats
    - Candidate A2 — Remove BackendStats tracking and /__stats endpoints from the REST backend
    - Candidate A3 — Collapse duplicate call-counting: unify RestClient.stats and the backend's onRequest hook into one instrumentation path
    - Candidate B1 — Cross-loader priming to eliminate redundant back-edge fetches
    - Candidate B2 — Response cache for repeated unauthenticated queries
    - Candidate B3 — Per-phase cost breakdown in benchmark with regression thresholds
    winner: B1
    ship: PUSHED d14ab47
  iter-02
    lenses: unknown
    - Candidate A1 — GraphQL config file for editor/codegen schema discovery
    - Candidate A2 — Machine-readable benchmark output with exit-code CI gate
    - Candidate A3 — Introspection-off production default with explicit opt-in
    - Candidate B1 — Remove dead exports: requireAuth, estimateComplexity, resetStats
    - Candidate B2 — Remove dead BackendStats tracking and /__stats endpoints from the REST backend
    - Candidate B3 — Replace hand-rolled pad/padStart in benchmark with ES2022 String builtins
    winner: A2
    ship: REVERTED
  iter-01
    lenses: unknown
    - Candidate A1 — Downstream request timeout with typed error mapping
    - Candidate A2 — Structured error handling for missing entities in loaders
    - Candidate A3 — Health-check endpoint and graceful shutdown for the gateway process
    - Candidate B1 — Programmatic library entry point via package.json exports map
    - Candidate B2 — Machine-readable benchmark output for CI regression tracking
    - Candidate B3 — GraphQL config file for schema discovery by editor tooling and client codegen
    winner: B1
    ship: REVERTED
30 scouted iterations
