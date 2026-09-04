import { Pool } from 'pg';
import { migrate } from './migrate.js';
import { poolConfigFromEnv } from './pool-config.js';
import { syncLoginRolePassword } from './sync-login-role-password.js';

/**
 * Migration one-shot task entrypoint — run once ahead of a deploy, connected
 * as the database owner (never mdloop_login: DDL needs owner privileges
 * migrate.ts doesn't have itself). Local/dev DBs migrate inline via
 * dev-main.ts/createTestDb instead; this entrypoint is prod-deploy-pipeline
 * only, run however a deployment runs one-off tasks.
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL must be set'); // eslint-disable-line no-console
  process.exit(1);
}

// `...poolConfigFromEnv()` picks up TLS (DB_SSL_CA_PATH) the same way every
// other prod entrypoint does; `max: 1` overrides its pool-size default
// because this is a single-shot task, not a long-lived service.
const pool = new Pool({ connectionString: databaseUrl, ...poolConfigFromEnv(), max: 1 });
try {
  const applied = await migrate(pool);
  if (applied.length > 0) {
    console.log(`migrated: ${applied.join(', ')}`); // eslint-disable-line no-console
  } else {
    console.log('no pending migrations'); // eslint-disable-line no-console
  }
  // Real deploy failure (2026-08-07): mdloop_login is created by migration
  // 0024 with `login` and no password, so every service crashed on
  // "password authentication failed" until this ran as a manual one-off.
  // APP_LOGIN_PASSWORD, sourced from whatever secrets store a deployment
  // brings (never a plaintext override committed anywhere), makes this a
  // permanent, idempotent step of every deploy instead. Absent env var
  // (local/dev, trust socket) skips it entirely — mdloop_login stays
  // passwordless there by design.
  const appLoginPassword = process.env.APP_LOGIN_PASSWORD;
  if (appLoginPassword) {
    await syncLoginRolePassword(pool, appLoginPassword);
    console.log('synced mdloop_login password'); // eslint-disable-line no-console
  }
} catch (e) {
  console.error(e); // eslint-disable-line no-console
  process.exitCode = 1;
} finally {
  await pool.end();
}
