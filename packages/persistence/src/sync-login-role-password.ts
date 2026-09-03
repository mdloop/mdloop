import type { Pool } from 'pg';

/**
 * Syncs the `vorlyn_login` Postgres role's password to match a value
 * generated outside SQL, by whatever secrets store a deployment brings —
 * migration 0024 deliberately creates the role with `login` and no password
 * (local dev connects over the trust socket), so every real deploy needs
 * this run once after migrations, as the database owner, before anything
 * using `DATABASE_URL` can authenticate. Idempotent: safe to run on every
 * deploy, not just the first. A missing/empty `password` is a caller bug,
 * not a runtime possibility to guard here — the only caller
 * (migrate-main.ts) only invokes this when the env var backing it
 * (`APP_LOGIN_PASSWORD`) is actually set.
 */
export async function syncLoginRolePassword(pool: Pool, password: string): Promise<void> {
  const quoted = await pool.query<{ stmt: string }>(
    'select format($fmt$alter role vorlyn_login with password %L$fmt$, $1::text) as stmt',
    [password],
  );
  const [row] = quoted.rows;
  if (!row) throw new Error('unreachable — format() always returns exactly one row');
  await pool.query(row.stmt);
}
