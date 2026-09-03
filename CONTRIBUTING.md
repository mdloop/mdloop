# Contributing to Vorlyn

## Before you write code

Read [`CONSTITUTION.md`](CONSTITUTION.md) first — it's short and it's the actual list of
non-negotiables (tenant isolation, comments that never lie about their anchor confidence,
zero-downtime migrations). Then [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the system
shape. A change that deviates from §1–7 needs an ADR (§8.5) — look in `docs/adr/` for precedent
before writing one from scratch.

## Setup

Requires Node ≥22 (see `.nvmrc`) and pnpm. A local Postgres — no Docker needed:

```sh
pnpm install
make dev            # API :3000, web :5173, MCP :3001 — loopback auth, "Sign in" just signs you in
```

## Before opening a PR

```sh
make verify         # lint, format check, typecheck, dependency-cruiser boundaries, tests
```

This is the same gate CI runs. A few things it checks that are easy to miss locally:

- **Coverage floor**: domain and app packages need ≥95% coverage. If you're removing code, check
  this early — deleting tests along with the code they covered can silently drop the average.
- **Dependency boundaries** (`dependency-cruiser`): the hexagonal-architecture layering
  (`domain` → `app` → adapters) is enforced, not just documented. A violation fails CI, not just a
  lint warning.
- **Money-path Gherkin**: tenant isolation, permissions, and retention changes need a
  `features/*.feature` scenario (`@amiceli/vitest-cucumber`), not just a unit test. See existing
  `.feature` files for the pattern.

## Docs that travel with a change

This repo treats several docs as load-bearing, not optional cleanup:

| Change touches...                              | Update                   |
| ---------------------------------------------- | ------------------------ |
| System diagram, client shapes, port boundaries | `docs/ARCHITECTURE.md`   |
| Visual tokens, viewer chrome, design direction | `docs/design-system.md`  |
| A §1–7 deviation                               | A new ADR in `docs/adr/` |

If a change doesn't fit either row and still feels like it needs a doc update, say so in the PR
rather than skipping silently.

## Commit messages

Explain what changed and, more importantly, _why_ — especially for anything non-obvious a future
reader (human or agent) would otherwise have to re-derive from the diff alone. Several ADRs and
`CONSTITUTION.md` sections in this repo exist specifically because a past decision wasn't written
down anywhere else.

## Reporting a security issue

Don't open a public issue — see [`SECURITY.md`](SECURITY.md).

## Code of conduct

See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
