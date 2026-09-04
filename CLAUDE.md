# mdloop — agent notes

Read in order: `CONSTITUTION.md` (non-negotiables — §1 core principles, §7 the open-core boundary,
§8 delivery gates) → `docs/ARCHITECTURE.md` → `docs/STATUS.md` (what exists, what is deliberately
absent) → `docs/RISKS.md`.

## What this repository is

**This is the core, and it is the source of truth.** Apache-2.0, public, self-hostable. Two
consequences that change how you work:

- **Public API is a real concept here.** Anything exported from a package — `ServerDeps`,
  `ServerExtension`, the port interfaces, `createTestServer`'s signature — is a contract anyone
  self-hosting or integrating this repo can depend on. Changing an export is a breaking change to
  that contract, not a local refactor. Say so in the commit message.
- **Every commit on `main` is expected to be a place someone could safely stop.** Nothing here
  knows who is running it or how; what this repository owes anyone operating this code is that its
  own gates — lint, types, tests, coverage floors, boundaries — actually ran and passed.

## The boundary test (CONSTITUTION §7)

**A concept the core does not need does not live in the core.** Apply it as a test, not a list.

- Genuinely core: tenant isolation, anchoring, review/sign-off, suggestions, the MCP and HTTP
  transports, org-scoped self-administration, the tier/quota domain logic (a self-hosted org runs
  with unlimited ceilings, so it is inert rather than crippling).
- Not core: billing, payment providers, subscription lifecycle, a cross-org staff console, a
  specific cloud's IaC.
- Where the core genuinely must state a fact a deployment may act on, it states the **bare
  fact** through a narrow port it owns and defaults to a no-op. `SeatSyncPort.onSeatsChanged(org,
humanMemberCount)` is the worked example: no billable seats, no customers, no subscriptions
  appear in it — not a port, not a stub, not a null object; the concept simply does not appear.
- Extension is a designed seam, never a patch: `ServerExtension`
  (`packages/api/src/server-extension.ts`) exposes three registration positions differing in which
  core guards have already run. The core keeps ownership of that placement deliberately, so an
  extension cannot accidentally register outside the session guard when it meant to be inside it.

## Hard rules (full text in CONSTITUTION.md)

- Tenant isolation is DB-enforced: RLS + `withTenant()` is the only query path; FKs between tenant
  tables are composite `(id, org_id)` — FK checks bypass RLS, plain FKs leak. This is Core
  Principle 1 and a cross-tenant leak is the worst-case failure of this product.
- Comments never lie: version-pinned anchors, confidence-scored re-anchoring, orphan honestly below
  0.6. This extends to what you write _about_ the code — a stale doc or tool description is the
  same failure at a different surface.
- No org data in logs: opaque IDs only.
- Blob storage keys are always derived from a typed `VersionKey{orgId, documentId, seq}` fed by
  tenant context — no function ever accepts a raw storage key/path from outside.
- `share_grants.permission` is `read | comment | share | edit` (ADR 0008, ADR 0014). `share` buys
  creating/revoking grants, capped at the grantor's own held level (`canDelegate`); `edit` buys new
  versions and inherits `share` by lattice. Document management (delete/archive/move, resolve,
  review requests, suggestion accept/reject) stays owner-or-org-admin on `canManageDocument`.
  Guests and share links are capped by explicit allowlists (`'read' | 'comment'`), never a denylist
  — a denylist silently admits every new rung the lattice grows.
- Migrations are expand-only and forward-only (ADR 0006). Never renumber one; every prior
  migration is presumed already applied somewhere.
- Every change merges green: `pnpm verify` (lint, format, typecheck, dependency-cruiser boundaries,
  tests with the coverage floors, and a generated-docs drift check via `pnpm docs:check`).
- Money paths — quota, retention, permissions, isolation — get Gherkin in `features/`
  (@amiceli/vitest-cucumber; the peer warning against vitest 3 is known and fine).

## Environment

- Local Postgres via Homebrew, trust auth on the socket; **no Docker required**. Integration tests
  create an ephemeral database per run (`createTestDb` in `@mdloop/persistence/test-support`;
  `TEST_DATABASE_URL` overrides). ADR 0005 is explicit that RLS is proven against a real database,
  never a mock, and that LocalStack/fake-AWS is not used.
- Local blob storage is a filesystem adapter. An S3-compatible adapter exists behind the same port
  (MinIO and friends work); no emulator is needed for development.
- Auth sits behind `AuthPort`. Tests use a fake; there is no requirement to hold provider keys to
  work on this repository.

## Docs that travel with a change

| Change touches...                                      | Update                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| A shipped capability, or something deliberately absent | `docs/STATUS.md`                                            |
| A newly-discovered or newly-closed risk                | `docs/RISKS.md`                                             |
| System diagram, package layout, port boundaries        | `docs/ARCHITECTURE.md`                                      |
| Anything a self-hoster runs, configures, or upgrades   | `SELF_HOSTING.md`, `.env.example` / `.env.selfhost.example` |
| An exported symbol, `ServerDeps`, or `ServerExtension` | say "breaking" in the commit; it is public API              |
| A CONSTITUTION §1–7 deviation                          | new ADR in `docs/adr/` (§8.5) — needs an explicit human OK  |
| MCP tool set or CLI usage text                         | `pnpm gen:docs`, and check `pnpm docs:check` passes         |

## Working notes

- **This repository may be checked out as a git submodule inside someone else's pnpm workspace.**
  If you are working in such a checkout (no `node_modules` here of its own), do NOT run
  `pnpm install` in it: the nested tree shadows the parent's resolution and a test inside a package
  here will load a second instance of `@amiceli/vitest-cucumber`, failing with `No test suite found
in file`. Develop this repo in a standalone clone instead, where installing is exactly right.

- Do not add a `docs/PLAN.md`, `docs/PRICING.md` or `docs/PRODUCTION_READINESS.md` here — none of
  those belong in this repository. `docs/STATUS.md` is this repo's equivalent of a plan document.
- CI: `.github/workflows/ci.yml`. If a run shows a red X with **zero jobs and zero duration**, the
  workflow file failed to parse — that is not a test failure, and there is no log to open. It
  happened once already: `fetch-depth` used `github.event.pull_request.commits + 1`, and the
  GitHub Actions expression language has no arithmetic operators, so no job in the file ran for the
  file's entire lifetime. Check `gh run view <id> --json jobs` before debugging anything else.
