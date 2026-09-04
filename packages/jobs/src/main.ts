import { Pool } from 'pg';
import {
  OtelTelemetry,
  PgAnchorResolutionRepository,
  PgCommentRepository,
  PgDocumentRepository,
  PgErasureLogRepository,
  PgOrganizationRepository,
  PgRetentionSweepRepository,
  PgVersionPurgeSweepRepository,
  PgVersionRepository,
  assertNonSuperuserRole,
  logPoolFaults,
  poolConfigFromEnv,
  setupTelemetry,
  storageFromEnv,
} from '@mdloop/persistence';
import { jobsEnvFromEnv } from './env-config.js';
import type { ComplianceJobDeps } from './scheduler.js';
import { DEFAULT_JOB_INTERVAL_MS, startComplianceScheduler } from './scheduler.js';

/**
 * Compliance scheduler process (Phase 24.D). Runs the GDPR/retention sweeps
 * (version purge, retention, erasure replay) plus the anchor-cache prune on
 * an interval — the same use-cases the API/MCP expose no HTTP surface for,
 * wired to the same Pg* repositories and pool config. Deployed as its own
 * long-running task (single instance); the ECS schedule lands with Phase 10
 * infra. (The billing lifecycle sweep — trial expiry, idle-org warn/purge,
 * cancellation-grace purge — was removed with the billing vertical.)
 */
// Validate env before any pool/telemetry/scheduler setup — a typo'd var
// name/value fails loud here instead of limping along on a silently-wrong
// default.
const env = jobsEnvFromEnv();

setupTelemetry('mdloop-jobs');
const telemetry = new OtelTelemetry();

const pool = new Pool({ connectionString: env.DATABASE_URL, ...poolConfigFromEnv() });
logPoolFaults(pool, telemetry);

// The sweeps run via withProvisioner (BYPASSRLS by design), but the login role
// must still be non-superuser (CONSTITUTION §4) — a superuser DATABASE_URL here
// is the same latent isolation hole as in the API/MCP. Refuse to start.
await assertNonSuperuserRole(pool);

const intervalMs = env.JOB_INTERVAL_MS ?? DEFAULT_JOB_INTERVAL_MS;

const deps: ComplianceJobDeps = {
  versionPurgeSweep: new PgVersionPurgeSweepRepository(pool),
  retentionSweep: new PgRetentionSweepRepository(pool),
  orgs: new PgOrganizationRepository(pool),
  documents: new PgDocumentRepository(pool),
  versions: new PgVersionRepository(pool),
  comments: new PgCommentRepository(pool),
  resolutions: new PgAnchorResolutionRepository(pool),
  storage: storageFromEnv(),
  erasures: new PgErasureLogRepository(pool),
  telemetry,
};

function errorCodeOf(e: unknown): string {
  return e instanceof Error ? e.name : 'unknown_error';
}

const scheduler = startComplianceScheduler(deps, intervalMs);

// Crash-only faults (CONSTITUTION §3 — opaque fields only): an uncaught
// exception leaves process state unspecified, so exit; a stray rejection only
// logs. Mirrors the api/mcp entrypoints.
process.on('uncaughtException', (e: unknown) => {
  telemetry.log('process_fault', { errorCode: errorCodeOf(e), outcome: 'error' });
  process.exit(1);
});
process.on('unhandledRejection', (e: unknown) => {
  telemetry.log('process_fault', { errorCode: errorCodeOf(e), outcome: 'error' });
});

const DRAIN_TIMEOUT_MS = 30_000;

function shutdown(): void {
  const forceExit = setTimeout(() => process.exit(1), DRAIN_TIMEOUT_MS);
  forceExit.unref();
  void scheduler
    .stop()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, shutdown);
}

// eslint-disable-next-line no-console
console.log(`mdloop jobs scheduler up, interval ${String(intervalMs)}ms`);
