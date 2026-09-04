import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentExportKeyset, TenantContext } from '@mdloop/app';
import type { DocumentId } from '@mdloop/shared';
import { PgDirectoryRepository, PgDocumentRepository } from './repositories/pg-repositories.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

/**
 * The org-export keyset read (`listForExport`) at the DB level: SQL ordering by
 * (created_at, id), archived rows included, soft-deleted rows excluded, and the
 * id tie-break exercised by forcing created_at collisions — the branch the
 * in-memory fake can't prove agrees with Postgres.
 */
describe('listForExport keyset pagination', () => {
  let db: TestDb;
  let ctx: TenantContext;

  beforeAll(async () => {
    db = await createTestDb();
    const directory = new PgDirectoryRepository(db.pool);
    const org = await directory.createOrganization('Acme');
    const alice = await directory.createUser(org.id, {
      workosUserId: 'wos_alice',
      email: 'alice@acme.test',
      displayName: 'Alice',
      role: 'admin',
    });
    ctx = { orgId: org.id, userId: alice.id };
  });

  afterAll(async () => {
    await db.close();
  });

  it('pages every non-deleted document by (created_at, id), archived kept, deleted dropped', async () => {
    const documents = new PgDocumentRepository(db.pool);
    // Two timestamps, three docs sharing the first: forces both the created_at
    // advance AND the id tie-break within an equal timestamp.
    const t1 = new Date('2026-01-01T00:00:00.000Z');
    const t2 = new Date('2026-01-02T00:00:00.000Z');
    const plan: { at: Date }[] = [{ at: t1 }, { at: t1 }, { at: t1 }, { at: t2 }, { at: t2 }];
    const created: { id: DocumentId; at: Date }[] = [];
    for (const [i, p] of plan.entries()) {
      const doc = await documents.create(ctx, {
        projectId: null,
        title: `doc-${i}`,
        ownerId: ctx.userId,
      });
      await db.pool.query('update documents set created_at = $2 where id = $1', [doc.id, p.at]);
      created.push({ id: doc.id, at: p.at });
    }
    // Archived rows still export; soft-deleted rows never do.
    await documents.setArchived(ctx, created[2]!.id, true);
    await documents.softDelete(ctx, created[4]!.id, new Date('2027-01-01T00:00:00Z'));

    const expected = created
      .filter((c) => c.id !== created[4]!.id)
      .sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((c) => c.id);

    const seen: DocumentId[] = [];
    let after: DocumentExportKeyset | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const rows = await documents.listForExport(ctx, after, 2);
      seen.push(...rows.map((r) => r.id));
      if (rows.length < 2) break;
      const last = rows[rows.length - 1]!;
      after = { createdAt: last.createdAt, id: last.id };
    }

    // Full coverage, correct order, no duplicates or gaps across the keyset.
    expect(seen).toEqual(expected);
  });
});
