# graphql-rest-gateway — schema-first GraphQL over REST without the N+1 explosion

A production-shaped GraphQL gateway that fronts REST backends and resolves nested queries through request-scoped DataLoaders, so one client query costs a handful of batched downstream calls instead of a fan-out. It is the canonical strangler-fig migration layer: stand it up in front of legacy REST, move clients over query by query, and never expose the fan-out to callers.

For backend engineers migrating REST estates to a graph who need batching, pagination shape, depth/complexity limiting, and per-request auth handled once at the edge, with proof rather than promises: the bundled benchmark measures downstream call counts and a regression test fails if batching degrades.

Quality bar and hard constraints:
- Everything boots in-process (`npm start`) with the bundled Fastify REST backend; no external accounts, Docker, or network in tests. `npm test` (vitest) and `npm run typecheck` (tsc, strict) must stay green and fast.
- Schema-first: the SDL is the contract; generated types stay in sync via codegen and are never hand-edited.
- Any resolver or loader change ships with a call-count assertion; the N+1 regression test is the load-bearing oracle and may never be weakened to pass.
- TypeScript on Node >=20, MIT, generic identifiers only, no machine paths, publication-safe at all times.
