#!/usr/bin/env bash
#
# Branch tests for hooks/mdloop-sync.sh. Plain bash — this bundle is outside
# `packages/`, so it is deliberately not part of `pnpm verify`'s vitest run.
#
#   bash claude-plugin/hooks/mdloop-sync.test.sh
#
# Each case builds a throwaway git repo and (where relevant) a stub `mdloop` on
# PATH that records its argv and cwd, then asserts on the hook's exit code,
# stdout, stderr, and whether the stub ran at all.
set -u

HOOK_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
HOOK="$HOOK_DIR/mdloop-sync.sh"

# A PATH with the system tools the hook needs but never a real `mdloop`, so a
# developer who has the CLI installed still gets the same results as CI.
CLEAN_PATH=/usr/bin:/bin:/usr/sbin:/sbin

# The hook reads both of these; never inherit the tester's own.
unset MDLOOP_API_KEY MDLOOP_CLI_PATH

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

new_repo() { # empty git repo at $WORK/repo, cwd moved into it
  WORK=$(mktemp -d)
  mkdir -p "$WORK/repo" "$WORK/bin"
  git -C "$WORK/repo" init --quiet
  cd "$WORK/repo" || exit 1
}

link_repo() {
  mkdir -p "$WORK/repo/.mdloop"
  cat >"$WORK/repo/.mdloop/manifest.json" <<'JSON'
{ "endpoint": "http://localhost:3001/mcp", "projectId": "p_test", "files": {} }
JSON
}

# The default trigger is "commit" (the git hook owns the push), so every case
# below that exercises the Stop hook's *push* path has to opt in explicitly.
set_trigger() { # <commit|agent-turn>
  printf '{ "trigger": "%s" }\n' "$1" >"$WORK/repo/.mdloop/config.json"
}

stub_mdloop() { # <exit code> — records argv + cwd, always writes a stderr line
  cat >"$WORK/bin/mdloop" <<STUB
#!/usr/bin/env bash
printf 'argv:%s cwd:%s\n' "\$*" "\$(pwd)" >>"$WORK/invocations"
printf 'stub mdloop stderr\n' >&2
exit $1
STUB
  chmod +x "$WORK/bin/mdloop"
}

run_hook() { # <env assignments/-u flags...> — fills STATUS / STDOUT / STDERR
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

# ---------------------------------------------------------------------------
echo '1. no .mdloop/ (never linked) → silent no-op'
new_repo
run_hook PATH="$WORK/bin:$CLEAN_PATH"
assert_eq 'exit 0' 0 "$STATUS"
assert_eq 'no stdout' '' "$STDOUT"
assert_eq 'no stderr' '' "$STDERR"
cleanup

# ---------------------------------------------------------------------------
echo '1b. not a git repo at all → silent no-op'
WORK=$(mktemp -d)
mkdir -p "$WORK/bin" "$WORK/plain"
cd "$WORK/plain" || exit 1
run_hook PATH="$WORK/bin:$CLEAN_PATH"
assert_eq 'exit 0' 0 "$STATUS"
assert_eq 'no stdout' '' "$STDOUT"
assert_eq 'no stderr' '' "$STDERR"
cleanup

# ---------------------------------------------------------------------------
echo '2. trigger: "commit" → silent no-op, mdloop never invoked'
new_repo
link_repo
printf '{ "include": ["docs/**/*.md"], "trigger": "commit" }\n' >"$WORK/repo/.mdloop/config.json"
stub_mdloop 0
run_hook PATH="$WORK/bin:$CLEAN_PATH" MDLOOP_API_KEY=mdloop_test
assert_eq 'exit 0' 0 "$STATUS"
assert_eq 'no stdout' '' "$STDOUT"
assert_eq 'no stderr' '' "$STDERR"
assert_no_mdloop 'mdloop not invoked'
cleanup

# ---------------------------------------------------------------------------
echo '2b. trigger: "commit" is still honoured without jq on PATH'
new_repo
link_repo
printf '{\n  "trigger": "commit"\n}\n' >"$WORK/repo/.mdloop/config.json"
stub_mdloop 0
mkdir -p "$WORK/nojq"
# Everything the hook needs except jq — `bash`/`env` because of the shebang.
for tool in bash env git sed head; do ln -s "$(command -v $tool)" "$WORK/nojq/$tool"; done
run_hook PATH="$WORK/bin:$WORK/nojq" MDLOOP_API_KEY=mdloop_test
assert_eq 'exit 0' 0 "$STATUS"
assert_eq 'no stderr' '' "$STDERR"
assert_no_mdloop 'fallback parse saw trigger=commit'
cleanup

# ---------------------------------------------------------------------------
echo '2c. trigger: "agent-turn" (explicit) → pushes'
new_repo
link_repo
set_trigger agent-turn
stub_mdloop 0
run_hook PATH="$WORK/bin:$CLEAN_PATH" MDLOOP_API_KEY=mdloop_test
assert_eq 'exit 0' 0 "$STATUS"
assert_contains 'mdloop invoked' 'argv:push --quiet' "$(cat "$WORK/invocations")"
cleanup

# ---------------------------------------------------------------------------
echo '2d. no config.json at all → defaults to commit, so this hook stands down'
# The default flipped from "agent-turn" to "commit" on 2026-07-30 (multi-harness
# sync trigger). Repos linked before that have no
# trigger field — they must pick up the new default, not the old one, so
# behaviour never depends on when a repo happened to be linked.
new_repo
link_repo
stub_mdloop 0
run_hook PATH="$WORK/bin:$CLEAN_PATH" MDLOOP_API_KEY=mdloop_test
assert_eq 'exit 0' 0 "$STATUS"
assert_eq 'no stdout' '' "$STDOUT"
assert_eq 'no stderr' '' "$STDERR"
assert_no_mdloop 'mdloop not invoked'
cleanup

# ---------------------------------------------------------------------------
echo '2e. config.json with no trigger field → same default, still stands down'
new_repo
link_repo
printf '{ "include": ["docs/**/*.md"] }\n' >"$WORK/repo/.mdloop/config.json"
stub_mdloop 0
run_hook PATH="$WORK/bin:$CLEAN_PATH" MDLOOP_API_KEY=mdloop_test
assert_eq 'exit 0' 0 "$STATUS"
assert_no_mdloop 'mdloop not invoked'
cleanup

# ---------------------------------------------------------------------------
echo '3. linked, has a key, but mdloop not on PATH → stderr line, exit 1 (visible)'
# Exit 1 is load-bearing: Claude Code discards a hook'"'"'s stderr when it exits 0,
# so the old exit-0 version wrote this diagnostic to nowhere. 1 is non-blocking
# and surfaces the first stderr line as a transcript notice; 2 would block.
new_repo
link_repo
set_trigger agent-turn
run_hook PATH="$CLEAN_PATH" MDLOOP_API_KEY=mdloop_test
assert_eq 'exit 1, not 0 (0 would discard the message) and not 2 (2 blocks)' 1 "$STATUS"
assert_eq 'no stdout' '' "$STDOUT"
assert_contains 'hint names the CLI' 'mdloop CLI is not on PATH' "$STDERR"
assert_eq 'exactly one stderr line' 1 "$(printf '%s\n' "$STDERR" | grep -c .)"
cleanup

# ---------------------------------------------------------------------------
echo '3c. neither the CLI nor a key → the no-key path wins, silently'
# Ordering matters now that exit codes do. A teammate who never opted in has no
# use for a CLI-missing nag on every turn; "not adopted" outranks
# "misconfigured".
new_repo
link_repo
set_trigger agent-turn
run_hook -u MDLOOP_API_KEY PATH="$CLEAN_PATH"
assert_eq 'exit 0' 0 "$STATUS"
assert_eq 'no stdout' '' "$STDOUT"
assert_eq 'no stderr — not the CLI-missing message' '' "$STDERR"
cleanup

# ---------------------------------------------------------------------------
echo '3b. MDLOOP_CLI_PATH is the fallback when mdloop is not on PATH'
new_repo
link_repo
set_trigger agent-turn
stub_mdloop 0
mv "$WORK/bin/mdloop" "$WORK/mdloop-binary"
run_hook PATH="$CLEAN_PATH" MDLOOP_API_KEY=mdloop_test MDLOOP_CLI_PATH="$WORK/mdloop-binary"
assert_eq 'exit 0' 0 "$STATUS"
assert_contains 'invoked via MDLOOP_CLI_PATH' 'argv:push --quiet' "$(cat "$WORK/invocations")"
cleanup

# ---------------------------------------------------------------------------
echo '4. happy path → push --quiet, from the repo root, silent on stdout'
new_repo
link_repo
set_trigger agent-turn
stub_mdloop 0
mkdir -p "$WORK/repo/docs/deep"
cd "$WORK/repo/docs/deep" || exit 1 # the hook must find the root from a subdirectory
run_hook PATH="$WORK/bin:$CLEAN_PATH" MDLOOP_API_KEY=mdloop_test
assert_eq 'exit 0' 0 "$STATUS"
assert_eq 'no stdout' '' "$STDOUT"
INVOKED=$(cat "$WORK/invocations")
assert_contains 'invoked as push --quiet' 'argv:push --quiet' "$INVOKED"
assert_contains 'cwd is the repo root' "cwd:$(cd "$WORK/repo" && pwd -P)" "$INVOKED"
# A successful push is a no-op as far as the user is concerned: exit 0, which
# means whatever the CLI wrote to stderr is discarded by Claude Code anyway.
# Asserting on it would be asserting on something nobody ever sees.
assert_eq 'success exits 0' 0 "$STATUS"
cleanup

# ---------------------------------------------------------------------------
echo '4b. mdloop exits non-zero (conflict/failure) → hook exits 1, never 2'
new_repo
link_repo
set_trigger agent-turn
stub_mdloop 1
run_hook PATH="$WORK/bin:$CLEAN_PATH" MDLOOP_API_KEY=mdloop_test
assert_eq 'exit 1 so the failure is actually surfaced' 1 "$STATUS"
assert_eq 'never 2 — 2 would block the Stop and force the turn to continue' 0 "$((STATUS == 2))"
# The CLI's own line comes first, because that is the line the transcript
# notice shows; the summary is the fallback for a failure that printed nothing.
assert_eq 'CLI stderr is the first line' 'stub mdloop stderr' "$(printf '%s\n' "$STDERR" | head -1)"
assert_contains 'summary names the exit code' 'mdloop push exited 1' "$STDERR"
cleanup

# ---------------------------------------------------------------------------
echo '4c. mdloop killed (exit 143, nothing on stderr) → hook still surfaces it'
new_repo
link_repo
set_trigger agent-turn
cat >"$WORK/bin/mdloop" <<'STUB'
#!/usr/bin/env bash
exit 143
STUB
chmod +x "$WORK/bin/mdloop"
run_hook PATH="$WORK/bin:$CLEAN_PATH" MDLOOP_API_KEY=mdloop_test
assert_eq 'exit 1' 1 "$STATUS"
assert_contains 'summary is the only diagnostic there is' 'mdloop push exited 143' "$STDERR"
cleanup

# ---------------------------------------------------------------------------
echo '4d. first push fails, the local daemon was down, restarting it and retrying once recovers'
new_repo
link_repo
set_trigger agent-turn
# Stateful stub: `serve status` says "not running", `serve start` succeeds,
# and `push --quiet` fails on its first call (daemon was down) but succeeds
# on its second (the hook's one retry, after restarting it).
cat >"$WORK/bin/mdloop" <<STUB
#!/usr/bin/env bash
printf 'argv:%s\n' "\$*" >>"$WORK/invocations"
case "\$1 \$2" in
  "serve status") exit 1 ;;
  "serve start") exit 0 ;;
  "push --quiet")
    count_file="$WORK/push_calls"
    n=\$(cat "\$count_file" 2>/dev/null || echo 0)
    n=\$((n + 1))
    echo "\$n" >"\$count_file"
    if [ "\$n" -eq 1 ]; then
      printf 'stub mdloop stderr\n' >&2
      exit 1
    fi
    exit 0
    ;;
esac
STUB
chmod +x "$WORK/bin/mdloop"
run_hook PATH="$WORK/bin:$CLEAN_PATH" MDLOOP_API_KEY=mdloop_test
assert_eq 'the retry recovers — hook exits 0, not 1' 0 "$STATUS"
assert_eq 'no stdout' '' "$STDOUT"
assert_contains 'checked whether the daemon was running' 'argv:serve status' "$(cat "$WORK/invocations")"
assert_contains 'restarted it since status said it was down' 'argv:serve start' "$(cat "$WORK/invocations")"
assert_eq 'push was attempted exactly twice — the original call, then one retry' 2 \
  "$(grep -c '^argv:push --quiet$' "$WORK/invocations")"
cleanup

# ---------------------------------------------------------------------------
echo '4e. retry does not help (still down/still failing) → still exits 1, not a poll loop'
new_repo
link_repo
set_trigger agent-turn
stub_mdloop 1
run_hook PATH="$WORK/bin:$CLEAN_PATH" MDLOOP_API_KEY=mdloop_test
assert_eq 'exit 1' 1 "$STATUS"
assert_contains 'summary names the exit code' 'mdloop push exited 1' "$STDERR"
assert_eq 'push was attempted exactly twice, never more — one retry, not a loop' 2 \
  "$(grep -c 'argv:push --quiet' "$WORK/invocations")"
cleanup

# ---------------------------------------------------------------------------
echo '5. linked, mdloop present, no API key anywhere → silent no-op'
new_repo
link_repo
set_trigger agent-turn
stub_mdloop 0
run_hook -u MDLOOP_API_KEY PATH="$WORK/bin:$CLEAN_PATH"
assert_eq 'exit 0' 0 "$STATUS"
assert_eq 'no stdout' '' "$STDOUT"
assert_eq 'no stderr' '' "$STDERR"
assert_no_mdloop 'mdloop not invoked'
cleanup

# ---------------------------------------------------------------------------
echo '5b. .mdloop/credentials alone is enough'
new_repo
link_repo
set_trigger agent-turn
stub_mdloop 0
printf '{ "apiKey": "mdloop_test" }\n' >"$WORK/repo/.mdloop/credentials"
run_hook -u MDLOOP_API_KEY PATH="$WORK/bin:$CLEAN_PATH"
assert_eq 'exit 0' 0 "$STATUS"
assert_contains 'mdloop invoked' 'argv:push --quiet' "$(cat "$WORK/invocations")"
cleanup

# ---------------------------------------------------------------------------
echo '6. hooks.json wiring'
# `async: true` keeps a full network round trip off the critical path of every
# turn — the 60s synchronous timeout was the whole turn's worst case.
if grep -q '"async": true' "$HOOK_DIR/hooks.json"; then
  ok 'Stop hook runs async, so a slow push never blocks a turn'
else
  fail 'hooks.json should set "async": true'
fi
# Nothing in the script may ever exit 2 from a Stop hook.
if grep -qE '^\s*exit 2\b' "$HOOK"; then
  fail 'the script must never exit 2 — that blocks the Stop'
else
  ok 'no exit 2 anywhere in the script'
fi

# ---------------------------------------------------------------------------
printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
