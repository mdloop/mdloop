import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@vorlyn/app';
import { uploadNewDocument, uploadNewVersion } from '@vorlyn/app';
import { PgDirectoryRepository, PgUploadUnitOfWork } from './repositories/pg-repositories.js';
import { FsStorage } from './storage/fs-storage.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

/**
 * Proves the upload-transaction lock reshape's core safety claim against
 * real Postgres, not the in-memory fake: concurrent uploads to the SAME
 * document each get a unique, non-colliding seq, even though the row lock
 * (`reserveVersionSeq`, packages/persistence/src/repositories/queries.ts) is
 * now held only for the fast reservation step, not across the blob write.
 * The in-memory fake can't prove this — its operations aren't actually
 * serialized the way a real transaction lock is (see upload.test.ts).
 */
describe('uploadNewVersion seq reservation under real concurrency', () => {
  let db: TestDb;
  let blobDir: string;
  let uow: PgUploadUnitOfWork;
  let storage: FsStorage;
  let owner: Actor;
  let documentId: string;

  beforeAll(async () => {
    db = await createTestDb();
    blobDir = await mkdtemp(path.join(tmpdir(), 'vorlyn-upload-concurrency-'));
    storage = new FsStorage(blobDir);
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

    const first = await uploadNewDocument(uow, storage, owner, {
      title: 'contended.md',
      projectId: null,
      content: new TextEncoder().encode('v1'),
      source: 'web',
    });
    if (!first.ok) throw new Error('setup upload failed');
    documentId = first.value.document.id;
  });

  afterAll(async () => {
    await db.close();
    await rm(blobDir, { recursive: true, force: true });
  });

  it('assigns strictly unique, non-colliding seqs when uploads race for the same document', async () => {
    const concurrency = 8;
    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        uploadNewVersion(uow, storage, owner, {
          documentId: documentId as never,
          content: new TextEncoder().encode(`racer-${String(i)}`),
          source: 'web',
        }),
      ),
    );

    // Every racer succeeds (none see a version_conflict-style error — the
    // pessimistic FOR UPDATE reservation means there's nothing to conflict
    // on, only to wait briefly for).
    expect(results.every((r) => r.ok)).toBe(true);

    const seqs = results.map((r) => (r.ok ? r.value.version.seq : -1)).sort((a, b) => a - b);
    // seq 1 is the setup upload; the 8 racers must land on exactly 2..9,
    // each exactly once — the document_versions_doc_seq_uniq constraint
    // (migration 0026) would reject the insert if the lock ever let two
    // racers compute the same seq, so a clean pass here is a real proof, not
    // an artifact of how the fake happens to interleave promises.
    expect(seqs).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
