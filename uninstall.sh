#!/bin/sh
#
# mdloop uninstall — the one-line `curl -fsSL .../uninstall.sh | sh` path, the reverse of
# install.sh.
#
# `npm uninstall -g mdloop` on its own is NOT enough: it removes the package, but leaves behind
# everything "mdloop link"/"mdloop instructions install --global" wrote elsewhere on the machine
# (the CLAUDE.md/AGENTS.md review-loop block, every linked repo's own .mdloop/ and its own
# CLAUDE.md/AGENTS.md block, the git post-commit hooks). This is not an oversight npm could fix
# for us — empirically (see uninstall.ts's own doc comment), npm does not run
# preuninstall/postuninstall lifecycle scripts for a global package uninstall at all, on any
# version tested. This script is the actual fix: it runs "mdloop uninstall" (which does the real
# work — see packages/cli/src/uninstall.ts) BEFORE removing the package, since that command no
# longer exists afterward.
#
# POSIX sh, deliberately — same reasoning as install.sh's own header comment.
#
# What this script does, in order:
#   1. Find mdloop on PATH. If missing, there is nothing local to clean up (skip straight to step
#      3 — the npm package may still be present under a name npm knows even if the binary isn't
#      on this shell's PATH right now, so the uninstall itself is still attempted).
#   2. "mdloop uninstall" — unlinks every folder this machine ever auto-linked and removes the
#      global instructions block. Best-effort, matching install.sh's own steps 3/4: reported, not
#      fatal, if it fails.
#   3. npm uninstall -g mdloop. This IS fatal on failure — it is the one step actually removing
#      the package.
#
# Escape hatches, matching install.sh's own style:
#   MDLOOP_NO_CLEANUP=1   skip step 2 entirely (leaves every repo linked, and the global
#                         instructions block in place)
#   MDLOOP_PURGE_DATA=1   also pass --purge-data to step 2, removing the local embedded Postgres
#                         + blob data directory. Off by default — that's real document content,
#                         not configuration mdloop wrote on someone's behalf.
#
# Exit codes: 0 on success (step 2 is a convenience — a failure there is reported and this script
# still exits 0); non-zero only when step 3 — the actual uninstall — fails.
set -eu

say() {
  printf 'mdloop-uninstall: %s\n' "$1"
}

die() {
  printf 'mdloop-uninstall: %s\n' "$1" >&2
  exit 1
}

# --- (1) Find mdloop, and (2) run its own cleanup ------------------------------------------------

MDLOOP_BIN=$(command -v mdloop 2>/dev/null) || MDLOOP_BIN=''

if [ -n "$MDLOOP_BIN" ]; then
  if [ "${MDLOOP_NO_CLEANUP:-0}" != '1' ]; then
    say 'unlinking every folder this machine ever auto-linked, and removing the global review-loop instructions...'
    if [ "${MDLOOP_PURGE_DATA:-0}" = '1' ]; then
      CLEANUP_STATUS=0
      "$MDLOOP_BIN" uninstall --purge-data || CLEANUP_STATUS=$?
    else
      CLEANUP_STATUS=0
      "$MDLOOP_BIN" uninstall || CLEANUP_STATUS=$?
    fi
    if [ "$CLEANUP_STATUS" != '0' ]; then
      say 'cleanup reported a problem (see above) — not fatal; re-run "mdloop uninstall" by hand to retry before removing the package yourself.'
    fi
  else
    say 'MDLOOP_NO_CLEANUP=1 — skipping "mdloop uninstall". Every linked folder and the global instructions block are left in place.'
  fi
else
  say 'mdloop not found on PATH — nothing local to clean up. Proceeding to remove the npm package.'
fi

# --- (3) Remove the npm package -------------------------------------------------------------------

NPM_BIN=$(command -v npm 2>/dev/null) || die 'npm not found. Nothing more this script can do — remove the mdloop install by hand.'

say 'removing the mdloop npm package...'
if ! "$NPM_BIN" uninstall -g mdloop; then
  die '"npm uninstall -g mdloop" failed (see above).'
fi

say 'done.'
