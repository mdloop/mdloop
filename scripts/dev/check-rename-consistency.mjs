#!/usr/bin/env node
// pnpm brand-check: after a rename, no literal occurrence of a prior product
// identifier should remain anywhere in tracked source — the rename script's
// job is to leave zero trace, not "mostly zero." Wired into `pnpm verify` so
// a rename that missed a spot fails CI rather than rotting quietly.
//
// Real leftovers aren't the only reason a stale identifier appears, though:
// docs legitimately talk *about* a prior identifier defensively/historically
// (e.g. "not `baton_login` — that name is stale, doesn't exist") — same
// reasoning rename.mjs already applies to itself and to this file
// (EXCLUDED_PATHS below): a blind rewrite/flag would mangle or false-positive
// on history instead of catching what this check actually exists to catch.
// The current identifier isn't settled yet (still a placeholder), so this
// isn't a one-off: every future rename will produce more of this same class
// of intentional mention. Whole-file exemptions would be the wrong shape for
// that — they'd blind the check to a genuine leftover landing in the same
// file later. Instead, mark the exact line: any line containing the inline
// marker below is allowed to also contain the stale identifier; every other
// occurrence still fails the check, file included.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOW_MARKER = 'brand-check:allow';

const ROOT = path.join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE_PATH = path.join(ROOT, '.product-identifier.json');

// Every identifier this repo has ever actually shipped under. Extend this
// list if a future rename needs to retire another identifier from history.
const KNOWN_PRIOR_IDENTIFIERS = ['baton', 'collab', 'chevron', 'vorlyn'];

const SELF = path.relative(ROOT, fileURLToPath(import.meta.url));
// rename.mjs is excluded from the rename rewrite itself (it describes prior
// identifiers as history, e.g. "the repo's first identifier was baton"), so
// it will always mention retired identifiers by design — exclude it here too.
const EXCLUDED_PATHS = new Set(['pnpm-lock.yaml', SELF, 'scripts/dev/rename.mjs']);

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function currentIdentifier() {
  if (!existsSync(STATE_PATH)) return 'baton';
  return JSON.parse(readFileSync(STATE_PATH, 'utf8')).identifier;
}

const identifier = currentIdentifier();
const staleIdentifiers = KNOWN_PRIOR_IDENTIFIERS.filter((id) => id !== identifier);

if (staleIdentifiers.length === 0) {
  console.log('brand-check: no prior identifiers to check for (nothing has ever been renamed).');
  process.exit(0);
}

const files = git(['ls-files'])
  .split('\n')
  .filter(Boolean)
  .filter((p) => !EXCLUDED_PATHS.has(p));

let violated = false;
for (const file of files) {
  let content;
  try {
    content = readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    continue;
  }
  const lines = content.split('\n');
  for (const stale of staleIdentifiers) {
    // Negative lookahead, not just a bare substring match: "collab" (this
    // repo's own second-ever identifier, per this same list) is also a
    // literal prefix of the ordinary English words "collaborator" /
    // "collaboration" / "collaborative" — real, expected words in a
    // collaboration tool's own comments and docs, not leftover renames. A
    // stale identifier immediately followed by another letter is virtually
    // always part of a different, unrelated word; one immediately followed
    // by a non-letter (`_`, `-`, `.`, digit, punctuation, end of line) is the
    // shape every real leftover reference actually takes (COLLAB_API_KEY,
    // .collab-blobs, "collab.local", etc.) and stays fully caught.
    const re = new RegExp(`${stale}(?![a-zA-Z])`, 'i');
    lines.forEach((line, i) => {
      if (!re.test(line)) return;
      if (line.includes(ALLOW_MARKER)) return;
      console.error(
        `STALE IDENTIFIER: "${stale}" found in ${file}:${String(i + 1)} — rename left a trace ` +
          `(intentional? add "${ALLOW_MARKER}" on the same line).`,
      );
      violated = true;
    });
  }
}

if (violated) {
  process.exitCode = 1;
} else {
  console.log(
    `brand-check: scanned ${files.length} tracked file(s), no trace of ${staleIdentifiers.join(', ')}.`,
  );
}
