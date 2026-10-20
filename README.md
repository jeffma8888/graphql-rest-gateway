# graphql-rest-gateway

> Schema-first GraphQL gateway that wraps REST backends and kills the N+1 problem with request-scoped DataLoader batching.

[![CI](https://github.com/jeffma8888/graphql-rest-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffma8888/graphql-rest-gateway/actions/workflows/ci.yml)
![tests](https://img.shields.io/badge/tests-156%20passing-brightgreen)
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
| `npm start` | REST backend + GraphQL gateway in one process (GraphiQL) |
| `npm run backend` | Just the bundled REST backend (`REST_PORT`, `REST_LATENCY_MS`) |
| `npm run benchmark` | Prints the naive-vs-batched downstream call table |
| `npm test` | Full test suite (unit + integration + N+1 regression) |
| `npm run coverage` | Tests with an istanbul coverage report |
| `npm run codegen` | Regenerate TS types from `schema.graphql` |
| `npm run build` | Type-check + emit to `dist/` |

> `reviewer` is redacted to `REDACTED` unless the request carries a valid bearer token. Send header `Authorization: Bearer user:42` (see [Auth context](#auth-context)) to reveal it.

### Programmatic usage

The package exports a library entry point so you can embed the gateway in your own server:

```ts
import { createGateway, buildBackend } from 'graphql-rest-gateway';

// Boot the bundled REST backend (or point to your own)
const { app } = buildBackend({ latencyMs: 0 });
const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

// Create a gateway (returns { yoga, fetch, close })
const gateway = createGateway({ restBaseUrl: baseUrl });

// Use gateway.fetch() directly or mount gateway.yoga on any Node HTTP server
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

Exported symbols: `createGateway`, `GatewayOptions`, `GatewayServer`, `createContext`, `parseAuth`, `GatewayContext`, `AuthContext`, `buildBackend`, `schema`.

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

---

## 7. Senior-concern coverage

### Cursor pagination (Relay)
`Query.authors` is a Relay connection: `edges { node cursor }`, `pageInfo { hasNextPage hasPreviousPage startCursor endCursor }`, `totalCount`. Cursors are **opaque** (base64 of an offset) so clients can't parse them — which lets the implementation swap offset for a keyset/seek cursor later without a breaking change. `after: endCursor` pages forward cleanly (verified in the integration test). See `src/gateway/pagination/relay.ts`.

### Query depth + complexity limiting
Two custom GraphQL **validation rules** run before execution (`src/gateway/security/`):
- **Depth limit** rejects queries nested beyond `maxDepth` (default 10). Follows fragment spreads; ignores introspection meta-fields so GraphiQL keeps working.
- **Complexity/cost limit** rejects shallow-but-wide queries (`authors(first: 10000)`). Each field costs 1; list fields multiply their subtree by an estimated fan-out (`first`/`last` when present, else a default). Relay wrappers (`edges`/`nodes`/`pageInfo`) get a multiplier of 1 to avoid double-counting the connection's `first`. It's a conservative upper bound — exactly what you want for admission control.

Both surface a typed error (`extensions.code = QUERY_TOO_DEEP` / `QUERY_TOO_COMPLEX`) and are covered by unit + HTTP integration tests.

### Partial errors & null propagation
Root-level `Query.author` and `Query.book` return structured NOT_FOUND errors when the requested id does not exist: `data.author: null` (or `data.book: null`) plus an entry in `errors[]` with `extensions: { code: "NOT_FOUND", id: "<requested-id>" }`, letting clients correlate exactly which entity was missing. Back-edge resolvers (`Book.author`, `Review.book`) follow the same pattern for non-null fields — a missing referenced entity throws a `GraphQLError` (`code: NOT_FOUND`), which triggers GraphQL's standard null-propagation: the error surfaces in `errors[]` and null bubbles to the nearest nullable parent rather than corrupting the response. DataLoaders return `null` for a missing single-entity key (never throw at the batch level), so a bad id degrades gracefully.

### <a name="auth-context"></a>Auth context
A bearer token is parsed per request and threaded through `context.auth` (`parseAuth` in `src/gateway/context.ts`). A stub token format `user:<id>:<scope,scope>` demonstrates the pattern without pulling in an auth vendor; swap `parseAuth` for real JWT verification in production. `Review.reviewer` is treated as PII and redacted to `REDACTED` for anonymous callers, revealed for authenticated ones — a concrete, tested example of context-based authorization. A `requireAuth(ctx)` guard helper is provided for fields that should hard-fail without a token.

### Observability
The `RestClient` and the REST backend both count calls; the backend exposes `GET /__stats` and `POST /__stats/reset`. This is the seam an OpenTelemetry span exporter would hook into (see [what's next](#10-what-id-do-next-in-production)).

---

## 8. Testing

`npm test` — 156 tests across 16 files (Vitest), all green:

- **Unit** — DataLoader batching/grouping/caching (`loaders.test.ts`), Relay cursor round-trip + pageInfo (`pagination.test.ts`), depth/complexity rules (`security.test.ts`), auth parsing + redaction (`auth.test.ts`).
- **Integration** — full request through the real Yoga HTTP handler (`integration.test.ts`): nested query, cursor pagination across pages, depth rejection, complexity rejection, auth redaction.
- **Library entry** — imports from the barrel (`lib-entry.test.ts`), boots a gateway against the bundled backend, and asserts a successful query round-trip.
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
- **Real auth** — replace the stub bearer parser with JWT/JWKS verification and scope-based field authorization.

---

## License

[MIT](./LICENSE) © jeffma8888
