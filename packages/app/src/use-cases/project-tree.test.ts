import { describe, expect, it } from 'vitest';
import type { DocumentId, ProjectId, UserId } from '@mdloop/shared';
import {
  FakeCommentRepository,
  FakeDocumentRepository,
  FakeProjectRepository,
  FakeReviewRepository,
  FakeShareGrantRepository,
  FakeWorld,
} from '../test-support/fakes.js';
import type { Actor } from './org-settings.js';
import { projectTree } from './project-tree.js';

function setup() {
  const world = new FakeWorld();
  const org = world.org();
  const otherOrg = world.org();
  const admin: Actor = { ctx: { orgId: org.id, userId: 'admin' as UserId }, role: 'admin' };
  const grants = new FakeShareGrantRepository(world);
  return {
    world,
    org,
    otherOrg,
    admin,
    documents: new FakeDocumentRepository(world, grants),
    projects: new FakeProjectRepository(world),
    reviews: new FakeReviewRepository(world),
    comments: new FakeCommentRepository(world),
  };
}

function run(
  s: ReturnType<typeof setup>,
  actor: Actor,
  projectId: ProjectId,
  maxDocuments?: number,
) {
  return projectTree(s.documents, s.projects, s.reviews, actor, projectId, maxDocuments);
}

function addDoc(
  s: ReturnType<typeof setup>,
  title: string,
  projectId: ProjectId,
  path: string | null = null,
): DocumentId {
  const doc = s.world.addDocument(s.org.id, {
    title,
    projectId,
    ownerId: s.admin.ctx.userId,
    path,
  });
  return doc.id;
}

describe('projectTree', () => {
  it('returns project_not_found for a missing or cross-org project', async () => {
    const s = setup();
    const missing = await run(s, s.admin, 'does-not-exist' as ProjectId);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('project_not_found');

    // A project that genuinely exists, just in another org — RLS-shaped: the
    // tenant boundary and "not found" are the same answer, never a 403 that
    // would confirm the project's existence to an outsider.
    const foreignProject = s.world.addProject(s.otherOrg.id, { name: 'Foreign', color: '#000' });
    const crossOrg = await run(s, s.admin, foreignProject.id);
    expect(crossOrg.ok).toBe(false);
    if (!crossOrg.ok) expect(crossOrg.error.code).toBe('project_not_found');
  });

  it('returns an empty tree for a project with no documents', async () => {
    const s = setup();
    const project = s.world.addProject(s.org.id, { name: 'Empty', color: '#000' });
    const result = await run(s, s.admin, project.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        projectId: project.id,
        tooLarge: false,
        documentCount: 0,
        documents: [],
      });
    }
  });

  it('mixes path-backed and manually-uploaded documents, sorted with nulls last', async () => {
    const s = setup();
    const project = s.world.addProject(s.org.id, { name: 'Mixed', color: '#000' });
    addDoc(s, 'manual.md', project.id, null);
    addDoc(s, 'auth.md', project.id, 'docs/specs/auth.md');
    addDoc(s, 'plan.md', project.id, 'docs/plan.md');

    const result = await run(s, s.admin, project.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.documentCount).toBe(3);
    // Path-backed docs first (path order), manual upload last (null path).
    expect(result.value.documents.map((d) => d.path)).toEqual([
      'docs/plan.md',
      'docs/specs/auth.md',
      null,
    ]);
    // Every row still carries the review-attention shape, defaulted sanely.
    for (const doc of result.value.documents) {
      expect(doc.openCommentCount).toBe(0);
      expect(doc.reviewStatus).toBe('draft');
    }
  });

  it('aggregates open comment counts per document, honestly over the whole project', async () => {
    const s = setup();
    const project = s.world.addProject(s.org.id, { name: 'Busy', color: '#000' });
    const docId = addDoc(s, 'auth.md', project.id, 'docs/auth.md');
    const version = s.world.addVersion(s.org.id, {
      documentId: docId,
      contentHash: 'h',
      byteSize: 1,
      source: 'web',
      createdBy: s.admin.ctx.userId,
      viaApiKeyId: null,
      changeNote: null,
    });
    s.world.documents.set(docId, {
      ...s.world.documents.get(docId)!,
      currentVersionId: version.id,
    });
    await s.comments.create(s.admin.ctx, {
      documentId: docId,
      versionId: version.id,
      body: 'needs work',
      anchor: { type: 'document' },
      authorId: s.admin.ctx.userId,
    });

    const result = await run(s, s.admin, project.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.documents).toHaveLength(1);
    expect(result.value.documents[0]?.openCommentCount).toBe(1);
  });

  it('falls back to tooLarge with an empty array above the document-count bound', async () => {
    const s = setup();
    const project = s.world.addProject(s.org.id, { name: 'Huge', color: '#000' });
    addDoc(s, 'a.md', project.id, 'a.md');
    addDoc(s, 'b.md', project.id, 'b.md');
    addDoc(s, 'c.md', project.id, 'c.md');

    // Inject a tiny bound rather than fixturing thousands of real documents —
    // the production default (PROJECT_TREE_MAX_DOCUMENTS) is exercised by its
    // own constant; this proves the comparison and the fallback shape.
    const result = await run(s, s.admin, project.id, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      projectId: project.id,
      tooLarge: true,
      documentCount: 3,
      documents: [],
    });
  });

  it('scopes the tree to what the actor can access, like the home overview', async () => {
    const s = setup();
    const project = s.world.addProject(s.org.id, { name: 'Scoped', color: '#000' });
    const owner: Actor = { ctx: { orgId: s.org.id, userId: 'owner' as UserId }, role: 'member' };
    const other: Actor = { ctx: { orgId: s.org.id, userId: 'other' as UserId }, role: 'member' };
    s.world.addDocument(s.org.id, {
      title: 'private.md',
      projectId: project.id,
      ownerId: owner.ctx.userId,
      path: 'private.md',
    });

    const asOwner = await run(s, owner, project.id);
    expect(asOwner.ok).toBe(true);
    if (asOwner.ok) expect(asOwner.value.documentCount).toBe(1);

    const asOther = await run(s, other, project.id);
    expect(asOther.ok).toBe(true);
    if (asOther.ok) expect(asOther.value.documentCount).toBe(0);

    const asAdmin = await run(s, s.admin, project.id);
    expect(asAdmin.ok).toBe(true);
    if (asAdmin.ok) expect(asAdmin.value.documentCount).toBe(1);
  });
});
