import { writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Pool } from 'pg';
import type { ApiKeyRepository, Actor, AuthPort, AuthProfile, EmailPort } from '@vorlyn/app';
import { createApiKey } from '@vorlyn/app';
import type { OrgId, UserId } from '@vorlyn/shared';
import {
  OtelTelemetry,
  PgApiKeyRepository,
  PgDirectoryRepository,
  PgVersionPurgeSweepRepository,
  logPoolFaults,
  poolConfigFromEnv,
  setupTelemetryIfAvailable,
} from '@vorlyn/persistence';
import { SingleUserAuthAdapter } from './auth/single-user.adapter.js';
import { LoggingEmailAdapter } from './email/logging-email.adapter.js';
import { SmtpEmailAdapter } from './email/smtp-email.adapter.js';
import { configFromEnv } from './config.js';
import { buildServer } from './server.js';
import { buildSelfHostServerDeps } from './selfhost-server-deps.js';
import { registerWebSpa, webSpaServingEnabled } from './serve-web-spa.js';

/**
 * Embedded-mode composition root — the process `vorlyn open ./folder`
 * (packages/cli/src/open.ts) spawns as a child. Deliberately near-identical
 * to `selfhost-main.ts` (same telemetry/pool/shutdown/fault-handling/
 * storage/email/rate-limiter/SPA-serving shape, `buildSelfHostServerDeps`
 * shared with it verbatim) with exactly two differences, documented at their
 * call sites below:
 *
 *   1. No `assertNonSuperuserRole` call.
 *   2. A narrower env surface, constructed entirely by the CLI that spawns
 *      this process (never a human-edited .env) — `VORLYN_AUTH_MODE` is
 *      always `single-user`, `oidc` is refused outright rather than
 *      supported: an embedded instance is inherently one local person
 *      opening one folder, so there is no second identity an OIDC login
 *      screen would ever need to distinguish.
 *   3. Trusts a `PORT` the CLI chose in advance (see `DEFAULT_API_PORT`'s
 *      doc comment in `packages/cli/src/local-instance.ts`) rather than
 *      picking its own — `pickEphemeralPort` below only ever runs when a
 *      caller skips the CLI entirely.
 *
 * ## Why no `assertNonSuperuserRole` (read `embedded-postgres.ts` first)
 *
 * `packages/persistence/src/embedded-postgres.ts`'s module doc comment (RLS /
 * role-switching trust model section) is the full reasoning; this is a
 * pointer to it, not a restatement. Short version: PGlite's only login
 * identity is `postgres`, its built-in superuser — there is no separate
 * `vorlyn_login` role reachable over its wire protocol the way real
 * Postgres's `pg_hba.conf` would gate one, so `assertNonSuperuserRole` would
 * (correctly) refuse to run against this connection string. RLS itself is
 * NOT bypassed: `withTenant()`/`withProvisioner()`/`withPublicReader()`
 * (`packages/persistence/src/db.ts`) unconditionally `set local role
 * vorlyn_app`/etc. before every tenant query regardless of which identity is
 * connected, so a superuser session genuinely drops to that non-superuser,
 * non-bypassrls role for the query. What differs is only *who is allowed to
 * reach that `SET ROLE` in the first place* — here, unconditionally
 * `postgres`, over a socket bound to `127.0.0.1` with exactly one local user
 * ever holding it. The multi-tenant threat model `assertNonSuperuserRole`
 * defends against (an attacker with only `DATABASE_URL`, reading another
 * tenant's rows over the open internet) does not exist in a single-user embedded
 * deployment. This is NOT a generic "skip the check" escape hatch —
 * `selfhost-main.ts`'s own call is untouched and remains an unconditional
 * hard requirement for every real self-host deployment (Docker Compose, any
 * cloud-via-containers target).
 */

/**
 * Grabs a free OS-assigned port by briefly binding a throwaway socket to
 * `0`, reading back what it landed on, and releasing it immediately — the
 * same "port: 0, then ask" trick `embedded-postgres.ts` and this file's own
 * `server.listen` use, just done *before* `configFromEnv()` rather than
 * after. That ordering is the whole reason this function exists: `config.
 * baseUrl`/`webAppUrl`/`webOrigin` (below) are read live, at request time,
 * by route handlers that need to already be correct the moment routes are
 * registered (`auth-routes.ts`'s OAuth `redirect_uri`, the CSRF Origin
 * allowlist) — discovering the port only after this process starts
 * *actually* listening would mean serving on a config computed too late to
 * matter. The accepted tradeoff: a window between this probe's close and the
 * real `server.listen` below — spanning the org-bootstrap DB work and
 * `buildServer` in between, so tens of milliseconds, not an instant — where
 * another process could in theory grab the same ephemeral port first.
 * Vanishingly unlikely to matter on a single-user local machine even so, and
 * if it ever happens `server.listen`'s existing `.catch()` surfaces it as a
 * plain, clear `EADDRINUSE` failure — not a silent wrong-config startup.
 */
async function pickEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const chosen = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(chosen);
      });
    });
  });
}

// `PORT` is always set by the CLI that spawns this process
// (`packages/cli/src/local-instance.ts`'s `DEFAULT_API_PORT`, or a caller's
// explicit override of it) — not 3000, one of the most common dev-server
// ports there is, but still fixed rather than freshly OS-assigned per boot,
// so a document link stays valid across a `vorlyn serve` restart. Only a
// caller that skips the CLI entirely (a direct invocation, or a test) ever
// reaches the OS-assigned fallback below.
const port = process.env.PORT ? Number(process.env.PORT) : await pickEphemeralPort();
const rootUrl = `http://127.0.0.1:${String(port)}`;
// Kept in lockstep with `port` above rather than left to each fall back to
// `configFromEnv`'s own `localhost:3000`/`localhost:5173` defaults — see
// the `invalid_oauth_state` fix for why `127.0.0.1` specifically, not
// `localhost`: browsers treat them as separate cookie origins, and this
// process is what the CLI's `openBrowser(rootUrl)` always navigates to.
// `??=` rather than an unconditional set, so an explicit override (tests, a
// deliberately different deploy shape) still wins.
process.env.API_BASE_URL ??= rootUrl;
process.env.WEB_APP_URL ??= rootUrl;
process.env.WEB_ORIGIN ??= rootUrl;

const config = configFromEnv();

await setupTelemetryIfAvailable('vorlyn-api-selfhost-embedded');
const telemetry = new OtelTelemetry();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ...poolConfigFromEnv() });
logPoolFaults(pool, telemetry);

// Difference 1 (see module doc comment above): no assertNonSuperuserRole —
// PGlite's connecting identity is unconditionally the `postgres` superuser,
// and the check would (correctly) refuse to run against it.

// Difference 2: the narrower env surface. This entrypoint is only ever
// started by packages/cli/src/open.ts, which constructs every var below
// itself — never a human-edited .env — and always sets
// VORLYN_AUTH_MODE=single-user (or leaves it unset, same default). Any other
// value is refused outright rather than silently coerced: an embedded
// instance is inherently one local person opening one folder, so `oidc`
// mode's browser-login flow has no second identity to distinguish and is
// simply not offered here.
const authMode = process.env.VORLYN_AUTH_MODE ?? 'single-user';
if (authMode !== 'single-user') {
  throw new Error(
    `Embedded mode only supports VORLYN_AUTH_MODE=single-user (got ${JSON.stringify(authMode)}) — oidc requires a real browser-reachable OIDC provider, which does not fit "vorlyn open ./folder"'s single local user.`,
  );
}

const directory = new PgDirectoryRepository(pool);
const apiKeys: ApiKeyRepository = new PgApiKeyRepository(pool);

const profile: AuthProfile = {
  providerUserId: `self-host:${process.env.VORLYN_ADMIN_EMAIL ?? 'admin@localhost'}`,
  email: process.env.VORLYN_ADMIN_EMAIL ?? 'admin@localhost',
  displayName: process.env.VORLYN_ADMIN_NAME ?? 'Admin',
};
const auth: AuthPort = new SingleUserAuthAdapter(profile);

// Same "has this instance already been bootstrapped" privileged read
// selfhost-main.ts uses (see its own equivalent comment) — cheaper than
// adding a new DirectoryRepository method.
const orgSweep = new PgVersionPurgeSweepRepository(pool);
const [existingOrgId] = await orgSweep.listOrgIds(1);
let adminUserId: UserId;
let adminOrgId: OrgId;
if (!existingOrgId) {
  const org = await directory.createOrganization('Self-hosted workspace', 'enterprise');
  const admin = await directory.createUser(org.id, {
    workosUserId: profile.providerUserId,
    email: profile.email,
    displayName: profile.displayName,
    role: 'admin',
  });
  adminUserId = admin.id;
  adminOrgId = org.id;
} else {
  const admin = await directory.userByWorkosId(profile.providerUserId);
  if (!admin) {
    throw new Error(
      'Embedded instance already has an organization but no user matching VORLYN_ADMIN_EMAIL — the admin identity must not change across restarts of the same data directory.',
    );
  }
  adminUserId = admin.id;
  adminOrgId = admin.orgId;
}

/**
 * Mints the one API key `vorlyn open`'s "link-if-needed" step
 * (packages/cli/src/open.ts) needs to authenticate its MCP client — there is
 * no browser-driven login+settings-page flow to generate one the way a real
 * self-host deploy's admin would, so a brand-new embedded instance could
 * never complete its own first link without this. Persisted once, in the
 * data directory (not the target folder — this process doesn't know which
 * folder(s) will ever link to it), reused on every later boot rather than
 * minted fresh per run. `VORLYN_DATA_DIR` is set by the CLI on every spawn;
 * failing loud on its absence matches this file's fail-fast posture
 * everywhere else (`assertNonSuperuserRole`'s replacement check above,
 * `configFromEnv`).
 *
 * Does NOT create a default project (it used to, named "My Project", before
 * `create_project` existed as an MCP tool). Per-folder project resolution
 * now happens client-side, at link time (`packages/cli/src/project-
 * resolution.ts`): the first `vorlyn link`/`vorlyn open` for a given
 * folder creates (or reuses) a project named after that folder, via the
 * `create_project` MCP tool. A data directory that predates this change may
 * still have a `defaultProjectId` field in its `bootstrap.json` from an
 * older boot — harmlessly ignored by every reader from here on; its
 * `apiKey` field is the only one still written or read.
 */
const dataDir = process.env.VORLYN_DATA_DIR;
if (!dataDir) {
  throw new Error('VORLYN_DATA_DIR must be set — this entrypoint is only ever spawned by the CLI');
}
const bootstrapPath = path.join(dataDir, 'bootstrap.json');
if (!existingOrgId) {
  const actor: Actor = { ctx: { orgId: adminOrgId, userId: adminUserId }, role: 'admin' };
  const minted = await createApiKey(apiKeys, actor, 'vorlyn open');
  if (!minted.ok) {
    throw new Error(`Could not mint the embedded instance's admin API key: ${minted.error.code}`);
  }
  await writeFile(bootstrapPath, `${JSON.stringify({ apiKey: minted.value.key }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

// ---- Email: SMTP if configured, logging (never hard-fail) otherwise ----
// Same selection as selfhost-main.ts — kept for parity even though an
// embedded local instance realistically never sets SMTP_HOST.
const smtpHost = process.env.SMTP_HOST?.trim();
const email: EmailPort = smtpHost
  ? new SmtpEmailAdapter({
      host: smtpHost,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: (process.env.SMTP_SECURE ?? 'false').trim() === 'true',
      ...(process.env.SMTP_USER ? { user: process.env.SMTP_USER } : {}),
      ...(process.env.SMTP_PASS ? { pass: process.env.SMTP_PASS } : {}),
      from: process.env.SMTP_FROM ?? 'vorlyn@localhost',
    })
  : new LoggingEmailAdapter();

const server = await buildServer(
  buildSelfHostServerDeps(pool, config, auth, directory, telemetry, email),
);

// ---- Serve the built web SPA (packages/web/dist), single-process default ----
// Shared with selfhost-main.ts — see serve-web-spa.ts for the mechanism and
// for why a missing build is a hard boot failure rather than a silent 404.
if (webSpaServingEnabled()) {
  await registerWebSpa(server);
}

// Crash-only faults (CONSTITUTION.md §3 — opaque fields only, never the
// error message, which may embed user input): identical to selfhost-main.ts.
process.on('uncaughtException', (e: unknown) => {
  telemetry.log('process_fault', { errorCode: errorCodeOf(e), outcome: 'error' });
  process.exit(1);
});
process.on('unhandledRejection', (e: unknown) => {
  telemetry.log('process_fault', { errorCode: errorCodeOf(e), outcome: 'error' });
});

function errorCodeOf(e: unknown): string {
  return e instanceof Error ? e.name : 'unknown_error';
}

const DRAIN_TIMEOUT_MS = 10_000;

function shutdown(): void {
  const forceExit = setTimeout(() => process.exit(1), DRAIN_TIMEOUT_MS);
  forceExit.unref();
  void server
    .close()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, shutdown);
}

server
  .listen({ port, host: '127.0.0.1' })
  .then(async () => {
    // Announced for the CLI-side supervisor (packages/cli/src/local-
    // instance.ts) to discover, since `port` above may have been `0` —
    // see the matching comment on @vorlyn/mcp's embedded main.
    const boundPort = (server.server.address() as AddressInfo).port;
    await writeFile(path.join(dataDir, 'api.port'), `${String(boundPort)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  })
  .catch((err: unknown) => {
    // Startup failure is the one place stderr is correct: telemetry isn't up yet.
    if (err instanceof Error && 'code' in err && err.code === 'EADDRINUSE') {
      // The common, actionable case now that `port` is a fixed default
      // rather than always OS-assigned — named explicitly rather than
      // buried in Node's raw EADDRINUSE stack trace.
      // eslint-disable-next-line no-console
      console.error(
        `Port ${String(port)} is already in use by something else. Set PORT to a free port and try again.`,
      );
    } else {
      console.error(err); // eslint-disable-line no-console
    }
    process.exit(1);
  });
