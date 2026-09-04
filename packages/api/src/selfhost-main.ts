import { Pool } from 'pg';
import type { AuthPort, AuthProfile, DirectoryRepository, EmailPort } from '@mdloop/app';
import type { Organization, OrgInvite, ShareGrant, User } from '@mdloop/domain';
import type { InviteId, OrgId } from '@mdloop/shared';
import {
  OtelTelemetry,
  PgDirectoryRepository,
  PgVersionPurgeSweepRepository,
  assertNonSuperuserRole,
  logPoolFaults,
  poolConfigFromEnv,
  setupTelemetry,
} from '@mdloop/persistence';
import { OidcAuthAdapter } from './auth/oidc.adapter.js';
import { SingleUserAuthAdapter } from './auth/single-user.adapter.js';
import { LoggingEmailAdapter } from './email/logging-email.adapter.js';
import { SmtpEmailAdapter } from './email/smtp-email.adapter.js';
import { configFromEnv } from './config.js';
import { buildServer } from './server.js';
import { buildSelfHostServerDeps } from './selfhost-server-deps.js';
import { registerWebSpa, webSpaServingEnabled } from './serve-web-spa.js';

/**
 * Self-hosted composition root (open-source release track, Phase D). Same
 * production hygiene as main.ts (telemetry, pool creation,
 * assertNonSuperuserRole, graceful shutdown, crash-only fault handling) minus
 * the WorkOS-specific bits main.ts has that don't apply here — self-host has
 * no WorkOS account, and configFromEnv() already treats every WORKOS_* var as
 * fully optional, so this file simply never reads `config.workos`.
 *
 * Unlike main.ts (always WorkOS) and dev-main.ts/e2e-main.ts (always a
 * loopback AuthPort), this entrypoint chooses its AuthPort at boot from
 * MDLOOP_AUTH_MODE — see "Auth adapter selection" below.
 *
 * Migrations are NOT run by this file (matching main.ts, which also doesn't)
 * — run packages/persistence's migrate-main.ts (or equivalent) against
 * DATABASE_URL before starting this process, same as a real production
 * deploy's separate migration step.
 */
const config = configFromEnv();

setupTelemetry('mdloop-api-selfhost');
const telemetry = new OtelTelemetry();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ...poolConfigFromEnv() });
logPoolFaults(pool, telemetry);
const port = Number(process.env.PORT ?? 3000);

// Refuse to serve if DATABASE_URL connects as a superuser/BYPASSRLS role —
// RLS tenant isolation would be silently defeated (CONSTITUTION §4). A
// self-host instance has only one tenant, but the guarantee is schema-level
// (migration 0024's mdloop_login role), not something a single-tenant
// deployment gets to skip.
await assertNonSuperuserRole(pool);

// Used directly by the auth-mode bootstrap logic below (org/admin
// pre-creation); `buildSelfHostServerDeps` builds its own separate
// `PgOrganizationRepository`/repo instances for `ServerDeps` — same table,
// two independent connections through the same pool, nothing shared here
// needs to be the same object identity as what ends up in `ServerDeps`.
const directory = new PgDirectoryRepository(pool);

/**
 * Self-host OIDC instance bootstrap (Task 3): makes signIn()'s unmodified
 * "no invite token, no SSO connection -> create a fresh personal org, role
 * admin" fallback path (packages/app/src/use-cases/sign-in.ts, called
 * unchanged from auth-routes.ts) attach the FIRST real OIDC login to the
 * self-host org this file pre-creates at boot below, instead of minting a
 * brand-new org the way main.ts's multi-tenant entrypoint does for every
 * unknown identity.
 *
 * signIn() itself is NOT modified, and neither is auth-routes.ts — both are
 * shared with main.ts's real multi-tenant path, and changing either to
 * special-case "an org with zero users" would be a much bigger, riskier
 * change than this pass is asked to make. Instead, this decorates only the
 * `DirectoryRepository` dependency signIn() is handed: `createOrganization`
 * returns the pre-existing, still-memberless self-host org instead of
 * inserting a new row, and `createUser` forces `role: 'admin'` for that
 * org's first member (defensive — signIn()'s fallback path already passes
 * `role: 'admin'` itself, but this holds even if that ever changes).
 *
 * This is the "implement the minimal self-host-specific version directly in
 * selfhost-main.ts" fallback the task anticipated: signIn() was not cleanly
 * reusable/adaptable as-is because its fallback branch unconditionally
 * inserts a brand-new organization row, with no notion of "attach to this
 * already-provisioned one instead" — adapting it to support that without
 * risking the multi-tenant path would have meant growing its signature or
 * adding an org-agnostic mode, a bigger change than a like-for-like port
 * wrapper.
 *
 * **Known, deliberately unhardened simplification**: once the pre-created
 * org has its first member, this decorator becomes a pure passthrough —
 * `createOrganization` reverts to inserting new rows for any later, distinct
 * identity, same as main.ts's multi-tenant entrypoint. Self-host does not
 * hard-block a second unrelated identity from getting its own fresh org on the same
 * instance; nothing in this task asked for that, and enforcing it would
 * mean deciding what "reject a login" even looks like for a self-host admin
 * console that does not exist — a cross-org operator console isn't core
 * (CONSTITUTION §7). An operator wanting a strictly single-org instance should scope
 * their OIDC provider's client to their own team, or rely on invite-only
 * join (unaffected by this decorator — invite acceptance already targets a
 * specific `orgId` directly, never through `createOrganization`). The two
 * `memberCount` reads below (one in `createOrganization`, one in
 * `createUser`) are not transactional with each other either — a real
 * concern under concurrent signups, a non-issue for the single first-login
 * this exists for.
 */
class FirstOidcLoginBecomesAdminDirectory implements DirectoryRepository {
  constructor(
    private readonly inner: DirectoryRepository,
    private readonly selfHostOrgId: OrgId,
  ) {}

  async createOrganization(
    name: string,
    tier?: 'free' | 'team' | 'enterprise',
  ): Promise<Organization> {
    if ((await this.inner.memberCount(this.selfHostOrgId)) === 0) {
      const existing = await this.inner.organizationById(this.selfHostOrgId);
      if (existing) return existing;
    }
    return this.inner.createOrganization(name, tier);
  }

  async createUser(
    orgId: OrgId,
    input: Pick<User, 'workosUserId' | 'email' | 'displayName' | 'role'>,
  ): Promise<User> {
    if (orgId === this.selfHostOrgId && (await this.inner.memberCount(orgId)) === 0) {
      return this.inner.createUser(orgId, { ...input, role: 'admin' });
    }
    return this.inner.createUser(orgId, input);
  }

  // Everything else is an unmodified passthrough.
  createUserWithinSeatCap(
    orgId: OrgId,
    input: Pick<User, 'workosUserId' | 'email' | 'displayName' | 'role'>,
    limit: number | null,
  ): Promise<User | undefined> {
    return this.inner.createUserWithinSeatCap(orgId, input, limit);
  }
  organizationById(id: OrgId): Promise<Organization | undefined> {
    return this.inner.organizationById(id);
  }
  userByWorkosId(workosUserId: string): Promise<User | undefined> {
    return this.inner.userByWorkosId(workosUserId);
  }
  memberCount(orgId: OrgId): Promise<number> {
    return this.inner.memberCount(orgId);
  }
  organizationBySsoConnection(connectionId: string): Promise<Organization | undefined> {
    return this.inner.organizationBySsoConnection(connectionId);
  }
  isAllowlisted(orgId: OrgId, email: string): Promise<boolean> {
    return this.inner.isAllowlisted(orgId, email);
  }
  inviteByTokenHash(tokenHash: string): Promise<OrgInvite | undefined> {
    return this.inner.inviteByTokenHash(tokenHash);
  }
  markInviteAccepted(id: InviteId): Promise<void> {
    return this.inner.markInviteAccepted(id);
  }
  guestGrantByTokenHash(tokenHash: string): Promise<ShareGrant | undefined> {
    return this.inner.guestGrantByTokenHash(tokenHash);
  }
}

// Privileged, cross-org "list every organization" read (ADR 0001's version
// auto-purge sweep already needed exactly this — no tenant context exists
// yet at boot, same trust boundary DirectoryRepository itself runs under).
// Reused here, `limit: 1`, purely to answer "has this instance already been
// bootstrapped, and if so what is its org id" — cheaper than adding a new
// DirectoryRepository method, and unlike a plain existence check it hands
// back the id the OIDC branch below actually needs on every restart, not
// only the first boot.
const orgSweep = new PgVersionPurgeSweepRepository(pool);

// ---- Auth adapter selection (MDLOOP_AUTH_MODE, default 'single-user') ----
const authMode = process.env.MDLOOP_AUTH_MODE ?? 'single-user';
let auth: AuthPort;
let signInDirectory: DirectoryRepository = directory;

if (authMode === 'single-user') {
  // Deterministic identity: SingleUserAuthAdapter always resolves to this
  // exact profile, so the admin user can be created eagerly, right now,
  // rather than lazily on first login the way OIDC mode (below) has to.
  const profile: AuthProfile = {
    providerUserId: `self-host:${process.env.MDLOOP_ADMIN_EMAIL ?? 'admin@localhost'}`,
    email: process.env.MDLOOP_ADMIN_EMAIL ?? 'admin@localhost',
    displayName: process.env.MDLOOP_ADMIN_NAME ?? 'Admin',
  };
  auth = new SingleUserAuthAdapter(profile);
  const [existingOrgId] = await orgSweep.listOrgIds(1);
  if (!existingOrgId) {
    const org = await directory.createOrganization('Self-hosted workspace', 'enterprise');
    await directory.createUser(org.id, {
      workosUserId: profile.providerUserId,
      email: profile.email,
      displayName: profile.displayName,
      role: 'admin',
    });
  }
} else if (authMode === 'oidc') {
  const issuer = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  // Fail loud at boot, not silently degrade — same instinct config.ts and
  // storageFromEnv already use throughout this codebase.
  if (!issuer || !clientId) {
    throw new Error(
      'MDLOOP_AUTH_MODE=oidc requires OIDC_ISSUER and OIDC_CLIENT_ID to be set (OIDC_CLIENT_SECRET is optional, for a public/PKCE-only client)',
    );
  }
  auth = await OidcAuthAdapter.create({
    issuer,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
  });
  // The identity isn't known until someone actually logs in (unlike
  // single-user mode above) — pre-create only the org, and let
  // FirstOidcLoginBecomesAdminDirectory (see its own doc comment) attach the
  // first real login to it as admin. Always wrapped — including on a
  // restart before anyone has logged in yet, where the org already exists
  // but still has zero members — not only on the boot that first creates it.
  const [existingOrgId] = await orgSweep.listOrgIds(1);
  const selfHostOrgId =
    existingOrgId ?? (await directory.createOrganization('Self-hosted workspace', 'enterprise')).id;
  signInDirectory = new FirstOidcLoginBecomesAdminDirectory(directory, selfHostOrgId);
} else {
  throw new Error(
    `MDLOOP_AUTH_MODE must be "single-user" or "oidc" (got ${JSON.stringify(authMode)})`,
  );
}

// ---- Email: SMTP if configured, logging (never hard-fail) otherwise ----
const smtpHost = process.env.SMTP_HOST?.trim();
const email: EmailPort = smtpHost
  ? new SmtpEmailAdapter({
      host: smtpHost,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: (process.env.SMTP_SECURE ?? 'false').trim() === 'true',
      ...(process.env.SMTP_USER ? { user: process.env.SMTP_USER } : {}),
      ...(process.env.SMTP_PASS ? { pass: process.env.SMTP_PASS } : {}),
      from: process.env.SMTP_FROM ?? 'mdloop@localhost',
    })
  : new LoggingEmailAdapter();

// Every ServerDeps field that's built off `pool` the same way regardless of
// which self-host composition root is booting — see selfhost-server-deps.ts.
// `signInDirectory` (not the raw `directory` above) is what actually reaches
// ServerDeps.directory: OIDC mode's decorator must be what the server sees.
const server = await buildServer(
  buildSelfHostServerDeps(pool, config, auth, signInDirectory, telemetry, email),
);

// ---- Serve the built web SPA (packages/web/dist), single-process default ----
// Shared with selfhost-embedded-main.ts — see serve-web-spa.ts for the
// mechanism, the MDLOOP_SERVE_WEB escape hatch, and for why a missing build
// is a hard boot failure rather than a silent 404.
if (webSpaServingEnabled()) {
  await registerWebSpa(server);
}

// Crash-only faults (CONSTITUTION.md §3 — opaque fields only, never the
// error message, which may embed user input): process state after an
// uncaught exception is unspecified, so it always exits; a rejected promise
// that nothing awaited doesn't corrupt state the same way, so it only logs.
// Identical to main.ts's handling.
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

server.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  // Startup failure is the one place stderr is correct: telemetry isn't up yet.
  console.error(err); // eslint-disable-line no-console
  process.exit(1);
});
