import { readFileSync } from 'node:fs';
import type { PoolConfig } from 'pg';
import { positiveIntFromEnv } from './env-numbers.js';

/**
 * TLS to Aurora — `verify-full`: the server
 * certificate must chain to this CA *and* its hostname must match, which is
 * `rejectUnauthorized: true` plus node's default `checkServerIdentity` (both
 * apply automatically; nothing here disables either). Unset in local dev and
 * the test harness — Homebrew Postgres over the trust socket never speaks
 * TLS. Prod points `DB_SSL_CA_PATH` at the RDS CA bundle the Dockerfile bakes
 * into every image (`ca-bundle` stage, `/app/rds-ca-bundle.pem`); the ECS
 * task definition sets the var, the image doesn't default it, so a plain
 * `docker run` against a non-TLS Postgres (e.g. local smoke-testing) still
 * works unchanged. A *set* path that can't be read throws — same fail-loud
 * contract as `positiveIntFromEnv` below, never a silent plaintext fallback.
 */
function sslConfigFromEnv(env: NodeJS.ProcessEnv): PoolConfig['ssl'] {
  const caPath = env.DB_SSL_CA_PATH;
  if (!caPath) return undefined;
  let ca: string;
  try {
    ca = readFileSync(caPath, 'utf8');
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`DB_SSL_CA_PATH (${JSON.stringify(caPath)}) could not be read: ${reason}`);
  }
  return { ca, rejectUnauthorized: true };
}

/**
 * Env-configurable `pg.Pool` tuning shared by every production entrypoint
 * (api/main.ts, mcp/main.ts, mcp/stdio-main.ts, jobs/main.ts,
 * persistence/migrate-main.ts) — an unbounded pool with no connect/idle
 * timeouts lets a slow Postgres (or a leak) queue connections indefinitely
 * instead of failing fast. Defaults are conservative single-instance values;
 * dev-main.ts and e2e-main.ts are local/ephemeral harnesses and
 * intentionally keep plain `new Pool({ connectionString })`.
 *
 * Fails fast (throws) on a *present but garbage* override — a typo'd
 * `DB_POOL_MAX=nope` used to silently fall back to the default with no
 * signal anything was wrong; that's now indistinguishable from a bug report
 * nobody can explain. An *unset* var still means "use the documented
 * default" — that distinction is deliberate, see `positiveIntFromEnv`.
 */
export function poolConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  return {
    max: positiveIntFromEnv(env.DB_POOL_MAX, 10, 'DB_POOL_MAX'),
    connectionTimeoutMillis: positiveIntFromEnv(
      env.DB_POOL_CONNECTION_TIMEOUT_MS,
      5_000,
      'DB_POOL_CONNECTION_TIMEOUT_MS',
    ),
    idleTimeoutMillis: positiveIntFromEnv(
      env.DB_POOL_IDLE_TIMEOUT_MS,
      30_000,
      'DB_POOL_IDLE_TIMEOUT_MS',
    ),
    ssl: sslConfigFromEnv(env),
  };
}
