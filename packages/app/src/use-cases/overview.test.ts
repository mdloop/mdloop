import { describe, expect, it } from 'vitest';
import type { DocumentId, UserId } from '@vorlyn/shared';
import {
  FakeCommentRepository,
  FakeDocumentRepository,
  FakeProjectRepository,
  FakeReviewRepository,
  FakeShareGrantRepository,
  FakeWorld,
} from '../test-support/fakes.js';
import type { Actor } from './org-settings.js';
import type { OverviewLane, OverviewPage } from './overview.js';
import { homeOverview } from './overview.js';

function setup() {
  const world = new FakeWorld();
  const org = world.org();
  const admin: Actor = { ctx: { orgId: org.id, userId: 'admin' as UserId }, role: 'admin' };
  const member: Actor = { ctx: { orgId: org.id, userId: 'member' as UserId }, role: 'member' };
  const grants = new FakeShareGrantRepository(world);
  const s = {
    world,
    org,
    admin,
    member,
    documents: new FakeDocumentRepository(world, grants),
    projects: new FakeProjectRepository(world),
    comments: new FakeCommentRepository(world),
    grants,
    reviews: new FakeReviewRepository(world),
  };
  return s;
}

/** The homeOverview call, threading this setup's repositories (Phase 24.F signature). */
function run(s: ReturnType<typeof setup>, actor: Actor, lane?: OverviewLane, page?: OverviewPage) {
  return homeOverview(s.documents, s.projects, s.reviews, actor, lane, page);
}

function addDoc(
  s: ReturnType<typeof setup>,
  title: string,
  opts: {
    ownerId?: UserId;
    projectId?: string | null;
    createdAt?: string;
    archived?: boolean;
  } = {},
): DocumentId {
  const doc = s.world.addDocument(s.org.id, {
    title,
    projectId: (opts.projectId ?? null) as never,
    ownerId: opts.ownerId ?? s.admin.ctx.userId,
  });
  s.world.documents.set(doc.id, {
    ...doc,
    createdAt: new Date(opts.createdAt ?? '2026-07-01T00:00:00Z'),
    archivedAt: opts.archived ? new Date('2026-07-10T00:00:00Z') : null,
  });
  return doc.id;
}

async function comment(
  s: ReturnType<typeof setup>,
  documentId: DocumentId,
  createdAt: string,
  status: 'open' | 'resolved' = 'open',
): Promise<void> {
  const c = await s.comments.create(s.admin.ctx, {
    documentId,
    versionId: 'v1' as never,
    body: 'note',
    anchor: { type: 'document' },
    authorId: s.admin.ctx.userId,
  });
  s.world.comments.set(c.id, {
    ...c,
    status,
    createdAt: new Date(createdAt),
    resolvedBy: status === 'resolved' ? s.admin.ctx.userId : null,
    resolvedAt: status === 'resolved' ? new Date(createdAt) : null,
  });
}

describe('homeOverview', () => {
  it('sorts by last activity, newest first, with counts attached', async () => {
    const s = setup();
    const quiet = addDoc(s, 'quiet.md', { createdAt: '2026-07-05T00:00:00Z' });
    const busy = addDoc(s, 'busy.md', { createdAt: '2026-07-01T00:00:00Z' });
    await comment(s, busy, '2026-07-08T00:00:00Z');
    await comment(s, busy, '2026-07-02T00:00:00Z', 'resolved');

    const o = await run(s, s.admin);
    expect(o.documents.map((d) => d.document.id)).toEqual([busy, quiet]);
    expect(o.documents[0]).toMatchObject({ open: 1, resolved: 1 });
    expect(o.documents[0]?.lastActivityAt.toISOString()).toBe('2026-07-08T00:00:00.000Z');
    expect(o.counts).toEqual({ all: 2, unfiled: 2, archived: 0 });
  });

  it('scopes documents, counts and signals to what a member can open', async () => {
    const s = setup();
    const project = s.world.addProject(s.org.id, { name: 'Ops', color: '#0e7490' });
    const mine = addDoc(s, 'mine.md', { ownerId: s.member.ctx.userId, projectId: project.id });
    const theirs = addDoc(s, 'theirs.md', { projectId: project.id });
    await comment(s, mine, '2026-07-03T00:00:00Z');
    await comment(s, theirs, '2026-07-04T00:00:00Z');

    const o = await run(s, s.member);
    expect(o.documents.map((d) => d.document.id)).toEqual([mine]);
    expect(o.counts.all).toBe(1);
    // The inaccessible document's open comment never leaks into the signal.
    expect(o.openByProject).toEqual([{ projectId: project.id, open: 1 }]);
  });

  it('includes a member-granted document in the page and signals', async () => {
    const s = setup();
    const project = s.world.addProject(s.org.id, { name: 'Ops', color: '#0e7490' });
    const shared = addDoc(s, 'shared.md', { projectId: project.id });
    await comment(s, shared, '2026-07-06T00:00:00Z');
    await s.grants.create(s.member.ctx, {
      subject: { type: 'document', id: shared },
      grantee: { type: 'user', userId: s.member.ctx.userId },
      permission: 'comment',
      tokenHash: null,
      createdBy: s.admin.ctx.userId,
    });

    const o = await run(s, s.member);
    expect(o.documents.map((d) => d.document.id)).toEqual([shared]);
    expect(o.openByProject).toEqual([{ projectId: project.id, open: 1 }]);
  });

  it('breaks activity ties deterministically by document id', async () => {
    const s = setup();
    const a = addDoc(s, 'a.md', { createdAt: '2026-07-01T00:00:00Z' });
    const b = addDoc(s, 'b.md', { createdAt: '2026-07-01T00:00:00Z' });
    const o = await run(s, s.admin);
    const expected = [a, b].sort((x, y) => y.localeCompare(x));
    expect(o.documents.map((d) => d.document.id)).toEqual(expected);
  });

  it('serves lanes: project, unfiled and archived', async () => {
    const s = setup();
    const project = s.world.addProject(s.org.id, { name: 'Ops', color: '#0e7490' });
    const inProject = addDoc(s, 'a.md', { projectId: project.id });
    const unfiled = addDoc(s, 'b.md');
    const archived = addDoc(s, 'c.md', { archived: true });

    const p = await run(s, s.admin, { projectId: project.id });
    expect(p.documents.map((d) => d.document.id)).toEqual([inProject]);
    const u = await run(s, s.admin, { view: 'unfiled' });
    expect(u.documents.map((d) => d.document.id)).toEqual([unfiled]);
    const a = await run(s, s.admin, { view: 'archived' });
    expect(a.documents.map((d) => d.document.id)).toEqual([archived]);
    expect(a.counts.archived).toBe(1);
  });

  it('pages with a stable keyset cursor', async () => {
    const s = setup();
    const ids = [1, 2, 3, 4, 5].map((n) =>
      addDoc(s, `d${String(n)}.md`, { createdAt: `2026-07-0${String(n)}T00:00:00Z` }),
    );

    const page1 = await run(s, s.admin, {}, { limit: 2 });
    expect(page1.documents).toHaveLength(2);
    expect(page1.documents.map((d) => d.document.id)).toEqual([ids[4], ids[3]]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await run(
      s,
      s.admin,
      {},
      { limit: 2, ...(page1.nextCursor ? { cursor: page1.nextCursor } : {}) },
    );
    expect(page2.documents.map((d) => d.document.id)).toEqual([ids[2], ids[1]]);

    const page3 = await run(
      s,
      s.admin,
      {},
      { limit: 2, ...(page2.nextCursor ? { cursor: page2.nextCursor } : {}) },
    );
    expect(page3.documents.map((d) => d.document.id)).toEqual([ids[0]]);
    expect(page3.nextCursor).toBeNull();
  });

  it('returns an empty page when the cursor is past the end', async () => {
    const s = setup();
    addDoc(s, 'only.md');
    const page1 = await run(s, s.admin, {}, { limit: 1 });
    expect(page1.nextCursor).toBeNull();
    // Re-using a position past every row as a cursor: nothing sorts after it.
    const drained = await run(
      s,
      s.admin,
      {},
      { cursor: Buffer.from(`0:00000000-0000-0000-0000-000000000000`).toString('base64url') },
    );
    expect(drained.documents).toHaveLength(0);
    expect(drained.nextCursor).toBeNull();
  });

  it('treats a malformed cursor as the first page', async () => {
    const s = setup();
    addDoc(s, 'only.md');
    const o = await run(s, s.admin, {}, { cursor: '???not-base64url???' });
    expect(o.documents).toHaveLength(1);
  });
});
