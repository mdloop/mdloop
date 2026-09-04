#!/usr/bin/env node
/**
 * Builds `packages/mdloop/dist` — the published npm package's payload.
 *
 * Bundles exactly three entry points (`cli/main.js`, `api/selfhost-embedded-
 * main.js`, `mcp/selfhost-embedded-main.js`) with esbuild, using one rule for
 * what gets inlined: every `@mdloop/*` specifier is bundled, every other bare
 * specifier stays external. That is what makes the published npm surface
 * exactly one package — the internal `@mdloop/*` names vanish into the
 * output and never appear in a registry manifest — and it is what lets
 * `@electric-sql/pglite` (wasm + path-loaded `.tar.gz` extension bundles)
 * and `open` (resolves `xdg-open` off its own `import.meta.url`) keep
 * working: neither would survive being bundled.
 *
 * Bundles from `tsc` output (`packages/*\/dist/*.js`), not `.ts` source, so
 * the published artifact is byte-derived from the exact compiler output
 * `pnpm test`/`pnpm boundaries`/e2e already ran against — esbuild does no
 * typechecking of its own.
 *
 * `splitting: false` is not a style choice: `packages/persistence/src/
 * migrate.ts`'s `new URL('../migrations', import.meta.url)`,
 * `packages/api/src/serve-web-spa.ts`'s `webDistCandidates()`, and
 * `packages/cli/src/serve.ts`'s `resolveSelfEntrypoint()` all depend on
 * `import.meta.url` pointing at *their own* file. Code splitting would
 * relocate that code into a separate chunk file and silently break every
 * one of those relative-path lookups with no compile-time signal.
 *
 * `absWorkingDir` is set to the repo root so source maps hold repo-relative
 * paths — without it, esbuild writes the machine's real absolute path
 * (e.g. `/Users/<name>/...`) into every shipped `.js.map`, which is a real
 * privacy leak to the public registry, not a cosmetic one.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, chmodSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const mdloopPkgDir = path.join(repoRoot, 'packages', 'mdloop');
const outDir = path.join(mdloopPkgDir, 'dist');

function fail(message) {
  console.error(`build-dist: ${message}`);
  process.exit(1);
}

// 1. The web SPA must already be built — this script never runs `vite
//    build` itself, matching `assertWebSpaBuilt`'s own posture of naming the
//    fix rather than doing it silently on the caller's behalf.
const webIndexHtml = path.join(repoRoot, 'packages', 'web', 'dist', 'index.html');
if (!existsSync(webIndexHtml)) {
  fail(
    `no built web SPA at ${webIndexHtml}. Run "pnpm build" first — "pnpm typecheck" alone only ` +
      'emits .d.ts files for @mdloop/web, never the actual "vite build" output.',
  );
}

// 2. Clean, forced tsc rebuild of every package. Forced, and preceded by an
//    explicit rm -rf, because `tsc --build`'s incremental mode never deletes
//    orphaned output — `packages/cli/dist` has, at various points in this
//    repo's history, held stale artifacts (e.g. a prior product name's
//    compiled files) with no corresponding source, which `--force` alone
//    does not clear. Bundling from a `dist/` that could contain that kind of
//    leftover is exactly the failure this step exists to rule out.
//
//    `packages/web/dist` is deliberately EXCLUDED from this cleanup — it is
//    not purely tsc output. `@mdloop/web`'s tsconfig sets
//    `emitDeclarationOnly`, so Vite's `pnpm build` (checked for above) and
//    `tsc --build` both write into the *same* directory: Vite produces
//    `index.html`/`assets/`, tsc adds `.d.ts` files alongside them. Wiping
//    that directory here would delete the Vite output this script's own
//    first check just confirmed exists, and `tsc --build --force` would
//    then silently repopulate it with `.d.ts` files only — recreating,
//    inside this script, the exact "directory exists but has no
//    index.html" trap `assertWebSpaBuilt`/`resolveWebDist` exist to catch.
//    (Found by running this script for real, not reasoned out in advance —
//    left as a comment because the failure mode is non-obvious.)
console.log('build-dist: clean rebuild via tsc --build --force...');
for (const entry of readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === 'web') continue;
  rmSync(path.join(repoRoot, 'packages', entry.name, 'dist'), { recursive: true, force: true });
}
rmSync(path.join(repoRoot, 'scripts', 'gen-docs', 'dist'), { recursive: true, force: true });
for (const tsbuildinfo of findTsbuildinfoFiles(repoRoot)) rmSync(tsbuildinfo, { force: true });
execFileSync('pnpm', ['exec', 'tsc', '--build', '--force'], { cwd: repoRoot, stdio: 'inherit' });

function findTsbuildinfoFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findTsbuildinfoFiles(full));
    else if (entry.name.endsWith('.tsbuildinfo')) found.push(full);
  }
  return found;
}

// 3. Bundle. `{ in, out }` entry points (rather than plain path strings) so
//    each of the three lands at the exact nested path the runtime
//    resolution in local-instance.ts / serve-web-spa.ts expects:
//    dist/cli/main.js, dist/api/selfhost-embedded-main.js,
//    dist/mcp/selfhost-embedded-main.js — all siblings one level under
//    `outDir`.
console.log('build-dist: bundling cli, api, and mcp entrypoints...');
rmSync(outDir, { recursive: true, force: true });

/** @type {import('esbuild').Plugin} */
const externalizeThirdParty = {
  name: 'externalize-third-party',
  setup(buildApi) {
    // Any bare specifier (not relative, not absolute) that isn't @mdloop/*
    // stays external — third-party packages (including Node builtins like
    // `node:fs`, which match this filter too) and deep subpaths alike
    // (e.g. `@modelcontextprotocol/sdk/server/streamableHttp.js`).
    buildApi.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('@mdloop/')) return undefined;
      return { path: args.path, external: true };
    });
  },
};

const buildResult = await esbuild.build({
  entryPoints: [
    { in: path.join(repoRoot, 'packages', 'cli', 'dist', 'main.js'), out: 'cli/main' },
    {
      in: path.join(repoRoot, 'packages', 'api', 'dist', 'selfhost-embedded-main.js'),
      out: 'api/selfhost-embedded-main',
    },
    {
      in: path.join(repoRoot, 'packages', 'mcp', 'dist', 'selfhost-embedded-main.js'),
      out: 'mcp/selfhost-embedded-main',
    },
  ],
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  splitting: false,
  sourcemap: true,
  sourcesContent: true,
  absWorkingDir: repoRoot,
  metafile: true,
  logLevel: 'info',
  plugins: [externalizeThirdParty],
});

// 4. SQL migrations — `migrate.ts`'s `new URL('../migrations', import.meta.url)`
//    resolves to `dist/migrations` from all three bundled entrypoints (each
//    sits at `dist/<name>/x.js`, so "one level up" always lands at `dist/`).
const migrationsSrc = path.join(repoRoot, 'packages', 'persistence', 'migrations');
const migrationsDest = path.join(outDir, 'migrations');
cpSync(migrationsSrc, migrationsDest, { recursive: true });

// 5. The built web SPA — `serve-web-spa.ts`'s `webDistCandidates()` looks
//    for `../web` relative to `dist/api/`, i.e. `dist/web` here.
cpSync(path.join(repoRoot, 'packages', 'web', 'dist'), path.join(outDir, 'web'), {
  recursive: true,
});

// 6. License/notice/changelog, and the npm-facing README (not the repo
//    README — that one assumes a git checkout).
cpSync(path.join(repoRoot, 'LICENSE'), path.join(mdloopPkgDir, 'LICENSE'));
cpSync(path.join(repoRoot, 'NOTICE'), path.join(mdloopPkgDir, 'NOTICE'));
cpSync(path.join(repoRoot, 'CHANGELOG.md'), path.join(mdloopPkgDir, 'CHANGELOG.md'));
const npmReadme = path.join(mdloopPkgDir, 'README.npm.md');
if (existsSync(npmReadme)) {
  cpSync(npmReadme, path.join(mdloopPkgDir, 'README.md'));
} else {
  fail(`missing ${npmReadme} — the npm-facing README (distinct from the repo root's).`);
}

// 7. Executable bit on the bin — tsc doesn't preserve it either (root
//    package.json's own `typecheck` script chmods packages/cli/dist/main.js
//    for the exact same reason), and esbuild's bundling doesn't change that.
chmodSync(path.join(outDir, 'cli', 'main.js'), 0o755);

// 8. The metafile — gitignored, consumed by check-external-deps.mjs to
//    verify the published manifest's dependencies/optionalDependencies
//    exactly match what the bundles actually import, and that nothing in
//    `optionalDependencies` is ever a *static* import in any bundle.
writeFileSync(path.join(outDir, '.metafile.json'), JSON.stringify(buildResult.metafile, null, 2));

console.log(`build-dist: done — ${outDir}`);
