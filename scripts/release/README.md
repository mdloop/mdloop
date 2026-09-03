# scripts/release

Tooling for building and verifying the published `vorlyn` npm package
(`packages/vorlyn`). Nothing here runs as part of `pnpm verify` unless noted —
these scripts need `pnpm build` (the Vite SPA) and shell out to `npm`, so they
live in the separate `pnpm verify:release` gate instead.

- `build-dist.mjs` — bundles `packages/cli`, `packages/api`'s and
  `packages/mcp`'s embedded entrypoints, and copies the SPA and SQL
  migrations into `packages/vorlyn/dist`.
- `check-external-deps.mjs` — asserts `packages/vorlyn/package.json`'s
  `dependencies`/`optionalDependencies` exactly match what the bundles
  actually import. Wired into `pnpm verify`.
- `smoke-install.mjs` — packs the tarball, installs it into a clean temp
  directory outside the repo, and drives `vorlyn open` end-to-end against a
  real embedded Postgres, the built SPA, and a live MCP call.
- `assert-packed.mjs` — `prepublishOnly` guard: refuses to publish if
  `dist/` is missing or incomplete.
