# Foundry directions

foundry directions -- graphql-rest-gateway
  iter-19
    lenses: unknown
    - Candidate A1 — Health-check endpoint and graceful shutdown for the gateway process
    - Candidate A2 — Structured NOT_FOUND errors for root-level entity queries
    - Candidate A3 — GraphQL config file (.graphqlrc.yml) for editor and codegen discovery
    - Candidate B1 — `.graphqlrc.yml` for editor/codegen/tool discovery
    - Candidate B2 — SDL sub-path export for downstream codegen consumers
    - Candidate B3 — Machine-readable benchmark output (`--json` flag + CI exit code)
    winner: A1
    ship: pending (not yet decided)
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
8 scouted iterations
