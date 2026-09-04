import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

/**
 * Migration 0024: the dedicated login role that binds CONSTITUTION §4 — the
 * app connects as a non-superuser role that cannot skip RLS — into schema,
 * and is a member of the three roles db.ts SET ROLEs into.
 */
describe('mdloop_login role (migration 0024)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  it('is a LOGIN role that is neither superuser nor BYPASSRLS', async () => {
    const { rows } = await db.pool.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>("select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = 'mdloop_login'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcanlogin: true });
  });

  it('is a member of mdloop_app, mdloop_provisioner and mdloop_public_reader', async () => {
    const { rows } = await db.pool.query<{ rolname: string }>(
      `select r.rolname
         from pg_auth_members m
         join pg_roles r on r.oid = m.roleid
         join pg_roles member on member.oid = m.member
        where member.rolname = 'mdloop_login'
        order by r.rolname`,
    );
    expect(rows.map((r) => r.rolname)).toEqual([
      'mdloop_app',
      'mdloop_provisioner',
      'mdloop_public_reader',
    ]);
  });
});
