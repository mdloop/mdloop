#!/usr/bin/env node
// pnpm rename <identifier> [--display "<Name>"] [--dry-run]
//
// Rewrites every tracked file's content and path from the current product
// identifier to a new one, across three case forms (lower/Title/UPPER), plus
// the display name used in website copy (site.config.ts's {{PRODUCT}} token
// system, unrelated to this mechanism). See docs/adr and the rename plan for
// why this is safe pre-launch and frozen at first prod deploy.
//
// State lives in .product-identifier.json (git-tracked) so re-runs know what
// to replace *from*, not just what to replace *to* — this is what makes
// `pnpm rename foo && pnpm rename collab` idempotent.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE_PATH = path.join(ROOT, '.product-identifier.json');
// Neither infra/ nor website/ exists in this repository (CONSTITUTION §7 —
// cloud IaC and the marketing/docs site belong to the deployment, not the
// core) — every use of these two paths below is existsSync-guarded and
// no-ops here. Left in place because this script is generic rename tooling
// a deployment repo that *does* have an infra/ or website/ tree can reuse
// as-is; the guards are what make that safe rather than a silent no-op that
// masquerades as success.
const CDK_JSON_PATH = path.join(ROOT, 'infra', 'cdk.json');
const SITE_CONFIG_PATH = path.join(ROOT, 'website', 'site.config.ts');

// Never text-rewritten or path-renamed, regardless of content. The two
// scripts are excluded because they talk *about* prior identifiers as
// historical facts (e.g. "the repo's first identifier was baton") — a blind
// content rewrite would mangle that history instead of just updating current
// state, which is what .product-identifier.json is for.
const EXCLUDED_PATHS = new Set([
  'pnpm-lock.yaml',
  'scripts/dev/rename.mjs',
  'scripts/dev/check-rename-consistency.mjs',
]);

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const displayIdx = args.indexOf('--display');
  const display = displayIdx !== -1 ? args[displayIdx + 1] : undefined;
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--display');
  const identifier = positional[0];
  return { identifier, display, dryRun };
}

function fail(message) {
  console.error(`rename: ${message}`);
  process.exit(1);
}

function checkCleanGitStatus() {
  const status = git(['status', '--porcelain']);
  if (status.trim().length > 0) {
    fail(
      'refusing to run with a dirty working tree — the rename must be reviewable as its own diff.\n' +
        'Commit or stash your current changes first.',
    );
  }
}

function checkNotProdDeployed() {
  if (!existsSync(CDK_JSON_PATH)) return;
  const cdkJson = JSON.parse(readFileSync(CDK_JSON_PATH, 'utf8'));
  if (cdkJson.context?.prodDeployed === true) {
    fail(
      'refusing to run — infra/cdk.json marks context.prodDeployed: true.\n' +
        'Identifiers are frozen the moment production infrastructure exists ' +
        '(AWS resource names, DB roles, and the CDK bootstrap qualifier are not ' +
        'cheaply renameable once real data depends on them).',
    );
  }
}

// npm scope, Postgres unquoted identifier, S3 bucket-name-prefix, and the
// 10-char CDK bootstrap qualifier (identifier + "01" suffix) all intersect at:
// lowercase, starts with a letter, alphanumeric only, 3-8 characters.
const IDENTIFIER_RE = /^[a-z][a-z0-9]{2,7}$/;

function validateIdentifier(id) {
  if (!id) {
    fail(
      'usage: pnpm rename <identifier> [--display "<Name>"] [--dry-run]\n' +
        'example: pnpm rename collab --display "Collab"',
    );
  }
  if (!IDENTIFIER_RE.test(id)) {
    fail(
      `"${id}" is not a valid identifier — must be 3-8 lowercase letters/digits, ` +
        'starting with a letter (intersection of npm scope, Postgres identifier, ' +
        'S3 bucket-prefix, and CDK bootstrap-qualifier rules — the qualifier is ' +
        '<identifier>01, capped at 10 characters).',
    );
  }
}

function loadState() {
  if (!existsSync(STATE_PATH)) {
    // First-ever run: the repo's actual current identifier is "baton".
    return { identifier: 'baton', display: 'Baton' };
  }
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * @param {string} identifier
 * @returns {{ lower: string, title: string, upper: string }}
 */
function buildForms(identifier) {
  return {
    lower: identifier,
    title: capitalize(identifier),
    upper: identifier.toUpperCase(),
  };
}

function listTrackedFiles() {
  return git(['ls-files'])
    .split('\n')
    .filter(Boolean)
    .filter((p) => !EXCLUDED_PATHS.has(p));
}

// A bare substring rewrite is wrong, and has drawn blood twice: "collab" is a
// literal prefix of "collaborator"/"collaboration"/"collaborative" — ordinary
// English words that are everywhere in a *collaboration* tool's own comments,
// docs, and identifiers — so a blind split/join silently mangled 92 of them
// into "chevronorator" and friends, including `TierCeilings.maxCollaborators`
// and the `maxCollaborators` field on `GET /org/usage`, a live API contract.
// Nothing caught it: the mangling is self-consistent, so it compiles, tests
// pass, and `brand-check` sees no stale identifier.
//
// The fix is a word-boundary lookahead, tuned per case form rather than one
// blanket rule, because the boundary means something different in each:
//
//   lower/title — reject only a following LOWERCASE letter. That protects
//     "collaborator" (…b + "orator") while still renaming the camelCase and
//     delimiter forms the identifier legitimately takes: `CollabMark`
//     (following "M" is uppercase), `collab_login`, `@collab/domain`,
//     `collab-dev`.
//   upper — reject any following letter. SCREAMING_SNAKE never continues a
//     word without a delimiter, so `COLLAB_DB` is unaffected, while a
//     hypothetical `MAX_COLLABORATORS` is protected.
/**
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} content
 * @param {{ lower: string, title: string, upper: string }} fromForms
 * @param {{ lower: string, title: string, upper: string }} toForms
 * @returns {string}
 */
function replaceAllForms(content, fromForms, toForms) {
  const swap = (text, from, to, lookahead) =>
    text.replace(new RegExp(`${escapeRegExp(from)}${lookahead}`, 'g'), to);

  return [
    [fromForms.upper, toForms.upper, '(?![A-Za-z])'],
    [fromForms.title, toForms.title, '(?![a-z])'],
    [fromForms.lower, toForms.lower, '(?![a-z])'],
  ].reduce((text, [from, to, lookahead]) => swap(text, from, to, lookahead), content);
}

function rewriteContents(files, fromForms, toForms, dryRun) {
  let changed = 0;
  for (const file of files) {
    const full = path.join(ROOT, file);
    let content;
    try {
      content = readFileSync(full, 'utf8');
    } catch {
      continue; // not readable as utf8 (shouldn't happen — repo has no tracked binaries today)
    }
    const rewritten = replaceAllForms(content, fromForms, toForms);
    if (rewritten !== content) {
      changed++;
      if (!dryRun) writeFileSync(full, rewritten, 'utf8');
    }
  }
  return changed;
}

function renamePaths(files, fromForms, toForms, dryRun) {
  const moves = [];
  for (const file of files) {
    const renamed = replaceAllForms(file, fromForms, toForms);
    if (renamed !== file) moves.push([file, renamed]);
  }
  for (const [from, to] of moves) {
    const toFull = path.join(ROOT, to);
    if (existsSync(toFull) && !moves.some(([f]) => f === to)) {
      fail(`rename collision: ${from} -> ${to}, but ${to} already exists and isn't also moving.`);
    }
  }
  if (!dryRun) {
    for (const [from, to] of moves) {
      mkdirSync(path.dirname(path.join(ROOT, to)), { recursive: true });
      git(['mv', from, to]);
    }
  }
  return moves;
}

function updateSiteConfigDisplay(display, dryRun) {
  if (!display) return false;
  if (!existsSync(SITE_CONFIG_PATH)) return false;
  const content = readFileSync(SITE_CONFIG_PATH, 'utf8');
  const rewritten = content.replace(/productName:\s*'[^']*'/, `productName: '${display}'`);
  if (rewritten !== content && !dryRun) {
    writeFileSync(SITE_CONFIG_PATH, rewritten, 'utf8');
  }
  return rewritten !== content;
}

// The FsStorage dev-blob directory (packages/api/src/main.ts,dev-main.ts:
// `.${identifier}-blobs`) is gitignored, so it's invisible to
// listTrackedFiles() — but its *name* still embeds the identifier, and
// .gitignore's own pattern for it gets rewritten by the content pass above.
// Left alone, the old directory silently falls out of .gitignore coverage
// (the pattern now names the new directory) and the next `git add -A` picks
// up months of local dev blobs as newly-tracked files. Rename it on disk,
// not via `git mv` — it was never tracked.
function renameLocalArtifactDirs(fromForms, toForms, dryRun) {
  const from = path.join(ROOT, `.${fromForms.lower}-blobs`);
  const to = path.join(ROOT, `.${toForms.lower}-blobs`);
  if (!existsSync(from) || existsSync(to)) return false;
  if (!dryRun) renameSync(from, to);
  return true;
}

function writeState(identifier, display, dryRun) {
  if (dryRun) return;
  writeFileSync(
    STATE_PATH,
    JSON.stringify({ identifier, display: display ?? capitalize(identifier) }, null, 2) + '\n',
    'utf8',
  );
}

function main() {
  const { identifier, display, dryRun } = parseArgs(process.argv);
  validateIdentifier(identifier);
  // The clean-tree requirement is about the real run being reviewable as its
  // own diff — a --dry-run touches nothing, so it's safe (and useful) to run
  // it against a dirty tree, e.g. while other work is in flight.
  if (!dryRun) checkCleanGitStatus();
  checkNotProdDeployed();

  const state = loadState();
  if (state.identifier === identifier) {
    console.log(`rename: already "${identifier}" — nothing to do.`);
    return;
  }

  const fromForms = buildForms(state.identifier);
  const toForms = buildForms(identifier);
  const files = listTrackedFiles();

  console.log(
    `rename: ${state.identifier} -> ${identifier} across ${files.length} tracked files` +
      (dryRun ? ' (dry run — no changes written)' : ''),
  );

  const changedContent = rewriteContents(files, fromForms, toForms, dryRun);
  const moves = renamePaths(files, fromForms, toForms, dryRun);
  const displayChanged = updateSiteConfigDisplay(display, dryRun);
  const localBlobsRenamed = renameLocalArtifactDirs(fromForms, toForms, dryRun);

  console.log(`  content rewritten: ${changedContent} file(s)`);
  console.log(`  paths renamed: ${moves.length}`);
  for (const [from, to] of moves) console.log(`    ${from} -> ${to}`);
  if (localBlobsRenamed) {
    console.log(
      `  local dev blob dir: .${fromForms.lower}-blobs -> .${toForms.lower}-blobs (untracked, renamed on disk)`,
    );
  }
  if (display) {
    console.log(
      displayChanged
        ? `  website/site.config.ts productName -> "${display}"`
        : '  website/site.config.ts unchanged (already set, or file missing)',
    );
  }

  if (dryRun) {
    console.log('\nDry run — no files were changed.');
    return;
  }

  writeState(identifier, display, dryRun);

  console.log(
    '\nDone. Not run automatically — do these next:\n' +
      '  1. pnpm verify\n' +
      '  2. make db-reset && make dev        (Postgres role names changed)\n' +
      '  3. if dev is currently deployed to AWS: tear it down and redeploy\n' +
      '     (every AWS resource name embeds the old identifier)\n',
  );
}

// Guarded so the module can be imported by a test without performing a rename.
// `replaceAllForms` is the one piece with real, twice-bitten logic in it
// (see its comment); everything else here is filesystem plumbing.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export { replaceAllForms, buildForms };
