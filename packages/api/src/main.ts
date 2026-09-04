import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { UserRateLimiter } from '@mdloop/app';
import type { RateLimiterPort } from '@mdloop/app';
import {
  OtelTelemetry,
  PgAllowlistRepository,
  PgAnchorResolutionRepository,
  PgApiKeyRepository,
  PgErasureLogRepository,
  PgCommentRepository,
  PgCommentRollupReader,
  PgDirectoryRepository,
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
  RedisRateLimiter,
  assertNonSuperuserRole,
  logPoolFaults,
  pingPool,
  poolConfigFromEnv,
  setupTelemetry,
  storageFromEnv,
} from '@mdloop/persistence';
import { WorkosAuthAdapter } from './auth/workos.adapter.js';
import { LoggingEmailAdapter } from './email/logging-email.adapter.js';
import { configFromEnv } from './config.js';
import { buildServer } from './server.js';

const config = configFromEnv();
if (!config.workos) {
  throw new Error('WORKOS_API_KEY and WORKOS_CLIENT_ID must be set');
}

setupTelemetry('mdloop-api');
const telemetry = new OtelTelemetry();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ...poolConfigFromEnv() });
logPoolFaults(pool, telemetry);
const port = Number(process.env.PORT ?? 3000);

// Refuse to serve if DATABASE_URL connects as a superuser/BYPASSRLS role —
// RLS tenant isolation would be silently defeated (CONSTITUTION §4). Prod uses
// mdloop_login (migration 0024); the dev entrypoint (dev-main.ts) is separate.
await assertNonSuperuserRole(pool);

// Shared-store rate limiter (ADR 0010): unset REDIS_URL falls back to the
// in-process UserRateLimiter — safe single-node default, correct behavior
// for local dev and a degrade-gracefully path.
const redisClient = config.redisUrl ? new Redis(config.redisUrl) : undefined;
// Same "unlistened EventEmitter 'error' crashes the process" hazard
// logPoolFaults guards against for the pg Pool (see that file's doc
// comment) — a dropped Redis connection must not take the whole api down.
redisClient?.on('error', (err: Error) => {
  telemetry.log('process_fault', { errorCode: err.name, outcome: 'error' });
});
const redisRateLimiter = redisClient ? new RedisRateLimiter(redisClient) : undefined;
const userRateLimiter: RateLimiterPort = redisRateLimiter ?? new UserRateLimiter();

// Single instance: it implements both the tenant-scoped OrganizationRepository
// and the privileged OrgLifecyclePort (GDPR purge/lookup, relocated off
// BillingRepository in the S4 billing-removal spike) — no reason for two
// pool-holding instances of the same repository.
const organizations = new PgOrganizationRepository(pool);

const server = await buildServer({
  config,
  auth: new WorkosAuthAdapter(config.workos.apiKey, config.workos.clientId),
  directory: new PgDirectoryRepository(pool),
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
  email: new LoggingEmailAdapter(),
  publicHub: new PgPublicHubRepository(pool),
  readiness: () => pingPool(pool),
  userRateLimiter,
});

// Crash-only faults (CONSTITUTION.md §3 — opaque fields only, never the
// error message, which may embed user input): process state after an
// uncaught exception is unspecified, so it always exits; a rejected promise
// that nothing awaited doesn't corrupt state the same way, so it only logs.
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
    .then(() => Promise.all([pool.end(), redisRateLimiter?.close()]))
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
