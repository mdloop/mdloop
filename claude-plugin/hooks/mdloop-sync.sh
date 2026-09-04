#!/usr/bin/env bash
#
# mdloop sync — Claude Code `Stop` hook.
#
# Runs `mdloop push --quiet` once at the end of an agent turn, so a repo that
# opted into mdloop sync never depends on the agent remembering to push. This is
# the *guarantee* layer; the `mdloop-sync` skill is the *quality* layer (it gets
# a good --note onto the version).
#
# Exit codes, per Claude Code's documented hook contract:
#
#   0  success. stdout goes to the debug log; STDERR IS DISCARDED. Exiting 0
#      after writing a diagnostic therefore writes it to nowhere — the mistake
#      the first cut of this script made. Reserve 0 for genuine no-ops.
#   1  non-blocking error. Execution continues, and the first stderr line is
#      shown to the user as a "hook error" notice in the transcript. This is
#      the only way a background sync failure ever becomes visible, so every
#      real problem exits 1.
#   2  BLOCKING. From a `Stop` hook it prevents Claude from stopping and forces
#      the conversation to continue. A failed sync is a convenience failing,
#      not a gate — this script must never exit 2.
#
# Rule two, unchanged: silent unless something actually happened. A developer
# who never opted in sees no output, ever. `.mdloop/` is committed, so every
# teammate on a linked repo runs this hook whether or not they use mdloop.
#
# `set -e` is deliberately absent: a non-zero from any step must fall through
# to an explicit exit, never abort the script with an arbitrary status.
set -u

hint() {
  printf 'mdloop-sync: %s\n' "$1" >&2
}

# (a) Repo root. Not a git repo → nothing to sync, and no opinion about it.
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -n "$REPO_ROOT" ] || exit 0

# (b) Never linked (`mdloop link` was never run here) → silent no-op.
[ -f "$REPO_ROOT/.mdloop/manifest.json" ] || exit 0

# (c) Trigger mode. Default "commit" (multi-harness
# sync trigger, 2026-07-30): a git post-commit hook fires whichever tool made
# the edit, so it — not this Claude-Code-only Stop hook — is the default that
# `mdloop link` installs. When "commit" is in force, that git hook owns the push
# and this one stands down.
#
# The fallback below matters for repos linked before that change, which have a
# config.json with no `trigger` field, or none at all: they get the new default
# too, so behaviour does not depend on when a repo happened to be linked. That
# is an intentional migration. Wanting the old per-turn behaviour back is one
# explicit step — `mdloop link --trigger agent-turn`, or hand-edit config.json.
#
# jq is used when present but is not a dependency — the fallback is a one-field
# scrape, which is all this needs.
CONFIG="$REPO_ROOT/.mdloop/config.json"
TRIGGER="commit"
if [ -f "$CONFIG" ]; then
  if command -v jq >/dev/null 2>&1; then
    PARSED=$(jq -r '.trigger // empty' "$CONFIG" 2>/dev/null) || PARSED=""
  else
    PARSED=$(sed -n 's/.*"trigger"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG" | head -1)
  fi
  [ -n "$PARSED" ] && TRIGGER="$PARSED"
fi
if [ "$TRIGGER" = "commit" ]; then
  exit 0
fi

# (d) Credentials. Checked BEFORE the CLI lookup, and deliberately so: "no key
# anywhere" is the signature of a teammate who never opted in, and that
# diagnosis has to win over every other one. `.mdloop/` is committed, so every
# teammate inherits the link on clone; someone with neither a key nor the CLI
# should see silence, not a nag about a CLI they have no use for. (The two
# checks used to be the other way round, which only became a bug once exit
# codes started meaning something.)
#
# This one stays exit 0 / silent rather than joining the exit-1 cases. The
# judgement call: a missing key is not a misconfiguration, it is a
# non-adoption, and the hook has no advice to offer that the person hasn't
# already declined. Making it visible would give every unopted teammate on a
# linked repo a hook-error notice on every single turn, forever — strictly
# worse than silence. Anyone who wants the diagnosis runs `mdloop push` by hand,
# where the CLI's own "No API key found..." is the right message in the right
# place.
if [ -z "${MDLOOP_API_KEY:-}" ] && [ ! -f "$REPO_ROOT/.mdloop/credentials" ]; then
  exit 0
fi

# (e) Locate the CLI. `mdloop` is not published to a registry yet, so
# MDLOOP_CLI_PATH is the escape hatch for a monorepo build that is not on PATH.
# Past this point the developer has a key, so they *have* opted in: a linked
# repo whose CLI is missing is a real misconfiguration they can fix, and exit 1
# is the only way they will ever hear about it.
MDLOOP=$(command -v mdloop 2>/dev/null) || MDLOOP=""
if [ -z "$MDLOOP" ] && [ -n "${MDLOOP_CLI_PATH:-}" ] && [ -x "${MDLOOP_CLI_PATH}" ]; then
  MDLOOP="$MDLOOP_CLI_PATH"
fi
if [ -z "$MDLOOP" ]; then
  hint '.mdloop/ is linked but the mdloop CLI is not on PATH — see claude-plugin/README.md'
  exit 1
fi

# (f) Push. stdout is dropped (--quiet emits none anyway); stderr is inherited
# so the CLI's own conflict/failure lines come first and are therefore what the
# transcript notice shows. The summary line goes after them, as the fallback
# for a failure that printed nothing at all (a kill, say).
cd "$REPO_ROOT" || {
  hint "could not enter $REPO_ROOT"
  exit 1
}
"$MDLOOP" push --quiet >/dev/null
PUSH_STATUS=$?
if [ "$PUSH_STATUS" -ne 0 ]; then
  # Bounded self-healing: the one failure mode worth an automatic retry is a
  # local daemon that died mid-session (`mdloop serve stop`, a crash, a
  # reboot). `mdloop serve status` is the cheap check; `mdloop serve start`
  # only runs when it says the daemon is actually down. Against a remote
  # server this pair is close to a no-op — status likely fails fast and start
  # fails too — so the retry below just repeats the original failure once,
  # cheaply. Exactly one retry: this is a convenience, not a poll loop.
  "$MDLOOP" serve status >/dev/null 2>&1 || "$MDLOOP" serve start >/dev/null 2>&1
  "$MDLOOP" push --quiet >/dev/null
  PUSH_STATUS=$?
  if [ "$PUSH_STATUS" -ne 0 ]; then
    hint "mdloop push exited $PUSH_STATUS — sync did not complete"
    exit 1
  fi
fi

exit 0
