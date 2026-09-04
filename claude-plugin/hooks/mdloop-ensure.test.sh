#!/usr/bin/env bash
#
# Branch tests for hooks/mdloop-ensure.sh. Plain bash, same idiom as
# mdloop-sync.test.sh (which see for the general shape) — this bundle is
# outside `packages/`, so it is deliberately not part of `pnpm verify`'s
# vitest run.
#
#   bash claude-plugin/hooks/mdloop-ensure.test.sh
#
# Each case builds a throwaway git repo and (where relevant) a stub `mdloop`
# on PATH that records its argv, then asserts on the hook's exit code,
# stdout, stderr, and what — if anything — the stub was invoked with.
set -u

HOOK_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
HOOK="$HOOK_DIR/mdloop-ensure.sh"

# A PATH with the system tools the hook needs but never a real `mdloop`, so a
# developer who has the CLI installed still gets the same results as CI.
CLEAN_PATH=/usr/bin:/bin:/usr/sbin:/sbin

# The hook reads all three; never inherit the tester's own.
unset MDLOOP_CLI_PATH MDLOOP_AUTO MDLOOP_API_KEY

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

assert_no_mdloop() {
  if [ -f "$WORK/invocations" ]; then
    fail "$1 — mdloop was invoked: $(cat "$WORK/invocations")"
  else
    ok "$1"
  fi
}

assert_no_claude() {
  if [ -f "$WORK/claude-invocations" ]; then
    fail "$1 — claude was invoked: $(cat "$WORK/claude-invocations")"
  else
    ok "$1"
  fi
}

new_repo() { # empty git repo at $WORK/repo, cwd moved into it
  WORK=$(mktemp -d)
  mkdir -p "$WORK/repo" "$WORK/bin"
  git -C "$WORK/repo" init --quiet
  cd "$WORK/repo" || exit 1
}

link_repo() { # <endpoint> — writes .mdloop/manifest.json with that endpoint
  mkdir -p "$WORK/repo/.mdloop"
  printf '{ "endpoint": "%s", "projectId": "p_test", "files": {} }\n' "$1" \
    >"$WORK/repo/.mdloop/manifest.json"
}

# Records every call's argv (space-joined) as one line; `serve status` exits
# with $1, `serve start` and `link` both exit 0 unconditionally — the cases
# that need finer control (a failing `link`, a failing `serve start`) build
# their own inline stub instead of calling this.
stub_mdloop() { # <serve-status-exit-code>
  cat >"$WORK/bin/mdloop" <<STUB
#!/usr/bin/env bash
printf 'argv:%s\n' "\$*" >>"$WORK/invocations"
if [ "\$1 \$2" = "serve status" ]; then
  exit $1
fi
exit 0   # "serve start" and "link" both succeed unconditionally
STUB
  chmod +x "$WORK/bin/mdloop"
}

# Records every call's argv as one line in a separate log from the mdloop
# stub's, so assertions about one binary's calls never accidentally match
# the other's. `mcp list` prints the given line (or nothing, for "not yet
# registered"); `mcp add` succeeds unconditionally — the cases that need
# a failing `add` build their own inline stub instead.
stub_claude() { # <mcp-list-output-line-or-empty>
  cat >"$WORK/bin/claude" <<STUB
#!/usr/bin/env bash
printf 'argv:%s\n' "\$*" >>"$WORK/claude-invocations"
if [ "\$1 \$2" = "mcp list" ]; then
  printf '%s\n' '$1'
  exit 0
fi
exit 0   # "mcp add" succeeds unconditionally
STUB
  chmod +x "$WORK/bin/claude"
}

run_hook() { # <env assignments...> — fills STATUS / STDOUT / STDERR
  local out err
  out=$(mktemp)
  err=$(mktemp)
  env "$@" "$HOOK" >"$out" 2>"$err"
  STATUS=$?
  STDOUT=$(cat "$out")
  STDERR=$(cat "$err")
  rm -f "$out" "$err"
}

cleanup() {
  cd / || true
  [ -n "$WORK" ] && rm -rf "$WORK"
  WORK=""
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
echo '1. not a git repo → silent, exit 0'
WORK=$(mktemp -d)
mkdir -p "$WORK/bin" "$WORK/not-a-repo"
cd "$WORK/not-a-repo" || exit 1
run_hook PATH="$WORK/bin:$CLEAN_PATH"
assert_eq 'exit 0' 0 "$STATUS"
assert_eq 'no stdout' '' "$STDOUT"
assert_eq 'no stderr' '' "$STDERR"
assert_no_mdloop 'mdloop not invoked'
cleanup

# ---------------------------------------------------------------------------
echo '2. MDLOOP_AUTO=0 → the opt-out, silent, exit 0'
new_repo
stub_mdloop 1
run_hook PATH="$WORK/bin:$CLEAN_PATH" MDLOOP_AUTO=0
assert_eq 'exit 0' 0 "$STATUS"
assert_eq 'no stdout' '' "$STDOUT"
assert_eq 'no stderr' '' "$STDERR"
assert_no_mdloop 'mdloop not invoked'
cleanup

# ---------------------------------------------------------------------------
echo '3. mdloop not on PATH nor MDLOOP_CLI_PATH → silent, exit 0 (no nag before opt-in)'
new_repo
run_hook PATH="$CLEAN_PATH"
assert_eq 'exit 0' 0 "$STATUS"
assert_eq 'no stdout' '' "$STDOUT"
assert_eq 'no stderr' '' "$STDERR"
cleanup

# ---------------------------------------------------------------------------
echo '3b. MDLOOP_CLI_PATH is the fallback when mdloop is not on PATH'
new_repo
stub_mdloop 0
run_hook PATH="$CLEAN_PATH" MDLOOP_CLI_PATH="$WORK/bin/mdloop"
assert_eq 'exit 0' 0 "$STATUS"
assert_contains 'invoked via MDLOOP_CLI_PATH' 'argv:serve status' "$(cat "$WORK/invocations")"
cleanup

# ---------------------------------------------------------------------------
echo '4. already linked to a non-local endpoint → never autostart a local daemon, silent, exit 0'
new_repo
link_repo 'https://mdloop.example.com/mcp'
stub_mdloop 1
run_hook PATH="$WORK/bin:$CLEAN_PATH"
assert_eq 'exit 0' 0 "$STATUS"
assert_eq 'no stdout' '' "$STDOUT"
assert_eq 'no stderr' '' "$STDERR"
assert_no_mdloop 'mdloop not invoked'
cleanup

# ---------------------------------------------------------------------------
echo '4b. an unparseable/missing endpoint field is treated as remote — the safe direction to be wrong in'
new_repo
mkdir -p "$WORK/repo/.mdloop"
printf '{ "projectId": "p_test", "files": {} }\n' >"$WORK/repo/.mdloop/manifest.json"
stub_mdloop 1
run_hook PATH="$WORK/bin:$CLEAN_PATH"
assert_eq 'exit 0' 0 "$STATUS"
assert_no_mdloop 'mdloop not invoked'
cleanup

# ---------------------------------------------------------------------------
echo '5. already linked to a local endpoint, server already running → nothing left to do, silent, exit 0'
new_repo
link_repo 'http://127.0.0.1:54321/mcp'
stub_mdloop 0
run_hook PATH="$WORK/bin:$CLEAN_PATH"
assert_eq 'exit 0' 0 "$STATUS"
assert_eq 'no stdout' '' "$STDOUT"
assert_eq 'no stderr' '' "$STDERR"
assert_eq 'only checked status — already linked, so no link attempt' 1 \
  "$(wc -l <"$WORK/invocations" | tr -d ' ')"
cleanup

# ---------------------------------------------------------------------------
echo '5b. "localhost" (not just 127.0.0.1) is recognized as local too'
new_repo
link_repo 'http://localhost:54321/mcp'
stub_mdloop 0
run_hook PATH="$WORK/bin:$CLEAN_PATH"
assert_eq 'exit 0' 0 "$STATUS"
cleanup

# ---------------------------------------------------------------------------
echo '6. not linked, server not running → starts it, then links, exit 0'
new_repo
stub_mdloop 1
run_hook PATH="$WORK/bin:$CLEAN_PATH"
assert_eq 'exit 0' 0 "$STATUS"
assert_contains 'checked status first' 'argv:serve status' "$(cat "$WORK/invocations")"
assert_contains 'started the server since status said it was down' 'argv:serve start' \
  "$(cat "$WORK/invocations")"
assert_contains 'then linked the folder' 'argv:link' "$(cat "$WORK/invocations")"
cleanup

# ---------------------------------------------------------------------------
echo '6b. not linked, server already running → skips straight to linking'
new_repo
stub_mdloop 0
run_hook PATH="$WORK/bin:$CLEAN_PATH"
assert_eq 'exit 0' 0 "$STATUS"
assert_contains 'linked the folder' 'argv:link' "$(cat "$WORK/invocations")"
INVOCATIONS=$(cat "$WORK/invocations")
case "$INVOCATIONS" in
  *"serve start"*) fail 'should not have started the server — status already said running' ;;
  *) ok 'never called serve start — status already said running' ;;
esac
cleanup

# ---------------------------------------------------------------------------
echo '7. server fails to start → one stderr line, exit 1, never attempts to link'
new_repo
cat >"$WORK/bin/mdloop" <<STUB
#!/usr/bin/env bash
printf 'argv:%s\n' "\$*" >>"$WORK/invocations"
exit 1
STUB
chmod +x "$WORK/bin/mdloop"
run_hook PATH="$WORK/bin:$CLEAN_PATH"
assert_eq 'exit 1' 1 "$STATUS"
assert_contains 'hint names the problem' 'could not start the local mdloop server' "$STDERR"
INVOCATIONS=$(cat "$WORK/invocations")
case "$INVOCATIONS" in
  *"argv:link"*) fail 'should never have attempted to link — the server never came up' ;;
  *) ok 'never attempted to link' ;;
esac
cleanup

# ---------------------------------------------------------------------------
echo '8. server up, but link fails → one stderr line, exit 1'
new_repo
cat >"$WORK/bin/mdloop" <<STUB
#!/usr/bin/env bash
printf 'argv:%s\n' "\$*" >>"$WORK/invocations"
case "\$1" in
  serve) exit 0 ;;   # "serve status" — server already running
  link) exit 1 ;;
esac
STUB
chmod +x "$WORK/bin/mdloop"
run_hook PATH="$WORK/bin:$CLEAN_PATH"
assert_eq 'exit 1' 1 "$STATUS"
assert_contains 'hint names the problem' 'mdloop link failed' "$STDERR"
cleanup

# ---------------------------------------------------------------------------
echo '9. steady state: already registered → one cheap `claude mcp list` call, nothing else'
new_repo
link_repo 'http://127.0.0.1:54321/mcp'
stub_mdloop 0
stub_claude 'mdloop: http://127.0.0.1:54321/mcp (HTTP) - ✔ Connected'
run_hook PATH="$WORK/bin:$CLEAN_PATH"
assert_eq 'exit 0' 0 "$STATUS"
assert_eq 'mdloop: only the pre-existing "serve status" from step (e) — the' \
  1 "$(wc -l <"$WORK/invocations" | tr -d ' ')"
assert_eq 'claude: exactly one call' 1 "$(wc -l <"$WORK/claude-invocations" | tr -d ' ')"
assert_contains 'claude was asked to list' 'argv:mcp list' "$(cat "$WORK/claude-invocations")"
case "$(cat "$WORK/claude-invocations")" in
  *"mcp add"*) fail 'should never have called mcp add — already registered' ;;
  *) ok 'never called mcp add — already registered' ;;
esac
cleanup

# ---------------------------------------------------------------------------
echo '9b. first-ever link: not yet registered → resolves the endpoint and token, registers'
new_repo
cat >"$WORK/bin/mdloop" <<STUB
#!/usr/bin/env bash
printf 'argv:%s\n' "\$*" >>"$WORK/invocations"
case "\$*" in
  "serve status --json")
    printf '%s\n' '{"running":true,"mcpEndpoint":"http://127.0.0.1:54321/mcp"}'
    exit 0
    ;;
  "serve status") exit 1 ;;   # not running yet — step (e) must start it
  *) exit 0 ;;                 # serve start, link both succeed
esac
STUB
chmod +x "$WORK/bin/mdloop"
mkdir -p "$WORK/repo/.mdloop"
printf '{"apiKey":"mdloop_test_fixture"}\n' >"$WORK/repo/.mdloop/credentials"
stub_claude 'plugin:context7:context7: https://mcp.context7.com/mcp (HTTP) - ✔ Connected'
run_hook PATH="$WORK/bin:$CLEAN_PATH"
assert_eq 'exit 0' 0 "$STATUS"
CLAUDE_LOG=$(cat "$WORK/claude-invocations")
assert_contains 'checked the list first' 'argv:mcp list' "$CLAUDE_LOG"
assert_contains 'registered against the live endpoint' \
  'mcp add --transport http mdloop http://127.0.0.1:54321/mcp' "$CLAUDE_LOG"
assert_contains 'carried the credentials-file token as a bearer header' \
  'Authorization: Bearer mdloop_test_fixture' "$CLAUDE_LOG"
assert_contains 'used --scope local, never project (never .mcp.json)' '--scope local' "$CLAUDE_LOG"
cleanup

# ---------------------------------------------------------------------------
echo '9c. MDLOOP_API_KEY env var wins over a .mdloop/credentials file present at the same time'
new_repo
link_repo 'http://127.0.0.1:54321/mcp'
cat >"$WORK/bin/mdloop" <<STUB
#!/usr/bin/env bash
printf 'argv:%s\n' "\$*" >>"$WORK/invocations"
case "\$*" in
  "serve status --json")
    printf '%s\n' '{"running":true,"mcpEndpoint":"http://127.0.0.1:54321/mcp"}'
    exit 0
    ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$WORK/bin/mdloop"
printf '{"apiKey":"mdloop_from_file"}\n' >"$WORK/repo/.mdloop/credentials"
stub_claude ''
run_hook PATH="$WORK/bin:$CLEAN_PATH" MDLOOP_API_KEY=mdloop_from_env
CLAUDE_LOG=$(cat "$WORK/claude-invocations")
assert_contains 'env var value used' 'Bearer mdloop_from_env' "$CLAUDE_LOG"
case "$CLAUDE_LOG" in
  *"mdloop_from_file"*) fail 'the credentials-file key leaked in despite MDLOOP_API_KEY being set' ;;
  *) ok 'credentials-file key never used — env var took precedence' ;;
esac
cleanup

# ---------------------------------------------------------------------------
echo '9d. claude missing from PATH → silent, exit 0, no crash'
new_repo
stub_mdloop 1
run_hook PATH="$WORK/bin:$CLEAN_PATH"
assert_eq 'exit 0' 0 "$STATUS"
assert_no_claude 'claude never invoked — never on PATH'
cleanup

# ---------------------------------------------------------------------------
echo '9e. remote endpoint → MCP registration never attempted (endpoint not derivable)'
new_repo
link_repo 'https://mdloop.example.com/mcp'
stub_mdloop 1
stub_claude ''
run_hook PATH="$WORK/bin:$CLEAN_PATH"
assert_eq 'exit 0' 0 "$STATUS"
assert_no_claude 'claude never invoked for a remote endpoint'
cleanup

# ---------------------------------------------------------------------------
echo '9f. MDLOOP_AUTO=0 → MCP registration never attempted either'
new_repo
stub_mdloop 1
stub_claude ''
run_hook PATH="$WORK/bin:$CLEAN_PATH" MDLOOP_AUTO=0
assert_eq 'exit 0' 0 "$STATUS"
assert_no_claude 'claude never invoked — opted out'
cleanup

# ---------------------------------------------------------------------------
echo '10. hooks.json wiring'
if grep -qE '"SessionStart"' "$HOOK_DIR/hooks.json"; then
  ok 'SessionStart hook is registered'
else
  fail 'hooks.json should register a SessionStart hook'
fi
if grep -q 'mdloop-ensure\.sh' "$HOOK_DIR/hooks.json"; then
  ok 'points at mdloop-ensure.sh'
else
  fail 'hooks.json should point the SessionStart hook at mdloop-ensure.sh'
fi
# A SessionStart hook has no business blocking a session over a convenience.
if grep -qE '^\s*exit 2\b' "$HOOK"; then
  fail 'the script must never exit 2 — that would block the session'
else
  ok 'no exit 2 anywhere in the script'
fi

# ---------------------------------------------------------------------------
printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
