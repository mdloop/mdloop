import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@vorlyn/app';
import { createComment, uploadNewDocument } from '@vorlyn/app';
import { createTextAnchor } from '@vorlyn/domain';
import type { CommentId, VersionId } from '@vorlyn/shared';
import {
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
 * `UploadTx.markSuggestionAccepted` (Phase 24.D) used to be the mechanism that
 * folded a suggestion's open->accepted flip into the same transaction as the
 * version it minted. ADR 0007 removed that call from `acceptSuggestion` —
 * accept is metadata-only now and never mints a version — but the primitive
 * itself (and its atomicity guarantee: a throw inside the transaction rolls
 * the flip back) is still part of `UploadTx` and still worth proving directly.
 */
describe('UploadTx.markSuggestionAccepted rolls back with its transaction', () => {
  const encoder = new TextEncoder();
  const DOC = '# Spec\n\nThis is a draft ready for review.';

  let db: TestDb;
  let storageDir: string;
  let storage: FsStorage;
  let documents: PgDocumentRepository;
  let comments: PgCommentRepository;
  let orgs: PgOrganizationRepository;
  let grants: PgShareGrantRepository;
  let uow: PgUploadUnitOfWork;
  let alice: Actor;

  beforeAll(async () => {
    db = await createTestDb();
    storageDir = await mkdtemp(path.join(tmpdir(), 'vorlyn-suggest-atomic-'));
    storage = new FsStorage(storageDir);
    const directory = new PgDirectoryRepository(db.pool);
    documents = new PgDocumentRepository(db.pool);
    comments = new PgCommentRepository(db.pool);
    orgs = new PgOrganizationRepository(db.pool);
    grants = new PgShareGrantRepository(db.pool);
    uow = new PgUploadUnitOfWork(db.pool);

    const org = await directory.createOrganization('Acme');
    const admin = await directory.createUser(org.id, {
      workosUserId: `wos_alice_${String(Math.random())}`,
      email: 'alice@acme.test',
      displayName: 'alice',
      role: 'admin',
    });
    alice = { ctx: { orgId: org.id, userId: admin.id }, role: 'admin' };
  });

  afterAll(async () => {
    await db.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  async function seedSuggestion(): Promise<{ commentId: CommentId; versionId: VersionId }> {
    const uploaded = await uploadNewDocument(uow, storage, alice, {
      title: `spec-${String(Math.random())}.md`,
      projectId: null,
      content: encoder.encode(DOC),
      source: 'web',
    });
    if (!uploaded.ok) throw new Error('setup upload');
    const start = DOC.indexOf('draft');
    const r = await createComment(documents, comments, orgs, grants, alice, {
      documentId: uploaded.value.document.id,
      body: 'replace "draft"',
      anchor: createTextAnchor(DOC, start, start + 'draft'.length),
      proposedText: 'final',
    });
    if (!r.ok) throw new Error(`suggest failed: ${r.error.code}`);
    return { commentId: r.value.id, versionId: uploaded.value.version.id };
  }

  it('rolls the flip back when the upload transaction aborts (both-or-neither)', async () => {
    const { commentId, versionId } = await seedSuggestion();
    // Drive the UoW directly to simulate a crash after the flip but before
    // commit: the throw aborts the transaction, so the flip must not persist.
    await expect(
      uow.run(alice.ctx, async (tx) => {
        const flipped = await tx.markSuggestionAccepted(commentId, versionId);
        expect(flipped?.suggestionOutcome).toBe('accepted');
        throw new Error('simulated crash after flip');
      }),
    ).rejects.toThrow('simulated crash after flip');

    const fresh = await comments.byId(alice.ctx, commentId);
    expect(fresh?.suggestionOutcome).toBe('open');
    expect(fresh?.appliedVersionId).toBeNull();
  });
});
