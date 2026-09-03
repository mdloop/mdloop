import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '@vorlyn/app';
import type { UserId } from '@vorlyn/shared';
import { withTenant } from './db.js';
import { PgDirectoryRepository } from './repositories/pg-repositories.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

/**
 * withTenant sets statement_timeout per transaction (default 30s, wired from
 * DB_STATEMENT_TIMEOUT_MS) so a runaway query fails fast instead of holding a
 * pooled connection forever. Proven with an explicit tiny override rather
 * than the env var — the env var is a module-level default shared by every
 * transaction on the pool, so mutating it here would leak into unrelated
 * tests running against the same process.
 */
describe('withTenant statement_timeout', () => {
  let db: TestDb;
  let ctx: TenantContext;

  beforeAll(async () => {
    db = await createTestDb();
    const directory = new PgDirectoryRepository(db.pool);
    const org = await directory.createOrganization('Acme');
    ctx = { orgId: org.id, userId: 'system-test' as UserId };
  });

  afterAll(async () => {
    await db.close();
  });

  it('cancels a query that outlives a tiny timeout', async () => {
    await expect(
      withTenant(db.pool, ctx, (c) => c.query('select pg_sleep(1)'), 50),
    ).rejects.toThrow(/statement timeout/);
  });

  it('leaves the default (30s) generous enough for an ordinary query', async () => {
    await expect(withTenant(db.pool, ctx, (c) => c.query('select 1'))).resolves.toBeDefined();
  });
});
