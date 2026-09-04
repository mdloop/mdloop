# test/

Cross-package integration tests — spanning more than one `packages/*` — live here rather than
inside any single package, deliberately outside `packages/`: `pnpm boundaries`
(dependency-cruiser) only graphs `packages/`, so a test asserting a cross-package property (API/MCP
parity, redaction across transports, the rename tool's own word-boundary safety) can import from
several packages without tripping the hexagonal-layering rules those packages enforce on each
other. See `vitest.config.ts`'s `test.include` for where this is wired in.

Has its own `package.json` (`"type": "module"`, no `name` — not a pnpm workspace member) and
`tsconfig.json` (project-referenced from the root `tsconfig.json`, `outDir: dist` like every other
package here) purely so these files typecheck and run as ESM; there is nothing else to build or
publish from this directory.
