#!/usr/bin/env node
/**
 * `packages/mdloop/package.json`'s `prepublishOnly` guard — the last line
 * before anything reaches the registry. Refuses to publish if `dist/` is
 * missing or incomplete, so no path (a hand-run `npm publish` included) can
 * ship an empty or partial package.
 *
 * Deliberately does NOT run `build-dist.mjs` itself — a publish must never
 * be able to produce a different artifact than the one `pnpm smoke:package`
 * already validated. If this fails, the fix is to run `pnpm build:package`
 * (after `pnpm build`) and re-verify, not to have this script paper over it.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mdloopPkgDir = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  'packages',
  'mdloop',
);
const distDir = path.join(mdloopPkgDir, 'dist');

const required = [
  path.join(distDir, 'cli', 'main.js'),
  path.join(distDir, 'api', 'selfhost-embedded-main.js'),
  path.join(distDir, 'mcp', 'selfhost-embedded-main.js'),
  path.join(distDir, 'web', 'index.html'),
];

const missing = required.filter((p) => !existsSync(p));
if (missing.length > 0) {
  console.error('assert-packed: refusing to publish — missing required build output:');
  for (const p of missing) console.error(`  - ${p}`);
  console.error('\nRun "pnpm build && pnpm build:package" first.');
  process.exit(1);
}

const migrationsDir = path.join(distDir, 'migrations');
const migrationCount = existsSync(migrationsDir)
  ? readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).length
  : 0;
if (migrationCount === 0) {
  console.error(
    `assert-packed: refusing to publish — no .sql migrations found under ${migrationsDir}.`,
  );
  process.exit(1);
}

console.log('assert-packed: dist/ looks complete.');
