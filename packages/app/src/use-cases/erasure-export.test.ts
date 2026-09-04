import { describe, expect, it } from 'vitest';
import type { UserId } from '@mdloop/shared';
import {
  FakeCommentRepository,
  FakeDocumentRepository,
  FakeErasureLog,
  FakeOrganizationRepository,
  FakeShareGrantRepository,
  FakeStorage,
  FakeUploadUnitOfWork,
  FakeVersionRepository,
  FakeWorld,
} from '../test-support/fakes.js';
import type { Actor } from './org-settings.js';
import { uploadNewDocument, uploadNewVersion } from './upload.js';
import { createComment } from './comments.js';
import type { ErasureReplayDeps } from './erasure-replay.js';
import { replayErasures } from './erasure-replay.js';
import { exportOrg } from './export.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const MARKDOWN = '# Spec\n\nRetries back off.\n';

/** Create a live document and pin its createdAt for deterministic keyset order. */
async function makeDoc(
  s: Awaited<ReturnType<typeof setup>>,
  title: string,
  createdAt: Date,
): Promise<string> {
  const up = await uploadNewDocument(s.uow, s.storage, s.admin, {
    title,
    projectId: null,
    content: bytes(`# ${title}`),
    source: 'web',
  });
  if (!up.ok) throw new Error('makeDoc upload');
  const id = up.value.document.id;
  s.world.documents.set(id, { ...s.world.documents.get(id)!, createdAt });
  return id;
}

async function setup() {
  const world = new FakeWorld();
  const org = world.org();
  const admin: Actor = { ctx: { orgId: org.id, userId: 'u1' as UserId }, role: 'admin' };
  const member: Actor = { ctx: { orgId: org.id, userId: 'u2' as UserId }, role: 'member' };
  const storage = new FakeStorage();
  const uow = new FakeUploadUnitOfWork(world);
  const documents = new FakeDocumentRepository(world);
  const versions = new FakeVersionRepository(world);
  const comments = new FakeCommentRepository(world);
  const orgs = new FakeOrganizationRepository(world);
  const grants = new FakeShareGrantRepository(world);
  const erasures = new FakeErasureLog();
  const uploaded = await uploadNewDocument(uow, storage, admin, {
    title: 'spec.md',
    projectId: null,
    content: bytes(MARKDOWN),
    source: 'web',
  });
  if (!uploaded.ok) throw new Error('setup upload');
  const deps: ErasureReplayDeps = { erasures, orgs, documents, versions, storage };
  return {
    world,
    org,
    admin,
    member,
    storage,
    uow,
    documents,
    versions,
    comments,
    orgs,
    grants,
    erasures,
    deps,
    documentId: uploaded.value.document.id,
  };
}

describe('replayErasures', () => {
  it('re-purges resurrected documents and orgs; replay is idempotent', async () => {
    const s = await setup();
    await s.erasures.record({
      kind: 'document_purge',
      orgId: s.org.id,
      documentId: s.documentId,
    });

    const first = await replayErasures(s.deps);
    expect(first).toEqual({
      eventsReplayed: 1,
      orgsPurged: 0,
      documentsPurged: 1,
      versionsPurged: 0,
    });
    expect(s.world.documents.has(s.documentId)).toBe(false);
    expect(s.storage.objects.size).toBe(0);

    // Idempotent: the document is already gone.
    const second = await replayErasures(s.deps);
    expect(second.documentsPurged).toBe(0);

    await s.erasures.record({ kind: 'org_purge', orgId: s.org.id });
    const third = await replayErasures(s.deps);
    expect(third.orgsPurged).toBe(1);
    expect(s.world.orgs.has(s.org.id)).toBe(false);
    expect((await replayErasures(s.deps)).orgsPurged).toBe(0);
  });

  it('re-tombstones resurrected versions, skipping already-tombstoned ones', async () => {
    const s = await setup();
    const next = await uploadNewVersion(s.uow, s.storage, s.admin, {
      documentId: s.documentId,
      content: bytes('v2'),
      source: 'web',
    });
    if (!next.ok) throw new Error('setup version');
    await s.erasures.record({
      kind: 'version_purge',
      orgId: s.org.id,
      documentId: s.documentId,
      versionSeq: 1,
    });

    const report = await replayErasures(s.deps);
    expect(report.versionsPurged).toBe(1);
    const versions = await s.versions.listForDocument(s.admin.ctx, s.documentId);
    expect(versions.find((v) => v.seq === 1)?.purgedAt).not.toBeNull();
    expect(versions.find((v) => v.seq === 2)?.purgedAt).toBeNull();
    // Already tombstoned: nothing new on replay.
    expect((await replayErasures(s.deps)).versionsPurged).toBe(0);
  });
});

describe('exportOrg', () => {
  it('exports markdown + comments with replies; admin only', async () => {
    const s = await setup();
    const comment = await createComment(s.documents, s.comments, s.orgs, s.grants, s.admin, {
      documentId: s.documentId,
      body: 'please check',
      anchor: { type: 'document' },
    });
    if (!comment.ok) throw new Error('setup comment');
    await s.comments.addReply(s.admin.ctx, {
      parentReplyId: null,
      commentId: comment.value.id,
      body: 'on it',
      authorId: s.admin.ctx.userId,
    });

    const denied = await exportOrg(
      s.orgs,
      s.documents,
      s.versions,
      s.comments,
      s.storage,
      s.member,
    );
    expect(!denied.ok && denied.error.code).toBe('forbidden');

    const result = await exportOrg(s.orgs, s.documents, s.versions, s.comments, s.storage, s.admin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.orgName).toBe('Acme');
    const doc = result.value.documents.find((d) => d.id === s.documentId);
    expect(doc?.markdown).toBe(MARKDOWN);
    expect(doc?.comments[0]).toMatchObject({
      body: 'please check',
      versionSeq: 1,
      replies: [{ body: 'on it' }],
    });
  });

  it('exports a text comment quote and null markdown for purged versions', async () => {
    const s = await setup();
    const quote = 'Retries back off.';
    const start = MARKDOWN.indexOf(quote);
    const comment = await createComment(s.documents, s.comments, s.orgs, s.grants, s.admin, {
      documentId: s.documentId,
      body: 'about this line',
      anchor: {
        type: 'text',
        exact: quote,
        prefix: MARKDOWN.slice(Math.max(0, start - 8), start),
        suffix: '',
        start,
        end: start + quote.length,
      },
    });
    if (!comment.ok) throw new Error('setup comment');
    // Purge the only version's blob: markdown must export as null, quote survives.
    const versions = await s.versions.listForDocument(s.admin.ctx, s.documentId);
    await s.versions.tombstone(s.admin.ctx, versions[0]!.id);
    await s.storage.delete({ orgId: s.org.id, documentId: s.documentId, seq: 1 });

    const result = await exportOrg(s.orgs, s.documents, s.versions, s.comments, s.storage, s.admin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.documents.find((d) => d.id === s.documentId);
    expect(doc?.markdown).toBeNull();
    expect(doc?.comments[0]?.quote).toBe(quote);
    // Version row survives the blob purge and is flagged in the metadata.
    expect(doc?.versions).toEqual([expect.objectContaining({ seq: 1, purged: true })]);
  });

  it('errors when the org row is unreadable', async () => {
    const s = await setup();
    s.world.orgs.delete(s.org.id);
    const result = await exportOrg(s.orgs, s.documents, s.versions, s.comments, s.storage, s.admin);
    expect(!result.ok && result.error.code).toBe('org_not_found');
  });

  it('exports a null versionSeq when the pinned version row is unavailable', async () => {
    const s = await setup();
    const comment = await createComment(s.documents, s.comments, s.orgs, s.grants, s.admin, {
      documentId: s.documentId,
      body: 'orphaned pin',
      anchor: { type: 'document' },
    });
    if (!comment.ok) throw new Error('setup comment');
    // Version rows never actually disappear (ADR 0001 tombstones); this
    // simulates the defensive fallback for a comment whose pinned version id
    // the lookup can't resolve.
    s.world.versions.delete(comment.value.versionId);

    const result = await exportOrg(s.orgs, s.documents, s.versions, s.comments, s.storage, s.admin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.documents.find((d) => d.id === s.documentId);
    expect(doc?.comments[0]?.versionSeq).toBeNull();
  });

  it('exports every version as metadata, carrying the change_note', async () => {
    const s = await setup();
    const v2 = await uploadNewVersion(s.uow, s.storage, s.admin, {
      documentId: s.documentId,
      content: bytes('# Spec v2\n'),
      source: 'web',
      changeNote: 'tightened the retry budget',
    });
    if (!v2.ok) throw new Error('setup v2');

    const result = await exportOrg(s.orgs, s.documents, s.versions, s.comments, s.storage, s.admin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.documents.find((d) => d.id === s.documentId);
    expect(doc?.versions).toEqual([
      expect.objectContaining({ seq: 1, source: 'web', changeNote: null, purged: false }),
      expect.objectContaining({
        seq: 2,
        source: 'web',
        changeNote: 'tightened the retry budget',
        purged: false,
      }),
    ]);
  });

  it('groups batched replies onto the right comment, never crossing threads', async () => {
    const s = await setup();
    const first = await createComment(s.documents, s.comments, s.orgs, s.grants, s.admin, {
      documentId: s.documentId,
      body: 'first',
      anchor: { type: 'document' },
    });
    const second = await createComment(s.documents, s.comments, s.orgs, s.grants, s.admin, {
      documentId: s.documentId,
      body: 'second',
      anchor: { type: 'document' },
    });
    if (!first.ok || !second.ok) throw new Error('setup comments');
    await s.comments.addReply(s.admin.ctx, {
      parentReplyId: null,
      commentId: first.value.id,
      body: 'reply-to-first',
      authorId: s.admin.ctx.userId,
    });
    await s.comments.addReply(s.admin.ctx, {
      parentReplyId: null,
      commentId: second.value.id,
      body: 'reply-to-second',
      authorId: s.admin.ctx.userId,
    });

    const result = await exportOrg(s.orgs, s.documents, s.versions, s.comments, s.storage, s.admin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.documents.find((d) => d.id === s.documentId);
    const byBody = new Map(doc?.comments.map((c) => [c.body, c]));
    expect(byBody.get('first')?.replies.map((r) => r.body)).toEqual(['reply-to-first']);
    expect(byBody.get('second')?.replies.map((r) => r.body)).toEqual(['reply-to-second']);
  });

  it('exports an empty org as a single empty page', async () => {
    const world = new FakeWorld();
    const org = world.org();
    const admin: Actor = { ctx: { orgId: org.id, userId: 'u1' as UserId }, role: 'admin' };
    const result = await exportOrg(
      new FakeOrganizationRepository(world),
      new FakeDocumentRepository(world),
      new FakeVersionRepository(world),
      new FakeCommentRepository(world),
      new FakeStorage(),
      admin,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.documents).toEqual([]);
    expect(result.value.nextCursor).toBeNull();
  });

  it('pages by keyset with a cursor stable across calls', async () => {
    const s = await setup();
    const base = Date.UTC(2026, 0, 1);
    // Pin the setup doc first, then four more — ascending (createdAt, id) order.
    s.world.documents.set(s.documentId, {
      ...s.world.documents.get(s.documentId)!,
      createdAt: new Date(base),
    });
    const ids: string[] = [s.documentId];
    for (let i = 1; i < 5; i += 1) {
      ids.push(await makeDoc(s, `doc-${i}.md`, new Date(base + i * 1000)));
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const r = await exportOrg(s.orgs, s.documents, s.versions, s.comments, s.storage, s.admin, {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      pages += 1;
      expect(r.value.documents.length).toBeLessThanOrEqual(2);
      seen.push(...r.value.documents.map((d) => d.id));
      if (!r.value.nextCursor) break;
      cursor = r.value.nextCursor;
      if (pages > 10) throw new Error('runaway pagination');
    }
    // Full coverage, correct order, no duplicates or gaps across pages.
    expect(seen).toEqual(ids);
    expect(pages).toBe(3);
  });

  it('returns a null nextCursor on an exact final page boundary', async () => {
    const s = await setup();
    const base = Date.UTC(2026, 0, 1);
    s.world.documents.set(s.documentId, {
      ...s.world.documents.get(s.documentId)!,
      createdAt: new Date(base),
    });
    await makeDoc(s, 'doc-2.md', new Date(base + 1000));
    await makeDoc(s, 'doc-3.md', new Date(base + 2000));
    await makeDoc(s, 'doc-4.md', new Date(base + 3000));

    const p1 = await exportOrg(s.orgs, s.documents, s.versions, s.comments, s.storage, s.admin, {
      limit: 2,
    });
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    expect(p1.value.documents).toHaveLength(2);
    expect(p1.value.nextCursor).not.toBeNull();

    // Second page fills exactly to the end: no dangling extra page.
    const p2 = await exportOrg(s.orgs, s.documents, s.versions, s.comments, s.storage, s.admin, {
      limit: 2,
      cursor: p1.value.nextCursor!,
    });
    expect(p2.ok).toBe(true);
    if (!p2.ok) return;
    expect(p2.value.documents).toHaveLength(2);
    expect(p2.value.nextCursor).toBeNull();
  });

  it('caps an oversized limit and floors a non-positive one', async () => {
    const s = await setup();
    const huge = await exportOrg(s.orgs, s.documents, s.versions, s.comments, s.storage, s.admin, {
      limit: 10_000,
    });
    expect(huge.ok && huge.value.documents.length).toBe(1);
    const zero = await exportOrg(s.orgs, s.documents, s.versions, s.comments, s.storage, s.admin, {
      limit: 0,
    });
    // Floored to 1 — still returns the single document (no next page).
    expect(zero.ok && zero.value.documents.length).toBe(1);
    expect(zero.ok && zero.value.nextCursor).toBeNull();
  });
});
