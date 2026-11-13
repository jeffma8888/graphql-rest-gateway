# Foundry directions

foundry directions -- graphql-rest-gateway
  iter-95
    lenses: narrative-and-docs, new-capability
    - Candidate A1 -- Re-derive the README figures the suite pins as stale literals (coverage "~84/86/89%" against a measured 94.45/95.92/95.65 %, and §7's "351" against a live 356), and replace each literal pin with a check against its source (row 29)
    - Candidate A2 -- The §3 "Other entry points" table omits half of the product's own quality gate (`npm run typecheck`) and iter-94's `npm run bench:listener`, and says `npm run build` "type-checks" when it checks only `src/`. test_iter80 pins the stale table byte-for-byte. Replace that pin with a guard: every `package.json` script has a row, and every row names a real script
    - Candidate A3 -- The Programmatic-usage snippet no longer hangs (it exits 0 in 0.83 s, measured), but PRODUCT.md row 46 still says "hangs >30 s today", and nothing runs the block. Add a doc-test that executes the README snippet as written and close row 46
    - Candidate B1 -- Incremental delivery: the SDL declares `@defer`, so a client gets the fast part of a query after 1 hop (54 ms) instead of waiting for all 3 (158 ms), at an unchanged downstream call count
    - Candidate B2 -- The gateway's first write path: `Mutation.addReview(bookId: ID!, rating: Int!, body: String!): Review!` proxied to `POST /reviews`, with the request's `reviewsByBookId` key cleared so the same response shows the write
    - Candidate B3 -- Relay refetch: `interface Node { id: ID! }` on Author and Book, plus `Query.node(id: ID!): Node` / `nodes(ids: [ID!]!): [Node]!`, resolved by probing both by-id loaders in one tick, so any N ids cost at most 2 calls in 1 hop (row 49)
    winner: B1
    ship: pending (not yet decided)
  iter-94
    lenses: performance-and-throughput, narrative-and-docs
    - Candidate A1 -- Re-land iter-93's `nodeListener` direct chunk writes (+13 pp edge throughput) with the throughput claim moved OUT of vitest into `npm run benchmark`; the suite keeps only deterministic pins
    - Candidate A2 -- The quality gate's critical path drops from about 20 s to about 9 s wall: `test_iter61`'s sleep-bound shutdown tests run concurrently, each on its own backend and gateway
    - Candidate A3 -- The lookahead gate is computed once per execution, not on every by-id root and every `Book.author` resolve (row 67): about −18 % wall on a 60-root dashboard at an unchanged call count
    - Candidate B1 -- Two README figures the suite pins as stale literals: coverage under-claims by ~10 pp ("~84/86/89%" vs measured 95.5/96.65/96.7%) and §7 says the sample query "costs **351**" while the live gateway reports 356. Re-derive both and replace each literal pin with a check against its source (row 29)
    - Candidate B2 -- README §4 says its benchmark transcript is "from a real `npm run benchmark` run", but the block is not what the command prints. Regenerate it and pin it with an in-process doc-test that masks the timings
    - Candidate B3 -- README §10 calls the bundled backend's `/__stats` counter the OpenTelemetry "placeholder seam", contradicting §7 Observability, which documents `onDownstreamCall` as the operator per-call hook. Fix the bullet (row 80) and guard that every seam §10 names is exported by the package
    winner: A1
    ship: PUSHED 8aef7b5
  iter-93
    lenses: simplification-and-deletion), performance-and-throughput)
    - Candidate A1 -- `npm start` mounts `gateway.nodeListener` and delegates its drain to `gateway.close()`, deleting the CLI's private second copy of the drain-aware listener
    - Candidate A2 -- One drain primitive: `close()` is `settleWithin([...fetches, ...writes], 5 s)`, deleting the `inFlight` counter, `drainResolve`, the per-phase deadline arithmetic and the listener's `flushed()`/`idle()` pair
    - Candidate A3 -- `RestClient` shrinks: one transport `try` around fetch + 2xx body (iter-90's `bodyText` helper deleted) and the caller-less `resetStats()` deleted
    - Candidate B1 -- `gateway.nodeListener` stops costing 27 % edge throughput against `createServer(gw.yoga)`: write the response body chunks directly instead of `pipeline(Readable.from(body), res)`
    - Candidate B2 -- The lookahead gate is computed once per execution, not on every by-id root and every `Book.author` resolve (row 67): −18 % wall on a 60-root dashboard at an unchanged call count
    - Candidate B3 -- Compress GraphQL responses the client accepts (row 66): the 5-author page goes from 2 067 B to 480 B on the wire (−77 %) for about 16 µs CPU
    winner: B1
    ship: REVERTED
  iter-92
    lenses: integration-and-adoption, simplification-and-deletion
    - Candidate A1 -- Library embedders get the drain-aware Node listener: `gateway.nodeListener` (the bridge `npm start` already uses), and README stops telling them to mount the raw `gateway.yoga`, which keeps answering 200 after `close()`
    - Candidate A2 -- `--help` / `-h` on both installed bins prints every environment variable the command reads (name, default, bound) and exits 0, with a guard that fails when `parseEnv` reads a variable the help omits
    - Candidate A3 -- `check-backend --json` gives each route a machine-readable `code`, using the gateway's own vocabulary, so CI scripts stop regex-matching `problem` prose (iter-91 B1, deferred, not rejected)
    - Candidate B1 -- One drain primitive: `gateway.close()` waits on a `Set` of in-flight fetches via the same `settleWithin` that `http-adapter.ts` already ships, so the iter-91 hand-written copy goes away
    - Candidate B2 -- One transport `try` in `RestClient.send`: read the 2xx body inside the same `try` that wraps `fetch`, and delete iter-90's `bodyText` helper and its second `fetchFailure` call site
    - Candidate B3 -- Delete `RestClient.resetStats()`, a public method with zero callers anywhere
    winner: A1
    ship: PUSHED 84bd22f
  iter-91
    lenses: hardening/DX, integration-and-adoption
    - Candidate A1 -- `close()` is idempotent and lets the process exit once drained: no 5 s orphan drain timer, and a second `close()` cannot strand the first (row 30, timer and shared-drain half)
    - Candidate A2 -- A 2xx body the gateway cannot decode (corrupt `content-encoding`) is `DOWNSTREAM_BAD_RESPONSE`, not `DOWNSTREAM_UNREACHABLE`, for clients, `onDownstreamCall` and `/readyz`
    - Candidate A3 -- Only cursors the gateway issued are accepted: `decodeCursor` requires `encodeCursor(n) === cursor`, so lenient forms fail `BAD_CURSOR` at 0 calls (row 45, cursor-validation half)
    - Candidate B1 -- `check-backend --json` gives each route a machine-readable `code`, using the same vocabulary the gateway and `/readyz` already emit, so CI scripts stop regex-matching free-text `problem` strings
    - Candidate B2 -- `check-backend` honours the `DOWNSTREAM_TIMEOUT_MS` that `npm start` reads, so a green pre-flight means the gateway will not time out, and a bad value exits 2 like it does for `npm start` (row 42, timeout half)
    - Candidate B3 -- The package entry exports `checkBackend` (with the `CheckReport`/`RouteResult` types and `CONTRACT_ROUTES`), so a programmatic `createGateway` user can pre-flight their backend in their own boot code
    winner: A1
    ship: PUSHED b183854
  iter-90
    lenses: new-capability, hardening/DX
    - Candidate A1 -- Bulk `Query.authorsByIds(ids: [ID!]!): [Author]!`, the author twin of the shipped `books(ids:)`, in `BY_ID_ROOTS` from day one
    - Candidate A2 -- Filtered nested reviews: `Book.reviews(minRating: Int)` keeps only reviews rated at least N, applied after the one batched fetch and before `orderBy`/`first`
    - Candidate A3 -- Relay refetch: `interface Node { id: ID! }` on Author and Book + `Query.node(id: ID!): Node` / `nodes(ids: [ID!]!): [Node]!`, resolved by probing both by-id loaders, so any N ids cost at most 2 downstream calls in 1 hop (row 49)
    - Candidate B1 -- A 2xx whose body stalls or resets mid-read fails as typed `DOWNSTREAM_TIMEOUT` / `DOWNSTREAM_UNREACHABLE`, so clients and `/readyz` agree (row 54, behaviour half, no byte cap)
    - Candidate B2 -- Admission prices what execution runs: complexity and depth skip selections excluded by `@skip`/`@include`, for literals at validation and variables at execute time (row 69)
    - Candidate B3 -- Only cursors the gateway issued are accepted: `decodeCursor` requires an exact round-trip, so `""`, `offset:1abc`, `offset:2.9`, `offset:01` and padded or garbage base64 fail `BAD_CURSOR` at 0 calls (row 45, cursor-validation half)
    winner: B1
    ship: PUSHED bf88f82
  iter-89
    lenses: unknown
    - Candidate A1 -- Stale README figures that tests pin as literals: "351" and coverage "~84/86/89%" are re-derived, and each literal pin is replaced by a check against its source (row 29)
    - Candidate A2 -- The README Programmatic-usage snippet exits when run as written, and a doc-test runs the block itself (row 46)
    - Candidate A3 -- README §4's "real `npm run benchmark` run" transcript matches what the benchmark prints, and a doc-test regenerates it with the timings masked
    - Candidate B1 -- Ordered nested lists: `Author.books(first, orderBy: BookOrder)` / `Book.reviews(first, orderBy: ReviewOrder)`, sorted after the one batched fetch
    - Candidate B2 -- Bulk `Query.authorsByIds(ids: [ID!]!): [Author]!`, the author twin of the shipped `books(ids:)`, in `BY_ID_ROOTS` from day one
    - Candidate B3 -- Aggregates priced as scalars: `Book.reviewCount: Int!`, `Book.averageRating: Float`, `Author.bookCount: Int!`, from the already-batched child lists
    winner: B1
    ship: PUSHED 02f7fb4
  iter-88
    lenses: performance-and-throughput, narrative-and-docs
    - Candidate A1 -- `authors(last: N)` ("latest N") costs 1 downstream call and 1 serial hop on a warm gateway, not 2: a gateway-scoped `total` hint lets the tail be read directly and confirmed by the page's own `total`
    - Candidate A2 -- Contained `/authors` windows share one downstream call: `count+top3` 2 → 1 call, `top3+top10` 2 → 1, and `count+last3` 3 calls / 2 hops → 1 call / 1 hop
    - Candidate A3 -- Compress GraphQL responses the client accepts: the 10-author page goes from 1197 B to 371 B on the wire (−69 %) through the zero-dependency `useContentEncoding` already installed with Yoga (row 66)
    - Candidate B1 -- The pagination contract tells the truth in both places a client reads it: README §7 drops "out-of-range cursors surface `BAD_CURSOR`" (they return a 200 empty page), and the GraphiQL-visible SDL stops saying an edge cursor is only for `after`
    - Candidate B2 -- The README's Programmatic-usage snippet exits when run as written, and a doc-test runs the block itself (row 46)
    - Candidate B3 -- Stale figures locked in by tests: re-derive "351" and the coverage numbers, and replace the literal pins with checks against their sources (row 29)
    winner: B1
    ship: PUSHED 03cc65c
  iter-87
    lenses: simplification-and-deletion, performance-and-throughput
    - Candidate A1 -- One execute-phase result writer: fold `downstreamCallsPlugin` and `badUserInputPlugin` into `queryComplexityPlugin`, so each operation's result is rebuilt once instead of three times
    - Candidate A2 -- Delete the dead validation-to-execute cache only: remove `ValidationResult`'s WeakMap get/set, both `-1` sentinels and server.ts's never-taken `cached` branch, and keep `depthLimit` and `complexityLimit` as two separate rules
    - Candidate A3 -- Delete the reserved `requireAuth` helper and the never-emitted `UNAUTHENTICATED` code, plus the README sentence that apologises for them, as the declared prerequisite of row 58
    - Candidate B1 -- The `books(ids:)` bulk root joins the lookahead: its `reviews` (and `Book.author → books`) start in tick 0, so 5 measured shapes lose one serial hop at an unchanged call count
    - Candidate B2 -- Contained `/authors` windows share one downstream call: `c: authors{totalCount}` + `top: authors(first:3)` costs 1 call, not 2
    - Candidate B3 -- The quality gate's critical path drops from about 17 s to about 12 s: `test_iter61`'s 7 sleep-bound shutdown tests stop running back to back
    winner: B1
    ship: PUSHED 75704b6
  iter-86
    lenses: integration-and-adoption, simplification-and-deletion
    - Candidate A1 -- CI consults the quality bar: the workflow runs `npm run typecheck` and `npm run benchmark -- --threshold 3`, and the benchmark exits 2 on an unknown or malformed flag (row 53)
    - Candidate A2 -- Every error a client receives carries a machine-readable `extensions.code` from one importable vocabulary: variable-coercion errors get `BAD_USER_INPUT`, and the entry exports `type GatewayErrorCode` (row 58, widened)
    - Candidate A3 -- The pre-flight works against an authenticated legacy backend: `check-backend --header 'Name: value'` (repeatable) sends operator credentials on all 5 contract calls and never prints them (row 42, auth half)
    - Candidate B1 -- One admission rule, no cache handshake: fold `depthLimit` into the cost rule and delete `depth-limit.ts`, the per-document `cost`/`depth` cache and both `-1` sentinels. The cache never hits today, so behaviour is unchanged.
    - Candidate B2 -- One sendable-key gate in `loaders.ts`: collapse `fetchSendable` + `indexBy` + `groupBy` + the 2 post-filter ternaries into one `fetchByKey(keys, fetch, keyOf)` helper. `isSendableKey` is consulted at 1 site, not 5.
    - Candidate B3 -- Delete the reserved `requireAuth` helper and its never-emitted `UNAUTHENTICATED` code, plus the README sentence that apologises for them, before an error-code vocabulary freezes a code that no request can receive
    winner: A2
    ship: PUSHED 3315f25
  iter-85
    lenses: hardening/DX, integration-and-adoption
    - Candidate A1 -- By-id keys the REST list syntax cannot carry safely (contain `,`, are empty or padded, or exceed a length cap) resolve per-item `NOT_FOUND` at 0 downstream calls, instead of smuggling a batch past the 100-id cap or poisoning their honest siblings (row 83, widened)
    - Candidate A2 -- Admission skips what execution skips: complexity and depth honour `@skip`/`@include`, literal and variable alike, so the Apollo/Relay conditional-field idiom is priced by what runs (row 69)
    - Candidate A3 -- The quality gate is green outside a git checkout and catches a COMMITTED weakening of the N+1 test: one content guard replaces the git-HEAD pins on `test/n-plus-1.test.ts` (row 77)
    - Candidate B1 -- The SDL contract can be imported by name from the installed package: `exports` gains `./schema.graphql` + `./package.json`, and the entry re-exports a realm-free `typeDefs` string (row 52)
    - Candidate B2 -- CI enforces the stated quality bar: the workflow runs `npm run typecheck` and `npm run benchmark -- --threshold 3`, and the benchmark exits 2 on an unknown or malformed flag (row 53)
    - Candidate B3 -- The operator CLI consults the shipped `onDownstreamCall` hook: `LOG_DOWNSTREAM_CALLS=json` makes `npm start` / `npx graphql-rest-gateway` write one JSON line per downstream REST call to stderr
    winner: A1
    ship: PUSHED eca2592
  iter-84
    lenses: new-capability, hardening/DX
    - Candidate A1 -- Ordered nested lists: `Author.books(first, orderBy: BookOrder)` / `Book.reviews(first, orderBy: ReviewOrder)`, sorted after the one batched fetch
    - Candidate A2 -- Bulk `Query.authorsByIds(ids: [ID!]!): [Author]!` — the author twin of the shipped `books(ids:)`
    - Candidate A3 -- Filtered nested list: `Book.reviews(minRating: Int)`, applied after the one batched fetch and before `first`
    - Candidate B1 -- A by-id key that the REST list syntax cannot carry verbatim (it contains `,`, or is empty or padded) resolves `NOT_FOUND` at 0 downstream calls, instead of smuggling a whole batch past the 100-id cap and the cost model
    - Candidate B2 -- A 2xx whose body stalls or resets mid-read fails as typed `DOWNSTREAM_TIMEOUT` / `DOWNSTREAM_UNREACHABLE` for clients and `onDownstreamCall` (row 54, behaviour half, no byte cap)
    - Candidate B3 -- The suite runs green outside a git checkout and catches a COMMITTED weakening of the N+1 test: replace the 5 git-HEAD pins on `test/n-plus-1.test.ts` / `test/` with the one content guard that already exists (row 77)
    winner: A1
    ship: PUSHED 68bf329
  iter-83
    lenses: narrative-and-docs, new-capability
    - Candidate A1 -- README §7 "Request batching" promises a batch costs "the same as one merged query", but a mixed by-id + list batch costs 4 calls against the merged 3, and `maxDownstreamCalls: 3` refuses the batch while it admits the merged op. Disclose it and pin it with a prose==oracle test
    - Candidate A2 -- README §10 names the bundled backend's `/__stats` counter as the OpenTelemetry "placeholder seam", contradicting §7 Observability, which says `onDownstreamCall` is that seam. Fix §10 (row 80) and guard every named seam against what the package exports
    - Candidate A3 -- The GraphiQL-visible SDL still describes one-directional paging: `AuthorEdge.cursor` says "pass as `after` to page forward", and every `PageInfo` field has no description, although since iter-71 an edge cursor and `startCursor` are valid `before` values
    - Candidate B1 -- Ordered nested lists: `Author.books(first, orderBy: BookOrder)` / `Book.reviews(first, orderBy: ReviewOrder)`, sorted after the one batched fetch, so "latest N books" and "top review" screens become expressible at an unchanged call count
    - Candidate B2 -- Variable-driven bulk lookup `Query.books(ids: [ID!]!): [Book]!` (order-preserving, `null` + per-item `NOT_FOUND` for a missing id, max 100 ids, priced by list length), one downstream call through the existing by-id loader
    - Candidate B3 -- Aggregate fields `Book.reviewCount: Int!`, `Book.averageRating: Float` and `Author.bookCount: Int!`, computed from the already-batched child lists at 0 extra downstream calls
    winner: B2
    ship: PUSHED e651602
  iter-82
    lenses: performance-and-throughput, narrative-and-docs
    - Candidate A1 -- Batch-wide lookahead gate: a mixed opt-in HTTP batch `[author(id){books}, authors{…books}]` costs the merged operation's 3 calls, not 4 (row 44)
    - Candidate A2 -- Contained `/authors` windows share one downstream call: `c: authors{totalCount}` + `top: authors(first:3)` costs 1 call, not 2
    - Candidate A3 -- The lookahead gate runs once per execution, not per by-id root and per `Book.author` resolve (row 67): −20…−29% wall at 120 roots, which iter-81 made worse
    - Candidate B1 -- "The cost model is a conservative upper bound" is false, and inverted, for nested lists without `first`: re-tell it in README §7, §9 and the complexity.ts doc comment, and pin the measured counter-example
    - Candidate B2 -- README §7 claims a failing `Book.author` prefetch is "re-sent once (2 calls)", but it is sent exactly once (the services.ts comment says so too). Fix that sentence, the stale §8 iter-70 off-case list and PRODUCT row 55's premise, and pin all of it with the shipped `onDownstreamCall` oracle
    - Candidate B3 -- §10 names the retired `/__stats` counter as the OpenTelemetry seam; since iter-77 the seam is `onDownstreamCall` (§7 and PRODUCT row 10 already say so). Fix it, and guard that every "seam" the README names is something the package actually exports or serves
    winner: B1
    ship: PUSHED e0d824f
  iter-81
    lenses: simplification-and-deletion, performance-and-throughput
    - Candidate A1 -- One probe responder: `/healthz` and `/readyz` served by one plugin from one route table and one JSON-response builder (delete `healthzPlugin`)
    - Candidate A2 -- One execute-phase extensions writer: fold `downstreamCallsPlugin` into `queryComplexityPlugin`'s `onExecuteDone`, so each operation's result is rebuilt once instead of twice
    - Candidate A3 -- `check-backend` goes through the gateway's own data sources instead of re-spelling the 5 REST routes and their query-param names
    - Candidate B1 -- A list root whose subtree never reaches the prefetched loader keeps the lookahead: "detail + count" screens drop from 3 serial hops to 2 at the same call count (row 64)
    - Candidate B2 -- Batch-wide lookahead gate: a mixed opt-in HTTP batch stops paying +1 downstream call over the merged operation, at unchanged wall time (row 44)
    - Candidate B3 -- The lookahead gate is computed once per operation, not once per by-id root and per `Book.author` resolve (row 67): about −25% wall on wide by-id dashboards, unchanged below 15 roots
    winner: B1
    ship: PUSHED e762111
  iter-80
    lenses: integration-and-adoption, simplification-and-deletion
    - Candidate A1 -- The published package can run what the README tells operators to run: `bin` entries for the gateway and `check-backend` (`npx graphql-rest-gateway`, `npx graphql-rest-gateway-check-backend`)
    - Candidate A2 -- A per-request correlation id: echo or mint `x-request-id` on the response and put `requestId` on every `onDownstreamCall` event (row 72)
    - Candidate A3 -- Probes are never cacheable: `/healthz` and `/readyz` send `cache-control: no-store` (row 61)
    - Candidate B1 -- One admission rule: delete `security/depth-limit.ts` and the `depth: -1` sentinel, so cost and depth come from ONE `measureOperation` walk per operation
    - Candidate B2 -- One positive-integer rule for every numeric `createGateway` option: delete `validateMaxBatchSize` (server.ts:74) and `validateMaxDownstreamCalls` (rest-client.ts:47) in favour of options.ts's `assertPositiveInt`
    - Candidate B3 -- Replace the scattered "`n-plus-1.test.ts` unmodified vs git HEAD" guards with ONE content guard, so the suite runs outside a git checkout
    winner: A1
    ship: PUSHED 1a83b9d
  iter-79
    lenses: hardening/DX, integration-and-adoption
    - Candidate A1 -- Admission prices the clamped page size: `first`/`last` count as `min(n, 100)` for `authors`, `books` and `reviews`, so a query is never refused for rows the gateway would never fetch (row 74)
    - Candidate A2 -- A 2xx whose body stalls or resets mid-read fails as typed `DOWNSTREAM_TIMEOUT` / `DOWNSTREAM_UNREACHABLE`, not "Unexpected error." (row 54, behaviour half; no byte cap)
    - Candidate A3 -- `close()` lets the process exit as soon as the drain finishes, and concurrent `close()` calls share one drain (row 30, behaviour half)
    - Candidate B1 -- `npm start` consults the shipped `onDownstreamCall` hook: `LOG_DOWNSTREAM_CALLS=json` writes one JSON line per downstream REST call
    - Candidate B2 -- `npm start` opt-in boot pre-flight `PREFLIGHT=warn|fail` that runs the shipped `checkBackend` before listening (row 41)
    - Candidate B3 -- `/readyz` works against an authenticated backend: an opt-in, operator-owned readiness credential (`readinessHeaders` / `READYZ_HEADERS`), and the 503 body names the downstream status (row 57)
    winner: A1
    ship: PUSHED 15583d2
  iter-78
    lenses: new-capability, hardening/DX
    - Candidate A1 -- Bounded nested lists: `Author.books(first: Int)` / `Book.reviews(first: Int)`, sliced after the batched fetch (row 48)
    - Candidate A2 -- `onDownstreamCall` events carry per-request correlation: a `requestId` (gateway-generated, or taken from an opt-in validated header) echoed in the response, plus `operationName` when unambiguous (row 72)
    - Candidate A3 -- Opt-in shared cross-request entity cache (`entityCacheTtlMs`): a repeat by-id query within the TTL makes 0 downstream calls (row 9)
    - Candidate B1 -- Response keys follow the query's selection order at every level, not resolver completion order (row 68, widened: it is nested and deterministic, not 19/20 at the root)
    - Candidate B2 -- A 2xx whose body stalls or resets mid-read fails as typed `DOWNSTREAM_TIMEOUT` / `DOWNSTREAM_UNREACHABLE`, not "Unexpected error." (row 54, behaviour half; no byte cap)
    - Candidate B3 -- Request-body byte cap: HTTP 413 before the body is parsed (`maxRequestBytes`, finite default) (row 35)
    winner: A1
    ship: PUSHED dc1322e
  iter-77
    lenses: narrative-and-docs, new-capability
    - Candidate A1 -- README §7 says a failing `Book.author` prefetch is "re-sent once (2 calls)"; it is sent exactly once and always has been. Fix that sentence and the stale §8 lookahead off-case list, and close row 55
    - Candidate A2 -- The README's Programmatic usage snippet still never exits: add `await app.close()` and run the snippet itself as a doc-test (row 46)
    - Candidate A3 -- Stale figures pinned as literals: coverage badge and §8 say ~84/86/89 % (live 95.23/96.38/96.61 %); §7 says the sample query "costs 351" (live 501 for the §3 sample, 356 for the benchmark). Re-derive both and replace the literal pins (row 29)
    - Candidate B1 -- Relay global object identification: `interface Node` + `Query.node(id: ID!)` / `nodes(ids: [ID!]!)`, refetched through the existing batched by-id loaders (row 49)
    - Candidate B2 -- Bounded nested lists: `Author.books(first: Int)` / `Book.reviews(first: Int)`, sliced after the batched fetch (row 48)
    - Candidate B3 -- Operator-side downstream call hook: `createGateway({ onDownstreamCall })` receives `{ route, status, durationMs, errorCode, outcome }` for every REST call (row 10, dependency-free first slice)
    winner: B3
    ship: PUSHED 0ffeb67
  iter-76
    lenses: performance-and-throughput, narrative-and-docs
    - Candidate A1 -- Re-land iter-75's root-fragment / root `__typename` lookahead (3 serial hops → 2, same call count); it lost only to a reviewer auth outage
    - Candidate A2 -- Opt-in in-flight coalescing of identical downstream GETs across concurrent edge requests (thundering herd: 100 → 2 calls at 50 concurrent)
    - Candidate A3 -- Compress GraphQL responses when the client accepts it (10-author page: 2002 → 359 bytes on the wire, −82%)
    - Candidate B1 -- The README's Programmatic usage snippet never exits: add `await app.close()` and run the snippet as a doc-test
    - Candidate B2 -- Two §7 failure-contract sentences are false at HEAD: out-of-range cursors and body-stall timeouts. Rewrite them to the measured behaviour and pin each with a behaviour test
    - Candidate B3 -- The suite pins two false figures as literals (coverage ~84/86/89 % vs 95.3/96.3/96.6 %; "sample query costs 351" vs 501/356). Re-derive both and replace the literal pins with live checks
    winner: A1
    ship: PUSHED 0bb8e0f
  iter-75
    lenses: simplification-and-deletion, performance-and-throughput
    - Candidate A1 -- `check-backend` calls the gateway's own data sources instead of re-spelling the 5 routes and their query params, so a green check is about the requests the gateway actually sends
    - Candidate A2 -- One in-flight tracker: `gateway.close()` reuses http-adapter's `Set` + `settleWithin`, deleting the counter + single `drainResolve` slot (row 30)
    - Candidate A3 -- One probe-route responder: `/healthz` and `/readyz` served from one route table with one JSON-response builder (delete `healthzPlugin`)
    - Candidate B1 -- Root fragments and root `__typename` keep the lookahead: same operation, 3 serial hops → 2 at the same call count
    - Candidate B2 -- A list root that never reaches the prefetched loader no longer turns lookahead off ("current item + count" dashboards)
    - Candidate B3 -- Mixed opt-in HTTP batch costs +1 downstream call versus the merged operation (roadmap row 44)
    winner: B1
    ship: unknown
  iter-74
    lenses: simplification-and-deletion
    - Candidate A1 -- `GET /readyz`: a readiness probe that checks the downstream, so a load balancer stops sending traffic to a gateway whose REST backend is down or breaks the contract
    - Candidate A2 -- The typed error-code vocabulary is importable: `GATEWAY_ERROR_CODES` (frozen) + `type GatewayErrorCode` from the package entry, with a README §7 code table guarded against the source
    - Candidate A3 -- The SDL contract is importable by name: `exports` gains `./schema.graphql` (+ `./package.json`), and the entry re-exports a realm-free `typeDefs` string (row 52)
    - Candidate B1 -- One admission rule: delete `depth-limit.ts` and the `-1` sentinel protocol, so the cost and depth checks come from one `measureOperation` walk per document
    - Candidate B2 -- One in-flight tracker: `gateway.close()` reuses the `Set` + `settleWithin` rule that `http-adapter.ts` already ships, deleting the counter + single `drainResolve` slot (and closing row 30)
    - Candidate B3 -- One positive-integer rule for every numeric `createGateway` option: delete `validateMaxBatchSize` (server.ts) and `validateMaxDownstreamCalls` (rest-client.ts) in favour of options.ts's `assertPositiveInt`
    winner: A1
    ship: PUSHED 92c797f
  iter-73
    lenses: integration-and-adoption
    - Candidate A1 -- Options validated for the gateway's lifetime: snapshot `opts` at construction and reject unknown `loaderOptions` keys (row 50)
    - Candidate A2 -- A 2xx downstream body that breaks the REST contract fails as a typed `DOWNSTREAM_BAD_RESPONSE`, checked by the same row reader `check-backend` already uses (optionally widened with row 39's byte cap)
    - Candidate A3 -- Cursors are canonical or `BAD_CURSOR`: reject `""`, trailing junk, fractions and unsafe integers, and an empty page never claims `hasPreviousPage: true` with `startCursor: null` (row 45, behaviour half)
    - Candidate B1 -- The SDL contract is importable by name: export `./schema.graphql` (and `./package.json`) in the package `exports` map, plus a realm-free `typeDefs` string from the entry
    - Candidate B2 -- CI enforces the product's own gates: add `npm run typecheck`, and make "Prove the N+1 fix" actually able to fail (`benchmark --threshold`, unknown benchmark flags rejected with exit 2)
    - Candidate B3 -- `check-backend` can check an authenticated backend: repeatable `--header 'name: value'`, names validated by the shipped `validateForwardHeaders` (row 42, auth half)
    winner: A2
    ship: PUSHED 1664d6a
  iter-72
    lenses: new-capability, hardening/DX
    - Candidate A1 -- Relay global object identification: `interface Node` + `Query.node(id: ID!)` (and `nodes(ids:)`), with Author and Book refetched through the existing batched by-id loaders
    - Candidate A2 -- Bounded nested lists: `Author.books(first: Int)` and `Book.reviews(first: Int)`, sliced after the batched fetch, so a whole page still costs one downstream call per level and the client's cost becomes truthful
    - Candidate A3 -- Operator-side downstream call hook: `createGateway({ onDownstreamCall })` receives `{ path, status, durationMs, errorCode, outcome }` for every REST call (row 10, dependency-free first slice)
    - Candidate B1 -- `createGateway` validates its whole options object at construction: NaN/Infinity/0 limits, a missing or invalid `restBaseUrl`, and unknown keys all throw instead of silently disabling a limit (row 38, widened)
    - Candidate B2 -- `close()` stops holding the process open: clear the 5 s drain-bound timer, and make concurrent `close()` calls share one drain (row 30)
    - Candidate B3 -- Request-body byte cap with HTTP 413 before parse (`maxRequestBytes` / `MAX_REQUEST_BYTES`, finite default) (row 35)
    winner: B1
    ship: PUSHED 327b9f6
  iter-71
    lenses: narrative-and-docs, new-capability
    - A1 -- The README's Programmatic usage snippet never exits: add `await app.close()` and run the snippet as a doc-test
    - A2 -- README pagination contract and the GraphiQL-visible SDL descriptions told truthfully, checked against live behaviour
    - A3 -- Stale figures pinned as literals: coverage ~84/86/89 % (really 94/96/96 %) and "351" (really 356 / 501), re-derived from live runs
    - Candidate B1 -- Relay backward pagination on `Query.authors` (`last` / `before`), one downstream call per page (row 34)
    - Candidate B2 -- Operator-side downstream call hook: `createGateway({ onDownstreamCall })` gets `{ path, status, durationMs, errorCode, outcome }` for every REST call (row 10, dependency-free first slice)
    - Candidate B3 -- Opt-in cross-request entity cache (`entityCacheTtlMs` / `ENTITY_CACHE_TTL_MS`): a repeat by-id query within the TTL makes 0 downstream calls (row 9)
    winner: B1
    ship: PUSHED 72a155e
  iter-70
    lenses: performance-and-throughput, narrative-and-docs
    - Candidate A1 -- `Book.author` lookahead (roadmap row 31): `book(id){ author{ books } }` starts `/books/by-author` in the same tick as `/authors/by-ids`, so 3 serial hops become 2 at an identical call count
    - Candidate A2 -- Downstream transport on a keep-alive `node:http(s)` Agent instead of global `fetch`: about 20% less CPU per request and about 15% more req/s, re-measured
    - Candidate A3 -- One batched POST costs 34 ms of synchronous validation CPU per element, so 200 cap-sized docs block every caller for 6.7 s: budget the 2000-token cap per edge HTTP request (roadmap row 37)
    - B1 -- Redraw README §6 Architecture to match the code, and pin the diagram to the module tree
    - B2 -- Record the "read-only graph" invariant as a §9 design decision, with a tripwire on `type Mutation`
    - B3 -- §8 "N tests across M files" stops being a hand-maintained guess: M derived from the tree, N floor raised to now
    winner: A1
    ship: PUSHED 53bc47a
  iter-69
    lenses: simplification-and-deletion, performance-and-throughput
    - Candidate A1: Delete the four "working tree must match git HEAD" test guards (iter-62/64/66/68), which turn the suite red for any legitimate edit
    - Candidate A2: One admission rule instead of `depthLimit` + `complexityLimit`. Delete `depth-limit.ts` and the cross-rule `-1` sentinel protocol, which currently loses the depth and re-walks every request
    - Candidate A3: Delete the reserved `requireAuth` helper, its never-emitted `UNAUTHENTICATED` code and the README sentence that apologises for them (re-proposed; iter-68 B2)
    - Candidate B1 -- Request-scoped dedupe of identical list pages: one `/authors?offset&limit` call per distinct page per edge HTTP request, so a batch of N identical list operations costs what one costs
    - Candidate B2 -- Downstream transport on a keep-alive `node:http(s)` agent instead of global `fetch`: about 25% less CPU per request, about 18% more req/s
    - Candidate B3 -- `Book.author` lookahead (roadmap row 31): `book(id){ author{ books } }` starts `/books/by-author` alongside `/authors/by-ids`, cutting 3 serial hops to 2 with the same call count
    winner: B1
    ship: PUSHED fa5fc8e
  iter-68
    lenses: integration-and-adoption, simplification-and-deletion
    - Candidate A1 -- `npm start` runs the check-backend pre-flight before it listens (`PREFLIGHT=warn|fail`)
    - Candidate A2 -- `check-backend` can check an authenticated backend: repeatable `--header 'name: value'`, validated like `FORWARD_HEADERS`
    - Candidate A3 -- `check-backend` honours `npm start`'s `DOWNSTREAM_TIMEOUT_MS` and reports per-route latency, so a green check means the gateway will not time out
    - Candidate B1 -- One fragment-memoised selection walk yields both cost and depth (delete depth-limit.ts's private walker and `measureDepth`), which also ends a 2^n validation stall
    - Candidate B2 -- Delete the reserved `requireAuth` helper, its never-emitted `UNAUTHENTICATED` code, and the README sentence that apologises for them
    - Candidate B3 -- One positive-integer rule for every numeric `createGateway` option (collapse `validateMaxBatchSize` + `validateMaxDownstreamCalls`)
    winner: B1
    ship: PUSHED 8245c81
  iter-67
    lenses: hardening/DX, integration-and-adoption
    - Candidate A1 -- Opt-in batching undoes the iter-66 stall fix: one POST of 200 cap-sized documents freezes every caller for 6.5 s, so the token cap should count per edge HTTP request, not per operation
    - Candidate A2 -- Wrong numeric library options silently turn off the gateway's limits: `createGateway({ maxComplexity: NaN })` or `{ maxDepth: NaN }` accepts everything, and a bad `downstreamTimeoutMs` makes every request fail with an untyped error
    - Candidate A3 -- A misbehaving downstream can exhaust the gateway's memory: a 200 MB 2xx REST body is read whole (+704 MB RSS) to answer a 2-field query, with no cap and no typed error
    - Candidate B1 -- `npm run check-backend`: test an external REST service against the gateway's REST contract before you point clients at it
    - Candidate B2 -- `npm run benchmark -- --query <file.graphql> [--max-calls N]`: measure the user's own operation through the real gateway
    - Candidate B3 -- Export the typed error-code vocabulary (`GATEWAY_ERROR_CODES`, `type GatewayErrorCode`) from the package entry
    winner: B1
    ship: PUSHED 9080f3c
  iter-66
    lenses: hardening/DX
    - Candidate A1 -- Relay backward pagination: `authors(last: Int, before: String)` pages backward over the same `/authors?offset&limit` route, in one downstream call
    - Candidate A2 -- Opt-in shared TTL cache for by-key downstream results (`entityCacheTtlMs` / `ENTITY_CACHE_TTL_MS`): a repeat query within the TTL makes 0 downstream calls
    - Candidate A3 -- Persisted-operation allowlist (`allowedOperations` / `ALLOWED_OPERATIONS_FILE`): only documents the operator migrated may execute; anything else is refused before parse with 0 downstream calls
    - Candidate B1 -- One 40 KB query freezes the whole gateway for about 7 s. Run the gateway's own linear depth/complexity rules first, and add a parser token cap, so a hostile document is refused in milliseconds.
    - Candidate B2 -- Every non-HTTP-status downstream failure reaches clients as an untyped `"Unexpected error."`. Give each failure class a typed code.
    - Candidate B3 -- No request-body size limit: a 100 MB POST is read whole into memory and answered 200. Add a byte cap with HTTP 413.
    winner: B1
    ship: PUSHED 438a39e
  iter-65
    lenses: narrative-and-docs
    - Candidate A1 -- README §7's "sample query costs 351" figure was never true (the benchmark query costs 356, the §3 sample costs 501), and test_iter59 pins the wrong literal. Derive the figure from a live run instead.
    - Candidate A2 -- The README claims, twice, that the gateway hides backend topology from edge clients, but every DOWNSTREAM_ERROR / DOWNSTREAM_TIMEOUT message names the downstream route, and a test pins that it does. Write down the real policy.
    - Candidate A3 -- README §6 Architecture omits the lookahead layer and the edge/budget responsibilities, and says "resolvers: one field -> one service call", which the `author`/`book` resolvers break. Re-draw the map and guard it against the file tree.
    - Candidate B1 -- HTTP request batching: a JSON array of operations in one POST shares one loader set, so N batched operations cost the downstream calls of one merged operation
    - Candidate B2 -- Persisted operations: automatic persisted queries (APQ hash → document) plus an opt-in allowlist mode that refuses unknown documents with a typed error and 0 downstream calls
    - Candidate B3 -- Edge correlation id: the gateway mints `x-request-id` when the caller sent none, echoes it on the response, and stamps it on every downstream REST call of that request
    winner: B1
    ship: PUSHED cd45511
  iter-64
    lenses: performance-and-throughput, narrative-and-docs
    - Candidate A1 -- Edge lookahead on `Book.author`: `book(id){ author{ books } }` starts the `books/by-author` batch alongside the author fetch (one serial hop removed, same call count)
    - Candidate A2 -- `close()` stops lingering: clear the drain bound timer and make a second `close()` share the first drain (library-script exit about 6.4 s → about 2.2 s; double-close 5 005 ms → 218 ms)
    - Candidate A3 -- Cut the QC suite critical path (about 14 s wall) by splitting `test_iter61_behavior.test.ts` (11.8 s, 14 tests) into 3–4 worker files, with zero assertion edits
    - Candidate B1 -- The README's "sample query costs 351" figure was never true (it is 356 for the benchmark query and 501 for the README/GraphiQL sample), and a test pins the wrong number. Derive the README cost figures from a live run instead.
    - Candidate B2 -- The README documents public API the package does not export (`NAIVE`/`BATCHED`/`LoaderOptions`, `requireAuth`), and a consumer who follows it silently gets batched mode
    - Candidate B3 -- "The cost model is a conservative upper bound" (README §7, §9, `complexity.ts:31`) is contradicted by the README's own budget section and by a two-query probe
    winner: B2
    ship: PUSHED 2950645
  iter-63
    lenses: simplification-and-deletion, performance-and-throughput
    - Candidate A1 -- One selection-set walk yields both cost and depth (delete depth-limit.ts's private walker and `measureDepth`)
    - Candidate A2 -- One `prefetchKey` helper and one `byIdLoader` factory (services.ts / loaders.ts)
    - Candidate A3 -- One in-flight tracker for `GatewayServer.close()`: a Set of pending requests replaces the counter + single `drainResolve` slot (and fixes the double-close stall it hides)
    - Candidate B1 -- Multi-root by-id lookahead: aliased `a: author(id) b: author(id)` / `author(id) + book(id)` operations start their child batches in tick 0 (one serial round trip removed, same call count)
    - Candidate B2 -- Opt-in cross-request in-flight coalescing of identical downstream GETs (`coalesceDownstream: true`), keyed by URL + forwarded headers
    - Candidate B3 -- Cut the QC suite's critical path from 15.5 s to about 6 s by splitting `test_iter61_behavior.test.ts` along its describe blocks (zero assertion edits)
    winner: B1
    ship: PUSHED 8ac7a2b
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
62 scouted iterations
