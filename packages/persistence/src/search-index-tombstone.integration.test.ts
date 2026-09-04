import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '@mdloop/app';
import type { Document } from '@mdloop/domain';
import { withTenant } from './db.js';
import {
  PgDirectoryRepository,
  PgDocumentRepository,
  PgVersionRepository,
} from './repositories/pg-repositories.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

/**
 * Tombstoning a version must not leave a dangling search_index row pointing
 * at purged content (mirrors the whole-document purge's search_index
 * cleanup in queries.ts purgeDocument). search_index carries one row per
 * document (PK document_id, org_id) — the fix only deletes it when it still
 * references the version just tombstoned, so a row already pointing at the
 * live/current version must survive untouched.
 */
describe('tombstone clears a stale search_index row', () => {
  let db: TestDb;
  let ctx: TenantContext;
  let versions: PgVersionRepository;
  let doc: Document;

  beforeAll(async () => {
    db = await createTestDb();
    const directory = new PgDirectoryRepository(db.pool);
    const org = await directory.createOrganization('Acme');
    const alice = await directory.createUser(org.id, {
      workosUserId: 'wos_alice',
      email: 'alice@acme.test',
      displayName: 'Alice',
      role: 'member',
    });
    ctx = { orgId: org.id, userId: alice.id };
    versions = new PgVersionRepository(db.pool);
    const documents = new PgDocumentRepository(db.pool);
    doc = await documents.create(ctx, { projectId: null, ownerId: ctx.userId, title: 'idx.md' });
  });

  afterAll(async () => {
    await db.close();
  });

  async function insertSearchIndex(versionId: string): Promise<void> {
    await withTenant(db.pool, ctx, (c) =>
      c.query(
        `insert into search_index (document_id, org_id, version_id, tsv)
         values ($1, $2, $3, to_tsvector('english', 'stub'))
         on conflict (document_id, org_id)
         do update set version_id = excluded.version_id`,
        [doc.id, ctx.orgId, versionId],
      ),
    );
  }

  async function searchIndexVersionId(): Promise<string | undefined> {
    const { rows } = await withTenant(db.pool, ctx, (c) =>
      c.query<{ version_id: string }>(
        'select version_id from search_index where document_id = $1',
        [doc.id],
      ),
    );
    return rows[0]?.version_id;
  }

  it('deletes the row when it still references the just-purged (non-current) version', async () => {
    const v1 = await versions.append(ctx, {
      documentId: doc.id,
      contentHash: 'stale-1',
      byteSize: 10,
      createdBy: ctx.userId,
      source: 'web',
    });
    // Current version moves on; search_index is left pointing at v1 —
    // simulates a stale row (the fix should clear it, not leave it dangling).
    await versions.append(ctx, {
      documentId: doc.id,
      contentHash: 'stale-2',
      byteSize: 10,
      createdBy: ctx.userId,
      source: 'web',
    });
    await insertSearchIndex(v1.id);

    await versions.tombstone(ctx, v1.id);

    expect(await searchIndexVersionId()).toBeUndefined();
  });

  it('leaves the row alone when it references the current live version', async () => {
    const v3 = await versions.append(ctx, {
      documentId: doc.id,
      contentHash: 'live-1',
      byteSize: 10,
      createdBy: ctx.userId,
      source: 'web',
    });
    const v4 = await versions.append(ctx, {
      documentId: doc.id,
      contentHash: 'live-2',
      byteSize: 10,
      createdBy: ctx.userId,
      source: 'web',
    });
    // search_index points at the current version (v4); tombstoning the
    // older, non-current v3 must not touch it.
    await insertSearchIndex(v4.id);

    await versions.tombstone(ctx, v3.id);

    expect(await searchIndexVersionId()).toBe(v4.id);
  });
});
