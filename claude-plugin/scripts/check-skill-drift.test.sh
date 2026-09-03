#!/usr/bin/env bash
#
# Branch tests for scripts/check-skill-drift.sh. Plain bash — this bundle is
# outside `packages/`, so it is deliberately not part of `pnpm verify`'s vitest
# run, exactly like hooks/vorlyn-sync.test.sh.
#
#   bash claude-plugin/scripts/check-skill-drift.test.sh
#
# Case 1 runs the guard against the real repo, unmodified. Every other case
# points it at throwaway fixtures via VORLYN_SKILLS_DIR / VORLYN_MCP_SERVER, so
# the real skills and the real MCP server are never edited to induce a failure.
set -u

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
GUARD="$SCRIPT_DIR/check-skill-drift.sh"
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)

PASS=0
FAIL=0
WORK=""

fail() {
  printf '  FAIL: %s\n' "$1"
  FAIL=$((FAIL + 1))
}

ok() {
  printf '  ok:   %s\n' "$1"
  PASS=$((PASS + 1))
}

assert_eq() { # <label> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 — expected [$2], got [$3]"; fi
}

assert_contains() { # <label> <needle> <haystack>
  case "$3" in
    *"$2"*) ok "$1" ;;
    *) fail "$1 — [$3] does not contain [$2]" ;;
  esac
}

refute_contains() { # <label> <needle> <haystack>
  case "$3" in
    *"$2"*) fail "$1 — [$3] unexpectedly contains [$2]" ;;
    *) ok "$1" ;;
  esac
}

run_guard() { # <env assignments...> — fills STATUS / STDOUT / STDERR
  local out err
  out=$(mktemp)
  err=$(mktemp)
  env "$@" bash "$GUARD" >"$out" 2>"$err"
  STATUS=$?
  STDOUT=$(cat "$out")
  STDERR=$(cat "$err")
  rm -f "$out" "$err"
}

# A stand-in MCP server carrying the same registration shape as the real one.
new_fixtures() {
  WORK=$(mktemp -d)
  mkdir -p "$WORK/skills/fixture-skill"
  cat >"$WORK/server.ts" <<'TS'
export function registerTools(server: McpServer) {
  server.registerTool(
    'get_feedback_bundle',
    {
      description: 'Errors: `document_not_found`, `forbidden`, plus `rate_limited`.',
      inputSchema: {},
    },
  );

  server.registerTool(
    'upload_document',
    {
      description: 'Whole-file replacement. Errors: `title_required`.',
      inputSchema: {},
    },
  );
}
TS
}

fixture_skill() { # <markdown body on stdin>
  cat >"$WORK/skills/fixture-skill/SKILL.md"
}

cleanup() {
  [ -n "$WORK" ] && rm -rf "$WORK"
  WORK=""
}

# ---------------------------------------------------------------------------
echo '1. the real repo, unmodified → passes'
run_guard PATH="$PATH"
assert_eq 'exit 0' 0 "$STATUS"
assert_contains 'reports OK' 'OK —' "$STDOUT"
assert_eq 'nothing on stderr' '' "$STDERR"
# A pass over zero references would be vacuous — the guard has to actually be
# finding the tool names the skills use.
refute_contains 'the pass is not vacuous' '0 tool reference(s)' "$STDOUT"
assert_contains 'both skills were scanned' '2 skill file(s)' "$STDOUT"

# ---------------------------------------------------------------------------
echo '2. a skill naming a tool that does not exist → fails, naming it'
new_fixtures
fixture_skill <<'MD'
---
name: fixture-skill
description: fixture
---

Read the feedback with `get_feedback_bundle`, then call `get_fabricated_thing`
before uploading with `upload_document`.
MD
run_guard VORLYN_SKILLS_DIR="$WORK/skills" VORLYN_MCP_SERVER="$WORK/server.ts"
assert_eq 'exit 1' 1 "$STATUS"
assert_contains 'names the missing tool' 'get_fabricated_thing' "$STDERR"
assert_contains 'says what happened' 'not registered in' "$STDERR"
assert_contains 'points at the offending file' 'fixture-skill/SKILL.md' "$STDERR"
assert_contains 'explains both possible causes' 'renamed/removed' "$STDERR"
# The tools that *are* registered must not be dragged into the failure list.
refute_contains 'does not accuse a registered tool' '  upload_document' "$STDERR"
cleanup

# ---------------------------------------------------------------------------
echo '3. a skill naming only registered tools → passes'
new_fixtures
fixture_skill <<'MD'
---
name: fixture-skill
description: fixture
---

`get_feedback_bundle` then `upload_document`.
MD
run_guard VORLYN_SKILLS_DIR="$WORK/skills" VORLYN_MCP_SERVER="$WORK/server.ts"
assert_eq 'exit 0' 0 "$STATUS"
assert_contains 'counts both references' '2 tool reference(s)' "$STDOUT"
cleanup

# ---------------------------------------------------------------------------
echo '4. error codes and field names are not mistaken for tools'
# These are written exactly like tool names — backticked snake_case — and the
# real vorlyn-review skill is full of them. If the verb heuristic ever stops
# excluding them, case 1 turns into a permanent false alarm.
new_fixtures
fixture_skill <<'MD'
---
name: fixture-skill
description: fixture
---

`get_feedback_bundle` can return `document_not_found`, `rate_limited`,
`not_a_reviewer` or `not_a_suggestion`. Pass `document_id` and `change_note`,
and read `proposed_text` off each item.
MD
run_guard VORLYN_SKILLS_DIR="$WORK/skills" VORLYN_MCP_SERVER="$WORK/server.ts"
assert_eq 'exit 0 — no error code was treated as a tool' 0 "$STATUS"
assert_contains 'only the real tool reference counted' '1 tool reference(s)' "$STDOUT"
cleanup

# ---------------------------------------------------------------------------
echo '5. a server whose registrations cannot be parsed → hard failure, not a silent pass'
# The dangerous failure mode for a guard like this is reporting success because
# it found nothing to check.
new_fixtures
printf 'export function registerTools() { /* nothing here */ }\n' >"$WORK/server.ts"
fixture_skill <<'MD'
---
name: fixture-skill
description: fixture
---

`get_feedback_bundle`
MD
run_guard VORLYN_SKILLS_DIR="$WORK/skills" VORLYN_MCP_SERVER="$WORK/server.ts"
assert_eq 'exit 1' 1 "$STATUS"
assert_contains 'says the parse found nothing' 'parsed 0 tool registrations' "$STDERR"
cleanup

# ---------------------------------------------------------------------------
echo '6. missing inputs are reported, not ignored'
new_fixtures
run_guard VORLYN_SKILLS_DIR="$WORK/skills" VORLYN_MCP_SERVER="$WORK/nonexistent.ts"
assert_eq 'missing server → exit 1' 1 "$STATUS"
assert_contains 'names the missing server' 'MCP server not found' "$STDERR"

run_guard VORLYN_SKILLS_DIR="$WORK/no-such-dir" VORLYN_MCP_SERVER="$WORK/server.ts"
assert_eq 'missing skills dir → exit 1' 1 "$STATUS"
assert_contains 'names the missing skills dir' 'skills directory not found' "$STDERR"

run_guard VORLYN_SKILLS_DIR="$WORK/skills" VORLYN_MCP_SERVER="$WORK/server.ts"
assert_eq 'skills dir with no SKILL.md → exit 1' 1 "$STATUS"
assert_contains 'says there is nothing to check' 'no SKILL.md files' "$STDERR"
cleanup

# ---------------------------------------------------------------------------
printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
