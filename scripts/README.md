# scripts/

## Layout convention

**`dev/`**: repo-developer tooling that is not parameterized by environment — lint/consistency
checks and one-off maintenance scripts run by hand or from CI, never against a specific AWS
account. `check-migration-shape.sh` (ADR 0006 migration-shape gate, run by CI), `rename.mjs` /
`check-rename-consistency.mjs` (the pre-launch product-rename pair).

**`gen-docs/`**: a small standalone TypeScript package (own `package.json`/`tsconfig.json`) that
generates `docs/reference/*.md` from source — CLI usage text and MCP tool descriptions. Run via the
root `pnpm gen:*`/`pnpm docs:check` scripts, not directly.

**`load/`**: load-test scripts (k6) run by hand against a local or live target.

## Adding a new script

Ask which bucket it belongs in: is it environment-agnostic developer tooling? `dev/`. Anything
else, it likely deserves its own subfolder the way `gen-docs/` and `load/` have one.
