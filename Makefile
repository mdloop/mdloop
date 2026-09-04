# mdloop — local development entry points.
#
#   make dev            run the app (API :3000 + web :5173 + MCP :3001) with
#                       loopback auth, persistent local Postgres database "mdloop_dev"
#   make test           unit + integration tests (ephemeral DBs, coverage gate)
#   make e2e            Playwright browser suite against a throwaway stack
#   make verify         the full merge gate (lint, format, types, boundaries, tests)
#   make hooks-install  install a local pre-commit secret scan (courtesy check;
#                       CI's gitleaks job is the enforced backstop, catching a
#                       real key before it lands in a commit)
#   make db-reset       drop the dev database (next `make dev` recreates it)
#
# Requirements: Node >= 22, pnpm, local Postgres on the default socket —
# macOS/Homebrew: `brew services start postgresql@18`; Debian/Ubuntu:
# `sudo systemctl start postgresql` (apt's postgresql package); anything
# else: however your distro starts its Postgres service. No WorkOS keys
# needed — dev auth is a loopback stub; "Sign in" just signs you in.

# bash, not the shell installed by default only on macOS: every recipe below
# is plain POSIX-compatible shell (no zsh-only syntax), and bash ships on
# every mainstream Linux distro's base image where zsh commonly does not —
# `make dev`/`make verify` failing with "/bin/zsh: No such file or
# directory" on a fresh Linux clone was the actual, avoidable failure mode
# this used to have.
SHELL := /bin/bash

DEV_DB_URL := postgres://mdloop_login@localhost:5432/mdloop_dev

.PHONY: dev api web mcp build test e2e verify db-reset hooks-install

build:
	pnpm install
	pnpm typecheck

# api creates/migrates mdloop_dev on startup (see dev-main.ts); mcp connects
# to that same database on its very first query and has no retry of its own,
# so on a fresh checkout it loses the race and dies before api finishes
# creating the database. Block on /readyz before starting mcp so this is
# deterministic instead of "usually fine, flaky on a clean clone."
dev: build
	@node --env-file-if-exists=.env packages/api/dist/dev-main.js & api=$$!; \
	echo "waiting for api (:3000) before starting mcp..."; \
	for i in $$(seq 1 60); do \
		curl -sf http://localhost:3000/readyz >/dev/null 2>&1 && break; \
		kill -0 $$api 2>/dev/null || { echo "api exited before becoming ready"; exit 1; }; \
		sleep 0.5; \
	done; \
	DATABASE_URL=$(DEV_DB_URL) node --env-file-if-exists=.env packages/mcp/dist/main.js & mcp=$$!; \
	pnpm --filter @mdloop/web dev & web=$$!; \
	trap 'kill -TERM $$api $$mcp $$web -$$api -$$mcp -$$web 2>/dev/null' INT TERM EXIT; \
	wait

# Run these separately if you prefer more terminals.
api: build
	node --env-file-if-exists=.env packages/api/dist/dev-main.js

web:
	pnpm --filter @mdloop/web dev

# API dev-main creates/migrates mdloop_dev on startup; run `make api` once
# before `make mcp` on a fresh checkout so the database exists.
mcp: build
	DATABASE_URL=$(DEV_DB_URL) node --env-file-if-exists=.env packages/mcp/dist/main.js

test:
	pnpm test

e2e: build
	npx playwright test

verify:
	pnpm verify

db-reset:
	dropdb --if-exists mdloop_dev

# Installs .git/hooks/pre-commit: runs `gitleaks protect --staged` (staged
# changes only, fast) if gitleaks is installed locally, otherwise prints how
# to get it and lets the commit through — CI's gitleaks-action job is the
# enforced backstop, this is a courtesy. Marker-based clobber-avoidance, same
# precedent as packages/cli/src/git-hook.ts's post-commit hook: never
# overwrites a pre-commit hook that isn't already ours.
hooks-install:
	@hooks_dir=$$(git rev-parse --git-path hooks 2>/dev/null); \
	if [ -z "$$hooks_dir" ]; then echo "not a git repo — nothing to install"; exit 0; fi; \
	hook="$$hooks_dir/pre-commit"; \
	marker='# Managed by "make hooks-install" — safe to regenerate; do not hand-edit.'; \
	if [ -f "$$hook" ] && ! grep -qF "$$marker" "$$hook"; then \
		echo "pre-commit hook already exists at $$hook and isn't ours — leaving it untouched."; \
		echo 'Add this line yourself to get secret scanning: command -v gitleaks >/dev/null 2>&1 && gitleaks protect --staged --no-banner'; \
		exit 0; \
	fi; \
	mkdir -p "$$hooks_dir"; \
	{ \
		echo '#!/bin/sh'; \
		echo "$$marker"; \
		echo '#'; \
		echo '# Local secret-scan courtesy check.'; \
		echo '# CI (gitleaks-action, .github/workflows/ci.yml) is the enforced backstop —'; \
		echo '# a missing local gitleaks install must never block a commit, only a real leak.'; \
		echo 'if command -v gitleaks >/dev/null 2>&1; then'; \
		echo '  gitleaks protect --staged --no-banner'; \
		echo '  exit $$?'; \
		echo 'else'; \
		echo '  echo "note: gitleaks not installed (brew install gitleaks) — CI will still scan this commit before merge"'; \
		echo '  exit 0'; \
		echo 'fi'; \
	} > "$$hook"; \
	chmod +x "$$hook"; \
	echo "installed pre-commit hook at $$hook"
