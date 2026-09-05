# Self-hosting mdloop

Two shapes, depending on what you need.

## One user, one project

```sh
npx mdloop open ./my-project
```

Building from source instead (for development, or to run a version ahead of what's published):

```sh
git clone https://github.com/mdloop/mdloop
cd mdloop
pnpm install
pnpm build                # builds the CLI (tsc) AND the web SPA (vite) — `open` serves both
node packages/cli/dist/main.js open ./my-project
```

`pnpm typecheck` alone is not enough here, even though it does produce
`packages/cli/dist/main.js`: `packages/web`'s `tsconfig.json` sets
`emitDeclarationOnly`, so `tsc --build` emits only `.d.ts` files for it, never the
actual bundle `open` serves. `pnpm build` runs
`pnpm typecheck && pnpm --filter @mdloop/web build` (the `vite build` step) —
skip that second half and `open` starts Postgres and the MCP server successfully,
then crashes on `No built web SPA at .../packages/web/dist (no index.html)`
once it tries to serve the UI, which is a confusing place to fail after
everything else came up clean.

Starts an embedded Postgres (PGlite, a WASM build behind a real Postgres wire-protocol socket
server), migrates it, mints an admin API key, links the folder (auto-
provisioning a project named after it, reusing one if it already exists), and opens the app in your
browser (`mdloop open` prints the URL). The api/mcp ports default to a fixed pair in the private/
dynamic range — not 3000/3001, common enough dev-server defaults that hardcoding them risks
colliding with something else already running, but still the _same_ two ports every time, so a
document link stays valid across a `mdloop serve` restart instead of moving with each one. Set
`PORT`/`MCP_PORT` yourself if that pair is ever taken by something else on your machine. State
lives in a per-machine data directory (`packages/cli/src/data-dir.ts`) so re-running it against the
same folder reuses the same instance instead of minting a new one every time.

Multiple folders can share one instance: `mdloop open` attaches to an already-running one instead
of starting a second, and `mdloop serve start` runs the same embedded instance detached — it
survives closing the terminal that started it, so it doesn't have to be exactly one folder at a
time anymore. `mdloop serve stop`/`mdloop serve status` manage it directly; `mdloop projects
list` shows every folder this machine has auto-linked and to which project. Still single-user by
construction (one embedded Postgres, one admin identity) — this is the "try it" and "just me" path,
not a shared team deployment.

## A real instance (a team, always-on)

The web app and HTTP API are `packages/api/src/selfhost-main.ts` — one process, your own Postgres,
no other services required for that half. **MCP tool access for coding agents is a second,
separate process** (`packages/mcp/src/main.ts`) — start it too if you want agents to be
first-class participants, not just the web review UI.

### 1. Database

Any Postgres ≥14 works. The app connects as the `mdloop_login` role (migration `0024`) —
non-superuser, RLS-enforced, on purpose: tenant isolation is DB-enforced even when you only have
one tenant. Run the migrations once against a fresh database:

```sh
DATABASE_URL=postgres://<owner-role>@<host>/<db> APP_LOGIN_PASSWORD=<pick-one> \
  node node_modules/@mdloop/persistence/dist/migrate-main.js
```

Setting `APP_LOGIN_PASSWORD` makes this same command also set `mdloop_login`'s password —
idempotently, safe to re-run on every deploy — so it's ready for the app's own `DATABASE_URL`
below with no separate `ALTER ROLE` step. Omit it (and rely on peer/trust auth instead) if
Postgres runs on the same host as the app process; see `.env.selfhost.example` for both options.

### 2. Configuration

Copy `.env.selfhost.example` to `.env` and fill it in. The essentials:

| Variable                                                                            | What it does                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                      | Connects as `mdloop_login` (above)                                                                                                                                                                                                           |
| `SESSION_SECRET`                                                                    | Random, 32+ chars                                                                                                                                                                                                                            |
| `API_BASE_URL` / `WEB_APP_URL` / `WEB_ORIGIN`                                       | Your instance's public URL(s)                                                                                                                                                                                                                |
| `PORT`                                                                              | The port this process listens on (default `3000`)                                                                                                                                                                                            |
| `MDLOOP_AUTH_MODE`                                                                  | `single-user` (default — one fixed admin identity, no login screen) or `oidc` (real browser login against Keycloak, Authentik, Dex, Google, Okta, or any OIDC-compliant provider via discovery)                                              |
| `MDLOOP_ADMIN_EMAIL` / `MDLOOP_ADMIN_NAME`                                          | `single-user` mode only                                                                                                                                                                                                                      |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`                             | `oidc` mode only — all three required together (omit the secret for a public client using PKCE)                                                                                                                                              |
| `MDLOOP_SERVE_WEB`                                                                  | `true` (default) serves the built SPA from this same process — set `false` if you're fronting it with your own reverse proxy or static host                                                                                                  |
| `MDLOOP_ALLOW_LOCAL_BLOB_STORAGE`                                                   | `true` for this path — local disk under `NODE_ENV=production` is otherwise refused as a container-deployment safety default (`storageFromEnv`); a self-hosted instance with a persistent volume is exactly the legitimate case it exists for |
| `BLOB_STORAGE_DIR`                                                                  | Local-filesystem document storage (default, needs the flag above under `NODE_ENV=production`)                                                                                                                                                |
| `MDLOOP_BLOBS_BUCKET` (+ `MDLOOP_BLOBS_ENDPOINT` / `MDLOOP_BLOBS_FORCE_PATH_STYLE`) | S3 or an S3-compatible backend (MinIO, R2, Backblaze B2) instead of local disk                                                                                                                                                               |
| `SMTP_HOST` (+ `SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM`)                     | Real email for invites/share links. Unset → emails are logged instead of sent; invite/share tokens still come back in the API response either way, so nothing is blocked by a missing SMTP config                                            |

### 3. Run it

Build and start the self-host composition root directly:

```sh
pnpm install && pnpm build
node --env-file .env packages/api/dist/selfhost-main.js
```

`pnpm build` here, not `pnpm --filter @mdloop/api build` — `@mdloop/api` has no `build` script of
its own; `pnpm typecheck`'s `tsc --build` is what produces its `dist/`. The `pnpm --filter @mdloop/web
build` half matters just as much here as in the zero-install path above: `MDLOOP_SERVE_WEB` defaults
to `true`, so `selfhost-main.ts` tries to serve the built SPA unless you've explicitly set it to
`false` for a reverse-proxy setup — skip the web build and it fails the same way `open` does.

Or build a container image from the provided multi-stage `Dockerfile` (`--target api`) and run it
with your `.env` values injected however your platform prefers (env file, secrets manager, etc.).

### 3b. MCP (agent access)

A separate process, same install, same database — start it alongside the API process above:

```sh
DATABASE_URL=... node --env-file .env packages/mcp/dist/main.js
```

Needs only `DATABASE_URL` and, optionally, `MCP_PORT` (default `3001`). Each developer or agent
authenticates with their own per-user API key (minted from the web app, `Authorization: Bearer
mdloop_...`) — no separate MCP-specific credential to configure. The `Dockerfile`'s `--target mcp`
stage builds this as its own container image if you'd rather run it that way. MCP OAuth (ADR 0013,
`WORKOS_AUTHKIT_ISSUER`/`MCP_RESOURCE_INDICATOR`/`WORKOS_JWKS_URL`) is an optional, code-complete
alternative to the API-key path — see `docs/ARCHITECTURE.md` §9.

### 4. First login

- **`single-user` mode**: no login screen — every request authenticates as the one configured
  admin identity.
- **`oidc` mode**: real browser-based login via your provider; the first person to sign in through
  it becomes the org's bootstrap admin.

## Upgrading

Run the migration one-shot (`migrate-main.js`, step 1 above) against your existing database before
starting the new version — migrations are additive and safe to run repeatedly; a version that's
already applied is a no-op.

## Getting your data out

Nothing here is a black box: `GET /org/export` (also exposed as the `export_org` MCP tool) walks
every document with full version history and metadata, keyset-paged so it works at any org size.
There's no proprietary export format to reverse-engineer.
