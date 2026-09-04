#!/usr/bin/env bash
#
# mdloop ensure — Claude Code `SessionStart` hook.
#
# Makes "install the plugin, never type `mdloop open`" true. Where
# `mdloop-sync.sh` pushes an already-linked repo, this script's job is
# upstream of that: make sure a local mdloop server is running, this folder
# is linked to a project, and Claude Code's own MCP client knows how to
# reach it, before the agent ever needs any of that. This is a **separate
# script**, deliberately — `mdloop-sync.sh`'s "no manifest → silent exit 0"
# is load-bearing for *its* purpose (a teammate who never opted in sees
# nothing), and must not be repurposed into "go create one". Here, no
# manifest is exactly the case this script exists to fix.
#
# The MCP-registration step (g) at the bottom is local-only, on purpose: a
# remote/team endpoint's MCP URL is not derivable from anything on disk
# (`.mdloop/manifest.json`'s endpoint is the API base used for pushes, and
# SELF_HOSTING.md is explicit that MCP is a second, separate process that
# can sit on a different host/port entirely) — see that step's own comment.
#
# Exit codes, same contract as `mdloop-sync.sh` documents in full: 0 is a
# true no-op or a success, 1 is a non-blocking error surfaced as a hook-error
# notice, 2 would block — a `SessionStart` hook has no business blocking a
# session over a convenience, so this script must never exit 2.
#
# `set -e` is deliberately absent, matching `mdloop-sync.sh`: every failure
# path here is an explicit exit, never an arbitrary abort partway through.
set -u

hint() {
  printf 'mdloop-ensure: %s\n' "$1" >&2
}

# (a) Repo root. Not a git repo → nothing to ensure, and no opinion about it.
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -n "$REPO_ROOT" ] || exit 0

# (b) Opt-out. Installing the plugin is itself the opt-in for auto-start;
# MDLOOP_AUTO=0 is the escape hatch back out of it.
[ "${MDLOOP_AUTO:-1}" = "0" ] && exit 0

# (c) Locate the CLI. Unlike `mdloop-sync.sh`'s exit-1-with-hint for the same
# condition, a missing CLI here is silent exit 0: `mdloop-sync.sh` only ever
# runs on a repo someone already linked (so a missing CLI there is a real
# misconfiguration worth a nag), but this hook runs on every `SessionStart` in
# every git repo, including ones where nobody has installed the CLI or ever
# will. Nagging before anyone has opted in by installing `mdloop` itself
# would be exactly the kind of every-session noise this plugin is supposed to
# avoid.
MDLOOP=$(command -v mdloop 2>/dev/null) || MDLOOP=""
if [ -z "$MDLOOP" ] && [ -n "${MDLOOP_CLI_PATH:-}" ] && [ -x "${MDLOOP_CLI_PATH}" ]; then
  MDLOOP="$MDLOOP_CLI_PATH"
fi
[ -n "$MDLOOP" ] || exit 0

# (d) Never autostart a local daemon on behalf of a team server. If this
# folder is already linked, look at what it's linked to — the same
# jq-else-sed idiom `mdloop-sync.sh` uses to read `.trigger` from
# config.json, applied here to `.endpoint` in manifest.json. An endpoint that
# doesn't plainly say loopback (or that we fail to parse at all) is treated
# as remote: the safe direction to be wrong in is never spinning up a local
# server nobody asked for, not the reverse.
MANIFEST="$REPO_ROOT/.mdloop/manifest.json"
if [ -f "$MANIFEST" ]; then
  if command -v jq >/dev/null 2>&1; then
    ENDPOINT=$(jq -r '.endpoint // empty' "$MANIFEST" 2>/dev/null) || ENDPOINT=""
  else
    ENDPOINT=$(sed -n 's/.*"endpoint"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)
  fi
  case "$ENDPOINT" in
    *127.0.0.1* | *localhost*) ;; # local — fall through and ensure it's running
    *) exit 0 ;;                  # remote, or unparseable — never autostart
  esac
fi

# (e) Ensure the local daemon is up. `mdloop serve status` is the
# systemctl-is-active-shaped check this is built around: 0 means already
# running, so `start` only ever runs when it's genuinely needed.
"$MDLOOP" serve status >/dev/null 2>&1 || "$MDLOOP" serve start >/dev/null 2>&1 || {
  hint "could not start the local mdloop server — see the data directory's serve.log"
  exit 1
}

# (f) Ensure this folder is linked. Only needed the first time a folder is
# opened — once `.mdloop/manifest.json` exists, later sessions skip straight
# past this. `mdloop link` with no `--project` auto-provisions against a
# local server (reusing an existing project matching the folder before ever
# creating a new one), which is exactly the folder→project mapping this whole
# feature is about; against a remote endpoint the manifest check in (d) above
# would already have exited before this line.
if [ ! -f "$MANIFEST" ]; then
  cd "$REPO_ROOT" && "$MDLOOP" link >/dev/null || {
    hint 'mdloop link failed'
    exit 1
  }
fi

# (g) Register this instance with Claude Code's own MCP client — closes the
# gap where installing the plugin alone never made get_feedback_bundle and
# friends reachable: nothing before this line ever told Claude Code an MCP
# server exists at all, so the `mdloop-review` skill's tools were simply
# absent until a human ran `claude mcp add` by hand. Local only — see the
# file header for why a remote endpoint can't be derived safely here.
#
# Steady-state must cost nothing: the admin key this reads is durable
# (never rotates — see credentials.ts), so once `claude mcp add` has
# succeeded once for a repo, the entry sitting in `~/.claude.json` stays
# valid on every later session with no hook involvement at all. This
# existence check is what makes that true — bare `mdloop:` is a manually
# `add`ed entry's own line in `claude mcp list` (confirmed empirically;
# plugin-declared servers instead appear namespaced as
# `plugin:<name>:<server>`, so there is no collision risk here).
CLAUDE_BIN=$(command -v claude 2>/dev/null) || exit 0
"$CLAUDE_BIN" mcp list 2>/dev/null | grep -q '^mdloop:' && exit 0

STATUS_JSON=$("$MDLOOP" serve status --json 2>/dev/null) || exit 0
if command -v jq >/dev/null 2>&1; then
  MCP_ENDPOINT=$(printf '%s' "$STATUS_JSON" | jq -r '.mcpEndpoint // empty' 2>/dev/null) || MCP_ENDPOINT=""
else
  MCP_ENDPOINT=$(printf '%s' "$STATUS_JSON" | sed -n 's/.*"mcpEndpoint"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
fi
[ -n "$MCP_ENDPOINT" ] || exit 0

# Same MDLOOP_API_KEY-then-.mdloop/credentials precedence as
# resolveApiKey() in packages/cli/src/credentials.ts.
API_KEY="${MDLOOP_API_KEY:-}"
if [ -z "$API_KEY" ] && [ -f "$REPO_ROOT/.mdloop/credentials" ]; then
  if command -v jq >/dev/null 2>&1; then
    API_KEY=$(jq -r '.apiKey // empty' "$REPO_ROOT/.mdloop/credentials" 2>/dev/null) || API_KEY=""
  else
    API_KEY=$(sed -n 's/.*"apiKey"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_ROOT/.mdloop/credentials" | head -1)
  fi
fi
[ -n "$API_KEY" ] || exit 0

# --scope local: private to this user+repo in ~/.claude.json, never
# .mcp.json (that path is meant to be committed and would leak the token
# into git).
"$CLAUDE_BIN" mcp add --transport http mdloop "$MCP_ENDPOINT" \
  --header "Authorization: Bearer $API_KEY" --scope local >/dev/null 2>&1 || {
  hint "could not register the mdloop MCP server with Claude Code"
  exit 1
}

exit 0
