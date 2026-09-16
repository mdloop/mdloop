#!/usr/bin/env bash
#
# Branch tests for uninstall.sh. Same idiom as install.test.sh (which see for the general shape) —
# lives outside `packages/`, so deliberately not part of `pnpm verify`'s vitest run.
#
#   bash uninstall.test.sh
#
# uninstall.sh itself must stay POSIX sh; nothing about that constrains this driver, which only
# needs to build fake `npm`/`mdloop` on a throwaway PATH and assert on uninstall.sh's exit code,
# stdout, stderr, and what the fakes were invoked with.
set -u

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
UNINSTALL="$SCRIPT_DIR/uninstall.sh"

CLEAN_PATH=/usr/bin:/bin:/usr/sbin:/sbin

unset MDLOOP_NO_CLEANUP MDLOOP_PURGE_DATA

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

assert_not_contains() { # <label> <needle> <haystack>
  case "$3" in
    *"$2"*) fail "$1 — [$3] unexpectedly contains [$2]" ;;
    *) ok "$1" ;;
  esac
}

mdloop_invocations() {
  [ -f "$WORK/mdloop-invocations" ] && cat "$WORK/mdloop-invocations" || true
}

npm_invocations() {
  [ -f "$WORK/npm-invocations" ] && cat "$WORK/npm-invocations" || true
}

new_sandbox() {
  WORK=$(mktemp -d)
  mkdir -p "$WORK/bin"
}

# Records every call's argv; "uninstall" exits with the given code (default 0).
stub_mdloop() { # <uninstall-exit-code, default 0>
  local code="${1:-0}"
  cat >"$WORK/bin/mdloop" <<STUB
#!/usr/bin/env bash
printf 'argv:%s\n' "\$*" >>"$WORK/mdloop-invocations"
if [ "\$1" = "uninstall" ]; then
  exit $code
fi
exit 0
STUB
  chmod +x "$WORK/bin/mdloop"
}

# Records every call's argv; "uninstall -g mdloop" exits with the given code (default 0).
stub_npm() { # <uninstall-exit-code, default 0>
  local code="${1:-0}"
  cat >"$WORK/bin/npm" <<STUB
#!/usr/bin/env bash
printf 'argv:%s\n' "\$*" >>"$WORK/npm-invocations"
if [ "\$1" = "uninstall" ] && [ "\$2" = "-g" ]; then
  if [ "$code" != "0" ]; then
    echo "npm ERR! simulated failure" >&2
    exit $code
  fi
  exit 0
fi
exit 0
STUB
  chmod +x "$WORK/bin/npm"
}

run_uninstall() { # <env assignments...> — fills STATUS / STDOUT / STDERR
  local out err
  out=$(mktemp)
  err=$(mktemp)
  (
    env PATH="$WORK/bin:$CLEAN_PATH" "$@" \
      sh "$UNINSTALL" <"/dev/null" >"$out" 2>"$err"
  )
  STATUS=$?
  STDOUT=$(cat "$out")
  STDERR=$(cat "$err")
  rm -f "$out" "$err"
}

cleanup() {
  [ -n "$WORK" ] && rm -rf "$WORK"
  WORK=""
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
echo '1. mdloop on PATH, everything succeeds → cleanup then npm uninstall, exit 0'
new_sandbox
stub_mdloop 0
stub_npm 0
run_uninstall
assert_eq 'exit 0' 0 "$STATUS"
assert_contains 'ran mdloop uninstall' 'argv:uninstall' "$(mdloop_invocations)"
assert_contains 'ran npm uninstall -g mdloop' 'uninstall -g mdloop' "$(npm_invocations)"
cleanup

# ---------------------------------------------------------------------------
echo '2. mdloop not found on PATH → cleanup skipped, npm uninstall still runs'
new_sandbox
stub_npm 0
run_uninstall
assert_eq 'exit 0' 0 "$STATUS"
assert_contains 'says nothing local to clean up' 'nothing local to clean up' "$STDOUT"
assert_contains 'still removed the package' 'uninstall -g mdloop' "$(npm_invocations)"
cleanup

# ---------------------------------------------------------------------------
echo '3. mdloop uninstall reports a problem → not fatal, npm uninstall still runs, exit 0'
new_sandbox
stub_mdloop 1
stub_npm 0
run_uninstall
assert_eq 'exit 0' 0 "$STATUS"
assert_contains 'reports the cleanup problem' 'cleanup reported a problem' "$STDOUT"
assert_contains 'still removed the package' 'uninstall -g mdloop' "$(npm_invocations)"
cleanup

# ---------------------------------------------------------------------------
echo '4. npm uninstall fails → exit 1, npm'"'"'s own error surfaced'
new_sandbox
stub_mdloop 0
stub_npm 1
run_uninstall
assert_eq 'exit 1' 1 "$STATUS"
assert_contains 'surfaces npm'"'"'s own failure' 'npm ERR!' "$STDERR"
cleanup

# ---------------------------------------------------------------------------
echo '5. MDLOOP_NO_CLEANUP=1 skips mdloop uninstall entirely, still removes the package'
new_sandbox
stub_mdloop 0
stub_npm 0
run_uninstall MDLOOP_NO_CLEANUP=1
assert_eq 'exit 0' 0 "$STATUS"
assert_not_contains 'mdloop uninstall never invoked' 'argv:uninstall' "$(mdloop_invocations)"
assert_contains 'still removed the package' 'uninstall -g mdloop' "$(npm_invocations)"
cleanup

# ---------------------------------------------------------------------------
echo '6. MDLOOP_PURGE_DATA=1 passes --purge-data through to mdloop uninstall'
new_sandbox
stub_mdloop 0
stub_npm 0
run_uninstall MDLOOP_PURGE_DATA=1
assert_eq 'exit 0' 0 "$STATUS"
assert_contains 'passed --purge-data' 'argv:uninstall --purge-data' "$(mdloop_invocations)"
cleanup

# ---------------------------------------------------------------------------
echo '7. npm not found → clean refusal'
new_sandbox
stub_mdloop 0
run_uninstall
assert_eq 'exit 1' 1 "$STATUS"
assert_contains 'names the problem' 'npm not found' "$STDERR"
cleanup

# ---------------------------------------------------------------------------
printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
