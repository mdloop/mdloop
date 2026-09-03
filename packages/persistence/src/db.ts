import type { Pool, PoolClient } from 'pg';
import type { TenantContext } from '@vorlyn/app';
import { positiveIntFromEnv } from './env-numbers.js';

const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Module-level default, wired from env (`DB_STATEMENT_TIMEOUT_MS`) once at
 * import time — a runaway query (missing index, lock wait) fails fast instead
 * of holding a pooled connection indefinitely. Callers needing a different
 * bound (e.g. a test proving the timeout fires) pass it explicitly instead of
 * mutating env, which would leak across every other transaction sharing the
 * pool.
 *
 * A present-but-garbage `DB_STATEMENT_TIMEOUT_MS` throws (via
 * `positiveIntFromEnv`) rather than silently reverting to the default — the
 * same fail-loud contract as `poolConfigFromEnv`. In practice every prod
 * entrypoint validates this var at boot before serving anything, so this is
 * a defensive second layer, not the primary catch.
 */
function envStatementTimeoutMs(): number {
  return positiveIntFromEnv(
    process.env.DB_STATEMENT_TIMEOUT_MS,
    DEFAULT_STATEMENT_TIMEOUT_MS,
    'DB_STATEMENT_TIMEOUT_MS',
  );
}

/** SET LOCAL can't take a bind parameter; set_config can and takes the same text Postgres parses for the GUC. */
async function setStatementTimeout(client: PoolClient, statementTimeoutMs?: number): Promise<void> {
  await client.query("select set_config('statement_timeout', $1, true)", [
    String(statementTimeoutMs ?? envStatementTimeoutMs()),
  ]);
}

/**
 * Every tenant-scoped statement runs through here: a transaction with the RLS
 * session variable bound via SET LOCAL, executing as the vorlyn_app role
 * (non-superuser, NOBYPASSRLS). There is no other query path in this package —
 * tenant context is structurally unavoidable (CONSTITUTION.md §3).
 *
 * SET LOCAL scopes both the role and the org binding to the transaction, so
 * pooled connections reset automatically on commit/rollback.
 */
export async function withTenant<T>(
  pool: Pool,
  ctx: TenantContext,
  fn: (client: PoolClient) => Promise<T>,
  statementTimeoutMs?: number,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role vorlyn_app');
    await setStatementTimeout(client, statementTimeoutMs);
    // set_config is parameterizable; SET LOCAL literals are not.
    await client.query("select set_config('app.org_id', $1, true)", [ctx.orgId]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

/** Provisioning path: runs as vorlyn_provisioner (bypasses RLS for org/user bootstrap only). */
export async function withProvisioner<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  statementTimeoutMs?: number,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role vorlyn_provisioner');
    await setStatementTimeout(client, statementTimeoutMs);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

/** Public Docs Hub read path (ADR 0004): vorlyn_public_reader has SELECT on public_documents only — structurally cannot read tenant tables. The only query path for unauthenticated public reads. */
export async function withPublicReader<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  statementTimeoutMs?: number,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role vorlyn_public_reader');
    await setStatementTimeout(client, statementTimeoutMs);
    // Deliberately no set_config('app.org_id', ...) — there is no tenant
    // context on the anonymous read path, and this role has no grants that
    // would use it anyway.
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}
