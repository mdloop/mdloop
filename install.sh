#!/bin/sh
#
# mdloop install — the one-line `curl -fsSL .../install.sh | sh` path.
#
# A thin wrapper over "npm install -g mdloop", not a standalone installer: no bundled binaries, no
# bootstrapping Node itself (a script that silently reaches for sudo or a system package manager to
# install a language runtime is exactly the kind of thing this script must never do — Node is a
# precondition the person running this owns, not a decision to make on their behalf).
#
# POSIX sh, deliberately — `curl | sh` invokes `/bin/sh`, which on many systems (Debian, Alpine) is
# dash, not bash. No arrays, no `local`, no `[[`; only `${var:-default}`/`${var:+word}` expansion,
# which POSIX itself defines. `set -eu`, no `pipefail` (not POSIX).
#
# What this script does, in order:
#   1. Require node >=22 (packages/mdloop/package.json's engines.node) and npm. Fail fast, name the
#      exact version found, never try to fix either.
#   2. npm install -g mdloop (or mdloop@$MDLOOP_VERSION). Idempotent — a re-run upgrades in place.
#   3. Write the machine-wide review-loop instructions ("mdloop instructions install --global") so
#      every coding agent on this machine is steered to route plans/artifacts through mdloop instead
#      of approving them inline — see agent-instructions.ts. Repo-scope instructions are a separate,
#      later step: "mdloop link" writes those, committed, once someone actually links a repo.
#   4. Link the current directory, but only when it is safe to do so without a human at a prompt —
#      see the comment at that step for exactly what "safe" means here.
#
# Escape hatches, matching the existing MDLOOP_AUTO=0 / MDLOOP_CLI_PATH style from
# claude-plugin/hooks/*.sh:
#   MDLOOP_VERSION           install this exact npm dist-tag/version instead of latest
#   MDLOOP_NO_INSTRUCTIONS=1 skip step 3 entirely
#   MDLOOP_NO_LINK=1         skip step 4 entirely
#
# Exit codes: 0 on success (steps 3 and 4 are conveniences — a failure there is reported and this
# script still exits 0, matching the "never block on a convenience" contract mdloop-ensure.sh
# documents for its own analogous steps); non-zero only when step 1 or 2 — the actual install —
# fails, since without those nothing else in this script can do anything.
set -eu

say() {
  printf 'mdloop-install: %s\n' "$1"
}

die() {
  printf 'mdloop-install: %s\n' "$1" >&2
  exit 1
}

# --- (1) Preconditions -------------------------------------------------------------------------

NODE_BIN=$(command -v node 2>/dev/null) || die 'node not found. Install Node >=22 first — https://nodejs.org — then re-run this script.'

NODE_VERSION=$("$NODE_BIN" -v)
NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | sed -n 's/^v\([0-9][0-9]*\)\..*/\1/p')
if [ -z "$NODE_MAJOR" ]; then
  die "could not parse a version out of \"node -v\" ($NODE_VERSION) — is $NODE_BIN really node?"
fi
if [ "$NODE_MAJOR" -lt 22 ]; then
  die "node $NODE_VERSION found, but mdloop needs >=22. Upgrade Node, then re-run this script."
fi

NPM_BIN=$(command -v npm 2>/dev/null) || die 'npm not found alongside node. Reinstall Node from https://nodejs.org (it bundles npm), then re-run this script.'

# --- (2) Install --------------------------------------------------------------------------------

PACKAGE="mdloop${MDLOOP_VERSION:+@$MDLOOP_VERSION}"
say "installing $PACKAGE globally via npm..."
if ! "$NPM_BIN" install -g "$PACKAGE"; then
  cat >&2 <<EOF
mdloop-install: "npm install -g $PACKAGE" failed.

If that was a permission error (EACCES), npm's global prefix is probably owned by root. Fix it
once, without sudo, then re-run this script:
  npm config set prefix "\$HOME/.npm-global"
  export PATH="\$HOME/.npm-global/bin:\$PATH"   # add this line to your shell profile too

Never run this script with sudo — that fixes the symptom for one install and leaves the
underlying permission problem (and future installs) exactly as broken.
EOF
  exit 1
fi

MDLOOP_BIN=$(command -v mdloop 2>/dev/null) || die 'npm install succeeded but "mdloop" is still not on PATH. Check that npm'"'"'s global bin directory (npm config get prefix) is on your PATH, then re-run this script.'
say "mdloop installed: $MDLOOP_BIN"

# --- (3) Global review-loop instructions --------------------------------------------------------
#
# One per machine, so every repo is steered without per-repo setup — the repo-scope block is
# "mdloop link"'s job (see link.ts's reportAgentInstructionsInstall), not this script's.
if [ "${MDLOOP_NO_INSTRUCTIONS:-0}" != '1' ]; then
  say 'writing mdloop review-loop instructions for every coding agent found on this machine...'
  if ! "$MDLOOP_BIN" instructions install --global; then
    say 'could not write the global instructions (see above) — not fatal; re-run "mdloop instructions install --global" by hand to retry.'
  fi
else
  say 'MDLOOP_NO_INSTRUCTIONS=1 — skipping the global review-loop instructions.'
fi

# --- (4) Link the current directory, only when it is safe non-interactively ---------------------
#
# "mdloop link"'s own project resolution (link.ts) auto-provisions with no prompt, ever, against a
# local endpoint — the ordinary case, since a freshly installed CLI has nothing else configured.
# Against a non-local endpoint it falls back to an interactive picker, which only works with a real
# terminal on stdin: fine when this script was saved and run directly ("sh install.sh"), but under
# "curl ... | sh" stdin is the pipe, not a terminal, and a prompt reading from a closed pipe would
# hang or fail strangely. `[ -t 0 ]` is exactly the distinction between those two invocations, so
# only a non-local endpoint with no terminal on stdin is skipped — every other combination is safe
# to hand straight to "mdloop link" and let it apply its own existing rules unchanged.
if [ "${MDLOOP_NO_LINK:-0}" != '1' ]; then
  if command -v git >/dev/null 2>&1 && GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
    case "${MDLOOP_MCP_URL:-}" in
      '' | *127.0.0.1* | *localhost*) ENDPOINT_IS_LOCAL=1 ;;
      *) ENDPOINT_IS_LOCAL=0 ;;
    esac
    if [ -t 0 ] || [ "$ENDPOINT_IS_LOCAL" = '1' ]; then
      say "linking $GIT_ROOT..."
      if ! "$MDLOOP_BIN" link "$GIT_ROOT"; then
        say 'could not link this folder (see above) — not fatal; run "mdloop link" by hand to retry.'
      fi
    else
      say 'skipping "mdloop link" — no terminal on stdin and MDLOOP_MCP_URL points at a non-local endpoint, so there is no safe way to pick a project without one. Run "mdloop link --project <id>" by hand.'
    fi
  else
    say 'not inside a git repo — skipping "mdloop link". Run it by hand once you are.'
  fi
else
  say 'MDLOOP_NO_LINK=1 — skipping "mdloop link".'
fi

say 'done. Try: mdloop open .'
