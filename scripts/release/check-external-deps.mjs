#!/usr/bin/env node
/**
 * Wired into `pnpm verify:release` (not plain `pnpm verify` — that gate
 * deliberately never builds the web SPA or the npm package, and this script
 * depends on a metafile only `pnpm build:package` produces). Reads
 * `packages/vorlyn/dist/.metafile.json` (written by `build-dist.mjs`) and
 * asserts two things against the hand-written `packages/vorlyn/package.json`:
 *
 *  1. Set equality — every external package actually imported by any of the
 *     three bundles must be declared in `dependencies` or
 *     `optionalDependencies`, and every declared entry must actually be
 *     used by at least one bundle. Also checks each declared version range
 *     is character-identical to whichever `packages/*\/package.json` in
 *     this workspace really depends on it — the manifest is hand-written
 *     specifically so it's diffable and reviewable, and this is what keeps
 *     it from silently drifting out of sync with the packages it's derived
 *     from.
 *  2. The optional-only rule — nothing in `optionalDependencies` may ever
 *     appear as a *static* import (`esbuild`'s `kind: "import-statement"`)
 *     in any bundle; it must be exclusively `dynamic-import`. A static
 *     import of an `optionalDependencies` entry is exactly the failure mode
 *     `s3-storage.ts`/`telemetry/optional-setup.ts` exist to prevent —
 *     `npx vorlyn open` would crash at module-link time the moment that
 *     package is omitted (`npm i --omit=optional`). This is what turns
 *     Phase 2's weight-reduction work into a gate instead of a hope.
 *
 * Offline and sub-second — reads a JSON file already on disk, no network,
 * no bundling of its own.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const vorlynPkgDir = path.join(repoRoot, 'packages', 'vorlyn');
const metafilePath = path.join(vorlynPkgDir, 'dist', '.metafile.json');

const errors = [];

if (!existsSync(metafilePath)) {
  console.error(
    `check-external-deps: no metafile at ${metafilePath} — run "pnpm build:package" first.`,
  );
  process.exit(1);
}

const metafile = JSON.parse(readFileSync(metafilePath, 'utf8'));
const vorlynPkg = JSON.parse(readFileSync(path.join(vorlynPkgDir, 'package.json'), 'utf8'));

const bundleOutputs = Object.entries(metafile.outputs).filter(([file]) => file.endsWith('.js'));
if (bundleOutputs.length === 0) {
  console.error('check-external-deps: metafile has no .js outputs — something is wrong upstream.');
  process.exit(1);
}

/** Bare specifier -> package name: scoped packages keep their first two path
 *  segments (`@scope/name`), everything else keeps just the first. Strips
 *  any deeper subpath (e.g. `@modelcontextprotocol/sdk/server/x.js` ->
 *  `@modelcontextprotocol/sdk`). */
function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** package name -> Set of esbuild import kinds seen across all three bundles
 *  (e.g. {"import-statement"}, {"dynamic-import"}, or both). */
const kindsByPackage = new Map();
for (const [, output] of bundleOutputs) {
  for (const imp of output.imports ?? []) {
    if (!imp.external || imp.path.startsWith('node:')) continue;
    const pkg = packageNameOf(imp.path);
    const kinds = kindsByPackage.get(pkg) ?? new Set();
    kinds.add(imp.kind);
    kindsByPackage.set(pkg, kinds);
  }
}

const usedPackages = new Set(kindsByPackage.keys());
const declaredDeps = vorlynPkg.dependencies ?? {};
const declaredOptionalDeps = vorlynPkg.optionalDependencies ?? {};
const declaredPackages = new Set([
  ...Object.keys(declaredDeps),
  ...Object.keys(declaredOptionalDeps),
]);

// Check 1a — used but undeclared.
for (const pkg of usedPackages) {
  if (!declaredPackages.has(pkg)) {
    errors.push(
      `"${pkg}" is imported by the bundled output but not declared in packages/vorlyn/package.json's ` +
        `dependencies or optionalDependencies.`,
    );
  }
}

// Check 1b — declared but unused (dead weight in the published tarball).
for (const pkg of declaredPackages) {
  if (!usedPackages.has(pkg)) {
    errors.push(
      `"${pkg}" is declared in packages/vorlyn/package.json but no bundle actually imports it — ` +
        `remove it, or find what's supposed to use it.`,
    );
  }
}

// Check 1c — version ranges character-identical to the workspace package
// that really depends on each external package (search every package.json
// under packages/*, dependencies only — not devDependencies, which aren't
// what ships).
const workspacePackagesDir = path.join(repoRoot, 'packages');
for (const pkgName of usedPackages) {
  if (!declaredPackages.has(pkgName)) continue; // already reported above
  const declaredRange = declaredDeps[pkgName] ?? declaredOptionalDeps[pkgName];
  const sourceRange = findSourceVersionRange(workspacePackagesDir, pkgName);
  if (sourceRange === undefined) {
    errors.push(
      `"${pkgName}" is declared in packages/vorlyn/package.json (range "${declaredRange}") but no ` +
        `packages/*/package.json in this workspace lists it as a real dependency to check that ` +
        `range against.`,
    );
  } else if (sourceRange !== declaredRange) {
    errors.push(
      `"${pkgName}" version range mismatch: packages/vorlyn/package.json says "${declaredRange}", ` +
        `the workspace package that depends on it says "${sourceRange}".`,
    );
  }
}

function findSourceVersionRange(packagesDir, pkgName) {
  for (const entry of readAllPackageJsons(packagesDir)) {
    if (entry.name === 'vorlyn') continue;
    const range = entry.dependencies?.[pkgName];
    if (range !== undefined) return range;
  }
  return undefined;
}

function readAllPackageJsons(packagesDir) {
  const results = [];
  for (const dirName of readdirNames(packagesDir)) {
    const pkgJsonPath = path.join(packagesDir, dirName, 'package.json');
    if (existsSync(pkgJsonPath)) results.push(JSON.parse(readFileSync(pkgJsonPath, 'utf8')));
  }
  return results;
}

function readdirNames(dir) {
  return existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];
}

// Check 2 — the optional-only rule.
for (const pkgName of Object.keys(declaredOptionalDeps)) {
  const kinds = kindsByPackage.get(pkgName);
  if (kinds?.has('import-statement')) {
    errors.push(
      `"${pkgName}" is in optionalDependencies but is statically imported ("import-statement") in ` +
        `at least one bundle — this would crash "npx vorlyn open" at boot the moment it's omitted ` +
        `("npm i --omit=optional"). It must only ever be reached via a bare, direct ` +
        `"await import('${pkgName}')" — see s3-storage.ts's or telemetry/optional-setup.ts's doc ` +
        `comment for why indirection through a first-party module doesn't work.`,
    );
  }
}

if (errors.length > 0) {
  console.error('check-external-deps: FAILED\n');
  for (const error of errors) console.error(`  - ${error}`);
  console.error(`\n${errors.length} problem(s).`);
  process.exit(1);
}

console.log(
  `check-external-deps: ${usedPackages.size} external package(s) across ${bundleOutputs.length} ` +
    'bundle(s), all declared, versions match, optional-only rule holds.',
);
