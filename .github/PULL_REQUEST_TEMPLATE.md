## What and why

<!-- What changed, and why — especially anything non-obvious a future reader would otherwise have
to re-derive from the diff alone. -->

## Checklist

- [ ] `pnpm verify` passes locally (lint, format, typecheck, dependency-cruiser boundaries, tests
      with the coverage floors — the same gate CI runs).
- [ ] If this touches a CONSTITUTION §1–7 non-negotiable, there's a new ADR in `docs/adr/` with an
      explicit human OK (§8.5). If it doesn't, leave this unchecked and say so.
- [ ] If this changes an **exported symbol** — `ServerDeps`, `ServerExtension`, `ExtensionContext`,
      any port interface, `createTestServer`'s signature, or anything else a package exports — this
      PR says **"breaking"** in its title or description. Anyone self-hosting or integrating this
      repo can depend on it; an export change is a breaking change to that contract, not a local
      refactor, even if nothing in this repo calls it differently.
- [ ] If this adds or changes a migration, it's **expand-only** (additive, safe for the old app
      version to ignore) per ADR 0006 — a destructive change (`DROP COLUMN`, `RENAME`, tightening to
      `NOT NULL`) ships as its own later migration, never combined with the expand step. Migration
      numbers are never renumbered.
- [ ] Docs that travel with this change are updated in the same PR — see CONTRIBUTING.md's
      "Docs that travel with a change" table (`docs/ARCHITECTURE.md`, `docs/design-system.md`,
      `docs/STATUS.md`, `docs/RISKS.md`, `SELF_HOSTING.md`/`.env*.example`, or an ADR) — not filed
      as separate cleanup.
- [ ] Money-path change (tenant isolation, quota, retention, permissions, sharing)? There's a
      `features/*.feature` Gherkin scenario covering it, not just a unit test.

## Anything you're unsure about

<!-- A design choice you're not confident in, a doc row this change might touch that isn't listed
above, an alternative you considered — flag it here rather than deciding silently. -->
