#!/usr/bin/env bash
#
# Branch protection drill (docs/RISKS.md's "a gate that measures nothing looks
# exactly like a gate that passes" applied to the ruleset itself, not just
# CI). Proves the repository ruleset on `main` actually behaves the way its
# API response claims, by trying the things it's supposed to prevent — rather
# than trusting `gh api .../rulesets` output at face value.
#
# Run from repo root: scripts/dev/verify-branch-protection.sh
# Requires: gh (authenticated with repo write access), git, a clean working
# tree, and origin pointing at the real GitHub repo.
#
# Deliberately NOT tested: branch deletion. The only real assertion would be
# "deleting main fails" — and if the ruleset's `deletion` rule were ever
# misconfigured, running that assertion is exactly the mistake that deletes
# main for real. Assertion 1 below confirms the `deletion` rule exists and is
# active; that's as far as this script goes on purpose.
set -euo pipefail

REPO="mdloop/mdloop"
BRANCH_PREFIX="protection-drill"
FAIL=0

pass() { echo "  PASS: $1"; }
fail() {
  echo "  FAIL: $1"
  FAIL=1
}
section() { echo; echo "== $1 =="; }

on_exit() {
  # Best-effort cleanup — never let a failed assertion strand local state.
  git checkout -q main 2>/dev/null || true
  git branch -D "$DRILL_BRANCH" 2>/dev/null || true
  git reset -q --hard origin/main 2>/dev/null || true
  if [ -n "${PR_NUMBER:-}" ]; then
    gh pr close "$PR_NUMBER" --delete-branch 2>/dev/null || true
  fi
}
trap on_exit EXIT

if [ -n "$(git status --porcelain)" ]; then
  echo "verify-branch-protection: working tree not clean, aborting" >&2
  exit 1
fi

git fetch -q origin main
DRILL_BRANCH="${BRANCH_PREFIX}-$(date +%s)"

# ---------------------------------------------------------------------------
section "1. Ruleset shape"
# ---------------------------------------------------------------------------
RULESETS_JSON="$(gh api "repos/${REPO}/rulesets" --jq '[.[] | select(.enforcement=="active")]')"
RULESET_COUNT="$(echo "$RULESETS_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).length))')"

if [ "$RULESET_COUNT" -lt 1 ]; then
  fail "no active ruleset found on ${REPO}"
else
  RULESET_ID="$(echo "$RULESETS_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d)[0].id))')"
  RULESET="$(gh api "repos/${REPO}/rulesets/${RULESET_ID}")"

  check_field() {
    local desc="$1" jq_expr="$2" expected="$3"
    local actual
    actual="$(echo "$RULESET" | node -e "
      let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
        const r = JSON.parse(d);
        const val = ($jq_expr);
        console.log(JSON.stringify(val));
      })")"
    if [ "$actual" = "$expected" ]; then
      pass "$desc"
    else
      fail "$desc — got $actual, expected $expected"
    fi
  }

  check_field "enforcement is active" "r.enforcement" '"active"'
  check_field "no bypass actors" "r.bypass_actors.length" "0"
  check_field "deletion rule present" "r.rules.some(x=>x.type==='deletion')" "true"
  check_field "non_fast_forward rule present" "r.rules.some(x=>x.type==='non_fast_forward')" "true"
  check_field "pull_request rule present" "r.rules.some(x=>x.type==='pull_request')" "true"
  check_field "required_status_checks rule present" "r.rules.some(x=>x.type==='required_status_checks')" "true"
  check_field "status checks are strict (branch must be up to date)" \
    "r.rules.find(x=>x.type==='required_status_checks').parameters.strict_required_status_checks_policy" "true"

  REQUIRED_CONTEXTS="$(echo "$RULESET" | node -e "
    let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
      const r = JSON.parse(d);
      const rule = r.rules.find(x=>x.type==='required_status_checks');
      console.log(rule.parameters.required_status_checks.map(c=>c.context).sort().join(','));
    })")"
  EXPECTED_CONTEXTS="codeql,constitution,e2e,secret-scan,verify"
  if [ "$REQUIRED_CONTEXTS" = "$EXPECTED_CONTEXTS" ]; then
    pass "required status checks are exactly: $EXPECTED_CONTEXTS"
  else
    fail "required status checks are [$REQUIRED_CONTEXTS], expected [$EXPECTED_CONTEXTS]"
  fi
fi

# ---------------------------------------------------------------------------
section "2. Direct push to main is rejected"
# ---------------------------------------------------------------------------
git checkout -q -B main origin/main
echo "protection drill $(date -u +%FT%TZ)" >>.protection-drill-tmp
git add .protection-drill-tmp
git commit -q -m "protection drill: direct push probe (expected to be rejected)"
if git push origin main 2>drill-push.log; then
  fail "direct push to main SUCCEEDED — protection is not enforced"
else
  if grep -qiE "protected branch|rule violations|required status check" drill-push.log; then
    pass "direct push to main rejected (protected-branch error)"
  else
    fail "direct push to main was rejected, but not for a recognizable protected-branch reason — see drill-push.log"
  fi
fi
rm -f drill-push.log
git reset -q --hard origin/main
rm -f .protection-drill-tmp

# ---------------------------------------------------------------------------
section "3. Force-push to main is rejected"
# ---------------------------------------------------------------------------
git commit -q --allow-empty -m "protection drill: force-push probe (expected to be rejected)"
if git push --force-with-lease origin main 2>drill-force.log; then
  fail "force-push to main SUCCEEDED — non_fast_forward is not enforced"
else
  pass "force-push to main rejected"
fi
rm -f drill-force.log
git reset -q --hard origin/main

# ---------------------------------------------------------------------------
section "4. Merge is blocked while required checks are not green"
# ---------------------------------------------------------------------------
git checkout -q -b "$DRILL_BRANCH"
# A dedicated, self-documenting scratch file — not a real doc like
# docs/RISKS.md — so a successful drill run's merge doesn't leave permanent
# junk in maintained documentation. Overwritten (not appended) each run.
cat >PROTECTION_DRILL.md <<EOF
# Branch protection drill

This file exists only as a target for \`scripts/dev/verify-branch-protection.sh\`'s merge-gate
assertions (does a real PR through the real ruleset, end to end). Its content is meaningless;
only its presence and successful merge matter.

Last drill run: $(date -u +%FT%TZ)
EOF
git add PROTECTION_DRILL.md
git commit -q -m "protection drill: trivial change to exercise the merge gate"
git push -q -u origin "$DRILL_BRANCH"

PR_NUMBER="$(gh pr create --title "protection drill (auto-generated, will self-close)" \
  --body "Opened by scripts/dev/verify-branch-protection.sh — safe to close if left behind." \
  --head "$DRILL_BRANCH" --base main --json number --jq '.number' 2>/dev/null || true)"

if [ -z "$PR_NUMBER" ]; then
  fail "could not open drill PR — skipping merge-gate assertions (3 checks)"
else
  sleep 5 # let GitHub register the new PR's status-check expectations
  MERGE_STATE="$(gh pr view "$PR_NUMBER" --json mergeStateStatus --jq '.mergeStateStatus')"
  if [ "$MERGE_STATE" = "BLOCKED" ] || [ "$MERGE_STATE" = "UNSTABLE" ] || [ "$MERGE_STATE" = "UNKNOWN" ]; then
    pass "PR #$PR_NUMBER merge state is $MERGE_STATE while checks are pending"
  else
    fail "PR #$PR_NUMBER merge state is $MERGE_STATE — expected BLOCKED/UNSTABLE/UNKNOWN before checks finish"
  fi

  if gh pr merge "$PR_NUMBER" --squash 2>drill-merge.log; then
    fail "merge SUCCEEDED before required checks finished"
  else
    pass "merge correctly refused before required checks finished"
  fi
  rm -f drill-merge.log

  # -------------------------------------------------------------------------
  section "5. Merge succeeds once required checks are green"
  # -------------------------------------------------------------------------
  echo "  waiting for required checks on PR #$PR_NUMBER (up to 10 min)..."
  if gh pr checks "$PR_NUMBER" --watch --interval 15 --fail-fast >drill-checks.log 2>&1; then
    MERGE_STATE="$(gh pr view "$PR_NUMBER" --json mergeStateStatus --jq '.mergeStateStatus')"
    if [ "$MERGE_STATE" = "CLEAN" ]; then
      pass "PR #$PR_NUMBER merge state is CLEAN once checks are green"
    else
      fail "PR #$PR_NUMBER merge state is $MERGE_STATE, expected CLEAN — see drill-checks.log"
    fi

    if gh pr merge "$PR_NUMBER" --squash --delete-branch 2>drill-merge2.log; then
      pass "merge succeeded once required checks were green"
      PR_NUMBER="" # merged — on_exit's close/delete-branch is now a no-op, which is fine
    else
      fail "merge still refused after all required checks passed — see drill-merge2.log"
    fi
    rm -f drill-merge2.log
  else
    fail "required checks did not go green within the wait window — see drill-checks.log"
  fi
  rm -f drill-checks.log
fi

# ---------------------------------------------------------------------------
section "6. Cleanup"
# ---------------------------------------------------------------------------
git checkout -q main
git fetch -q origin main
git reset -q --hard origin/main
if git diff --quiet origin/main -- 2>/dev/null; then
  pass "local main matches origin/main after cleanup"
else
  fail "local main diverged from origin/main after cleanup"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "verify-branch-protection: ALL CHECKS PASSED"
  exit 0
else
  echo "verify-branch-protection: ONE OR MORE CHECKS FAILED"
  exit 1
fi
