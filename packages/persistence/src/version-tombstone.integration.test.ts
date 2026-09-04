import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '@mdloop/app';
import type { DocumentVersion } from '@mdloop/domain';
import { withTenant } from './db.js';
import {
  PgDirectoryRepository,
  PgDocumentRepository,
  PgVersionRepository,
} from './repositories/pg-repositories.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

/**
 * The document_versions trigger (migration 0005, ADR 0001): rows stay
 * content-immutable at the database level — the single permitted UPDATE is
 * the tombstone transition, and only with every other column untouched.
 */
describe('version immutability trigger', () => {
  let db: TestDb;
  let ctx: TenantContext;
  let version: DocumentVersion;
  let versions: PgVersionRepository;

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
    const doc = await documents.create(ctx, {
      projectId: null,
      ownerId: ctx.userId,
      title: 'spec.md',
    });
    version = await versions.append(ctx, {
      documentId: doc.id,
      contentHash: 'h1',
      byteSize: 42,
      createdBy: ctx.userId,
      source: 'web',
    });
  });

  afterAll(async () => {
    await db.close();
  });

  async function rawUpdate(sql: string, params: unknown[]): Promise<unknown> {
    return withTenant(db.pool, ctx, (c) => c.query(sql, params));
  }

  it('rejects content mutation on a live row', async () => {
    await expect(
      rawUpdate('update document_versions set content_hash = $2 where id = $1', [
        version.id,
        'tampered',
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it('rejects a tombstone transition that also edits content', async () => {
    await expect(
      rawUpdate('update document_versions set purged_at = now(), content_hash = $2 where id = $1', [
        version.id,
        'tampered',
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it('allows the pure tombstone transition exactly once', async () => {
    const tombstoned = await versions.tombstone(ctx, version.id);
    expect(tombstoned?.purgedAt).not.toBeNull();
    // Hash, size and lineage survive on the tombstone (ADR 0001).
    expect(tombstoned?.contentHash).toBe('h1');
    // Second transition: the repository refuses (returns undefined)…
    expect(await versions.tombstone(ctx, version.id)).toBeUndefined();
    // …and the trigger refuses even a raw re-stamp of purged_at.
    await expect(
      rawUpdate('update document_versions set purged_at = now() where id = $1', [version.id]),
    ).rejects.toThrow(/immutable/);
  });

  it('rejects un-purging a tombstone', async () => {
    await expect(
      rawUpdate('update document_versions set purged_at = null where id = $1', [version.id]),
    ).rejects.toThrow(/immutable/);
  });
});
