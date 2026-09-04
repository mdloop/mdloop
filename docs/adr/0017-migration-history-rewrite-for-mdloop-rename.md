# ADR 0017 — Migration history rewrite for the mdloop rename

- Status: Accepted (2026-09-04, explicit OK per CONSTITUTION §8.5 — approved as part of the
  rename plan before execution began)
- Date: 2026-09-04
- Deciders: Jasdeep (product)
- Relates to: CONSTITUTION.md §1 Core Principle 6, ADR 0006 (expand/contract, forward-only
  migrations)

## Context

ADR 0006 and CONSTITUTION Core Principle 6 require migrations to be forward-only and
backward-compatible: never renumbered, never rewritten, contract steps deferred until nothing
reads the old shape. That rule exists to protect a database that has already applied prior
migrations — rewriting `0001_core_schema.sql` in place is only safe if no such database exists
anywhere.

The 2026-09-04 rename to `mdloop` needed exactly that kind of rewrite. Four Postgres role names baked
into the literal SQL of 17 of the repository's migrations had to move to match the new identifier.
Two things make this specific case safe to treat as an exception rather than a forward migration:

- **`packages/persistence/src/migrate.ts` tracks applied migrations by filename only** — there is
  no checksum column in `schema_migrations`. A content edit to an already-numbered migration file
  is invisible to `migrate()`: it does not detect the file changed, does not re-run it, and does
  not fail. Renaming the roles inside `0001_core_schema.sql` is a **silent no-op** against any
  database that has already run it — the running database keeps its old role names regardless of
  what the file on disk now says. A forward migration (`ALTER ROLE ... RENAME TO ...`) would be the
  normal, safe way to change a role name without this gap — but only if preserving continuity with
  an existing installed base actually matters here.
- **It doesn't, because the install base is ≈0.** The product had been public for about 24 hours
  with effectively no downloads and no downstream dependents at rename time. The only database
  this decision actually affects is this machine's own local dev database.

Given that, the forward-migration path would add a permanent migration (`ALTER ROLE ... RENAME TO
...` × 4) whose only purpose is carrying a zero-user install base across a rename, while leaving
the other 16 migrations' literal SQL permanently referencing a retired product identifier for the
life of the repository. That is a worse outcome than the CONSTITUTION's default rule is designed
to prevent.

## Decision

**Rewrite the 17 migrations' role names in place** (via the same mechanical rename pass that
rewrote the rest of the tree), rather than shipping a forward `ALTER ROLE ... RENAME` migration.
This is a deliberate, one-time deviation from ADR 0006 / Core Principle 6, justified only by the
install-base argument above — **not** a precedent for rewriting migrations in general. Any future
role, table, or column rename ships as a forward migration per ADR 0006 as normal; this exception
does not reopen that rule.

Consequence for local state: `make db-reset && make dev` is required after this change on any
machine with an existing local database, since the running database's roles do not update
themselves. There is no production or shared database affected — self-hosters pulling this repo
fresh get the renamed roles from a clean `migrate()` run with no discontinuity to bridge.

## Consequences

- `schema_migrations`' filename-only tracking (no checksum) remains a known gap — this ADR does
  not close it, it just documents a case where the gap made an otherwise-forbidden rewrite
  detectably safe rather than detectably dangerous. If a checksum column is ever added, this kind
  of in-place rewrite would need to become a hash-reconciliation step instead of a silent edit.
- A future product rename, if the install base is no longer ≈0 by then, does not get this
  exception automatically — it goes through §8.5 again on its own facts.
