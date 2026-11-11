# graphql-rest-gateway

> Schema-first GraphQL gateway that wraps REST backends and kills the N+1 problem with request-scoped DataLoader batching.

[![CI](https://github.com/jeffma8888/graphql-rest-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffma8888/graphql-rest-gateway/actions/workflows/ci.yml)
![tests](https://img.shields.io/badge/tests-1276%20passing-brightgreen)
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
| `npm run check-backend` | Pre-flight: checks `REST_BASE_URL` (or the bundled backend) against the REST contract, PASS/FAIL per route (`--json`; exit 0/1/2) |
| `npm run benchmark` | Prints the naive-vs-batched downstream call table (`--json` for machine-readable output, `--threshold N` exits 1 when factor < N) |
| `npm test` | Full test suite (unit + integration + N+1 regression) |
| `npm run coverage` | Tests with an istanbul coverage report |
| `npm run codegen` | Regenerate TS types from `schema.graphql` |
| `npm run build` | Type-check + emit to `dist/` |

> `reviewer` is redacted to `REDACTED` unless the request carries a bearer token with the `pii` scope. Send header `Authorization: Bearer user:42:pii` (see [Auth context](#auth-context)) to reveal it.

**Installed from npm.** The package ships two commands, so you can run the gateway and its pre-flight check without a clone. `npx graphql-rest-gateway` is `npm start`, and `npx graphql-rest-gateway-check-backend` is `npm run check-backend` (same `--json` flag and exit codes 0/1/2). The gateway takes no arguments: it is configured with the same environment variables as `npm start` (see the table below), and any argument, `--help` included, exits 2 without starting anything. Install first (the block's first line): without a local install, npx looks `graphql-rest-gateway-check-backend` up as a registry package name, so the one-shot form is `npx -p graphql-rest-gateway graphql-rest-gateway-check-backend`.

```bash
npm install graphql-rest-gateway
REST_BASE_URL=http://127.0.0.1:4001 npx graphql-rest-gateway-check-backend
REST_BASE_URL=http://127.0.0.1:4001 npx graphql-rest-gateway
# -> REST backend (external): http://127.0.0.1:4001
# -> GraphQL gateway + GraphiQL: http://localhost:4000/graphql
```

### Front your own REST service (`npm start` environment)

`npm start` boots the bundled demo backend unless `REST_BASE_URL` is set. In that case it fronts the service you already run, which is the strangler-fig on-ramp. Every variable is validated before anything listens. An invalid value exits 1 with a message naming the variable. Unset or empty means "use the default".

| Variable | Rule | Default |
| --- | --- | --- |
| `REST_BASE_URL` | absolute `http:`/`https:` URL of an external REST backend; may include a path prefix, no query string or fragment | unset → bundled backend |
| `PORT` | non-negative integer (`0` = random port) | `4000` |
| `REST_LATENCY_MS` | non-negative integer, bundled mode only (ignored with `REST_BASE_URL`) | `25` |
| `MAX_DEPTH` | positive integer → `maxDepth` | `10` |
| `MAX_COMPLEXITY` | positive integer → `maxComplexity` | `1000` |
| `DOWNSTREAM_TIMEOUT_MS` | positive integer ≤ 2147483647 → `downstreamTimeoutMs` | `30000` |
| `MAX_DOWNSTREAM_CALLS` | positive integer → `maxDownstreamCalls` | unset → unlimited |
| `FORWARD_HEADERS` | comma-separated header names → `forwardHeaders` (whitespace trimmed, empty entries ignored) | unset → forward nothing |
| `MAX_BATCH_SIZE` | positive integer → `maxBatchSize` | unset → batching off |

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

> **Probes.** Point the load balancer's liveness check at `GET /healthz` (always `200` while the process serves) and its readiness check at `GET /readyz`, which answers `503` with a typed `code` while `REST_BASE_URL` is unreachable, erroring or off-contract. `npm start` boots even when the backend is down, so `/readyz` is what keeps traffic away until it is up. See [Readiness probe](#readiness-probe).

> **Shutdown.** On SIGTERM/SIGINT, `npm start` stops new work at once: any request that still reaches it gets `503` with `connection: close`, and the port stops accepting connections. In-flight requests drain (bounded at 5 s). Then the remaining sockets, including idle keep-alive ones, are closed and the process exits 0, so a load balancer's reused connections cannot hold shutdown open.

> An external backend must serve the same REST routes as the bundled one (`/authors`, `/authors/by-ids`, `/books/by-author`, `/books/by-ids`, `/reviews/by-book`). The gateway's resolvers are written against that contract. A path prefix in `REST_BASE_URL` is honoured: `REST_BASE_URL=http://127.0.0.1:4001/api/v1` calls `/api/v1/authors`, `/api/v1/books/by-author`, and so on (trailing slashes are ignored). A query string or fragment in `REST_BASE_URL` is rejected at startup.

**Check your backend first: `npm run check-backend`.** At runtime the gateway refuses a 2xx body with the wrong shape or a missing or mistyped row field (for example `/books/by-author` rows keyed `author_id` instead of `authorId`) as `DOWNSTREAM_BAD_RESPONSE`, but only once a client query hits it. It does not check join keys or ids: rows keyed to an author that was not requested give that author `books: []` with no error, and a by-id answer missing the requested row gives a false `NOT_FOUND`. The check calls each of the 5 routes once, on `REST_BASE_URL` (path prefix honoured exactly as the gateway joins it) or on the bundled backend when it is unset. Each call is seeded from the previous answer: `/authors?offset=0&limit=10`, then the first author by id, the books of all returned authors, the first book by id, and the reviews of all returned books. It verifies the response shape, every row field and its JSON type (`id`, `name`, `bio`; `id`, `authorId`, `title`, `year`; `id`, `bookId`, `body`, `reviewer`, `rating`), the join keys, and that by-id lookups return the requested id. It names the first wrong field per route:

```bash
REST_BASE_URL=http://127.0.0.1:4001/api/v1 npm run check-backend
# Checking http://127.0.0.1:4001/api/v1 -- REST_BASE_URL
# PASS /authors
# PASS /authors/by-ids
# FAIL /books/by-author -- row 0: field "authorId" is missing (found "author_id"; the contract uses camelCase)
# FAIL /books/by-ids -- skipped: needs a passing /books/by-author
# FAIL /reviews/by-book -- skipped: needs a passing /books/by-author
# 2/5 routes match the REST contract
```

Exit codes: `0` when all 5 routes pass, `1` on any mismatch (including an unreachable backend, a non-2xx status or a non-JSON body), and `2` on a configuration error. A configuration error is an invalid `REST_BASE_URL` (the same message `npm start` gives) or an unknown argument, and no request is made. `--json` prints one document instead, `{ baseUrl, backend: "bundled" | "external", ok, routes: [{ route, ok, problem }] }`, with the same exit code. An empty `/reviews/by-book` list passes, because reviews are the leaf. Empty authors or books fail, because the later routes need ids to check. The check makes read-only `GET`s with a fixed 5 s timeout per call. It does not check pagination semantics, extra fields, or auth headers.

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

// Readiness check: one downstream GET /authors?offset=0&limit=1 (see "Readiness probe" in §7)
const ready = await gateway.fetch('http://localhost/readyz');
// -> 200 { "status": "ready" }, or 503 { "status": "unready", "code": "DOWNSTREAM_UNREACHABLE" | ... }

// Graceful shutdown (drains in-flight requests, then resolves)
await gateway.close();
```

#### Options reference

**`GatewayOptions`** — passed to `createGateway(opts)`:

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `restBaseUrl` | `string` | *(required)* | Base URL of the downstream REST backend (absolute http(s) URL, else `TypeError`); a path prefix such as `/api/v1` is kept; a query string or fragment is ignored |
| `maxDepth` | `number` | `10` | Maximum allowed query nesting depth (positive integer, else `RangeError`) |
| `maxComplexity` | `number` | `1000` | Maximum allowed query cost (field-count × fan-out); positive integer, else `RangeError` |
| `loaderOptions` | `LoaderOptions` | `BATCHED` | DataLoader batching/caching mode; pass `BATCHED` or `NAIVE` (both frozen, importable from the package entry); `{ batch: boolean, cache: boolean }`, else `TypeError` |
| `downstreamTimeoutMs` | `number` | `30000` | Per-call timeout for downstream REST requests (ms) (positive integer, maximum 2147483647, else `RangeError`) |
| `maxDownstreamCalls` | `number` | unlimited | Per-request cap on downstream REST calls sent; a call past it fails with `DOWNSTREAM_BUDGET_EXCEEDED` (positive integer, else `RangeError`) |
| `forwardHeaders` | `readonly string[]` | `[]` (none) | Edge request headers (case-insensitive) copied onto every downstream REST call of the same request, e.g. `['authorization', 'x-request-id']`; invalid or hop-by-hop names throw |
| `maxBatchSize` | `number` | unset → batching off | Opt-in request batching: a POST whose JSON body is an array of up to this many operations is served as one batch sharing one loader set and one `maxDownstreamCalls` budget; a larger batch gets HTTP 413 (positive integer, else `RangeError`) |
| `onDownstreamCall` | `(event: DownstreamCallEvent) => void` | unset → no hook | Operator hook called once per downstream REST call sent, after it settles, with `{ route, status, durationMs, outcome, errorCode }`; never awaited, throws and rejections are swallowed (a function, else `TypeError`) |

`createGateway` validates the whole object synchronously, before anything is built: an unknown key throws `TypeError` with a did-you-mean hint (`maxComplexty` → `maxComplexity`), even when its value is `undefined`, and an explicit `undefined` value means omitted. Limits are unlimited only by omission (`maxDownstreamCalls`) or default (`maxDepth` 10, `maxComplexity` 1000); `NaN`/`Infinity` are rejected.

**`BackendOptions`** — passed to `buildBackend(opts)`:

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `latencyMs` | `number` | `10` | Artificial latency added to every data request (ms) |
| `forceCloseConnections` | `boolean` | `false` | Destroy idle keep-alive sockets on close instead of waiting for timeout |

Exported symbols: `createGateway`, `GatewayOptions`, `GatewayServer`, `createContext`, `parseAuth`, `GatewayContext`, `AuthContext`, `NAIVE`, `BATCHED`, `LoaderOptions`, `buildBackend`, `BackendOptions`, `schema`, `DownstreamCallEvent` (type).

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
resolvers.ts        thin: one field -> one service call, plus at most one lookahead
   │                prefetch (lookahead.ts). No fetch/URL logic.
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

The `LoaderOptions` flag is what powers the benchmark: `BATCHED = { batch: true, cache: true }` collapses keys in a tick into one call; `NAIVE = { batch: false, cache: false }` makes DataLoader call the batch function once per key, faithfully reproducing the N+1 explosion so we can measure it. Both constants (frozen) and the `LoaderOptions` type are importable from the package entry, so a library user can reproduce the comparison: with `import { createGateway, NAIVE } from 'graphql-rest-gateway'`, `createGateway({ restBaseUrl, loaderOptions: NAIVE })` makes 21 downstream calls for the benchmark query where the default makes 3.

**Lookahead prefetch on by-id roots.** `Author.books` only needs `author.id` and `Book.reviews` only needs `book.id`. On a root `author(id:)` or `book(id:)` that key is already known from `args.id`, so the gateway starts the child's batched load in the same tick as the root fetch instead of one round trip later (`src/gateway/lookahead.ts`). The call count is unchanged, but there is one less serial hop: `author(id){ books{ reviews } }` waits for 2 serial round trips instead of 3, and `book(id){ reviews }` waits for 1 instead of 2. The rule is deliberately conservative. It only fires when **every root selection is a by-id `author`/`book` field**, aliases included, so `{ a: author(id:"a1"){ books{...} } b: author(id:"a2"){ books{...} } }` sends both children's keys in one batch in the same tick as the roots: 2 calls, one serial hop less. Root fragments are flattened the way graphql-js executes them: a root fragment (named or inline, nested too) counts as the fields inside it, so `query { ...Q } fragment Q on Query { author(id:"a1"){ books{...} } }` prefetches exactly like the inline spelling, and a root `__typename` is ignored because it runs no resolver. A list root (`authors`) disables it for the whole operation, even when it is hidden in a root fragment, because such a root could reach the same loader a hop later and an early dispatch would split its batch; introspection roots such as `__schema` disable it too. An `authors` list root whose selection never selects `books` or `reviews` (fragments and `@skip`/`@include` honoured) cannot reach those loaders, so it keeps the prefetch: `{ author(id:"a1"){ books{ reviews{...} } } authors(first:3){ totalCount } }` waits for 2 serial round trips instead of 3 at the same 4 downstream calls. A `books(ids:)` bulk-lookup root turns the prefetch off for the whole operation too, so `{ one: book(id:"a3-b1"){ reviews{...} } books(ids:[...]){ reviews{...} } }` sends all three book ids in one `/books/by-ids` call and all three review keys in one `/reviews/by-book` call: 2 calls, never a split batch. A root fragment or list root excluded by `@skip`/`@include` does not count. It never fires for a child excluded by `@skip`/`@include`, and it never fires when the loader cache is off (`NAIVE` or `cache: false`). The one cost: a by-id root whose id does not exist still spends the speculative call, so `author(id:"missing"){ books{...} }` makes 2 downstream calls instead of 1. That cost is paid once per child route: `{ a: author(id:"missing"){ books{...} } b: book(id:"missing"){ reviews{...} } }` makes 4 calls instead of 2. The NOT_FOUND error is unchanged. A failing child route is still called only once: if the speculative load rejects, the error is re-primed into the loader cache (DataLoader clears failed keys), so the child resolver reuses that rejection instead of re-issuing the call. The same lookahead runs one level down on `Book.author`: `Author.books` needs `book.authorId`, which is already on the book row, so `book(id){ author{ books } }` starts the author's `/books/by-author` load in the same tick as its `/authors/by-ids` load. That is 3 downstream calls either way, but 2 serial round trips instead of 3. It uses the same every-root-is-by-id gate, honours `@skip`/`@include` and fragments under `author`, and is off when the loader cache is off. Its cost is the same speculative call: an orphan book whose author does not exist still spends one `/books/by-author` call before `Book.author` fails with NOT_FOUND, so `book(id){ author{ books{...} } }` on such a book makes 3 downstream calls instead of 2.

---

## 7. Senior-concern coverage

### Cursor pagination (Relay)
`Query.authors` is a Relay connection: `edges { node cursor }`, `pageInfo { hasNextPage hasPreviousPage startCursor endCursor }`, `totalCount`. Cursors are **opaque** (base64 of an offset) so clients can't parse them — which lets the implementation swap offset for a keyset/seek cursor later without a breaking change. `after: endCursor` pages forward cleanly (verified in the integration test). Malformed or out-of-range cursors surface a typed error (`extensions.code = BAD_CURSOR`). See `src/gateway/pagination/relay.ts`.

Paging works in both directions. `first`/`after` reads forward (`first` defaults to 10 when neither `first` nor `last` is given). `last`/`before` reads backward: `authors(last: 2)` is the tail of the list, and `authors(last: 2, before: startCursor)` is the previous page, so walking `before: startCursor` while `hasPreviousPage` is true visits every item exactly once. `after` and `before` together select a window, for example `authors(after: c1, before: c5)` returns the items strictly between those two cursors, and `first` or `last` then takes from its start or end. Passing `first` and `last` together is an error with `extensions.code = BAD_PAGINATION_ARGS`, raised before any downstream call. Any `before` costs 1 downstream call. `last` without `before` costs 1 call when the tail fits in the first page read, and 2 otherwise, because the REST contract has no count or tail route, so the gateway learns `totalCount` from one page and then reads the tail. Page sizes clamp to 0..100, and a 0 or negative `first`/`last` returns an empty page (`edges: []`, with `totalCount` still filled in). The gateway also truncates every page to its clamped size, rather than trusting the backend's `limit`.

**Nested lists take a plain `first` bound.** `Author.books(first: Int)` and `Book.reviews(first: Int)` return at most `first` items, in the order the backend returned them, for example `author(id: "a1") { books(first: 2) { id } }` for an author's first 2 books. The bound clamps to 0..100 like `authors`. A 0 or negative `first` returns `[]` with no error, and an omitted or null `first` returns the whole list. The slice happens after the one batched by-key call, so downstream call counts are unchanged, aliases with different bounds share that one call, and backend response bytes for `/books/by-author` and `/reviews/by-book` do not shrink. What shrinks is the response to the client, plus the grandchild keys: `books(first: 1) { reviews { id } }` asks `/reviews/by-book` only for the books that were kept. It is a bound, not a connection: there is no `after`, `pageInfo` or `totalCount` on nested lists. Admission cost counts `first` after the same 0..100 clamp, so the benchmark-shaped query `authors(first: 5)` with `books(first: 1) { id title reviews(first: 1) { id rating } }` is priced at 46 instead of 346, and `author(id: "a1") { books(first: 1000) { id } }` costs the same 102 as `books(first: 100)` and is admitted under the default `maxComplexity` of 1000. To get the whole list, omit `first`.

**Bulk lookup.** `books(ids: [ID!]!): [Book]!` hydrates a list of ids with one fixed document, so a client sends `query($ids:[ID!]!){ books(ids:$ids){ id title } }` for any id set instead of generating one aliased `book(id:)` root per id. The order of `ids` is kept and duplicates are repeated: `["a2-b1","a1-b1","nope","a2-b1"]` returns the a2-b1 row, the a1-b1 row, `null`, and the a2-b1 row again. An unknown id gives `null` at its index plus one `NOT_FOUND` error with `extensions.id` and `path: ["books", 2]`, and the other items keep their data. Every id goes through the batched `bookById` loader, so 15 ids cost 1 downstream call (one `/books/by-ids` holding the distinct ids), against 15 under NAIVE; children such as `reviews` and `author` stay batched (15 ids of `{ id reviews{ id } author{ name } }` make 3 calls). At most 100 ids are accepted: 101 ids fail with `extensions.code = BAD_ARGUMENT` (`argument: "ids"`, `max: 100`, `received: 101`) and `data: null`, and the oversized `books(ids:)` field itself makes 0 downstream calls (a sibling `book(id:)` root in the same operation still sends its own batched call before `data` is nulled). The complexity limiter prices it as `1 + n × subtree`, where n is the list length clamped to 0..100 (a literal list at validation, a variable per request), so 15 ids of `{ id title }` cost 31 and `[]` costs 1.

### Query depth + complexity limiting
Two custom GraphQL **validation rules** run before execution (`src/gateway/security/`):
- **Depth limit** rejects queries nested beyond `maxDepth` (default 10). Follows fragment spreads; ignores introspection meta-fields so GraphiQL keeps working.
- **Complexity/cost limit** rejects shallow-but-wide queries (`authors(first: 100) { edges { node { books { reviews { id } } } } }` is priced 3301). Each field costs 1; list fields multiply their subtree by an estimated fan-out (`first`/`last` when present, clamped to 0..100 exactly as the resolvers clamp them, else a default). A `first`/`last` above 100 is never priced above what the resolvers can return: `authors(first: 101)` and `authors(first: 1000)` cost the same 301 as `authors(first: 100)`. Relay wrappers (`edges`/`nodes`/`pageInfo`) get a multiplier of 1 to avoid double-counting the connection's `first`. The estimate is an upper bound only when every list field carries `first`/`last`. A nested `books` or `reviews` with no `first` is priced at the default fan-out of 5 but returns the whole list, so against a backend with 150 books per author `author(id: "a1") { books { id } }` costs 7 for 150 rows while `books(first: 100)` costs 102 for 100 rows. A root `authors` with no `first`/`last` is priced as one row although the page fetches up to 10, so `authors { edges { node { id } } }` costs 4 and `authors(first: 10) { edges { node { id } } }` costs 31 for the same data. Size `maxComplexity` for the bounded spellings, and do not rely on it to cap work for queries that omit `first`/`last`.
  - `first`/`last` supplied as **variables** (`authors(first: $n)`) are counted with their **runtime values** (falling back to the operation's variable default; an omitted or `null` variable counts like an omitted argument). Validation rules can't see variable values, so for variable-dependent operations the same check runs at the start of execution, before any resolver or downstream call, and rejects with the identical `QUERY_TOO_COMPLEX` error. Multi-operation documents are likewise costed at execute time, against the operation selected by `operationName` only. Negative `first`/`last` values (literal or variable) count as **0**, so an alias such as `authors(first: -1000)` can't drive the total cost negative.

Both surface a typed error (`extensions.code = QUERY_TOO_DEEP` / `QUERY_TOO_COMPLEX`) and are covered by unit + HTTP integration tests.

Admission runs cheapest check first, so a hostile document is refused quickly instead of stalling the event loop (and every concurrent caller) for seconds in graphql-js's own validation, some of whose specified rules are quadratic in repeated fields. The cap bounds that work rather than removing it: the worst accepted document observed under the cap spends about 150 ms in validation, while an oversized one is refused before validation starts:
- **Token cap.** A document of more than **2000** lexical tokens (names, punctuators, strings, numbers) is refused at parse time, before any validation, with `extensions.code = QUERY_TOO_LARGE` and `extensions.maxTokens = 2000`, and makes 0 downstream calls. Comments and whitespace are not counted. The cap is fixed and independent of `maxDepth`/`maxComplexity`; it applies to POST, GET and every element of a [batch](#request-batching). For scale, the 100-alias budget example below is about 1 400 tokens.
- **Gateway limits before spec rules.** The depth and complexity rules run on their own before graphql-js's specified validation rules. When they reject, only their errors are returned (`QUERY_TOO_DEEP` and `QUERY_TOO_COMPLEX` can appear together), with no `GRAPHQL_VALIDATION_FAILED` errors alongside. A document within the limits still gets full spec validation.
- **Each fragment walked once.** Cost and depth come from one selection walk that evaluates every named fragment at most once per walk and reuses that result for repeat spreads. A repeated spread still adds its cost (`query { ...A ...A }` costs twice `...A`), but walking does not multiply: a chain of 150 fragments that each spread the next one twice (`fragment Fi on Query { ...F(i+1) ...F(i+1) }`) is answered or refused in milliseconds instead of walking 2^150 nodes (the walk is linear in the document, which the token cap already bounds).

### Partial errors & null propagation
Root-level `Query.author` and `Query.book` return structured NOT_FOUND errors when the requested id does not exist: `data.author: null` (or `data.book: null`) plus an entry in `errors[]` with `extensions: { code: "NOT_FOUND", id: "<requested-id>" }`, letting clients correlate exactly which entity was missing. Back-edge resolvers (`Book.author`, `Review.book`) follow the same pattern for non-null fields — a missing referenced entity throws a `GraphQLError` (`code: NOT_FOUND`), which triggers GraphQL's standard null-propagation: the error surfaces in `errors[]` and null bubbles to the nearest nullable parent rather than corrupting the response. DataLoaders return `null` for a missing single-entity key (never throw at the batch level), so a bad id degrades gracefully.

### Downstream timeout
Every outbound REST call is guarded by a per-request deadline (`downstreamTimeoutMs`, default 30 s). If the downstream service does not respond in time, the call aborts and the resolver surfaces a typed error (`extensions.code = DOWNSTREAM_TIMEOUT`). Configure the timeout via the `downstreamTimeoutMs` option in `createGateway` / `createContext`.

### Downstream call budget
`maxDownstreamCalls` (env `MAX_DOWNSTREAM_CALLS`, unset = unlimited) is a hard per-request ceiling on the downstream REST calls the gateway actually sends. Once a request has sent that many, any further call is refused **before** it leaves the gateway: the resolver gets a typed error with `extensions.code = DOWNSTREAM_BUDGET_EXCEEDED` and `extensions.budget` set to the configured number, and normal null propagation applies. Calls already in flight are not aborted. The budget is per edge HTTP request (a [batched](#request-batching) POST is one request), so concurrent requests never share it, and it counts every path: batched loaders, naive loaders, list pages and lookahead prefetch. A speculative lookahead prefetch is counted when it is sent, so under a very tight budget it can take a slot before its root by-id fetch (the root then fails with `DOWNSTREAM_BUDGET_EXCEEDED` rather than `NOT_FOUND`). The refusal message names only the budget, never the downstream route. The same holds one level down: under `maxDownstreamCalls: 2`, `book(id){ author{ books{...} } }` spends its second slot on the speculative `/books/by-author` call, so it fails at `book.author` rather than at `book.author.books`.

WHY it complements `maxComplexity`: the cost model is an estimate of response size, not of downstream fan-out. List pages are not batched, so 100 aliases of `authors(first: 0, after: "<distinct cursor>") { totalCount }` cost only **100** yet make **100** downstream calls, while the legitimate nested sample query costs **351** and makes just **3**. No complexity limit can stop the first without rejecting the second; a cap on the *measured* call count can. Validation-time `maxComplexity` still rejects oversized queries before any call is made. The budget is the backstop for whatever shape gets through.

### Request batching
Batching clients (Apollo `BatchHttpLink`, Relay batching) send several operations in one POST whose JSON body is an array. This is off by default, and such a POST gets HTTP 400 `Batching is not supported.`. Set `maxBatchSize` (env `MAX_BATCH_SIZE`) to accept arrays of up to that many operations. The response is a JSON array in request order, and a larger array gets HTTP 413 before any downstream call. All operations in one HTTP request share one request-scoped `RestClient`, loader set and `maxDownstreamCalls` budget, so the DataLoader guarantee spans the whole round trip: three small author/book queries cost 5 downstream calls batched, the same as one merged query, against 9 as separate POSTs. Identical `authors` list pages (the same `first`/`after` after clamping to 0..100 and cursor decoding) are fetched once per edge HTTP request, whether they come from batched operations or same-page aliases: a batch of 10 copies of the nested sample query costs 3 downstream calls, not 12, and a failing page is called once and its error shared. NAIVE loaders (no cache) do not dedupe. `maxDepth` and `maxComplexity` still apply per operation, so a batch may cost up to `maxBatchSize × maxComplexity`. `maxDownstreamCalls` is the batch-wide backstop. Each element's `extensions.downstreamCalls.total` is the shared counter's value when that operation finished, so the largest one equals the batch's total. An element rejected by validation keeps its own errors and carries no extension. Nothing is shared between separate HTTP requests.

### Forwarding edge headers downstream
A legacy REST service usually authorizes each request itself and correlates logs by request id, so the gateway can pass selected caller headers through: `forwardHeaders: ['authorization', 'x-request-id']` (env `FORWARD_HEADERS=authorization,x-request-id`). Forwarding is opt-in and allowlist-only: nothing is forwarded by default, only the listed names (matched case-insensitively) are copied, and a header the caller did not send is not sent. Values are taken from each edge request, so one caller's token never reaches another caller's downstream calls; every path (batched, naive, list pages, lookahead prefetch) carries them. Forwarded credentials are sent to the configured downstream host (`restBaseUrl` / `REST_BASE_URL`), so only list headers that host is meant to see. Hop-by-hop and framing names (`host`, `connection`, `content-length`, `transfer-encoding`, `keep-alive`, `upgrade`, `te`, `trailer`, `proxy-connection`), `expect` (Node's fetch refuses it, so every downstream call would fail) and names that are not valid HTTP tokens are rejected at startup.

### Downstream error
When the downstream REST backend cannot be reached at all (connection refused, DNS failure, connection reset before a response), the field fails with `extensions.code = DOWNSTREAM_UNREACHABLE` and the exact message `Downstream request to <route> failed: backend unreachable`, e.g. `Downstream request to /authors failed: backend unreachable`. The host, port and system error (`ECONNREFUSED`) are not included, because they describe the backend's topology. `npm run check-backend` still reports them to the operator. The call is counted once in `extensions.downstreamCalls`, and other fields of the same query fail or succeed on their own. Like every typed downstream error, it is not written to the server log; use `/readyz` or `npm run check-backend` to see whether the backend is reachable.

When the downstream REST backend returns a non-OK HTTP status (e.g. 500, 404), the gateway surfaces a typed error (`extensions.code = DOWNSTREAM_ERROR`) with `extensions.status` carrying the HTTP status code. The error message includes the status, status text, and the failed path, letting clients distinguish "the backend returned an error" from "the query itself was invalid."

When the downstream answers 2xx but the body is not valid JSON (a maintenance page, an empty body) or breaks the REST contract (not a JSON array of rows, a row that is not an object, a row field missing or of the wrong JSON type, an `/authors` page that is not `{ items, total }`), the field fails with `extensions.code = DOWNSTREAM_BAD_RESPONSE`, `extensions.status` (the downstream HTTP status) and `extensions.route` (e.g. `/authors/by-ids`) instead of an untyped "Unexpected error.". The message names the route and the first problem, e.g. `Downstream REST response for /books/by-ids breaks the contract: row 0: field "year" must be a number, got a string`. The downstream body is never echoed: values and keys are reported only by JSON type. Other fields of the same query keep their data, the call is counted once in `extensions.downstreamCalls` and is not retried, and extra row fields are allowed. One exception to "not retried": when the failing call was a `Book.author` lookahead prefetch, the field's own load re-sends it once (2 calls). The check covers the whole downstream response, so one bad row fails every field served by that batched call, whether or not the bad field was selected. The row specs are the same module `npm run check-backend` checks against, so the pre-flight and the gateway cannot disagree about the contract.

### Readiness probe
`GET /readyz` tells a load balancer or orchestrator whether this instance can serve, while `/healthz` stays a static liveness check (`200 {"status":"ok"}`, no downstream call) that only says the process is up. Each probe sends one downstream call, `GET /authors?offset=0&limit=1` (the first author page, through the same data source and contract reader the resolvers use), and answers `200 {"status":"ready"}` or `503 {"status":"unready","code":"<code>"}`. The code is one of 4: `DOWNSTREAM_UNREACHABLE` (nothing answered), `DOWNSTREAM_ERROR` (a non-2xx status), `DOWNSTREAM_BAD_RESPONSE` (a 2xx body that is not a valid `{ items, total }` page, e.g. an html maintenance page) and `DOWNSTREAM_TIMEOUT` (no answer within `downstreamTimeoutMs`). These are the same codes GraphQL clients get for the same failure, with one known gap: when a 2xx response arrives and its body then fails or stalls mid-read, the probe reports `DOWNSTREAM_UNREACHABLE` while clients still get an untyped `INTERNAL_SERVER_ERROR` (the probe still reports unready, which is the right routing decision). The path is matched exactly like `/healthz`: any method and any query string, but not `/readyz/x`. Concurrent probes share one in-flight check, so 10 simultaneous probes make 1 downstream call, but the result is never cached: the next probe after it settles checks again, so a backend that recovers is reported ready at once. The probe belongs to no caller. It carries no [forwarded headers](#forwarding-edge-headers-downstream) and is not limited by the [downstream call budget](#downstream-call-budget), so a backend that requires auth on `/authors` reports unready (`DOWNSTREAM_ERROR`). Probe calls are not counted in any request's `extensions.downstreamCalls`. After `close()`, `/readyz` answers 503 like every other path, with no downstream call. While the backend hangs, every probe waits for the shared check, which gives up only after `downstreamTimeoutMs` (default 30 s), so set `downstreamTimeoutMs` below the load balancer's probe timeout if you want `/readyz` to answer with a code before the balancer gives up.

### Query complexity metrics
Every successful response includes `extensions.queryComplexity` with numeric `cost` and `depth` fields — the same values the depth and complexity validation rules compute. Integrators can observe real traffic to tune `maxDepth`/`maxComplexity`, alert on creeping cost before clients trip the hard limit, and prove exactly what each query costs. When a query is rejected by the validation rules (`QUERY_TOO_DEEP` / `QUERY_TOO_COMPLEX`), the `queryComplexity` extension is **not** injected — the rejection error already carries the relevant numbers.

### Downstream call metrics
Every executed response also includes `extensions.downstreamCalls` with a single `total` field: the exact number of downstream REST calls **this request** sent (including any that failed or timed out; calls refused by the [downstream call budget](#downstream-call-budget) are not counted), read from the request-scoped `RestClient` counter. It sits next to `queryComplexity`, so the cost estimate and the measured cost appear together: the nested sample query reports `{ "total": 3 }` with batching and `21` with naive loaders. The count is per request (one edge HTTP request), not cumulative, and concurrent requests never share it (in a [batch](#request-batching) each element reports the shared counter). Partial-error responses still carry it. Queries rejected by validation (`QUERY_TOO_DEEP` / `QUERY_TOO_COMPLEX`) make no downstream calls and do **not** get the extension. A per-path breakdown is deliberately left out so backend topology is not exposed to edge clients.

### <a name="auth-context"></a>Auth context
A bearer token is parsed per request and threaded through `context.auth` (`parseAuth` in `src/gateway/context.ts`). A stub token format `user:<id>:<scope,scope>` demonstrates the pattern without pulling in an auth vendor; swap `parseAuth` for real JWT verification in production. `Review.reviewer` is treated as PII and redacted to `REDACTED` unless the caller is both authenticated **and** carries the `pii` scope — a concrete, tested example of scope-based field authorization. `requireAuth(ctx)` is an internal helper in `src/gateway/context.ts` that throws a typed error (`extensions.code = UNAUTHENTICATED`) when the caller is not authenticated (missing or unparseable token), but no shipped field uses it, so today no request receives `UNAUTHENTICATED`; the code is reserved for future schema fields that adopt the helper.

### Observability
The `RestClient` and the REST backend both count calls; the backend exposes `GET /__stats` and `POST /__stats/reset`. The per-request gateway count is surfaced to clients as [`extensions.downstreamCalls`](#downstream-call-metrics). Operators get the per-call view through `createGateway({ onDownstreamCall })`: it is called exactly once for every downstream call the gateway sends. When all of a request's calls settle before its response, the number of events equals `extensions.downstreamCalls.total`. Each event is `{ route, status, durationMs, outcome, errorCode }`. `route` is the route template (`/books/by-author`, without the base URL's path prefix), and the event carries no URL, ids, query params, host or headers. `status` is the HTTP status, or `null` when no response arrived. `outcome` is one of `ok`, `http_error`, `bad_response`, `unreachable`, `timeout` or `other`. `errorCode` is the client-visible `extensions.code` (`DOWNSTREAM_ERROR`, `DOWNSTREAM_BAD_RESPONSE`, `DOWNSTREAM_UNREACHABLE`, `DOWNSTREAM_TIMEOUT`), or `null` for `ok` and `other`. A call refused by `maxDownstreamCalls` is never sent and fires nothing, and neither does the `/readyz` probe. A call can still be in flight when the response is sent, and it then settles and fires after its response: an orphaned lookahead prefetch, or a sibling NAIVE load still pending when an error ended its list early. Such a call fires an event but can be missing from that response's `extensions.downstreamCalls.total`, so the hook is the complete count. The hook is not awaited, and a sync throw or async rejection is swallowed, so it cannot change a response. This hook is the seam an OpenTelemetry span exporter would hook into (see [what's next](#10-what-id-do-next-in-production)).

---

## 8. Testing

`npm test` — 1276 tests across 53 files (Vitest), all green:

- **Unit** — DataLoader batching/grouping/caching (`loaders.test.ts`), Relay cursor round-trip + pageInfo (`pagination.test.ts`), depth/complexity rules (`security.test.ts`), auth parsing + redaction (`auth.test.ts`).
- **Integration** — full request through the real Yoga HTTP handler (`integration.test.ts`): nested query, cursor pagination across pages, depth rejection, complexity rejection, auth redaction.
- **Library entry** — imports from the barrel (`lib-entry.test.ts`), boots a gateway against the bundled backend, and asserts a successful query round-trip.
- **Built package** (`test_iter62_behavior.test.ts`) — builds with `tsconfig.build.json` into a temp dir, imports the package by name from plain Node ESM (no loader), and type-checks a NodeNext consumer that must reject a wrong-typed `GatewayOptions`.
- **Hostile documents** (`test_iter66_behavior.test.ts`): the 2000-token cap boundary, fast refusal of a 32 000-token document, no stall for a concurrent caller, and limit errors returned alone at 0 downstream calls.
- **Repeated fragment spreads** (`test_iter68_behavior.test.ts`): 2^n fan-out fragment chains answered or refused in milliseconds at 0 downstream calls, with every pinned cost and depth number unchanged.
- **List-page dedupe** (`test_iter69_behavior.test.ts`): batches of identical `authors` list ops and same-page aliases cost one `/authors` call per distinct page per edge request, a failing page is called once with its error shared, the `maxDownstreamCalls` budget sees deduped calls, and NAIVE mode still pays every call.
- **`Book.author` lookahead** (`test_iter70_behavior.test.ts`): `book(id){ author{ books } }` takes 2 serial hops instead of 3 at unchanged call counts and identical data, the gate off-cases (list roots, fragments, `__typename`, `@skip`, NAIVE), the orphan-book +1 call, the budget-2 error path, and mixed HTTP batches.
- **Backward pagination** (`test_iter71_behavior.test.ts`): `last`/`before` pages, windows from `after` plus `before`, a full backward walk that visits every author once, `first` with `last` refused as `BAD_PAGINATION_ARGS` at 0 calls, clamped and empty pages, and the exact downstream call count of each case.
- **Options validation** (`test_iter72_behavior.test.ts`): every bad `createGateway` option (NaN/0/Infinity limits, a `downstreamTimeoutMs` above 2147483647, a non-http(s) `restBaseUrl`, a malformed `loaderOptions`, an unknown key with its did-you-mean hint) throws at construction with 0 downstream calls, the CLI rejects `DOWNSTREAM_TIMEOUT_MS` above 2147483647, and the benchmark still costs 3 batched / 21 naive calls.
- **Contract-breaking 2xx bodies** (`test_iter73_behavior.test.ts`): a stub in front of the bundled backend corrupts one route at a time (an html or empty body, a wrapped list, a null row, a missing, mistyped or snake_case field, a bad `/authors` page) and each becomes `DOWNSTREAM_BAD_RESPONSE` naming the route, with no body text echoed, partial data kept, the call counted once, `DOWNSTREAM_ERROR` unchanged for non-2xx, and the benchmark still at 3 batched / 21 naive calls.
- **Readiness probe** (`test_iter74_behavior.test.ts`): `/readyz` answers 200 ready against the bundled backend and 503 with a typed code against a closed port, a 500, an html page, an off-contract page and a stalled backend; concurrent probes coalesce into one downstream call, a recovered backend is ready on the next probe, `/healthz` stays static, and connection refused reaches GraphQL clients as `DOWNSTREAM_UNREACHABLE` with no host or port in the message.
- **Root fragments keep the lookahead** (`test_iter76_behavior.test.ts`): `query { ...Q }`, `... on Query`, typeless inline, nested fragments and a root `__typename` take the same 2 serial hops and per-route calls as the inline spelling with identical data, cost and budget admission; a list root hidden in a fragment, `__schema` and NAIVE still refuse, and a `@skip`-excluded list fragment does not count.
- **Downstream call hook** (`test_iter77_behavior.test.ts`): a per-route hit-counting stub in front of the bundled backend checks that `onDownstreamCall` fires exactly once per sent call (3 batched, 21 naive, events == `downstreamCalls.total` == stub hits), never for budget-refused calls, `/readyz` or depth/complexity rejections, with the 5-key event carrying only the route template, each failure mode's outcome and client `extensions.code`, and a throwing, rejecting or never-settling hook leaving the response byte-identical.
- **Bounded nested lists** (`test_iter78_behavior.test.ts`): nested `books(first)` and `reviews(first)` return the prefix the backend sent, clamp to 0..100 (checked against a 150-row stub), give `[]` for 0 or negative bounds and the whole list when omitted, keep 3 batched / 21 naive calls, share one call across aliases with different bounds, ask `/reviews/by-book` only for kept books, keep the lookahead prefetch, and price the benchmark shape with `first: 1` at 46.
- **Clamped complexity pricing** (`test_iter79_behavior.test.ts`): `first`/`last` above 100 on `authors`, `books` and `reviews` (literal or `$var`) cost the same as 100 with the same data and calls, wide subtrees such as `authors(first: 5000)` over books and reviews are still refused at 3901 with 0 downstream calls, and prices for 0..100 are pinned unchanged (`1 + 3n`, `21 + 5n`, the benchmark shape at 46).
- **Installed commands** (`test_iter80_behavior.test.ts`): builds and packs the package once, links it into a temp consumer offline, then runs both `bin` commands through their shebangs: the gateway boots and serves the nested query at 3 downstream calls, SIGTERM exits 0, any argument exits 2 before anything listens, and check-backend keeps its `--json` output and 0/1/2 exit codes.
- **Count-only list roots keep the lookahead** (`test_iter81_behavior.test.ts`): `authors` roots that never select `books`/`reviews` (count, names, pageInfo, cursors; fragments and `@skip`/`@include` honoured) keep the by-id prefetch at 2 serial hops and the same calls, while a list that reaches `books` still refuses with `/books/by-author` called once.
- **Cost-model docs truth** (`test_iter82_behavior.test.ts`): the §7 cost bullet, the §9 design note and the complexity rule's doc comment are checked against the runtime pricer. Each query the README prints is posted verbatim and must cost the printed figure, and the unbounded-versus-bounded admission cases are re-run against a wide stub.
- **Bulk book hydration** (`test_iter83_behavior.test.ts`): `books(ids:)` keeps id order and duplicates, returns `null` plus a per-item `NOT_FOUND` for unknown ids, sends 15 ids as 1 `/books/by-ids` call (15 under NAIVE), refuses 101 ids with `BAD_ARGUMENT`, and is priced `1 + n × subtree` for literal and variable lists.
- **Backend pre-flight** (`test_iter67_behavior.test.ts`): `npm run check-backend` against in-process `node:http` fakes that each break the REST contract one way (a deleted or retyped field per dataset key, a wrong join key, a wrapped list, a 404), plus exit codes and the bundled backend's teardown.
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
- **Custom depth/complexity rules (over a library).** They're small, dependency-free, and demonstrate understanding of the validation phase — more defensible in an interview than importing a black box. The cost model is a static estimate, not a measurement: it bounds the work only when every list carries `first`/`last`, and it prices an omitted bound at a fixed default (see the Complexity/cost limit bullet in §7).
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
