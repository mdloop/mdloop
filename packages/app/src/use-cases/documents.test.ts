import { describe, expect, it } from 'vitest';
import type { DocumentId, ProjectId, UserId } from '@mdloop/shared';
import {
  FakeDocumentRepository,
  FakeErasureLog,
  FakeOrganizationRepository,
  FakeProjectRepository,
  FakeRetentionSweepRepository,
  FakeStorage,
  FakeWorld,
} from '../test-support/fakes.js';
import type { Actor } from './org-settings.js';
import {
  deleteDocument,
  getDocument,
  listDocuments,
  moveDocument,
  setDocumentArchived,
  sweepDuePurges,
} from './documents.js';

function setup(orgOverrides: Parameters<FakeWorld['org']>[0] = {}) {
  const world = new FakeWorld();
  const org = world.org(orgOverrides);
  const owner: Actor = { ctx: { orgId: org.id, userId: 'owner' as UserId }, role: 'member' };
  const stranger: Actor = { ctx: { orgId: org.id, userId: 'other' as UserId }, role: 'member' };
  return {
    world,
    org,
    owner,
    stranger,
    documents: new FakeDocumentRepository(world),
    projects: new FakeProjectRepository(world),
    orgs: new FakeOrganizationRepository(world),
    storage: new FakeStorage(),
    erasures: new FakeErasureLog(),
    sweep: new FakeRetentionSweepRepository(world),
  };
}

describe('listDocuments / getDocument', () => {
  it('filters unfiled, per-project and archived views', async () => {
    const s = setup();
    const project = s.world.addProject(s.org.id, { name: 'P', color: '#6366f1' });
    const unfiled = s.world.addDocument(s.org.id, {
      title: 'u.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
    });
    const filed = s.world.addDocument(s.org.id, {
      title: 'f.md',
      projectId: project.id,
      ownerId: s.owner.ctx.userId,
    });
    const archived = s.world.addDocument(s.org.id, {
      title: 'a.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
    });
    await s.documents.setArchived(s.owner.ctx, archived.id, true);

    const all = await listDocuments(s.documents, s.owner);
    expect(all.map((d) => d.id).sort()).toEqual([unfiled.id, filed.id].sort());
    const unfiledView = await listDocuments(s.documents, s.owner, { view: 'unfiled' });
    expect(unfiledView.map((d) => d.id)).toEqual([unfiled.id]);
    const projectView = await listDocuments(s.documents, s.owner, { projectId: project.id });
    expect(projectView.map((d) => d.id)).toEqual([filed.id]);
    const archivedView = await listDocuments(s.documents, s.owner, { view: 'archived' });
    expect(archivedView.map((d) => d.id)).toEqual([archived.id]);
  });

  it('getDocument hides soft-deleted and missing documents', async () => {
    const s = setup();
    const doc = s.world.addDocument(s.org.id, {
      title: 'd.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
    });
    expect((await getDocument(s.documents, s.owner, doc.id)).ok).toBe(true);
    await s.documents.softDelete(s.owner.ctx, doc.id, new Date());
    const gone = await getDocument(s.documents, s.owner, doc.id);
    expect(!gone.ok && gone.error.code).toBe('document_not_found');
    const missing = await getDocument(s.documents, s.owner, 'nope' as DocumentId);
    expect(missing.ok).toBe(false);
  });
});

describe('moveDocument', () => {
  it('moves to a project and back to unfiled', async () => {
    const s = setup();
    const project = s.world.addProject(s.org.id, { name: 'P', color: '#6366f1' });
    const doc = s.world.addDocument(s.org.id, {
      title: 'd.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
    });
    expect((await moveDocument(s.documents, s.projects, s.owner, doc.id, project.id)).ok).toBe(
      true,
    );
    expect(s.world.documents.get(doc.id)?.projectId).toBe(project.id);
    expect((await moveDocument(s.documents, s.projects, s.owner, doc.id, null)).ok).toBe(true);
    expect(s.world.documents.get(doc.id)?.projectId).toBeNull();
  });

  it('rejects unknown target project and non-owner movers', async () => {
    const s = setup();
    const doc = s.world.addDocument(s.org.id, {
      title: 'd.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
    });
    const badProject = await moveDocument(
      s.documents,
      s.projects,
      s.owner,
      doc.id,
      'missing' as ProjectId,
    );
    expect(!badProject.ok && badProject.error.code).toBe('project_not_found');
    const denied = await moveDocument(s.documents, s.projects, s.stranger, doc.id, null);
    expect(!denied.ok && denied.error.code).toBe('forbidden');
  });
});

describe('setDocumentArchived', () => {
  it('archives and unarchives for the owner', async () => {
    const s = setup();
    const doc = s.world.addDocument(s.org.id, {
      title: 'd.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
    });
    expect((await setDocumentArchived(s.documents, s.owner, doc.id, true)).ok).toBe(true);
    expect(s.world.documents.get(doc.id)?.archivedAt).not.toBeNull();
    expect((await setDocumentArchived(s.documents, s.owner, doc.id, false)).ok).toBe(true);
    expect(s.world.documents.get(doc.id)?.archivedAt).toBeNull();
  });
});

describe('lifecycle on deleted documents', () => {
  it('archive and delete both 404 after soft delete; missing org errors', async () => {
    const s = setup();
    const doc = s.world.addDocument(s.org.id, {
      title: 'd.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
    });
    await s.documents.softDelete(s.owner.ctx, doc.id, new Date());
    const archived = await setDocumentArchived(s.documents, s.owner, doc.id, true);
    expect(!archived.ok && archived.error.code).toBe('document_not_found');

    const fresh = s.world.addDocument(s.org.id, {
      title: 'e.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
    });
    s.world.orgs.clear();
    const noOrg = await deleteDocument(
      s.documents,
      s.orgs,
      s.storage,
      s.erasures,
      s.owner,
      fresh.id,
    );
    expect(!noOrg.ok && noOrg.error.code).toBe('org_not_found');
  });
});

describe('deleteDocument', () => {
  it('soft-deletes with purge_after from org retention', async () => {
    const s = setup({ retentionDays: 10 });
    const doc = s.world.addDocument(s.org.id, {
      title: 'd.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
    });
    const now = new Date('2026-07-10T00:00:00Z');
    const result = await deleteDocument(
      s.documents,
      s.orgs,
      s.storage,
      s.erasures,
      s.owner,
      doc.id,
      now,
    );
    expect(result.ok && result.value.purged).toBe(false);
    const stored = s.world.documents.get(doc.id);
    expect(stored?.deletedAt).not.toBeNull();
    expect(stored?.purgeAfter).toEqual(new Date('2026-07-20T00:00:00Z'));
  });

  it('purges rows and blobs at once when the org purges immediately', async () => {
    const s = setup({ purgeImmediately: true });
    const doc = s.world.addDocument(s.org.id, {
      title: 'd.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
    });
    await s.storage.put(
      { orgId: s.org.id, documentId: doc.id, seq: 1 },
      new TextEncoder().encode('x'),
    );
    const result = await deleteDocument(
      s.documents,
      s.orgs,
      s.storage,
      s.erasures,
      s.owner,
      doc.id,
    );
    expect(result.ok && result.value.purged).toBe(true);
    expect(s.world.documents.has(doc.id)).toBe(false);
    expect(s.storage.objects.size).toBe(0);
  });

  it('forbids non-owner members and 404s a second delete', async () => {
    const s = setup();
    const doc = s.world.addDocument(s.org.id, {
      title: 'd.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
    });
    const denied = await deleteDocument(
      s.documents,
      s.orgs,
      s.storage,
      s.erasures,
      s.stranger,
      doc.id,
    );
    expect(!denied.ok && denied.error.code).toBe('forbidden');
    await deleteDocument(s.documents, s.orgs, s.storage, s.erasures, s.owner, doc.id);
    const again = await deleteDocument(s.documents, s.orgs, s.storage, s.erasures, s.owner, doc.id);
    expect(!again.ok && again.error.code).toBe('document_not_found');
  });
});

describe('sweepDuePurges', () => {
  it('purges only documents past purge_after, blobs included', async () => {
    const s = setup();
    const due = s.world.addDocument(s.org.id, {
      title: 'due.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
    });
    const notDue = s.world.addDocument(s.org.id, {
      title: 'later.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
    });
    const now = new Date('2026-07-10T00:00:00Z');
    await s.documents.softDelete(s.owner.ctx, due.id, new Date('2026-07-01T00:00:00Z'));
    await s.documents.softDelete(s.owner.ctx, notDue.id, new Date('2026-08-01T00:00:00Z'));
    await s.storage.put(
      { orgId: s.org.id, documentId: due.id, seq: 1 },
      new TextEncoder().encode('x'),
    );

    const purged = await sweepDuePurges(s.sweep, s.storage, s.erasures, now);
    expect(purged).toBe(1);
    expect(s.world.documents.has(due.id)).toBe(false);
    expect(s.world.documents.has(notDue.id)).toBe(true);
    expect(s.storage.objects.size).toBe(0);
  });
});
