#!/usr/bin/env bash
#
# Skill/MCP drift guard.
#
#   bash claude-plugin/scripts/check-skill-drift.sh
#
# Both skills in this bundle name Vorlyn MCP tools by hand — `get_feedback_bundle`,
# `accept_suggestion`, `upload_document` and friends. Nothing links those strings
# to the server that actually registers them, so a rename or removal in
# `packages/mcp/src/server.ts` leaves a skill quietly instructing the agent to
# call a tool that no longer exists. The agent then fails at the worst possible
# moment: mid-review, in front of the human whose feedback it was fetching.
#
# This script closes that loop. It exits non-zero, naming names, the moment a
# skill references a tool the server no longer registers.
#
# It is deliberately one-directional. A newly registered tool that no skill
# mentions is not drift — most of the 18 tools are not, and should not be,
# named in a skill. Only the skill→server direction can be wrong.
#
# Like the rest of this bundle (JSON, Markdown, shell) it sits outside
# `packages/` and is therefore not part of `pnpm verify`'s vitest /
# dependency-cruiser / coverage pipeline. Run it by hand, or from whatever CI
# eventually watches this directory.
#
# `set -e` is deliberately absent, matching hooks/vorlyn-sync.sh: every failure
# path here is an explicit exit with a message, never an arbitrary abort.
set -u

BUNDLE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
REPO_ROOT=$(cd -- "$BUNDLE_DIR/.." && pwd)

# Both are overridable so the test suite can point the same logic at fixtures
# instead of editing the real skills.
SKILLS_DIR="${VORLYN_SKILLS_DIR:-$BUNDLE_DIR/skills}"
MCP_SERVER="${VORLYN_MCP_SERVER:-$REPO_ROOT/packages/mcp/src/server.ts}"

say() {
  printf 'check-skill-drift: %s\n' "$1"
}

die() {
  printf 'check-skill-drift: %s\n' "$1" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# (a) The tools the MCP server actually registers.
#
# Registrations are `server.registerTool(\n  'tool_name',\n  { ... })`. The awk
# below takes the first `'identifier',` line after each `registerTool(`, and
# also handles the name sitting on the call line itself in case prettier ever
# reflows one.
#
# If that shape changes, this returns fewer names than it should — which makes
# the check fail loudly on the next skill reference rather than pass silently.
# The empty-result guard in (c) is the backstop for the total-failure case.
registered_tools() {
  awk '
    {
      line = $0
    }
    /server\.registerTool\(/ {
      # Same-line form: server.registerTool('"'"'tool_name'"'"', ...
      if (match(line, /registerTool\([ \t]*'"'"'[a-z][a-z0-9_]*'"'"'/)) {
        tok = substr(line, RSTART, RLENGTH)
        sub(/^registerTool\([ \t]*'"'"'/, "", tok)
        print tok
        pending = 0
      } else {
        pending = 1
      }
      next
    }
    pending == 1 {
      # Own-line form: the name is the next bare quoted identifier.
      if (match(line, /^[ \t]*'"'"'[a-z][a-z0-9_]*'"'"',[ \t]*$/)) {
        tok = line
        sub(/^[ \t]*'"'"'/, "", tok)
        sub(/'"'"',[ \t]*$/, "", tok)
        print tok
        pending = 0
      }
    }
  ' "$1" | sort -u
}

# ---------------------------------------------------------------------------
# (b) The tools the skills reference.
#
# Skills name tools as bare backticked identifiers in prose and tables:
# `get_feedback_bundle`, `reply_to_comment`. So the candidate set is every
# backticked snake_case token.
#
# That set also catches things that are not tools and never will be: MCP error
# codes (`document_not_found`, `rate_limited`, `not_a_reviewer`) and parameter
# names (`change_note`, `document_id`) are written the same way. They are told
# apart by their first segment: a tool name always starts with a verb, an error
# code or field name does not. The verb set is read from the server itself, so
# it grows on its own as tools are added, plus a small static list of verbs that
# would otherwise vanish from that set if their last tool were the one removed —
# the one case where deriving the set from the server could hide a real removal.
#
# Consequence worth knowing: an error code or field that *does* start with one
# of these verbs would be reported as a missing tool. That is the safe direction
# to be wrong in — a loud false alarm, resolved by reading this comment, versus
# a silently stale skill.
STATIC_TOOL_VERBS="get list create update delete upload download search export import accept reject reply resolve request submit"

tool_verbs() { # <registered tool names on stdin>
  {
    sed -n 's/^\([a-z][a-z0-9]*\)_.*$/\1/p'
    printf '%s\n' $STATIC_TOOL_VERBS
  } | sort -u
}

referenced_tools() { # <verbs file> <skill files...>
  local verbs_file="$1"
  shift
  grep -ohE '`[a-z][a-z0-9]*(_[a-z0-9]+)+`' "$@" |
    tr -d '`' |
    sort -u |
    while IFS= read -r token; do
      verb="${token%%_*}"
      grep -qxF "$verb" "$verbs_file" && printf '%s\n' "$token"
    done
}

# ---------------------------------------------------------------------------
# (c) Compare.
[ -f "$MCP_SERVER" ] || die "MCP server not found at $MCP_SERVER"
[ -d "$SKILLS_DIR" ] || die "skills directory not found at $SKILLS_DIR"

SKILL_FILES=$(find "$SKILLS_DIR" -name 'SKILL.md' | sort)
[ -n "$SKILL_FILES" ] || die "no SKILL.md files under $SKILLS_DIR"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

registered_tools "$MCP_SERVER" >"$WORK/registered"
REGISTERED_COUNT=$(grep -c . <"$WORK/registered")

# A parse that finds nothing means the registration shape moved, not that the
# server has no tools. Passing on an empty set would make this script a no-op
# that reports success forever, which is worse than not having it.
[ "$REGISTERED_COUNT" -gt 0 ] ||
  die "parsed 0 tool registrations out of $MCP_SERVER — the registerTool( shape changed; fix registered_tools() in this script"

tool_verbs <"$WORK/registered" >"$WORK/verbs"

# shellcheck disable=SC2086
referenced_tools "$WORK/verbs" $SKILL_FILES >"$WORK/referenced"
REFERENCED_COUNT=$(grep -c . <"$WORK/referenced")

MISSING=$(comm -23 "$WORK/referenced" "$WORK/registered")

if [ -n "$MISSING" ]; then
  {
    printf 'check-skill-drift: FAIL — %s tool(s) referenced by a skill are not registered in %s:\n' \
      "$(printf '%s\n' "$MISSING" | grep -c .)" "${MCP_SERVER#"$REPO_ROOT"/}"
    printf '%s\n' "$MISSING" | while IFS= read -r tool; do
      printf '  %s\n' "$tool"
      grep -rn -- "\`$tool\`" $SKILL_FILES | sed 's|^|    |'
    done
    printf '\n'
    printf 'Either the tool was renamed/removed in the MCP server (update the skill to match),\n'
    printf 'or this is not a tool name at all (see the verb heuristic in this script).\n'
  } >&2
  exit 1
fi

say "OK — $REFERENCED_COUNT tool reference(s) across $(printf '%s\n' "$SKILL_FILES" | grep -c .) skill file(s), all registered ($REGISTERED_COUNT tools in ${MCP_SERVER#"$REPO_ROOT"/})"
exit 0
