# syntax=docker/dockerfile:1

# Vorlyn — production container image. One Dockerfile, one shared deps ->
# build pipeline, four build targets: api, mcp, jobs (the three backend
# services) and migrate (a one-shot migration task). `web` is a Vite SPA
# shipped as a static bundle, not containerized; `cli` is a local tool run
# from source (see README.md/SELF_HOSTING.md — nothing here is published to
# npm yet), not containerized either.
#
# Build (ARM64/Graviton is a build-command concern, not a Dockerfile one —
# node:22-bookworm-slim is multi-arch, no arch-specific logic needed here):
#   docker buildx build --platform linux/arm64 --target api     -t vorlyn-api:<digest-tag>     .
#   docker buildx build --platform linux/arm64 --target mcp     -t vorlyn-mcp:<digest-tag>     .
#   docker buildx build --platform linux/arm64 --target jobs    -t vorlyn-jobs:<digest-tag>    .
#   docker buildx build --platform linux/arm64 --target migrate -t vorlyn-migrate:<digest-tag> .
# A deployment's task definitions should reference the resulting image by
# digest, never by tag.
#
# Migration one-shot (run once ahead of every deploy, connected as the DB
# owner — never vorlyn_login; see packages/persistence/src/migrate-main.ts):
#   docker run --rm -e DATABASE_URL=... -e DB_SSL_CA_PATH=/app/rds-ca-bundle.pem vorlyn-migrate:<digest-tag>
# which is exactly:
#   node node_modules/@vorlyn/persistence/dist/migrate-main.js
# run from the `migrate` target's /app (that target reuses the `api` deploy
# output — @vorlyn/persistence, and migrate-main.js with it, is already a
# transitive prod dependency of @vorlyn/api, so no fourth `pnpm deploy` is
# needed). api/mcp/jobs should set the same DB_SSL_CA_PATH
# (packages/persistence/src/pool-config.ts) when connecting over TLS; a plain
# `docker run` without it still works unmodified against a non-TLS Postgres.
#
# Secrets: never baked in via ARG/ENV — there are none needed at build time.
# Runtime secrets arrive via whatever secrets-injection mechanism a deployment
# uses. `.dockerignore` keeps .env/.git out of the build context entirely.

ARG NODE_IMAGE=node:22-bookworm-slim

# -----------------------------------------------------------------------------
# deps — install the full pnpm workspace once. All 9 workspace package.json
# files are copied (not just api/mcp/jobs's own) because `--frozen-lockfile`
# validates against every workspace importer in pnpm-lock.yaml, including
# cli and web, even though this image never builds or ships those two.
# -----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/app/package.json packages/app/package.json
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/jobs/package.json packages/jobs/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/web/package.json packages/web/package.json

RUN pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# build — compile the backend's TypeScript project references and produce a
# pruned, prod-deps-only, real-files (not workspace symlinks) deploy dir per
# service via `pnpm deploy`.
# -----------------------------------------------------------------------------
FROM deps AS build

COPY tsconfig.json tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/domain packages/domain
COPY packages/app packages/app
COPY packages/persistence packages/persistence
COPY packages/api packages/api
COPY packages/mcp packages/mcp
COPY packages/jobs packages/jobs

# Builds packages/api, packages/mcp, packages/jobs; tsc --build follows their
# project references (shared, domain, app, persistence) automatically.
RUN pnpm exec tsc --build packages/api packages/mcp packages/jobs

# pnpm 10 defaults to the injected-workspace-package deploy implementation,
# which this workspace isn't configured for (no inject-workspace-packages
# setting), and fails with ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE without
# --legacy. --legacy still materializes real files for workspace:* deps in
# the target dir (verified locally: node_modules/@vorlyn/* are real compiled
# output, not symlinks back into the workspace) — it's the correct flag here,
# not a fallback.
RUN pnpm --filter @vorlyn/api deploy --prod --legacy /deploy/api \
 && pnpm --filter @vorlyn/mcp deploy --prod --legacy /deploy/mcp \
 && pnpm --filter @vorlyn/jobs deploy --prod --legacy /deploy/jobs

# `pnpm deploy` has no `"files"` allowlist to constrain it (none of these
# package.json declare one), so it copies each package's .ts source and test
# files verbatim alongside dist/ — including compiled *.test.js fixtures that
# reference fake API-key-shaped strings (e.g. packages/api/src/config.test.ts
# `sk_test_123`). Strip all of that: it's dead weight against the <300MB
# budget and needless surface for `trivy image --scanners secret`.
RUN for svc in api mcp jobs; do \
      find /deploy/$svc -type f -name '*.test.*' -delete; \
      rm -rf /deploy/$svc/src /deploy/$svc/tsconfig.json /deploy/$svc/tsconfig.tsbuildinfo; \
      for dep in /deploy/$svc/node_modules/@vorlyn/*; do \
        find "$dep" -type f -name '*.test.*' -delete; \
        rm -rf "$dep/src" "$dep/tsconfig.json" "$dep/tsconfig.tsbuildinfo"; \
      done; \
    done

# -----------------------------------------------------------------------------
# ca-bundle — an RDS CA bundle, fetched once and shared by every runtime
# target, for the common case of a Postgres provider whose TLS chain needs
# one. Consumed by app code (packages/persistence/src/pool-config.ts,
# DB_SSL_CA_PATH) only when that env var is set — the image doesn't default
# it, so a plain `docker run` against a non-TLS Postgres (local
# smoke-testing) or a different provider's own CA still works unchanged.
# Isolated in its own stage so curl/apt-get never touch the final runtime images.
# -----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS ca-bundle
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /rds-ca-bundle.pem \
 && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# runtime-base — shared non-root setup for every service image below.
# Read-only-rootfs compatible: nothing here (or in api/mcp/jobs main.ts)
# writes under /app at runtime. Local blob storage (FsStorage/BLOB_STORAGE_DIR)
# is dev-only per CLAUDE.md and is never wired up in these entrypoints; a real
# deployment configures an object-storage adapter instead. Node's own /tmp
# needs, if any, are a deployment's own container-runtime setting (a
# read-only root filesystem plus a tmpfs mount at /tmp), not this image's job.
# -----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime-base
RUN groupadd --gid 10001 appuser \
 && useradd --uid 10001 --gid appuser --no-create-home --shell /usr/sbin/nologin appuser
ENV NODE_ENV=production
COPY --from=ca-bundle /rds-ca-bundle.pem /app/rds-ca-bundle.pem
WORKDIR /app

# -----------------------------------------------------------------------------
# api — HTTP API service.
# -----------------------------------------------------------------------------
FROM runtime-base AS api
COPY --from=build --chown=10001:10001 /deploy/api ./
USER 10001:10001
# Documentation only — a deployment's own load-balancer health check against
# /readyz, not this EXPOSE, is what actually gates traffic.
EXPOSE 3000
CMD ["node", "dist/main.js"]

# -----------------------------------------------------------------------------
# mcp — MCP streamable-HTTP service.
# -----------------------------------------------------------------------------
FROM runtime-base AS mcp
COPY --from=build --chown=10001:10001 /deploy/mcp ./
USER 10001:10001
EXPOSE 3001
CMD ["node", "dist/main.js"]

# -----------------------------------------------------------------------------
# jobs — long-running compliance scheduler. No HTTP port; health for this
# service is process-liveness, not an HTTP health-check endpoint.
# -----------------------------------------------------------------------------
FROM runtime-base AS jobs
COPY --from=build --chown=10001:10001 /deploy/jobs ./
USER 10001:10001
CMD ["node", "dist/main.js"]

# -----------------------------------------------------------------------------
# migrate — one-shot migration task. Reuses the api deploy output rather than
# a fourth `pnpm deploy`, since @vorlyn/persistence (migrate-main.js included)
# is already a transitive prod dependency of @vorlyn/api.
# -----------------------------------------------------------------------------
FROM runtime-base AS migrate
COPY --from=build --chown=10001:10001 /deploy/api ./
USER 10001:10001
CMD ["node", "node_modules/@vorlyn/persistence/dist/migrate-main.js"]
