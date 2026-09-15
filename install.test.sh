#!/usr/bin/env bash
#
# Branch tests for install.sh. Plain bash driving the target script, same idiom as
# claude-plugin/hooks/mdloop-ensure.test.sh (which see for the general shape) — this lives outside
# `packages/`, so it is deliberately not part of `pnpm verify`'s vitest run.
#
#   bash install.test.sh
#
# install.sh itself must stay POSIX sh (see its own header comment for why); nothing about that
# constrains this driver, which only needs to build fake `node`/`npm`/`mdloop`/`git` on a throwaway
# PATH and assert on install.sh's exit code, stdout, stderr, and what the fakes were invoked with.
set -u

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
INSTALL="$SCRIPT_DIR/install.sh"

# A PATH with the system tools install.sh needs (git, sed, cat) but never a real
# node/npm/mdloop — every case builds exactly the fakes it wants to test against.
CLEAN_PATH=/usr/bin:/bin:/usr/sbin:/sbin

# install.sh reads all three; never inherit the tester's own.
unset MDLOOP_VERSION MDLOOP_NO_INSTRUCTIONS MDLOOP_NO_LINK MDLOOP_MCP_URL

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

# A throwaway sandbox: bin/ for fakes, repo/ as the folder install.sh runs from. Also drops the
# fixed template a passing npm fake "installs" as the mdloop stub (see stub_npm) — kept as a
# separate real file rather than a heredoc nested inside npm's own heredoc, since two layers of
# variable-substitution-vs-literal heredoc quoting is exactly the kind of thing that is easy to get
# subtly wrong and hard to read back later.
new_sandbox() {
  WORK=$(mktemp -d)
  mkdir -p "$WORK/bin" "$WORK/repo"
  cat >"$WORK/mdloop-template" <<'TEMPLATE'
#!/usr/bin/env bash
printf 'argv:%s\n' "$*" >>"$MDLOOP_LOG"
exit 0
TEMPLATE
  chmod +x "$WORK/mdloop-template"
}

git_init_repo() {
  git -C "$WORK/repo" init --quiet
}

stub_node() { # <version, e.g. "v22.11.0">
  local ver="$1"
  cat >"$WORK/bin/node" <<STUB
#!/usr/bin/env bash
if [ "\$1" = "-v" ]; then
  printf '%s\n' "$ver"
  exit 0
fi
exit 1
STUB
  chmod +x "$WORK/bin/node"
}

# Records every call's argv, then on "install -g ..." either fails with the given code or "installs"
# mdloop by copying the template into place — the same effect a real `npm install -g mdloop` has on
# a later `command -v mdloop`, without a network or a registry.
stub_npm() { # <install-exit-code, default 0>
  local code="${1:-0}"
  cat >"$WORK/bin/npm" <<STUB
#!/usr/bin/env bash
printf 'argv:%s\n' "\$*" >>"$WORK/npm-invocations"
if [ "\$1" = "install" ] && [ "\$2" = "-g" ]; then
  if [ "$code" != "0" ]; then
    echo "npm ERR! simulated failure" >&2
    exit $code
  fi
  cp "$WORK/mdloop-template" "$WORK/bin/mdloop"
  chmod +x "$WORK/bin/mdloop"
  exit 0
fi
exit 0
STUB
  chmod +x "$WORK/bin/npm"
}

run_install() { # <env assignments...> — fills STATUS / STDOUT / STDERR
  local out err
  out=$(mktemp)
  err=$(mktemp)
  # stdin from /dev/null, same as the pipe end of "curl ... | sh" — this is what makes `[ -t 0 ]`
  # false in these tests regardless of whether the test suite itself is run from a real terminal.
  (
    cd "$WORK/repo" &&
      env PATH="$WORK/bin:$CLEAN_PATH" MDLOOP_LOG="$WORK/mdloop-invocations" "$@" \
        sh "$INSTALL" <"/dev/null" >"$out" 2>"$err"
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
echo '1. node not found → clean refusal, npm never invoked'
new_sandbox
git_init_repo
stub_npm 0
run_install
assert_eq 'exit 1' 1 "$STATUS"
assert_contains 'names the problem' 'node not found' "$STDERR"
assert_eq 'npm never invoked' '' "$(npm_invocations)"
cleanup

# ---------------------------------------------------------------------------
echo '2. node too old → clean refusal naming the version, npm never invoked'
new_sandbox
git_init_repo
stub_node 'v20.11.0'
stub_npm 0
run_install
assert_eq 'exit 1' 1 "$STATUS"
assert_contains 'names the version found' 'v20.11.0' "$STDERR"
assert_contains 'says what is needed' '>=22' "$STDERR"
assert_eq 'npm never invoked' '' "$(npm_invocations)"
cleanup

# ---------------------------------------------------------------------------
echo '3. node >=22, npm succeeds → installs, writes global instructions, links the repo'
new_sandbox
git_init_repo
stub_node 'v22.11.0'
stub_npm 0
run_install
assert_eq 'exit 0' 0 "$STATUS"
assert_contains 'npm installed the mdloop package' 'install -g mdloop' "$(npm_invocations)"
assert_contains 'wrote the global instructions' 'argv:instructions install --global' "$(mdloop_invocations)"
assert_contains 'linked the repo' 'argv:link' "$(mdloop_invocations)"
cleanup

# ---------------------------------------------------------------------------
echo '4. npm install fails → exit 1, guidance surfaced, mdloop never installed or invoked'
new_sandbox
git_init_repo
stub_node 'v22.11.0'
stub_npm 1
run_install
assert_eq 'exit 1' 1 "$STATUS"
assert_contains 'surfaces npm'"'"'s own failure' 'npm ERR!' "$STDERR"
assert_contains 'offers the no-sudo prefix fix' 'npm config set prefix' "$STDERR"
assert_not_contains 'never suggests sudo' 'sudo npm' "$STDERR"
assert_eq 'mdloop was never even created' '' "$(mdloop_invocations)"
cleanup

# ---------------------------------------------------------------------------
echo '5. MDLOOP_VERSION pins an exact version'
new_sandbox
git_init_repo
stub_node 'v22.11.0'
stub_npm 0
run_install MDLOOP_VERSION=0.2.0
assert_eq 'exit 0' 0 "$STATUS"
assert_contains 'installs the pinned version' 'install -g mdloop@0.2.0' "$(npm_invocations)"
cleanup

# ---------------------------------------------------------------------------
echo '6. MDLOOP_NO_INSTRUCTIONS=1 skips the global instructions but still links'
new_sandbox
git_init_repo
stub_node 'v22.11.0'
stub_npm 0
run_install MDLOOP_NO_INSTRUCTIONS=1
assert_eq 'exit 0' 0 "$STATUS"
assert_not_contains 'instructions never written' 'argv:instructions' "$(mdloop_invocations)"
assert_contains 'still linked' 'argv:link' "$(mdloop_invocations)"
cleanup

# ---------------------------------------------------------------------------
echo '7. MDLOOP_NO_LINK=1 skips linking but still writes instructions'
new_sandbox
git_init_repo
stub_node 'v22.11.0'
stub_npm 0
run_install MDLOOP_NO_LINK=1
assert_eq 'exit 0' 0 "$STATUS"
assert_contains 'still wrote the global instructions' 'argv:instructions install --global' "$(mdloop_invocations)"
assert_not_contains 'link never invoked' 'argv:link' "$(mdloop_invocations)"
cleanup

# ---------------------------------------------------------------------------
echo '8. not inside a git repo → link skipped and said so, instructions still written'
new_sandbox
stub_node 'v22.11.0'
stub_npm 0
run_install
assert_eq 'exit 0' 0 "$STATUS"
assert_contains 'says why it skipped linking' 'not inside a git repo' "$STDOUT"
assert_not_contains 'link never invoked' 'argv:link' "$(mdloop_invocations)"
assert_contains 'instructions still written' 'argv:instructions install --global' "$(mdloop_invocations)"
cleanup

# ---------------------------------------------------------------------------
echo '9. no TTY on stdin + a non-local MDLOOP_MCP_URL → link skipped rather than risking a hang'
new_sandbox
git_init_repo
stub_node 'v22.11.0'
stub_npm 0
run_install MDLOOP_MCP_URL='https://mdloop.example.com/mcp'
assert_eq 'exit 0' 0 "$STATUS"
assert_contains 'explains the skip' 'no terminal on stdin' "$STDOUT"
assert_not_contains 'link never invoked' 'argv:link' "$(mdloop_invocations)"
cleanup

# ---------------------------------------------------------------------------
echo '10. a local MDLOOP_MCP_URL is linked even with no TTY on stdin'
new_sandbox
git_init_repo
stub_node 'v22.11.0'
stub_npm 0
run_install MDLOOP_MCP_URL='http://127.0.0.1:58744/mcp'
assert_eq 'exit 0' 0 "$STATUS"
assert_contains 'linked anyway — local endpoints never need a prompt' 'argv:link' "$(mdloop_invocations)"
cleanup

# ---------------------------------------------------------------------------
echo '11. re-running is idempotent — a second run also succeeds'
new_sandbox
git_init_repo
stub_node 'v22.11.0'
stub_npm 0
run_install
FIRST_STATUS=$STATUS
run_install
assert_eq 'first run exit 0' 0 "$FIRST_STATUS"
assert_eq 'second run exit 0' 0 "$STATUS"
cleanup

# ---------------------------------------------------------------------------
printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
