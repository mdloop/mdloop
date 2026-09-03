# ADR 0010 — Rate-limiter test infrastructure: real local Valkey, and the CAS/clock design

- Status: Accepted (2026-08-03, explicit OK per CONSTITUTION §8.5 — confirmed directly with the
  product owner during the rate-limiter design conversation; this document was written
  2026-08-04, immediately before the deviation lands, per §8.5's "ADR before deviation")
- Date: 2026-08-04
- Deciders: Jasdeep (product)
- Relates to: CONSTITUTION.md §8 rule 4 (externals mocked in unit tests, real in integration
  tests), §8 rule 5 (ADR before deviation); ADR 0005 (test infrastructure reality — the
  Postgres/filesystem precedent this ADR extends)

## Context

`UserRateLimiter`'s per-process `Map` was a known horizontal-scalability gap ("N× the tier
ceiling with N replicas"). A design pass found no edge-level mitigation was a per-user/per-tier
substitute, and the product owner decided the fix belongs in the core now, backed by a real
Redis-protocol store (Valkey) behind `RateLimiterPort` — a production deployment supplies its own
instance; this repo runs a local one for tests and self-hosting.

The implementation needs a `WATCH`/`MULTI`/`EXEC` optimistic-concurrency loop
(`packages/persistence/src/rate-limit/redis-rate-limiter.ts`) proven against a **real** Redis-
protocol engine: the property under test — that concurrent writers contending for the same
key never double-consume or lose an update — is enforced by the engine itself and is not
provable against a single-process JS mock, which cannot exhibit the interleaving the real
protocol creates. This mirrors exactly the class of test-infrastructure question ADR 0005
already settled for Postgres/RLS, but CONSTITUTION §8's rule 4 ("externals mocked in unit
tests… real in integration tests") has, in practice, only ever meant Postgres and the
filesystem — every other external (WorkOS, Stripe, SES) is 100% faked by hand. Adding a real
Valkey dependency for this one path is a genuine deviation from that pattern and needs its own
ADR and explicit human OK per §8's rule 5, which the product owner gave directly ("Confirmed
with the product owner directly" in the design conversation, 2026-08-03).

## Decision

### A. Real local Valkey via Homebrew, no container runtime

Same shape as ADR 0005's Postgres decision: `brew install valkey` (native, no Docker), reachable
locally on the default port, confirmed with `redis-cli -p 6379 ping` → `PONG`. `TEST_REDIS_URL`
overrides the connection target, mirroring `TEST_DATABASE_URL`'s pattern exactly (unset ⇒
`redis://localhost:6379`). `createTestRedis()`
(`packages/persistence/src/test-support/test-redis.ts`) selects one of Redis's numbered logical
databases (1–15; 0 stays the unconfigured-client default, deliberately never used by tests, so a
misconfigured connection can never silently collide with test data) and flushes it on both open
and close — the numbered-DB analogue of `createTestDb`'s per-run randomly-named database, giving
the same no-cross-test-state isolation without provisioning a new server per run.

### B. Principle: a real instance is required only when the engine enforces the property

A real backing instance is warranted only when the correctness property is enforced by the
external engine itself and is unprovable in JS — true for RLS (ADR 0005: Postgres's row-security
engine), true for atomic cross-replica CAS (this ADR: Redis's per-connection
`WATCH`/`MULTI`/`EXEC` protocol) — and **not** true for S3 blob semantics (plain
put/get/delete, fully provable against the filesystem fake already in place) or WorkOS/Stripe/SES
(protocol-shaped request/response, provable against a hand-written fake, which is how all three
are tested today). This ADR does not retroactively bless every future external dependency; each
still needs its own justification against this principle and its own §8.5 sign-off.

`ioredis-mock` (or any other in-memory mock library) is explicitly ruled out for the CAS path: a
single-process mock cannot falsify a broken `WATCH`/`MULTI` loop, which is precisely the bug class
a shared store exists to prevent, and no mocking library has any precedent anywhere in this
codebase (32 hand-written fakes in `packages/app/src/test-support/fakes.ts`, zero mocking
libraries) — introducing one here would be the more foundational deviation, not the smaller one.

### C. `WATCH`/`MULTI`/`EXEC` from Node, not a Lua script

`packages/domain/src/rate-limit.ts`'s `consumeRequest`/`initialRateLimitState` stay the single
implementation of the token-bucket/daily-window math. A Lua script computing the transition
server-side would be more strongly atomic (one round trip, no retries), but it requires
re-implementing that math a second time in Lua — duplicating the one place business math is
supposed to live, a discipline this codebase has held everywhere else. The Node-side CAS loop
(`packages/persistence/src/rate-limit/redis-rate-limiter.ts`) keeps `consumeRequest` as the only
implementation, at the cost of bounded retries under contention (`MAX_CAS_RETRIES = 10`, then a
thrown error surfaced as a fault by the existing HTTP/MCP fault handlers — the same "fail loud,
never silently misbehave" stance the rest of this codebase takes on exhausted retries). Chosen
for architectural consistency over the small atomicity gain.

A second, less obvious consequence of using `WATCH`/`MULTI`/`EXEC`: the protocol accumulates
state **per physical connection**, not per logical caller, so two concurrent CAS loops sharing
one `ioredis` connection would corrupt each other's transactions (one call's `MULTI` would
silently absorb the other's commands). `RedisRateLimiter` mints a small pool of dedicated
connections via `ioredis`'s `duplicate()` rather than sharing one client across concurrent
`check()` calls — noted here because it is the direct, non-obvious consequence of choosing
`WATCH`/`MULTI`/`EXEC` over a single atomic Lua call, not a separate design axis.

### D. Clock source: each node's own wall clock, not Redis `TIME`

The domain layer never reads a clock internally — every caller supplies `nowMs` — so the shared
store needs an explicit choice. Each app node's local wall clock is used, not a `TIME` round trip
to Redis. Minor cross-replica clock skew (milliseconds to low seconds on any real fleet) is well
within tolerance for a token bucket refilling per minute and a window rolling per day; the extra
round trip a `TIME` call would cost on every single request has no offsetting correctness benefit
at stage-1 scale.

## Constitution amendments (applied with this ADR)

- **§8 rule 4** ("externals mocked in unit tests… real in integration tests"): the real-in-
  integration-tests list gains Valkey (native Homebrew install, `TEST_REDIS_URL`) alongside
  Postgres (`createTestDb`) and the filesystem storage adapter, scoped specifically to the rate
  limiter's CAS/concurrency path per principle B above.

## Consequences

- `packages/persistence`'s and `packages/mcp`'s test suites now assume a local Valkey install
  exists, exactly the tradeoff ADR 0005 already accepted for Postgres: no Docker daemon
  dependency, faster startup than a container, one more thing a contributor's machine (or CI
  runner) must have provisioned. For this codebase's current stage — single-engineer-plus-agents,
  no CI fleet yet — net positive; revisit if CI moves to ephemeral runners with no pre-provisioned
  Valkey, at which point Testcontainers becomes the right call for this path too, same as ADR
  0005 already flags for Postgres.
- New file `packages/persistence/src/rate-limit/redis-rate-limiter.integration.test.ts`, following
  the `*.integration.test.ts` naming convention already used 20+ times in `packages/persistence`.
- `packages/mcp/src/rate-limit-parity.feature.test.ts` gains a second `Scenario` (cross-replica
  budget sharing) that requires the same real local Valkey — `vitest-cucumber`'s
  `describeFeature` requires every `Scenario` in a `.feature` file to be implemented in the same
  binding, so this cannot be split into a separate file without duplicating the feature file's
  binding. The whole `packages/mcp` test suite now has this dependency, the same way it has
  always depended on local Postgres.
- No schema/migration change — this ADR is entirely about test strategy and the two implementation
  decisions (C, D) above; the production topology (which managed Valkey/Redis a deployment runs) is
  that deployment's own choice, behind `RateLimiterPort`.

## Alternatives considered

- **`ioredis-mock`**: rejected — principle B; cannot falsify a broken CAS loop.
- **Testcontainers Valkey**: rejected — same reasoning ADR 0005 already gave for Postgres (no
  Docker dependency in this codebase's tree today; native install is faster and simpler for a
  single-engineer-plus-agents build at this stage).
- **Lua script for the CAS path**: rejected — duplicates `packages/domain/src/rate-limit.ts`'s
  math in a second language; see (C) above.
- **Redis `TIME` as the clock source**: rejected — an extra round trip per request with no
  correctness benefit at stage-1 tolerances; see (D) above.
