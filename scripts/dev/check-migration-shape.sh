#!/usr/bin/env bash
#
# Migration shape check (ADR 0006 — expand/contract only,
# docs/adr/0006-zero-downtime-deploys-and-safe-migrations.md).
#
# Every migration under packages/persistence/migrations/*.sql must be an
# "expand" step: additive, and safe for the *old* app version to keep running
# against unmodified during a blue-green cutover. A "contract" step — DROP
# COLUMN, DROP TABLE, RENAME COLUMN, or tightening a column to NOT NULL — is
# destructive and, per the ADR, only ever ships as its own migration after a
# full deploy cycle has confirmed nothing still reads/writes the old shape.
# That's a judgment call a human has to make deliberately; ADR 0006 defines no
# override marker for skipping it, so this script fails hard on any match
# rather than guessing which ones are "fine." A genuine contract migration
# needs a human to review it and update this check on purpose, not slip past
# CI quietly.
#
# Checks every existing migration, not just newly-added ones — all 32 as of
# 2026-08-03 are already clean, so there's no backfill cost to doing so, and
# it's simpler than a git-diff-based changed-files-only version.
#
# Run from repo root: scripts/dev/check-migration-shape.sh
set -euo pipefail

MIGRATIONS_DIR="packages/persistence/migrations"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "check-migration-shape: $MIGRATIONS_DIR not found (run from repo root)" >&2
  exit 1
fi

shopt -s nullglob
files=("$MIGRATIONS_DIR"/*.sql)
shopt -u nullglob

if [ "${#files[@]}" -eq 0 ]; then
  echo "check-migration-shape: no .sql files found under $MIGRATIONS_DIR" >&2
  exit 1
fi

# Case-insensitive; SQL keywords are conventionally uppercase in this repo's
# migrations, but don't rely on that holding forever.
declare -a patterns=(
  'DROP[[:space:]]+COLUMN'
  'DROP[[:space:]]+TABLE'
  'RENAME[[:space:]]+COLUMN'
  'SET[[:space:]]+NOT[[:space:]]+NULL'
)

violations=0

for file in "${files[@]}"; do
  for pattern in "${patterns[@]}"; do
    if grep -Eiq "$pattern" "$file"; then
      echo "CONTRACT SHAPE DETECTED: $file matches /${pattern}/ — ADR 0006 requires contract steps to ship as their own, separately human-reviewed migration."
      violations=$((violations + 1))
    fi
  done
done

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "$violations violation(s) found. See docs/adr/0006-zero-downtime-deploys-and-safe-migrations.md."
  exit 1
fi

echo "OK: all ${#files[@]} migrations under $MIGRATIONS_DIR are expand-only (ADR 0006)."
