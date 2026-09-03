import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.test.tsx',
      // Cross-package integration: outside packages/, so exempt from the
      // dependency-cruiser boundary graph (ARCHITECTURE.md §9 parity gate).
      'test/**/*.test.ts',
      // NOTE: an `infra/test/**/*.test.ts` entry used to sit here, for CDK
      // synth-time template tests. There is no `infra/` in this repository —
      // cloud IaC belongs to whoever deploys this core, not to the core
      // (CONSTITUTION §7) — so the glob matched zero files. Removed rather
      // than left dangling: a test-discovery glob that matches nothing is
      // indistinguishable from one whose tests all pass.
    ],
    coverage: {
      provider: 'v8',
      // domain + app carry the 95% floor (CONSTITUTION.md §3, untouched).
      // api/persistence/mcp are newly visible here (2026-08-03) with a lower
      // floor grounded in what they measure today — see the per-glob
      // thresholds below for why 80, not domain/app's 95.
      // web/cli/jobs/shared stay unfloored: no established convention yet
      // for how much of them is meaningfully unit-testable (web leans on
      // Playwright, cli/jobs are thin process wiring) — revisit on demand
      // rather than forcing a number that doesn't mean anything today.
      include: [
        'packages/domain/src/**',
        'packages/app/src/**',
        'packages/api/src/**',
        'packages/persistence/src/**',
        'packages/mcp/src/**',
      ],
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        '**/test-support/**',
        // Process entrypoints: wiring only (arg parsing, adapter
        // construction, listen()), exercised by e2e/manual smoke rather than
        // unit tests. Matches main.ts, dev-main.ts, e2e-main.ts,
        // stdio-main.ts.
        '**/*main.ts',
        // Real third-party adapter with no credentials configured in any
        // environment (CLAUDE.md "Environment": WorkOS keys not yet set
        // up). Tests exercise the fake AuthPort instead, so this is
        // structurally untested until Phase 10 wires up real keys — not a
        // coverage gap to chase today. (Its billing sibling,
        // stripe.adapter.ts, went with the whole billing vertical in the S4
        // billing-removal spike — nothing left to exclude here for it.)
        'packages/api/src/auth/workos.adapter.ts',
      ],
      thresholds: {
        'packages/domain/src/**': { lines: 95, branches: 95, functions: 95, statements: 95 },
        'packages/app/src/**': { lines: 95, branches: 95, functions: 95, statements: 95 },
        // api/persistence/mcp: newly gated (2026-08-03). Measured actuals
        // with the excludes above applied were uneven per package/metric —
        // a single flat 80 across all three would have failed on day one
        // (persistence lines were 75.56%, mcp branches 67.9%) — so each
        // floor below is that package's real number minus a ~4-6 point
        // margin, not a round target picked in advance. Ratchet up
        // per-package as coverage improves; re-measure with
        // `pnpm exec vitest run --coverage --coverage.include='packages/<pkg>/src/**' --coverage.reporter=text-summary`.
        //   api/src:         lines/stmts 89.94%, branches 81.92%, functions 92.4%
        'packages/api/src/**': { lines: 85, branches: 78, functions: 88, statements: 85 },
        //   persistence/src: lines/stmts 75.56%, branches 88.21%, functions 86.14%
        'packages/persistence/src/**': { lines: 72, branches: 84, functions: 82, statements: 72 },
        //   mcp/src:         lines/stmts 83.69%, branches 67.9%,  functions 85.71%
        'packages/mcp/src/**': { lines: 80, branches: 62, functions: 80, statements: 80 },
        // A coverage glob that has been retired is deleted here, not left
        // dangling: a glob matching zero files silently reports as passing,
        // which reads identically to "well covered."
      },
      reporter: ['text', 'text-summary'],
    },
  },
});
