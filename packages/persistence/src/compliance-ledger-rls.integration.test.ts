import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgErasureLogRepository } from './repositories/pg-erasure-log-repository.js';
import { PgDirectoryRepository } from './repositories/pg-repositories.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

/**
 * Compliance-ledger RLS (Phase 24.D, migration 0023). billing_events and
 * erasure_log now carry FORCE ROW LEVEL SECURITY + an org-scoped policy, so
 * isolation is a DB guarantee rather than grant-absence. The provisioner
 * (BYPASSRLS) system paths — org-spanning replay reads, append-only writes —
 * must keep working exactly as before.
 */
describe('compliance ledger RLS (0023)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('forces row-level security on both ledgers', async () => {
    const { rows } = await db.pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select relname, relrowsecurity, relforcerowsecurity
       from pg_class
       where relname in ('billing_events', 'erasure_log')
       order by relname`,
    );
    expect(rows).toEqual([
      { relname: 'billing_events', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'erasure_log', relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it('carries an org-scoped tenant_isolation policy on both ledgers', async () => {
    const { rows } = await db.pool.query<{ tablename: string; policyname: string }>(
      `select tablename, policyname from pg_policies
       where tablename in ('billing_events', 'erasure_log')
       order by tablename`,
    );
    expect(rows).toEqual([
      { tablename: 'billing_events', policyname: 'tenant_isolation' },
      { tablename: 'erasure_log', policyname: 'tenant_isolation' },
    ]);
  });

  it('still lets the BYPASSRLS provisioner append and read the erasure log across orgs', async () => {
    const directory = new PgDirectoryRepository(db.pool);
    const erasures = new PgErasureLogRepository(db.pool);
    const orgA = await directory.createOrganization('A');
    const orgB = await directory.createOrganization('B');

    await erasures.record({ kind: 'org_purge', orgId: orgA.id });
    await erasures.record({ kind: 'org_purge', orgId: orgB.id });

    // The replay read is deliberately org-spanning (no tenant context); it must
    // see both orgs' entries — proof the provisioner bypasses the new policy.
    const logged = await erasures.list();
    const orgIds = new Set(logged.map((e) => e.orgId));
    expect(orgIds.has(orgA.id)).toBe(true);
    expect(orgIds.has(orgB.id)).toBe(true);
  });
});
