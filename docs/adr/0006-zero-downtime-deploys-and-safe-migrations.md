# ADR 0006 — Zero-downtime deploys and backward-compatible migrations

- Status: Accepted (2026-07-20, explicit OK per CONSTITUTION §8.5)
- Date: 2026-07-20
- Deciders: Jasdeep (product)
- Relates to: CONSTITUTION.md §1 (Core Principles 5 & 6, new), §2 (Technology Choices), §5
  (Architecture Invariants)

## Context

A production-readiness audit checks whether a _single_ deploy is correct — lint, coverage, tenant
isolation, secrets. None of that says anything about what happens _during_ a deploy, or across a
sequence of them. Two gaps fell out of that pass:

- **A. Deploy strategy is unspecified.** The core says nothing about _how_ a new version replaces
  an old one at the infrastructure level — that is a deployment's own concern (CONSTITUTION §7) —
  but it must still say what property any conforming deploy strategy has to provide: an in-place
  rolling deploy with no health gate can serve errors from half-started instances; a deploy with no
  fast rollback path turns a bad release into an incident instead of an automatic revert.
- **B. Migrations have no stated compatibility contract.** `packages/persistence/src/migrate.ts` is
  already forward-only, transactional, and tracked in `schema_migrations` — good bones — but nothing
  says a migration must tolerate the _previous_ app version still running against it. A rolling or
  blue-green deploy always has old and new code live simultaneously for some window; a migration that
  only the new code can tolerate (a `NOT NULL` add, a dropped column the old code still selects)
  turns that window into an outage, independent of how careful the deploy mechanism itself is.

Audited the 29 existing migrations against this before writing the rule: zero use `DROP COLUMN`,
`DROP TABLE`, `RENAME COLUMN`, or a blocking `ALTER COLUMN ... SET NOT NULL`. The history is already
compliant — this ADR makes the existing practice load-bearing rather than incidental.

## Decision

**A. Blue-green is the only conforming deploy shape; a deployment provides it.** A new version comes
up as a full new instance set alongside the old, passes health checks, then traffic cuts over. The
old set stays warm for a configured bake time as an instant rollback target — not just a paused
rollout, a live fallback. Auto-rollback on failed health checks or a manual trigger during the bake
window, no human required to restore service. No maintenance windows for routine releases. This core
ships no deploy mechanism of its own (CONSTITUTION §7) — the requirement binds whatever mechanism a
deployment brings.

**B. Expand/contract as the only migration shape.** Every schema change is either:

- **Expand** — additive and safe for the _old_ app version to ignore: a new nullable column, a new
  table, a new index, a new default that doesn't change existing rows' meaning. Ships in the same
  migration as the code that starts using it.
- **Contract** — destructive: `DROP COLUMN`, `DROP TABLE`, `RENAME COLUMN`, tightening a column to
  `NOT NULL`. Ships as its _own_ migration, only after the expand step (and the code depending on the
  old shape) has been fully rolled out and had at least one full deploy cycle to confirm nothing still
  reads or writes the old shape — including anything running against a rolled-back blue environment.

A single migration is never both. This is what makes A and B interact safely: because a blue-green
cutover always has both app versions live for some minutes, "old code + new schema" and "new code +
old schema" both have to work — expand satisfies the first, and contract is deliberately deferred
until the second stops being a possibility.

**Cleanup scripts, for state an expand step leaves behind.** Some expand steps intentionally leave
transitional state — a backfilled column with no `NOT NULL` yet, a dual-write to an old and new
location, rows created under a since-superseded default. Where that cleanup is more than "add a
follow-up contract migration" (e.g., a data-shape cleanup that isn't itself schema DDL, or a
one-time reconciliation job), it ships as an explicit script under `packages/persistence/src/`
(pattern: `cleanup-<what>.ts`, run manually or via `packages/jobs`, never auto-run by `migrate()`) —
named for what it cleans up and which migration it follows, so "why does this script exist" is
answered by its own name and a comment pointing at the migration number. `migrate()` itself stays
forward-only DDL only, per the existing design — cleanup scripts are a separate, explicitly-invoked
mechanism, not folded into the migration runner.

## Consequences

- A deployment's rollout mechanism is designed for blue-green from the start, not retrofitted onto
  an already-live rolling deploy.
- Every future migration PR gets one more review question: "does this work if the previous app
  version is still running against it?" A `NOT NULL` add or a column drop in the same migration as
  the code that needs it is now a review-blocking pattern, not a style preference.
- Contract migrations lag their expand step by at least one full deploy — slower cleanup, but the
  alternative is a migration that can only be safely applied during a maintenance window, which
  Core Principle 5 rules out.
- Deployment strategy and migration safety are two permanent checklist items for anyone standing up
  a production deployment of this core.
