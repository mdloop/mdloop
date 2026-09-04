import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@mdloop/app';
import { createComment, uploadNewDocument, uploadNewVersion } from '@mdloop/app';
import type { CommentId, VersionId } from '@mdloop/shared';
import {
  PgAnchorResolutionRepository,
  PgCommentRepository,
  PgDirectoryRepository,
  PgDocumentRepository,
  PgShareGrantRepository,
  PgUploadUnitOfWork,
} from './repositories/pg-repositories.js';
import { PgOrganizationRepository } from './repositories/pg-organization-repository.js';
import { FsStorage } from './storage/fs-storage.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

/**
 * Anchor-resolution cache prune (Phase 24.D). `pruneStale` must drop stale rows
 * for versions that are no longer current, while always keeping the current
 * version's rows (the hot read path) regardless of age.
 */
describe('PgAnchorResolutionRepository.pruneStale', () => {
  let db: TestDb;
  let storageDir: string;
  let storage: FsStorage;
  let documents: PgDocumentRepository;
  let comments: PgCommentRepository;
  let orgs: PgOrganizationRepository;
  let grants: PgShareGrantRepository;
  let resolutions: PgAnchorResolutionRepository;
  let uow: PgUploadUnitOfWork;
  let alice: Actor;
  let commentId: CommentId;
  let oldVersionId: VersionId;
  let currentVersionId: VersionId;

  const encoder = new TextEncoder();

  beforeAll(async () => {
    db = await createTestDb();
    storageDir = await mkdtemp(path.join(tmpdir(), 'mdloop-anchor-prune-'));
    storage = new FsStorage(storageDir);
    const directory = new PgDirectoryRepository(db.pool);
    documents = new PgDocumentRepository(db.pool);
    comments = new PgCommentRepository(db.pool);
    orgs = new PgOrganizationRepository(db.pool);
    grants = new PgShareGrantRepository(db.pool);
    resolutions = new PgAnchorResolutionRepository(db.pool);
    uow = new PgUploadUnitOfWork(db.pool);

    const org = await directory.createOrganization('Acme');
    const admin = await directory.createUser(org.id, {
      workosUserId: `wos_alice_${String(Math.random())}`,
      email: 'alice@acme.test',
      displayName: 'alice',
      role: 'admin',
    });
    alice = { ctx: { orgId: org.id, userId: admin.id }, role: 'admin' };

    // v1 (old) then v2 (current) of one document.
    const first = await uploadNewDocument(uow, storage, alice, {
      title: 'spec.md',
      projectId: null,
      content: encoder.encode('# Spec\n\nv1 body'),
      source: 'web',
    });
    if (!first.ok) throw new Error('setup upload v1');
    oldVersionId = first.value.version.id;
    const documentId = first.value.document.id;

    const comment = await createComment(documents, comments, orgs, grants, alice, {
      documentId,
      body: 'note',
      anchor: { type: 'document' },
    });
    if (!comment.ok) throw new Error('setup comment');
    commentId = comment.value.id;

    const second = await uploadNewVersion(uow, storage, alice, {
      documentId,
      content: encoder.encode('# Spec\n\nv2 body, revised'),
      source: 'web',
    });
    if (!second.ok) throw new Error('setup upload v2');
    currentVersionId = second.value.version.id;

    // Cache rows for both the old (non-current) and the current version.
    await resolutions.upsert(alice.ctx, {
      commentId,
      versionId: oldVersionId,
      method: 'exact',
      confidence: 1,
      start: 0,
      end: 4,
    });
    await resolutions.upsert(alice.ctx, {
      commentId,
      versionId: currentVersionId,
      method: 'exact',
      confidence: 1,
      start: 0,
      end: 4,
    });
    // Age BOTH rows well past any cutoff — currency, not age, must save the
    // current-version row.
    await db.pool.query(
      `update comment_anchor_resolutions set computed_at = now() - interval '200 days'`,
    );
  });

  afterAll(async () => {
    await db.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  it('drops the stale non-current row and keeps the current-version row', async () => {
    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    const deleted = await resolutions.pruneStale(alice.ctx, cutoff);
    expect(deleted).toBe(1);

    const survivingOld = await resolutions.forVersion(alice.ctx, oldVersionId);
    const survivingCurrent = await resolutions.forVersion(alice.ctx, currentVersionId);
    expect(survivingOld).toHaveLength(0);
    expect(survivingCurrent).toHaveLength(1);
    expect(survivingCurrent[0]?.commentId).toBe(commentId);
  });
});
