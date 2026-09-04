import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.d.ts',
      '**/*.d.mts',
      'coverage/**',
      'scripts/load/**',
      '.claude/worktrees/**',
      // NOTE: a `spikes/**` entry and a `website/**` entry (for an
      // Astro/Starlight site whose own `check` script covered it, exempting
      // it from strictTypeChecked + projectService) used to sit here.
      // Neither directory exists in this repository — `spikes/` was a
      // private-repo-only research area, `website/` belongs to the
      // deployment, not the core (CONSTITUTION §7). scripts/gen-docs/ is
      // plain TS and deliberately NOT ignored here.
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
    },
  },
  {
    files: [
      '**/*.mjs',
      '**/*.cjs',
      '**/vite.config.ts',
      '**/vitest.config.ts',
      'playwright.config.ts',
      'e2e/**/*.ts',
    ],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { globals: { module: 'writable', require: 'readonly' } },
  },
  {
    // scripts/gen-docs/: CLI-style generator scripts — same console-output
    // shape the removed infra/lambda carve-out used (progress/diagnostic output
    // is the point, not a bug to catch).
    files: ['scripts/gen-docs/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // scripts/*.mjs + scripts/dev/*.mjs + scripts/release/*.mjs — operational
    // tooling (rename, brand-check, the npm-package build/verify scripts),
    // same shape as the removed infra/lambda carve-out below: plain Node
    // runtime scripts, not bundled/transpiled, console output is the point.
    files: ['scripts/*.mjs', 'scripts/dev/*.mjs', 'scripts/release/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        AbortSignal: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      // scripts/dev/rename.mjs exports functions for other scripts to import
      // (a shared module, not a standalone CLI) — plain JS with no
      // .d.ts/JSDoc type surface to satisfy this TS-authoring rule, same
      // reasoning the removed infra/lambda carve-out used to give.
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  // NOTE: an `infra/lambda/**/*.mjs` config block used to sit here, for AWS
  // Lambda handlers. There is no `infra/` in this repository — cloud IaC
  // belongs to whoever deploys this core, not to the core (CONSTITUTION §7) —
  // so the block matched zero files. Removed rather than left dangling.
  prettier,
);
