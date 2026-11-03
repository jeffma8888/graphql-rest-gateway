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
| 30 | `close()` clears its drain-bound timer and shares one drain across repeated calls. Abort in-flight `/readyz` checks on `close()` (iter-74: a probe hung on a dead backend holds `close()` for the full 5 s cap) | planned | — |
| 31 | `Book.author` → `Author.books` lookahead (`book(id){author{books}}`: 3 hops → 2, call counts unchanged) | done | 70 |
| 32 | Opt-in HTTP request batching (`maxBatchSize` / `MAX_BATCH_SIZE`): ops in one POST share one loader set + one call budget | done | 65 |
| 33 | Hostile-document refusal: fixed 2000-token parser cap → `QUERY_TOO_LARGE`; depth/complexity rules run first and short-circuit (7 s stall → ms) | done | 66 |
| 34 | Relay backward pagination on `Query.authors` (`last`/`before`; 1 call with `before`, ≤2 without) + pages truncated to the clamped size (`first: 0` → empty) | done | 71 |
| 35 | Request-body byte cap with HTTP 413 (`maxRequestBytes`) | planned | — |
| 36 | `npm run check-backend`: REST-contract pre-flight for `REST_BASE_URL` (5 routes, PASS/FAIL per field, exit 0/1/2, `--json`) | done | 67 |
| 37 | Token cap budgeted per edge HTTP request under `maxBatchSize` (200 cap-sized batched docs stall 6.5 s) | planned | — |
| 38 | `createGateway` validates its whole options object: NaN/0/Infinity limits, `downstreamTimeoutMs` > 2^31-1, bad `restBaseUrl`/`loaderOptions` and unknown keys (did-you-mean) throw | done | 72 |
| 39 | Downstream response byte cap → typed `DOWNSTREAM_RESPONSE_TOO_LARGE` (200 MB body = +704 MB RSS) | planned | — |
| 40 | Fragment spreads walked once per document: one memoised cost+depth walk ends the 2^n repeated-spread validation stall | done | 68 |
| 41 | `npm start` opt-in pre-flight (`PREFLIGHT=warn\|fail`) runs check-backend before listening | planned | — |
| 42 | `check-backend` checks authenticated backends (`--header`) and honours `DOWNSTREAM_TIMEOUT_MS` with per-route latency | planned | — |
| 43 | Identical `authors(first, after)` list pages fetched once per edge HTTP request (batch of 10 identical ops: 12 → 3 calls) | done | 69 |
| 44 | Batch-wide lookahead gate: under `maxBatchSize`, one gate-off op turns prefetch off for every op in the POST (mixed batches split today: +1 call) | planned | — |
| 45 | README pagination truth: out-of-range `after`/`before` cursors return an empty page, not `BAD_CURSOR` (fix sentence + pin it); a past-end `before` must never give `hasPreviousPage: true` with `startCursor: null`; `""` cursors → `BAD_CURSOR` | planned | — |
| 46 | README Programmatic-usage snippet closes the backend `app` (hangs >30 s today) + doc-test that runs it | planned | — |
| 47 | Complexity prices the implicit default page size (`authors{…}` with no `first`/`last` costs 34 but fetches 10 rows, like `first: 10` at 331) | planned | — |
| 48 | Bounded nested lists `Author.books(first)` / `Book.reviews(first)`, sliced after the batched fetch (calls unchanged; benchmark-shaped cost 166 → 61) | planned | — |
| 49 | Relay `interface Node` + `Query.node(id)`/`nodes(ids)` refetch via the batched by-id loaders (global id never a loader key) | planned | — |
| 50 | Options validated for the gateway's lifetime: snapshot `opts` before validating (post-construction mutation such as `downstreamTimeoutMs = 2**31` re-opens the 1 ms clamp) and reject extra `loaderOptions` keys (`maxBatchSize: 1` there turns 2 calls into 6). `/readyz` and `contextFor` must read the same snapshot (iter-74: mutating `restBaseUrl` after boot leaves `/readyz` 200 while every query fails) | planned | — |
| 51 | 2xx downstream body that breaks the REST contract (non-JSON, wrong shape, bad row field) → typed `DOWNSTREAM_BAD_RESPONSE` naming the route, via check-backend's shared row reader | done | 73 |
| 52 | SDL contract importable by name: `exports` gains `./schema.graphql` + `./package.json`; entry re-exports realm-free `typeDefs` (`ERR_PACKAGE_PATH_NOT_EXPORTED` today) | planned | — |
| 53 | CI enforces the quality bar: `npm run typecheck` step (test/ type errors pass CI today) + `benchmark --threshold`; unknown benchmark flags exit 2 | planned | — |
| 54 | A 2xx body that stalls after headers maps to `DOWNSTREAM_TIMEOUT` (today `res.text()` sits outside the timeout mapping → "Unexpected error."); pair with row 39's byte cap. Also map a mid-body reset to `DOWNSTREAM_UNREACHABLE` so `/readyz` and clients agree by construction (iter-74: probe says UNREACHABLE, clients get INTERNAL_SERVER_ERROR) | planned | — |
| 55 | A failed `Book.author` lookahead prefetch is reused by the field's own `Author.books` load instead of re-sent (2 calls and 2 budget units today) | planned | — |
| 56 | `GET /readyz` readiness probe: one coalesced `/authors?offset=0&limit=1` contract check → 200 ready / 503 typed code; connection refused → typed `DOWNSTREAM_UNREACHABLE` for clients too | done | 74 |
| 57 | `/readyz` against an auth-required backend (opt-in probe credential/header; the probe forwards nothing today, so a 401 backend reports unready) | planned | — |
| 58 | Error-code vocabulary importable: frozen `GATEWAY_ERROR_CODES` + `type GatewayErrorCode` from the entry, README §7 code table guarded against source | planned | — |
| 59 | One admission rule: merge `depthLimit` into the cost walk, delete `depth-limit.ts` and the `-1` sentinel handshake (second walk ≈ 60% of admission CPU) | planned | — |
| 60 | One positive-integer validator: `maxBatchSize`/`maxDownstreamCalls` use options.ts `assertPositiveInt` (`"10"` renders as `got 10` today) | planned | — |
| 61 | `/healthz` and `/readyz` send `cache-control: no-store`, so a caching intermediary cannot replay a stale ready verdict | planned | — |
