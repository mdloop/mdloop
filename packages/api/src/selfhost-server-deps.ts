import type { Pool } from 'pg';
import type { AuthPort, DirectoryRepository, EmailPort, TelemetryPort } from '@mdloop/app';
import { UnlimitedRateLimiter } from '@mdloop/app';
import {
  PgAllowlistRepository,
  PgAnchorResolutionRepository,
  PgApiKeyRepository,
  PgErasureLogRepository,
  PgCommentRepository,
  PgCommentRollupReader,
  PgGuestUserRepository,
  PgDocumentRepository,
  PgOrganizationRepository,
  PgOrgInviteRepository,
  PgProjectRepository,
  PgPublicHubRepository,
  PgReviewRepository,
  PgSearchRepository,
  PgShareGrantRepository,
  PgUploadUnitOfWork,
  PgVersionRepository,
  pingPool,
  storageFromEnv,
} from '@mdloop/persistence';
import type { ApiConfig } from './config.js';
import type { ServerDeps } from './server.js';

/**
 * Every `ServerDeps` field that is built off one `Pool` in exactly the same
 * shape regardless of which self-host composition root is booting
 * (`selfhost-main.ts`'s real-Postgres deploy, `selfhost-embedded-main.ts`'s
 * PGlite-backed `mdloop open`) — extracted so the two entrypoints share this
 * ~25-line block instead of maintaining two hand-copied lists that will
 * silently drift the next time a `ServerDeps` field is added.
 *
 * Deliberately excludes the handful of fields that genuinely differ per
 * entrypoint and must stay caller-supplied: `config` (env parsing differs),
 * `auth` (WorkOS vs. single-user vs. OIDC), `directory` (selfhost-main.ts's
 * OIDC mode wraps this in `FirstOidcLoginBecomesAdminDirectory` before
 * passing it in — the helper must not assume the raw, unwrapped repository),
 * `telemetry` (each entrypoint names its own OTel service), and `email`
 * (SMTP vs. logging vs. a future embedded-specific choice).
 *
 * `userRateLimiter` is `UnlimitedRateLimiter` unconditionally: both self-host
 * targets are single-instance/single-org, so the per-user monthly-budget
 * limiter that protects a shared multi-tenant deployment from one noisy
 * tenant does not apply to either (same reasoning `selfhost-main.ts`
 * originally carried inline).
 */
export function buildSelfHostServerDeps(
  pool: Pool,
  config: ApiConfig,
  auth: AuthPort,
  directory: DirectoryRepository,
  telemetry: TelemetryPort,
  email: EmailPort,
): ServerDeps {
  // Single instance: one `PgOrganizationRepository` serves both the
  // `organizations` and `orgLifecycle` ServerDeps fields (see main.ts's
  // equivalent comment — same reasoning applies unchanged here).
  const organizations = new PgOrganizationRepository(pool);

  return {
    config,
    auth,
    directory,
    organizations,
    documents: new PgDocumentRepository(pool),
    projects: new PgProjectRepository(pool),
    versions: new PgVersionRepository(pool),
    uploadUow: new PgUploadUnitOfWork(pool),
    storage: storageFromEnv(),
    commentRollup: new PgCommentRollupReader(pool),
    comments: new PgCommentRepository(pool),
    reviews: new PgReviewRepository(pool),
    resolutions: new PgAnchorResolutionRepository(pool),
    grants: new PgShareGrantRepository(pool),
    apiKeys: new PgApiKeyRepository(pool),
    search: new PgSearchRepository(pool),
    telemetry,
    orgLifecycle: organizations,
    erasures: new PgErasureLogRepository(pool),
    invites: new PgOrgInviteRepository(pool),
    allowlist: new PgAllowlistRepository(pool),
    guests: new PgGuestUserRepository(pool),
    email,
    publicHub: new PgPublicHubRepository(pool),
    readiness: () => pingPool(pool),
    userRateLimiter: new UnlimitedRateLimiter(),
  };
}
