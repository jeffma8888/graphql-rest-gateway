# graphql-rest-gateway

> Schema-first GraphQL gateway that wraps REST backends and kills the N+1 problem with request-scoped DataLoader batching.

[![CI](https://github.com/jeffma8888/graphql-rest-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffma8888/graphql-rest-gateway/actions/workflows/ci.yml)
![tests](https://img.shields.io/badge/tests-513%20passing-brightgreen)
![coverage](https://img.shields.io/badge/coverage-~86%25%20lines-green)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

---

## 1. TL;DR

A production-shaped **GraphQL gateway** that fronts a REST backend. A client sends **one** nested query (authors -> their books -> each book's reviews) and the gateway resolves it against downstream REST endpoints **without** the N+1 call explosion, using **request-scoped DataLoaders** for batching + per-request caching. It ships with a benchmark that *proves* the fix (measured downstream call counts) and a regression test that fails if batching regresses.

```
                                    ┌─────────────────────────────────────────┐
                                    │             GraphQL Gateway              │
                                    │                                          │
  ┌────────┐   1 GraphQL query      │  resolvers ─▶ services ─▶ DataLoaders ─┐ │   batched REST calls   ┌──────────────┐
  │ client │ ────────────────────▶  │  (thin)       (business)  (per-request)│ │ ─────────────────────▶ │ REST backend │
  └────────┘   ◀────────────────────│                                        └─┼─▶ RestClient (counts)   │  (bundled)   │
                one JSON response    │  depth + complexity limiting on ingress  │   ◀─────────────────────│  + latency   │
                                    │  auth context per request                │    canned JSON          └──────────────┘
                                    └──────────────────────────────────────────┘
```

The REST backend is **bundled** (Fastify, canned JSON, artificial latency), so the whole thing boots in-process with `npm start` — no external accounts, no Docker required.

---

## 2. The problem it solves

**The N+1 problem.** Resolve `authors { books { reviews } }` naively and each level fans out: 1 call for the author list, then 1 call per author for their books, then 1 call per book for its reviews. For 5 authors x 3 books that's `1 + 5 + 15 = 21` downstream calls for a single client query. Add users and the downstream service melts.

**The fix.** [DataLoader](https://github.com/graphql/dataloader) coalesces all the per-key loads that happen within one tick of the event loop into a **single batched call**, and caches results for the life of the request. The same query drops to `1 + 1 + 1 = 3` downstream calls.

**The migration story (strangler fig).** This is the canonical "wrap a legacy REST service in a graph" pattern: you stand up a GraphQL layer in front of existing REST endpoints, move clients over query-by-query, and never expose the underlying fan-out to callers. The gateway owns batching, pagination shape, and access control; the REST services stay as-is.

---

## 3. Quickstart

```bash
npm install
npm start
# -> REST backend (bundled) boots on a random port
# -> GraphQL gateway + GraphiQL on http://localhost:4000/graphql
```

Open **http://localhost:4000/graphql** and run the sample query (it's pre-filled in GraphiQL):

```graphql
query Sample {
  authors(first: 5) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges {
      cursor
      node {
        id
        name
        books {
          id
          title
          reviews { id rating reviewer }
        }
      }
    }
  }
}
```

Other entry points:

| Command | What it does |
| --- | --- |
| `npm start` | GraphQL gateway (GraphiQL) in front of the bundled REST backend, or your own via `REST_BASE_URL` (see below) |
| `npm run backend` | Just the bundled REST backend (`REST_PORT`, `REST_LATENCY_MS`) |
| `npm run benchmark` | Prints the naive-vs-batched downstream call table (`--json` for machine-readable output, `--threshold N` exits 1 when factor < N) |
| `npm test` | Full test suite (unit + integration + N+1 regression) |
| `npm run coverage` | Tests with an istanbul coverage report |
| `npm run codegen` | Regenerate TS types from `schema.graphql` |
| `npm run build` | Type-check + emit to `dist/` |

> `reviewer` is redacted to `REDACTED` unless the request carries a bearer token with the `pii` scope. Send header `Authorization: Bearer user:42:pii` (see [Auth context](#auth-context)) to reveal it.

### Front your own REST service (`npm start` environment)

`npm start` boots the bundled demo backend unless `REST_BASE_URL` is set. In that case it fronts the service you already run, which is the strangler-fig on-ramp. Every variable is validated before anything listens. An invalid value exits 1 with a message naming the variable. Unset or empty means "use the default".

| Variable | Rule | Default |
| --- | --- | --- |
| `REST_BASE_URL` | absolute `http:`/`https:` URL of an external REST backend; may include a path prefix, no query string or fragment | unset → bundled backend |
| `PORT` | non-negative integer (`0` = random port) | `4000` |
| `REST_LATENCY_MS` | non-negative integer, bundled mode only (ignored with `REST_BASE_URL`) | `25` |
| `MAX_DEPTH` | positive integer → `maxDepth` | `10` |
| `MAX_COMPLEXITY` | positive integer → `maxComplexity` | `1000` |
| `DOWNSTREAM_TIMEOUT_MS` | positive integer → `downstreamTimeoutMs` | `30000` |
| `MAX_DOWNSTREAM_CALLS` | positive integer → `maxDownstreamCalls` | unset → unlimited |
| `FORWARD_HEADERS` | comma-separated header names → `forwardHeaders` (whitespace trimmed, empty entries ignored) | unset → forward nothing |

Two-terminal example (the backend runs in its own process, and the gateway fronts it):

```bash
# terminal 1
npm run backend
# terminal 2
REST_BASE_URL=http://127.0.0.1:4001 npm start
# -> REST backend (external): http://127.0.0.1:4001
# -> GraphQL gateway + GraphiQL: http://localhost:4000/graphql
# limits combine the same way: MAX_COMPLEXITY=500 REST_BASE_URL=http://127.0.0.1:4001 npm start
```

> **Shutdown.** On SIGTERM/SIGINT, `npm start` stops new work at once: any request that still reaches it gets `503` with `connection: close`, and the port stops accepting connections. In-flight requests drain (bounded at 5 s). Then the remaining sockets, including idle keep-alive ones, are closed and the process exits 0, so a load balancer's reused connections cannot hold shutdown open.

> An external backend must serve the same REST routes as the bundled one (`/authors`, `/authors/by-ids`, `/books/by-author`, `/books/by-ids`, `/reviews/by-book`). The gateway's resolvers are written against that contract. A path prefix in `REST_BASE_URL` is honoured: `REST_BASE_URL=http://127.0.0.1:4001/api/v1` calls `/api/v1/authors`, `/api/v1/books/by-author`, and so on (trailing slashes are ignored). A query string or fragment in `REST_BASE_URL` is rejected at startup.

### Programmatic usage

The package exports a library entry point so you can embed the gateway in your own server. The built package (`npm run build`, run automatically by `npm pack`) is verified by importing it by name from plain Node ESM and from a NodeNext TypeScript consumer, with real types and `schema.graphql` found at the package root:

```ts
import { createGateway, buildBackend } from 'graphql-rest-gateway';

// Boot the bundled REST backend (or point to your own)
const { app } = buildBackend({ latencyMs: 0 });
const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

// Create a gateway (returns { yoga, fetch, close })
const gateway = createGateway({ restBaseUrl: baseUrl });

// Use gateway.fetch() directly or mount gateway.yoga on any Node HTTP server.
// A raw gateway.yoga mount bypasses the shutdown drain; for drain-aware embedding
// (503 after close(), in-flight requests counted), serve every request through gateway.fetch.
const res = await gateway.fetch('http://localhost/graphql', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: '{ authors(first: 5) { edges { node { id name } } } }' }),
});

// Health check (short-circuits before GraphQL parsing)
const health = await gateway.fetch('http://localhost/healthz');
// -> 200 { "status": "ok" }

// Graceful shutdown (drains in-flight requests, then resolves)
await gateway.close();
```

#### Options reference

**`GatewayOptions`** — passed to `createGateway(opts)`:

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `restBaseUrl` | `string` | *(required)* | Base URL of the downstream REST backend; a path prefix such as `/api/v1` is kept; a query string or fragment is ignored |
| `maxDepth` | `number` | `10` | Maximum allowed query nesting depth |
| `maxComplexity` | `number` | `1000` | Maximum allowed query cost (field-count × fan-out) |
| `loaderOptions` | `LoaderOptions` | `BATCHED` | DataLoader batching/caching mode (`BATCHED` or `NAIVE`) |
| `downstreamTimeoutMs` | `number` | `30000` | Per-call timeout for downstream REST requests (ms) |
| `maxDownstreamCalls` | `number` | unlimited | Per-request cap on downstream REST calls sent; a call past it fails with `DOWNSTREAM_BUDGET_EXCEEDED` (positive integer, else `RangeError`) |
| `forwardHeaders` | `readonly string[]` | `[]` (none) | Edge request headers (case-insensitive) copied onto every downstream REST call of the same request, e.g. `['authorization', 'x-request-id']`; invalid or hop-by-hop names throw |

**`BackendOptions`** — passed to `buildBackend(opts)`:

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `latencyMs` | `number` | `10` | Artificial latency added to every data request (ms) |
| `forceCloseConnections` | `boolean` | `false` | Destroy idle keep-alive sockets on close instead of waiting for timeout |

Exported symbols: `createGateway`, `GatewayOptions`, `GatewayServer`, `createContext`, `parseAuth`, `GatewayContext`, `AuthContext`, `buildBackend`, `BackendOptions`, `schema`.

---

## 4. The N+1 result

Same query, same backend, resolved two ways. Numbers below are from a real `npm run benchmark` run (5 authors x 3 books x 2 reviews; artificial latency set to 0 to isolate the **call count**, which is the honest N+1 signal — see the note under the table).

| Downstream endpoint | Naive (N+1) | Batched (DataLoader) |
| --- | ---: | ---: |
| `/authors` | 1 | 1 |
| `/books/by-author` | 5 | 1 |
| `/reviews/by-book` | 15 | 1 |
| **Total** | **21** | **3** |

**➡ 7.0x fewer downstream calls (21 → 3).**

```
$ npm run benchmark

Downstream REST calls for the sample nested query (5 authors x 3 books x 2 reviews):

  Endpoint                 Naive (N+1)  Batched (DataLoader)
  /authors                           1                     1
  /books/by-author                   5                     1
  /reviews/by-book                  15                     1
  TOTAL                             21                     3

  => 7.0x fewer downstream calls (21 -> 3).
  Wall-clock: naive 32.0ms vs batched 2.4ms
```

> **Why call count, not wall-clock, is the headline.** GraphQL resolves sibling fields concurrently, so a naive gateway fires its N book-calls in parallel — wall-clock can hide the damage on a fast localhost backend. The real cost of N+1 is *load on the downstream service* (connection-pool pressure, rate limits, DB round-trips), which is exactly what the call count measures. The wall-clock delta here is real but secondary and sensitive to warm-up ordering.

The exact counts are pinned by a [regression test](#8-testing) so this claim can't silently rot.

---

## 5. Schema-first design

[`schema.graphql`](./schema.graphql) is the **single source of truth**. The TypeScript resolver types in `src/generated/graphql.ts` are *generated from it* by [GraphQL Code Generator](https://the-guild.dev/graphql/codegen) (`npm run codegen`, config in [`codegen.ts`](./codegen.ts)) — the SDL leads, the code follows.

The generated resolver map uses **mappers**: resolver *parent* types are the raw REST rows (`AuthorRow`, `BookRow`, `ReviewRow`), not the GraphQL output types. That's the idiomatic "wrap REST behind a graph" pattern — resolvers type-check against the downstream data model, and scalar fields fall through to GraphQL's default field resolver so only the graph edges need explicit resolvers.

CI runs `codegen` and `git diff --exit-code` to guarantee the committed types never drift from the SDL.

---

## 6. Architecture

```
Query / field
   │
   ▼
resolvers.ts        thin: one field -> one service call. No fetch/URL logic.
   │
   ▼
services.ts         business seam: chooses a batched loader (per-key) vs a
   │                datasource (list/pagination) call.
   ├────────────▶ loaders.ts          request-scoped DataLoaders (batch + cache)
   │                    │
   ▼                    ▼
datasources/*       the ONLY layer that knows downstream URL shapes
   │
   ▼
rest-client.ts      one HTTP call per invocation; counts calls (the instrument
   │                behind the benchmark + regression test)
   ▼
Fastify REST backend (bundled, canned JSON, artificial latency)
```

**Where DataLoader lives and why it's request-scoped.** Loaders are built fresh inside `createContext` on **every request** (`src/gateway/context.ts` -> `buildLoaders`). This is deliberate and it's the classic senior footgun if you get it wrong: a DataLoader carries a per-instance cache, so a **module-level / shared** loader would (a) leak one user's data into another user's response and (b) serve stale rows forever. Request scoping bounds both the cache and the batch window to a single operation.

The `LoaderOptions` flag is what powers the benchmark: `BATCHED = { batch: true, cache: true }` collapses keys in a tick into one call; `NAIVE = { batch: false, cache: false }` makes DataLoader call the batch function once per key, faithfully reproducing the N+1 explosion so we can measure it.

**Lookahead prefetch on by-id roots.** `Author.books` only needs `author.id` and `Book.reviews` only needs `book.id`. On a root `author(id:)` or `book(id:)` that key is already known from `args.id`, so the gateway starts the child's batched load in the same tick as the root fetch instead of one round trip later (`src/gateway/lookahead.ts`). The call count is unchanged, but there is one less serial hop: `author(id){ books{ reviews } }` waits for 2 serial round trips instead of 3, and `book(id){ reviews }` waits for 1 instead of 2. The rule is deliberately conservative. It only fires when that field is the operation's **sole root field**, because a sibling root, or a root-level fragment, could reach the same loader later and an early dispatch would split its batch. It never fires for a child excluded by `@skip`/`@include`, and it never fires when the loader cache is off (`NAIVE` or `cache: false`). The one cost: a by-id root whose id does not exist still spends the speculative call, so `author(id:"missing"){ books{...} }` makes 2 downstream calls instead of 1. The NOT_FOUND error is unchanged. A failing child route is still called only once: if the speculative load rejects, the error is re-primed into the loader cache (DataLoader clears failed keys), so the child resolver reuses that rejection instead of re-issuing the call.

---

## 7. Senior-concern coverage

### Cursor pagination (Relay)
`Query.authors` is a Relay connection: `edges { node cursor }`, `pageInfo { hasNextPage hasPreviousPage startCursor endCursor }`, `totalCount`. Cursors are **opaque** (base64 of an offset) so clients can't parse them — which lets the implementation swap offset for a keyset/seek cursor later without a breaking change. `after: endCursor` pages forward cleanly (verified in the integration test). Malformed or out-of-range cursors surface a typed error (`extensions.code = BAD_CURSOR`). See `src/gateway/pagination/relay.ts`.

### Query depth + complexity limiting
Two custom GraphQL **validation rules** run before execution (`src/gateway/security/`):
- **Depth limit** rejects queries nested beyond `maxDepth` (default 10). Follows fragment spreads; ignores introspection meta-fields so GraphiQL keeps working.
- **Complexity/cost limit** rejects shallow-but-wide queries (`authors(first: 10000)`). Each field costs 1; list fields multiply their subtree by an estimated fan-out (`first`/`last` when present, else a default). Relay wrappers (`edges`/`nodes`/`pageInfo`) get a multiplier of 1 to avoid double-counting the connection's `first`. It's a conservative upper bound — exactly what you want for admission control.
  - `first`/`last` supplied as **variables** (`authors(first: $n)`) are counted with their **runtime values** (falling back to the operation's variable default; an omitted or `null` variable counts like an omitted argument). Validation rules can't see variable values, so for variable-dependent operations the same check runs at the start of execution, before any resolver or downstream call, and rejects with the identical `QUERY_TOO_COMPLEX` error. Multi-operation documents are likewise costed at execute time, against the operation selected by `operationName` only. Negative `first`/`last` values (literal or variable) count as **0**, so an alias such as `authors(first: -1000)` can't drive the total cost negative.

Both surface a typed error (`extensions.code = QUERY_TOO_DEEP` / `QUERY_TOO_COMPLEX`) and are covered by unit + HTTP integration tests.

### Partial errors & null propagation
Root-level `Query.author` and `Query.book` return structured NOT_FOUND errors when the requested id does not exist: `data.author: null` (or `data.book: null`) plus an entry in `errors[]` with `extensions: { code: "NOT_FOUND", id: "<requested-id>" }`, letting clients correlate exactly which entity was missing. Back-edge resolvers (`Book.author`, `Review.book`) follow the same pattern for non-null fields — a missing referenced entity throws a `GraphQLError` (`code: NOT_FOUND`), which triggers GraphQL's standard null-propagation: the error surfaces in `errors[]` and null bubbles to the nearest nullable parent rather than corrupting the response. DataLoaders return `null` for a missing single-entity key (never throw at the batch level), so a bad id degrades gracefully.

### Downstream timeout
Every outbound REST call is guarded by a per-request deadline (`downstreamTimeoutMs`, default 30 s). If the downstream service does not respond in time, the call aborts and the resolver surfaces a typed error (`extensions.code = DOWNSTREAM_TIMEOUT`). Configure the timeout via the `downstreamTimeoutMs` option in `createGateway` / `createContext`.

### Downstream call budget
`maxDownstreamCalls` (env `MAX_DOWNSTREAM_CALLS`, unset = unlimited) is a hard per-request ceiling on the downstream REST calls the gateway actually sends. Once a request has sent that many, any further call is refused **before** it leaves the gateway: the resolver gets a typed error with `extensions.code = DOWNSTREAM_BUDGET_EXCEEDED` and `extensions.budget` set to the configured number, and normal null propagation applies. Calls already in flight are not aborted. The budget is per request, so concurrent requests never share it, and it counts every path: batched loaders, naive loaders, list pages and lookahead prefetch. A speculative lookahead prefetch is counted when it is sent, so under a very tight budget it can take a slot before its root by-id fetch (the root then fails with `DOWNSTREAM_BUDGET_EXCEEDED` rather than `NOT_FOUND`). The refusal message names only the budget, never the downstream route.

WHY it complements `maxComplexity`: the cost model is an estimate of response size, not of downstream fan-out. List pages are not batched, so 100 aliases of `authors(first: 0, after: "<distinct cursor>") { totalCount }` cost only **100** yet make **100** downstream calls, while the legitimate nested sample query costs **351** and makes just **3**. No complexity limit can stop the first without rejecting the second; a cap on the *measured* call count can. Validation-time `maxComplexity` still rejects oversized queries before any call is made. The budget is the backstop for whatever shape gets through.

### Forwarding edge headers downstream
A legacy REST service usually authorizes each request itself and correlates logs by request id, so the gateway can pass selected caller headers through: `forwardHeaders: ['authorization', 'x-request-id']` (env `FORWARD_HEADERS=authorization,x-request-id`). Forwarding is opt-in and allowlist-only: nothing is forwarded by default, only the listed names (matched case-insensitively) are copied, and a header the caller did not send is not sent. Values are taken from each edge request, so one caller's token never reaches another caller's downstream calls; every path (batched, naive, list pages, lookahead prefetch) carries them. Forwarded credentials are sent to the configured downstream host (`restBaseUrl` / `REST_BASE_URL`), so only list headers that host is meant to see. Hop-by-hop and framing names (`host`, `connection`, `content-length`, `transfer-encoding`, `keep-alive`, `upgrade`, `te`, `trailer`, `proxy-connection`), `expect` (Node's fetch refuses it, so every downstream call would fail) and names that are not valid HTTP tokens are rejected at startup.

### Downstream error
When the downstream REST backend returns a non-OK HTTP status (e.g. 500, 404), the gateway surfaces a typed error (`extensions.code = DOWNSTREAM_ERROR`) with `extensions.status` carrying the HTTP status code. The error message includes the status, status text, and the failed path, letting clients distinguish "the backend returned an error" from "the query itself was invalid."

### Query complexity metrics
Every successful response includes `extensions.queryComplexity` with numeric `cost` and `depth` fields — the same values the depth and complexity validation rules compute. Integrators can observe real traffic to tune `maxDepth`/`maxComplexity`, alert on creeping cost before clients trip the hard limit, and prove exactly what each query costs. When a query is rejected by the validation rules (`QUERY_TOO_DEEP` / `QUERY_TOO_COMPLEX`), the `queryComplexity` extension is **not** injected — the rejection error already carries the relevant numbers.

### Downstream call metrics
Every executed response also includes `extensions.downstreamCalls` with a single `total` field: the exact number of downstream REST calls **this request** sent (including any that failed or timed out; calls refused by the [downstream call budget](#downstream-call-budget) are not counted), read from the request-scoped `RestClient` counter. It sits next to `queryComplexity`, so the cost estimate and the measured cost appear together: the nested sample query reports `{ "total": 3 }` with batching and `21` with naive loaders. The count is per request, not cumulative, and concurrent requests never share it. Partial-error responses still carry it. Queries rejected by validation (`QUERY_TOO_DEEP` / `QUERY_TOO_COMPLEX`) make no downstream calls and do **not** get the extension. A per-path breakdown is deliberately left out so backend topology is not exposed to edge clients.

### <a name="auth-context"></a>Auth context
A bearer token is parsed per request and threaded through `context.auth` (`parseAuth` in `src/gateway/context.ts`). A stub token format `user:<id>:<scope,scope>` demonstrates the pattern without pulling in an auth vendor; swap `parseAuth` for real JWT verification in production. `Review.reviewer` is treated as PII and redacted to `REDACTED` unless the caller is both authenticated **and** carries the `pii` scope — a concrete, tested example of scope-based field authorization. A `requireAuth(ctx)` guard helper is provided for fields that should hard-fail without a token; unauthenticated callers receive a typed error (`extensions.code = UNAUTHENTICATED`).

### Observability
The `RestClient` and the REST backend both count calls; the backend exposes `GET /__stats` and `POST /__stats/reset`. The per-request gateway count is surfaced to clients as [`extensions.downstreamCalls`](#downstream-call-metrics). This is the seam an OpenTelemetry span exporter would hook into (see [what's next](#10-what-id-do-next-in-production)).

---

## 8. Testing

`npm test` — 513 tests across 33 files (Vitest), all green:

- **Unit** — DataLoader batching/grouping/caching (`loaders.test.ts`), Relay cursor round-trip + pageInfo (`pagination.test.ts`), depth/complexity rules (`security.test.ts`), auth parsing + redaction (`auth.test.ts`).
- **Integration** — full request through the real Yoga HTTP handler (`integration.test.ts`): nested query, cursor pagination across pages, depth rejection, complexity rejection, auth redaction.
- **Library entry** — imports from the barrel (`lib-entry.test.ts`), boots a gateway against the bundled backend, and asserts a successful query round-trip.
- **Built package** (`test_iter62_behavior.test.ts`) — builds with `tsconfig.build.json` into a temp dir, imports the package by name from plain Node ESM (no loader), and type-checks a NodeNext consumer that must reject a wrong-typed `GatewayOptions`.
- **The N+1 regression test** (`n-plus-1.test.ts`) — the most important artifact. It runs the same query in naive vs batched mode against the real backend and asserts the **exact** downstream call counts:

```ts
// naive: 1 (authors) + 5 (books, one per author) + 15 (reviews, one per book) = 21
// batched: 1 + 1 + 1 = 3
expect(batched.byPath['/books/by-author']).toBe(1);
expect(batched.total).toBe(3);
expect(batched.data).toEqual(naive.data); // identical results, fewer calls
```

If someone deletes a loader or sneaks a fetch into a resolver, the batched count blows up and this test fails.

Coverage (`npm run coverage`, istanbul): **~84% statements / ~86% lines / ~89% functions**. Uncovered lines are mostly defensive error branches.

> Test infra note: `graphql` must be a single module instance or you get `Cannot use GraphQLSchema from another module or realm`. `vitest.config.ts` dedupes `graphql` and inlines the graphql/envelop/graphql-tools chain so Vite doesn't split it across ESM/CJS realms.

---

## 9. Design decisions & trade-offs

- **Why TypeScript.** DataLoader was invented at Facebook for exactly this problem, so the canonical reference implementation lives in the JS/TS ecosystem — the N+1/batching narrative is cleanest and fastest to build here. The same batching pattern maps directly to **Spring for GraphQL** (`BatchLoaderRegistry`) or **Netflix DGS** (`@DgsDataLoader`); the concept transfers, only the annotations change.
- **Why GraphQL Yoga (over Apollo Server).** Yoga is lighter, ships GraphiQL, and its envelop plugin system made wiring the custom validation rules a two-line `onValidate` hook. Apollo Server 4 would be an equally valid choice and is more "enterprise-recognizable"; the resolver/service/datasource layering here is server-agnostic.
- **Why a bundled REST backend (over a public API).** Determinism. Controlling the data lets the benchmark and regression test assert *exact* call counts, and reviewers can run everything with zero external accounts.
- **Custom depth/complexity rules (over a library).** They're small, dependency-free, and demonstrate understanding of the validation phase — more defensible in an interview than importing a black box. The cost model is intentionally a conservative upper bound.
- **Offset-backed opaque cursors.** Simple and correct for this dataset; opaqueness preserves the freedom to move to keyset pagination later without breaking clients.

---

## 10. What I'd do next in production

- **Apollo Federation / schema stitching** — split the graph into subgraphs owned by different teams as the REST estate grows.
- **A response/entity cache** — layer a shared cache (Redis) *behind* the request-scoped loaders with explicit TTLs + invalidation, keeping the per-request cache for dedup and the shared cache for cross-request reuse.
- **Schema registry + checks** — publish the SDL to a registry and run breaking-change checks in CI against live operation traffic.
- **OpenTelemetry tracing** — spans per resolver + per downstream call (the `/__stats` counter is the placeholder seam), exported to a collector for latency attribution.
- **Persisted queries + APQ** — allowlist known operations to shrink payloads and shut down arbitrary-query DoS.
- **Real auth** — replace the stub bearer parser with JWT/JWKS verification (scope-based field authorization is already demonstrated on `Review.reviewer`).

---

## License

[MIT](./LICENSE) © jeffma8888
