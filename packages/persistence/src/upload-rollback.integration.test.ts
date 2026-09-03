import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor, StoragePort, VersionKey, PublicDocKey } from '@vorlyn/app';
import { uploadNewDocument } from '@vorlyn/app';
import type { OrgId, DocumentId } from '@vorlyn/shared';
import { PgDirectoryRepository, PgUploadUnitOfWork } from './repositories/pg-repositories.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

/** Always rejects `put` — proves the rollback (upload.ts's `uploadNewDocument`
 * catch block, `purgeDocumentRow` on `UploadTx`) against real Postgres, not
 * just the in-memory fake (`upload.test.ts`'s coverage of the same scenario).
 * The other four methods are unused by this test and never called. */
class RejectingStorage implements StoragePort {
  put(): Promise<void> {
    return Promise.reject(new Error('storage unavailable'));
  }
  get(_key: VersionKey): Promise<Uint8Array> {
    return Promise.reject(new Error('not implemented'));
  }
  delete(_key: VersionKey): Promise<void> {
    return Promise.resolve();
  }
  deleteDocument(_orgId: OrgId, _documentId: DocumentId): Promise<void> {
    return Promise.resolve();
  }
  deleteOrg(_orgId: OrgId): Promise<void> {
    return Promise.resolve();
  }
  putPublic(_key: PublicDocKey): Promise<void> {
    return Promise.reject(new Error('not implemented'));
  }
  getPublic(_key: PublicDocKey): Promise<Uint8Array> {
    return Promise.reject(new Error('not implemented'));
  }
}

/**
 * `uploadNewDocument` commits the `documents` row in its own transaction
 * before ever calling `storage.put` (upload.ts's doc comment explains why —
 * no row lock spanning S3 latency). This is the real-Postgres proof that a
 * failed blob write doesn't leave that row behind as an orphan: hit for real
 * when the AWS-dev deploy tried to upload before storageFromEnv/S3Storage
 * were wired in (Phase 10.G) — a document showed up on the home
 * page with no version, 404ing on open ("document not found").
 */
describe('uploadNewDocument rollback against real Postgres', () => {
  let db: TestDb;
  let uow: PgUploadUnitOfWork;
  let owner: Actor;

  beforeAll(async () => {
    db = await createTestDb();
    uow = new PgUploadUnitOfWork(db.pool);
    const directory = new PgDirectoryRepository(db.pool);
    const org = await directory.createOrganization('Acme');
    const user = await directory.createUser(org.id, {
      workosUserId: 'wos_owner',
      email: 'owner@acme.test',
      displayName: 'Owner',
      role: 'member',
    });
    owner = { ctx: { orgId: org.id, userId: user.id }, role: 'member' };
  });

  afterAll(async () => {
    await db.close();
  });

  it('deletes the document row when storage.put rejects, and the org doc count stays at zero', async () => {
    const storage = new RejectingStorage();

    await expect(
      uploadNewDocument(uow, storage, owner, {
        title: 'runbook.md',
        projectId: null,
        content: new TextEncoder().encode('# Runbook'),
        source: 'web',
      }),
    ).rejects.toThrow('storage unavailable');

    const count = await uow.run(owner.ctx, (tx) => tx.activeDocCount());
    expect(count).toBe(0);
  });
});
