import { describe, expect, it } from 'vitest';
import type { UserId } from '@mdloop/shared';
import type { Anchor } from '@mdloop/domain';
import type { DocumentId, VersionId } from '@mdloop/shared';
import {
  FakeCommentRepository,
  FakeDocumentRepository,
  FakeSearchRepository,
  FakeShareGrantRepository,
  FakeWorld,
} from '../test-support/fakes.js';
import type { Actor } from './org-settings.js';
import { searchComments, searchDocuments } from './search.js';

const textAnchor: Anchor = {
  type: 'text',
  exact: 'x',
  prefix: '',
  suffix: '',
  start: 0,
  end: 1,
};

function setup() {
  const world = new FakeWorld();
  const org = world.org();
  const owner: Actor = { ctx: { orgId: org.id, userId: 'owner' as UserId }, role: 'member' };
  const stranger: Actor = { ctx: { orgId: org.id, userId: 'other' as UserId }, role: 'member' };
  const admin: Actor = { ctx: { orgId: org.id, userId: 'admin' as UserId }, role: 'admin' };
  const grants = new FakeShareGrantRepository(world);
  return {
    world,
    org,
    owner,
    stranger,
    admin,
    documents: new FakeDocumentRepository(world),
    grants,
    comments: new FakeCommentRepository(world),
    search: new FakeSearchRepository(world, grants),
  };
}

async function seedDoc(s: ReturnType<typeof setup>, title: string, ownerId = s.owner.ctx.userId) {
  const doc = s.world.addDocument(s.org.id, { title, projectId: null, ownerId });
  s.world.documents.set(doc.id, { ...doc, currentVersionId: 'v1' as VersionId });
  return doc;
}

describe('searchDocuments', () => {
  it('rejects an empty query', async () => {
    const s = setup();
    const result = await searchDocuments(s.search, s.owner, '   ');
    expect(!result.ok && result.error.code).toBe('empty_query');
  });

  it('matches title and body text, scoped to the owner', async () => {
    const s = setup();
    const doc = s.world.addDocument(s.org.id, {
      title: 'runbook.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
    });
    s.world.searchIndex.set(doc.id, {
      orgId: s.org.id,
      title: doc.title,
      body: 'contains a rollback procedure',
    });

    const byTitle = await searchDocuments(s.search, s.owner, 'runbook');
    expect(byTitle.ok && byTitle.value.map((h) => h.documentId)).toEqual([doc.id]);

    const byBody = await searchDocuments(s.search, s.owner, 'rollback');
    expect(byBody.ok && byBody.value.map((h) => h.documentId)).toEqual([doc.id]);

    const noMatch = await searchDocuments(s.search, s.owner, 'nonexistent-term');
    expect(noMatch.ok && noMatch.value).toEqual([]);
  });

  it('hides results from a stranger without a grant, admin sees everything', async () => {
    const s = setup();
    const doc = s.world.addDocument(s.org.id, {
      title: 'secret.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
    });
    s.world.searchIndex.set(doc.id, { orgId: s.org.id, title: doc.title, body: 'classified' });

    const strangerResult = await searchDocuments(s.search, s.stranger, 'classified');
    expect(strangerResult.ok && strangerResult.value).toEqual([]);

    const adminResult = await searchDocuments(s.search, s.admin, 'classified');
    expect(adminResult.ok && adminResult.value.map((h) => h.documentId)).toEqual([doc.id]);

    await s.grants.create(s.owner.ctx, {
      subject: { type: 'document', id: doc.id },
      grantee: { type: 'user', userId: s.stranger.ctx.userId },
      permission: 'read',
      tokenHash: null,
      createdBy: s.owner.ctx.userId,
    });
    const grantedResult = await searchDocuments(s.search, s.stranger, 'classified');
    expect(grantedResult.ok && grantedResult.value.map((h) => h.documentId)).toEqual([doc.id]);
  });

  it('excludes archived and deleted documents', async () => {
    const s = setup();
    const doc = s.world.addDocument(s.org.id, {
      title: 'temp.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
    });
    s.world.searchIndex.set(doc.id, { orgId: s.org.id, title: doc.title, body: 'ephemeral notes' });
    await s.documents.setArchived(s.owner.ctx, doc.id, true);
    const archived = await searchDocuments(s.search, s.owner, 'ephemeral');
    expect(archived.ok && archived.value).toEqual([]);
  });

  it('carries the repo-relative path through to the hit, null when the document has none', async () => {
    const s = setup();
    const withPath = s.world.addDocument(s.org.id, {
      title: 'runbook.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
      path: 'docs/runbook.md',
    });
    s.world.searchIndex.set(withPath.id, {
      orgId: s.org.id,
      title: withPath.title,
      body: 'rollback procedure',
    });
    const withoutPath = s.world.addDocument(s.org.id, {
      title: 'scratch.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
    });
    s.world.searchIndex.set(withoutPath.id, {
      orgId: s.org.id,
      title: withoutPath.title,
      body: 'rollback notes',
    });

    const result = await searchDocuments(s.search, s.owner, 'rollback');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.value.map((h) => [h.documentId, h.path]));
    expect(byId.get(withPath.id)).toBe('docs/runbook.md');
    expect(byId.get(withoutPath.id)).toBeNull();
  });
});

describe('searchComments', () => {
  async function comment(
    s: ReturnType<typeof setup>,
    documentId: DocumentId,
    body: string,
    proposedText: string | null = null,
  ) {
    return s.comments.create(s.owner.ctx, {
      documentId,
      versionId: 'v1' as VersionId,
      body,
      anchor: textAnchor,
      authorId: s.owner.ctx.userId,
      viaApiKeyId: null,
      proposedText,
    });
  }

  it('rejects an empty query', async () => {
    const s = setup();
    const result = await searchComments(s.search, s.owner, '  ');
    expect(!result.ok && result.error.code).toBe('empty_query');
  });

  it('matches a comment body and returns anchor-grained hits', async () => {
    const s = setup();
    const doc = await seedDoc(s, 'design.md');
    const c = await comment(s, doc.id, 'the rollback path is unclear');

    const hit = await searchComments(s.search, s.owner, 'rollback');
    expect(hit.ok).toBe(true);
    if (!hit.ok) return;
    expect(hit.value).toHaveLength(1);
    expect(hit.value[0]).toMatchObject({
      kind: 'comment',
      commentId: c.id,
      documentId: doc.id,
      documentTitle: 'design.md',
      status: 'open',
    });
    expect(hit.value[0]?.anchor).toEqual(textAnchor);
  });

  it('matches a suggestion by its proposed replacement text', async () => {
    const s = setup();
    const doc = await seedDoc(s, 'spec.md');
    const c = await comment(s, doc.id, 'reword this', 'idempotent retry semantics');

    const hit = await searchComments(s.search, s.owner, 'idempotent');
    expect(hit.ok && hit.value.map((h) => h.commentId)).toEqual([c.id]);
  });

  it('hides a stranger without a grant; admin sees all; a grant reveals it', async () => {
    const s = setup();
    const doc = await seedDoc(s, 'secret.md');
    await comment(s, doc.id, 'classified remark');

    const stranger = await searchComments(s.search, s.stranger, 'classified');
    expect(stranger.ok && stranger.value).toEqual([]);

    const admin = await searchComments(s.search, s.admin, 'classified');
    expect(admin.ok && admin.value.map((h) => h.documentId)).toEqual([doc.id]);

    await s.grants.create(s.owner.ctx, {
      subject: { type: 'document', id: doc.id },
      grantee: { type: 'user', userId: s.stranger.ctx.userId },
      permission: 'comment',
      tokenHash: null,
      createdBy: s.owner.ctx.userId,
    });
    const granted = await searchComments(s.search, s.stranger, 'classified');
    expect(granted.ok && granted.value.map((h) => h.documentId)).toEqual([doc.id]);
  });

  it('excludes comments on archived or deleted documents', async () => {
    const s = setup();
    const doc = await seedDoc(s, 'temp.md');
    await comment(s, doc.id, 'ephemeral remark');
    await s.documents.setArchived(s.owner.ctx, doc.id, true);
    const archived = await searchComments(s.search, s.owner, 'ephemeral');
    expect(archived.ok && archived.value).toEqual([]);
  });
});
