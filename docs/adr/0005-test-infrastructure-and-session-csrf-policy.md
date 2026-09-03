# ADR 0005 — Test infrastructure reality, session duration, and CSRF mechanism

- Status: Accepted (2026-07-20, explicit OK per CONSTITUTION §8.5)
- Date: 2026-07-20
- Deciders: Jasdeep (product)
- Relates to: CONSTITUTION.md §2 (Technology Choices, Testing row), §4 (Security Non-Negotiables,
  Sessions/CSRF), §8 (Delivery Workflow, per-phase gates); Phase 24 (production hardening)

## Context

Phase 24's five-pass production-readiness review (2026-07-19) found two places where CONSTITUTION
text no longer matched — or had never precisely specified — what the codebase actually does. Per
§8.5, any change to §1–7 requires an ADR and explicit human OK; this ADR covers both findings
together since they surfaced in the same review pass and both amend already-loose CONSTITUTION
wording rather than introduce new product surface, the same shape of bundling ADR 0002 used for its
three-part handover arc.

- **A. Test infrastructure.** CONSTITUTION §2's Testing row reads "Vitest (unit/integration) +
  Testcontainers (real Postgres for RLS tests) + Playwright (e2e)", and §8.2/§8.4 additionally name
  "Testcontainers Postgres, LocalStack S3" for externals in integration tests. Neither has ever been
  true in this codebase. Every phase since Phase 1 has run integration and RLS tests against an
  ephemeral, per-run Postgres database (`createTestDb`, `packages/persistence/src/test-support/test-db.ts`)
  created on a real local Postgres 18 install — never a container. Blob storage in every environment
  short of production is the filesystem `StoragePort` adapter — LocalStack has never been wired in.
  `grep -r testcontainers packages/*/package.json` returns nothing; there is no Docker dependency
  anywhere in the tree. This was quietly true from Phase 0 onward and never corrected in writing.
- **B. Session duration and CSRF mechanism.** CONSTITUTION §4 says "Sessions: httpOnly + Secure +
  SameSite cookies; CSRF protection on all mutations" — true, but silent on _how long_ a session
  lasts and _which_ CSRF mechanism is in force. The actual behavior at the time (a 7-day cookie TTL
  with no CSRF mechanism at all) was a standing session-hijack window wider than necessary, and a
  gap the constitution should be precise about rather than leave undocumented. Phase 24.C made both
  concrete: a 24-hour global session ceiling, organization-configurable shorter, and a signed
  double-submit CSRF token plus an Origin allowlist. This ADR promotes both from "phase decision"
  to "constitutional fact," the same way ADR 0001 promoted tiered retention.

## Decision

### A. Test infrastructure: `createTestDb` + filesystem adapter, not Testcontainers/LocalStack

1. **Real Postgres, ephemeral per run, no container runtime.** `createTestDb()` connects to a
   locally running Postgres 18 (Homebrew, trust auth on socket — no password, no Docker daemon),
   creates a fresh randomly-named database per test run, runs every migration against it via the
   same `migrate()` used in production, and drops the database on teardown. `TEST_DATABASE_URL`
   overrides the connection target for CI or a differently-provisioned Postgres. RLS is proven
   against this real database exactly as §8.2 originally intended — "real Postgres for RLS tests"
   remains true, only the provisioning mechanism changes.
2. **Filesystem `StoragePort` adapter, always, outside production.** Local dev and every test run
   use the same filesystem-backed adapter behind `StoragePort` that `docs/ARCHITECTURE.md` §1 has
   described since Phase 0 ("a filesystem `StoragePort` adapter... No Docker, no LocalStack"). S3
   is exercised only by the real AWS S3 adapter, deployed in Phase 10. There has never been a
   LocalStack dependency to remove — the CONSTITUTION text describing one was aspirational from the
   initial technology-choices pass and never corrected.
3. **Why this is equivalent, not a downgrade.** The property §8.2 actually needs — RLS policies
   proven against a real Postgres engine, not a mock — holds identically whether that Postgres runs
   in a container or as a native per-run database. A dedicated per-run database gives the same
   isolation guarantee (no cross-test state) with less moving infrastructure: no Docker daemon
   dependency in CI or on a contributor's laptop, faster startup (native connection vs. container
   boot), and one less external tool in the dependency tree to keep patched. The tradeoff accepted:
   test runs assume a local Postgres 18 install exists (documented in `README`/CLAUDE.md's
   Environment section) rather than being fully hermetic via a container image pin. For this
   codebase's needs — a single-engineer-plus-agents build with no CI fleet yet provisioned — that
   tradeoff is net positive; revisit if/when CI runs on infrastructure where a persistent Postgres
   install isn't the natural default (e.g., ephemeral CI runners with no pre-provisioned DB), at
   which point Testcontainers becomes the right call and this ADR should be revisited, not silently
   ignored.
4. **Playwright e2e is unaffected** — still runs against the full dev stack (`make dev` equivalent
   used by `e2e-main.ts`), unchanged by this ADR.

### B. Session duration and CSRF mechanism

1. **Session ceiling: 24 hours global default, organization-configurable shorter.**
   `GLOBAL_SESSION_MAX_HOURS = 24` (`packages/domain/src/session.ts`) replaces the previous 7-day
   cookie TTL. `organizations.session_max_hours` (migration 0022) lets an org admin set a _shorter_
   ceiling (1–24 hours, DB `CHECK`-enforced so no application code path can widen it past the
   global default); `null` means "use the 24h default." The effective expiry for a session is
   `min(global default, org max)` applied to that session's issued-at, computed at decode time
   (`effectiveSessionExpiry`, `packages/domain/src/session.ts`) — never stored as a second
   materialized expiry, the same derived-not-stored discipline ADR 0002 already applies to review
   status.
2. **Silent refresh.** A session past half its effective lifetime is reissued (both cookies, same
   response) rather than forcing a re-login at the ceiling — the ceiling bounds exposure, it isn't
   meant to interrupt an actively-used session.
3. **CSRF: signed double-submit token, plus an Origin allowlist as a second layer.** On login (and
   every silent refresh), the server sets a second, non-`httpOnly` cookie (`vorlyn_csrf`) whose value
   is `HMAC(secret, session_cookie_value)` — bound to the exact session, verifiable server-side from
   the session cookie alone, with no server-side token store. The SPA echoes this value into an
   `x-csrf-token` header on every mutating request; the guard recomputes the HMAC from the incoming
   session cookie and rejects on mismatch. Layered on top: every mutating request (non-GET/HEAD/OPTIONS)
   carrying an `Origin` header must match the configured web origin exactly (`makeRequireOrigin`,
   `packages/api/src/auth/guards.ts`); a request with no `Origin` header is allowed through this layer
   alone, since some non-browser and same-origin clients omit it — the double-submit token still
   guards those. `SameSite=Lax` is kept as a third, defense-in-depth layer, not replaced by either
   mechanism above. MCP, webhook, and public-hub routes are exempt (no cookie session exists to
   forge against).
4. **Rejected alternative — synchronizer token pattern (server-side CSRF token store).** Would need
   a server-side store, reintroducing the session-state problem CONSTITUTION §2/§4 deliberately
   avoids (stateless signed cookies, "no server-side session state" per `docs/ARCHITECTURE.md` §1).
   The signed double-submit token gets the same guarantee — a forged cross-site request cannot
   produce a value the attacker couldn't already read (SameSite already blocks that) or compute
   (no secret) — without a store.
5. **Rejected alternative — leave the CSRF token unbound to the session (a random value stored in
   its own cookie, unrelated to the session cookie).** Rejected because it doesn't prove the token
   was issued _for this session_ — a stale or replayed token from a previous session would still
   validate. Binding the HMAC to the current session cookie value means the token invalidates the
   instant the session does (logout, expiry, refresh all rotate it for free).

## Constitution amendments (applied with this ADR)

- **§2 Testing row**: "Testcontainers (real Postgres for RLS tests)" → "ephemeral per-run Postgres
  database (`createTestDb`)"; drops the implied LocalStack dependency. See ADR 0005.
- **§4 Sessions/CSRF**: session bullet gains the 24h global ceiling + org-configurable shorter max;
  CSRF bullet names the signed double-submit token + Origin allowlist mechanism explicitly. See ADR 0005.
- **§8.2/§8.4**: "Testcontainers Postgres, LocalStack S3" → "ephemeral per-run Postgres (`createTestDb`),
  filesystem storage adapter" wherever named.

## Consequences

- No schema/migration change from part A — this is a documentation correction, not new machinery
  (the mechanism it describes has been in place since Phase 1).
- Part B's machinery (migration 0022, `packages/domain/src/session.ts`, `packages/api/src/auth/guards.ts`,
  `packages/api/src/auth/session.ts`) already shipped in Phase 24.C; this ADR is the constitutional
  record making it authoritative rather than a phase-scoped implementation detail.
- What we give up: a shorter default session lifetime than before (24h vs. 7 days) means more
  frequent silent refreshes and a smaller — but nonzero — window where a stolen cookie remains
  useful; accepted as a strict security improvement with no product-facing downside (silent refresh
  makes the shorter ceiling invisible to an actively-used session).

## Alternatives considered

- **Split into two ADRs** (test-infra; session/CSRF): considered, rejected — both are corrections to
  already-loose CONSTITUTION wording discovered in the same review pass, neither is large enough or
  contested enough to warrant separate ceremony, and ADR 0002 already set the precedent of bundling
  multiple related-but-distinct decisions under one Accepted ADR when they land together.
- **Leave CONSTITUTION §2/§4 as aspirational and fix the drift elsewhere**: rejected — §8.5
  exists precisely because CONSTITUTION text is supposed to be authoritative fact, not aspiration;
  letting it silently drift from reality (as it already had for over twenty phases on the
  Testcontainers line) is the failure mode this ADR closes.
