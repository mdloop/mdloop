import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';
import { syncLoginRolePassword } from './sync-login-role-password.js';

/**
 * Real deploy failure (2026-08-07): the original attempt used
 * `ALTER ROLE ... WITH PASSWORD $1`, which fails at runtime with
 * "syntax error at or near $1" — Postgres doesn't accept a bind parameter
 * there. Only a real database catches that; a mocked pool would have let it
 * through silently. Runs against a real ephemeral Postgres.
 *
 * `mdloop_login` is a *role*, and Postgres roles are cluster-global, not
 * scoped to the ephemeral per-test database `createTestDb()` creates — other
 * test files' migration runs share the same running Postgres instance and
 * can leave the role in an already-passworded state before this file's own
 * tests start. Every assertion here therefore compares a captured
 * before/after rather than assuming a pristine "starts with no password"
 * baseline.
 */
describe('syncLoginRolePassword', () => {
  let db: TestDb;

  afterEach(async () => {
    await db.close();
  });

  async function rolPassword(): Promise<string | null> {
    const { rows } = await db.pool.query<{ rolpassword: string | null }>(
      "select rolpassword from pg_authid where rolname = 'mdloop_login'",
    );
    return rows[0]?.rolpassword ?? null;
  }

  it('changes the role password to a new value', async () => {
    db = await createTestDb();
    const before = await rolPassword();

    await syncLoginRolePassword(db.pool, 'a-real-generated-password-123');
    const after = await rolPassword();

    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it('is idempotent — re-running with a different password updates it, never throws', async () => {
    db = await createTestDb();

    await syncLoginRolePassword(db.pool, 'first-password-abc');
    const first = await rolPassword();

    await syncLoginRolePassword(db.pool, 'second-password-xyz');
    const second = await rolPassword();

    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('handles quotes/backslashes/dollar-signs in the password safely', async () => {
    db = await createTestDb();
    const weird = `we'ird$$pa''ss\\word"\`;DROP TABLE schema_migrations;--`;

    await expect(syncLoginRolePassword(db.pool, weird)).resolves.not.toThrow();
    expect(await rolPassword()).not.toBeNull();

    const migrations = await db.pool.query('select 1 from schema_migrations limit 1');
    expect(migrations.rows.length).toBeGreaterThan(0);
  });
});
