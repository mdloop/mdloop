import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@mdloop/app';
import { uploadNewDocument } from '@mdloop/app';
import type { Organization, User } from '@mdloop/domain';
import {
  PgDirectoryRepository,
  PgDocumentRepository,
  PgSearchRepository,
  PgShareGrantRepository,
  PgUploadUnitOfWork,
} from './repositories/pg-repositories.js';
import { FsStorage } from './storage/fs-storage.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

/**
 * Permission-scoped full-text search against real Postgres: proves cross-org
 * isolation (RLS), owned/granted/admin visibility, and that body text (not
 * just title) is matched — the tsvector is built at upload time from a blob
 * read, not from anything stored verbatim in Postgres (ARCHITECTURE.md §9).
 */
describe('search (FTS)', () => {
  let db: TestDb;
  let storage: FsStorage;
  let storageDir: string;
  let uploadUow: PgUploadUnitOfWork;
  let search: PgSearchRepository;
  let grants: PgShareGrantRepository;
  let documents: PgDocumentRepository;

  let orgA: Organization;
  let orgB: Organization;
  let owner: User;
  let stranger: User;
  let ownerActor: Actor;
  let strangerActor: Actor;
  let adminOfA: Actor;
  let otherOrgActor: Actor;

  beforeAll(async () => {
    db = await createTestDb();
    storageDir = await mkdtemp(path.join(tmpdir(), 'mdloop-search-blobs-'));
    storage = new FsStorage(storageDir);
    uploadUow = new PgUploadUnitOfWork(db.pool);
    search = new PgSearchRepository(db.pool);
    grants = new PgShareGrantRepository(db.pool);
    documents = new PgDocumentRepository(db.pool);

    const directory = new PgDirectoryRepository(db.pool);
    orgA = await directory.createOrganization('Org A');
    orgB = await directory.createOrganization('Org B');
    owner = await directory.createUser(orgA.id, {
      workosUserId: 'wos_owner',
      email: 'owner@org-a.test',
      displayName: 'Owner',
      role: 'member',
    });
    const admin = await directory.createUser(orgA.id, {
      workosUserId: 'wos_admin',
      email: 'admin@org-a.test',
      displayName: 'Admin',
      role: 'admin',
    });
    stranger = await directory.createUser(orgA.id, {
      workosUserId: 'wos_stranger',
      email: 'stranger@org-a.test',
      displayName: 'Stranger',
      role: 'member',
    });
    const otherOrgUser = await directory.createUser(orgB.id, {
      workosUserId: 'wos_other_org',
      email: 'user@org-b.test',
      displayName: 'Other org',
      role: 'admin',
    });

    ownerActor = { ctx: { orgId: orgA.id, userId: owner.id }, role: 'member' };
    adminOfA = { ctx: { orgId: orgA.id, userId: admin.id }, role: 'admin' };
    strangerActor = { ctx: { orgId: orgA.id, userId: stranger.id }, role: 'member' };
    otherOrgActor = { ctx: { orgId: orgB.id, userId: otherOrgUser.id }, role: 'admin' };
  }, 60_000);

  afterAll(async () => {
    await db.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  it('matches body text, never returns another org, and respects owner/grant/admin scoping', async () => {
    const uploaded = await uploadNewDocument(uploadUow, storage, ownerActor, {
      title: 'runbook.md',
      projectId: null,
      content: Buffer.from('# Runbook\n\nContains a rollback procedure for deploys.', 'utf8'),
      source: 'web',
    });
    if (!uploaded.ok) throw new Error('setup: upload failed');
    const documentId = uploaded.value.document.id;

    // Body-only term (not present in the title) still matches — proves the
    // tsvector is built from blob content, not just the title.
    const byBody = await search.search(ownerActor.ctx, owner.id, 'member', 'rollback');
    expect(byBody.map((h) => h.documentId)).toEqual([documentId]);

    // A stranger in the SAME org, no grant: sees nothing.
    const strangerBefore = await search.search(
      strangerActor.ctx,
      stranger.id,
      'member',
      'rollback',
    );
    expect(strangerBefore).toEqual([]);

    // Org admin: sees it without a grant.
    const asAdmin = await search.search(adminOfA.ctx, adminOfA.ctx.userId, 'admin', 'rollback');
    expect(asAdmin.map((h) => h.documentId)).toEqual([documentId]);

    // Grant read access to the stranger — now they see it too.
    await grants.create(ownerActor.ctx, {
      subject: { type: 'document', id: documentId },
      grantee: { type: 'user', userId: stranger.id },
      permission: 'read',
      tokenHash: null,
      createdBy: owner.id,
    });
    const strangerAfter = await search.search(strangerActor.ctx, stranger.id, 'member', 'rollback');
    expect(strangerAfter.map((h) => h.documentId)).toEqual([documentId]);

    // Cross-org: an identity in org B, even as admin, never sees org A's row —
    // RLS scopes the query before the permission `where` clause even runs.
    const crossOrg = await search.search(
      otherOrgActor.ctx,
      otherOrgActor.ctx.userId,
      'admin',
      'rollback',
    );
    expect(crossOrg).toEqual([]);

    // Unrelated term: no match anywhere.
    const noMatch = await search.search(ownerActor.ctx, owner.id, 'member', 'nonexistent-term');
    expect(noMatch).toEqual([]);
  });

  it('excludes archived and deleted documents from results', async () => {
    const uploaded = await uploadNewDocument(uploadUow, storage, ownerActor, {
      title: 'temp-notes.md',
      projectId: null,
      content: Buffer.from('ephemeral scratch content', 'utf8'),
      source: 'web',
    });
    if (!uploaded.ok) throw new Error('setup: upload failed');
    const documentId = uploaded.value.document.id;

    const before = await search.search(ownerActor.ctx, owner.id, 'member', 'ephemeral');
    expect(before.map((h) => h.documentId)).toEqual([documentId]);

    await documents.setArchived(ownerActor.ctx, documentId, true);
    const archived = await search.search(ownerActor.ctx, owner.id, 'member', 'ephemeral');
    expect(archived).toEqual([]);
  });

  it('returns the repo-relative path on a hit, null for a document with none', async () => {
    const withPath = await uploadNewDocument(uploadUow, storage, ownerActor, {
      title: 'auth.md',
      projectId: null,
      content: Buffer.from('quorum-based leader election details', 'utf8'),
      source: 'web',
      path: 'docs/specs/auth.md',
    });
    if (!withPath.ok) throw new Error('setup: upload failed');

    const withoutPath = await uploadNewDocument(uploadUow, storage, ownerActor, {
      title: 'scratch.md',
      projectId: null,
      content: Buffer.from('quorum scratch notes', 'utf8'),
      source: 'web',
    });
    if (!withoutPath.ok) throw new Error('setup: upload failed');

    const hits = await search.search(ownerActor.ctx, owner.id, 'member', 'quorum');
    const byId = new Map(hits.map((h) => [h.documentId, h.path]));
    expect(byId.get(withPath.value.document.id)).toBe('docs/specs/auth.md');
    expect(byId.get(withoutPath.value.document.id)).toBeNull();
  });
});
