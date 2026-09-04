import { describe, expect, it } from 'vitest';
import { createTextAnchor } from '@mdloop/domain';
import type { Anchor } from '@mdloop/domain';
import type { UserId } from '@mdloop/shared';
import {
  FakeAnchorResolutionRepository,
  FakeCommentRepository,
  FakeDocumentRepository,
  FakeOrganizationRepository,
  FakeReviewRepository,
  FakeShareGrantRepository,
  FakeStorage,
  FakeUploadUnitOfWork,
  FakeVersionRepository,
  FakeWorld,
} from '../test-support/fakes.js';
import type { Actor } from './org-settings.js';
import type { DocumentRepository } from '../ports/repositories.port.js';
import { createComment, resolveComment } from './comments.js';
import { uploadNewDocument, uploadNewVersion } from './upload.js';
import { getFeedbackBundle } from './feedback-bundle.js';

const V1 = `# Doc

The payment flow retries twice before failing.
`;

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

async function setup() {
  const world = new FakeWorld();
  const org = world.org();
  const owner: Actor = { ctx: { orgId: org.id, userId: 'owner' as UserId }, role: 'member' };
  const stranger: Actor = { ctx: { orgId: org.id, userId: 'stranger' as UserId }, role: 'member' };
  const documents = new FakeDocumentRepository(world);
  const comments = new FakeCommentRepository(world);
  const orgs = new FakeOrganizationRepository(world);
  const versions = new FakeVersionRepository(world);
  const resolutions = new FakeAnchorResolutionRepository();
  const storage = new FakeStorage();
  const grants = new FakeShareGrantRepository(world);
  const reviews = new FakeReviewRepository(world);
  const uow = new FakeUploadUnitOfWork(world);
  const uploaded = await uploadNewDocument(uow, storage, owner, {
    title: 'doc.md',
    projectId: null,
    content: bytes(V1),
    source: 'web',
  });
  if (!uploaded.ok) throw new Error('setup upload');
  return {
    world,
    owner,
    stranger,
    documents,
    comments,
    versions,
    resolutions,
    storage,
    grants,
    orgs,
    reviews,
    uow,
    documentId: uploaded.value.document.id,
  };
}

function textAnchor(quote: string): Anchor {
  const start = V1.indexOf(quote);
  return createTextAnchor(V1, start, start + quote.length);
}

function bundle(s: Awaited<ReturnType<typeof setup>>, actor: Actor = s.owner) {
  return getFeedbackBundle(
    s.documents,
    s.comments,
    s.versions,
    s.resolutions,
    s.storage,
    s.grants,
    s.reviews,
    s.orgs,
    actor,
    s.documentId,
  );
}

describe('getFeedbackBundle', () => {
  it('returns only unresolved comments, quoted against the current version', async () => {
    const s = await setup();
    const open = await createComment(s.documents, s.comments, s.orgs, s.grants, s.owner, {
      documentId: s.documentId,
      body: 'please clarify',
      anchor: textAnchor('retries twice'),
    });
    if (!open.ok) throw new Error('setup comment');
    const resolved = await createComment(s.documents, s.comments, s.orgs, s.grants, s.owner, {
      documentId: s.documentId,
      body: 'already handled',
      anchor: { type: 'document' },
    });
    if (!resolved.ok) throw new Error('setup comment');
    await resolveComment(s.documents, s.comments, s.owner, resolved.value.id);

    const result = await bundle(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.openCount).toBe(1);
    expect(result.value.items).toHaveLength(1);
    expect(result.value.items[0]).toMatchObject({
      commentId: open.value.id,
      body: 'please clarify',
      quote: 'retries twice',
      anchorState: { kind: 'anchored', method: 'exact', confidence: 1 },
    });
    expect(result.value.prompt).toContain('please clarify');
    expect(result.value.prompt).toContain('upload_document');
  });

  it('surfaces suggestionOutcome null for a plain comment, "open" for an open suggestion', async () => {
    const s = await setup();
    const plain = await createComment(s.documents, s.comments, s.orgs, s.grants, s.owner, {
      documentId: s.documentId,
      body: 'just a note',
      anchor: { type: 'document' },
    });
    if (!plain.ok) throw new Error('setup comment');
    const suggestion = await createComment(s.documents, s.comments, s.orgs, s.grants, s.owner, {
      documentId: s.documentId,
      body: 'replace it',
      anchor: textAnchor('retries twice'),
      proposedText: 'gives up once',
    });
    if (!suggestion.ok) throw new Error('setup suggestion');

    const result = await bundle(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plainItem = result.value.items.find((i) => i.commentId === plain.value.id);
    const suggestionItem = result.value.items.find((i) => i.commentId === suggestion.value.id);
    expect(plainItem?.suggestionOutcome).toBeNull();
    expect(suggestionItem?.suggestionOutcome).toBe('open');
    expect(result.value.prompt).toContain('Suggested replacement: gives up once');
  });

  it('an accepted-but-unapplied suggestion surfaces the apply-it-yourself prompt line (ADR 0007)', async () => {
    const s = await setup();
    const suggestion = await createComment(s.documents, s.comments, s.orgs, s.grants, s.owner, {
      documentId: s.documentId,
      body: 'replace it',
      anchor: textAnchor('retries twice'),
      proposedText: 'gives up once',
    });
    if (!suggestion.ok) throw new Error('setup suggestion');
    await s.comments.setSuggestionOutcome(s.owner.ctx, suggestion.value.id, 'accepted', null);

    const result = await bundle(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.value.items.find((i) => i.commentId === suggestion.value.id);
    expect(item?.suggestionOutcome).toBe('accepted');
    expect(result.value.prompt).toContain(
      'Suggested replacement — ACCEPTED, not yet applied to the source: gives up once.',
    );
    expect(result.value.prompt).toContain('apply this text at the anchored location');
  });

  it('includes replies and marks orphaned quotes', async () => {
    const s = await setup();
    const comment = await createComment(s.documents, s.comments, s.orgs, s.grants, s.owner, {
      documentId: s.documentId,
      body: 'fix this',
      anchor: { type: 'diagram', blockIndex: 0, kind: 'node', stableId: 'B' },
    });
    if (!comment.ok) throw new Error('setup comment');
    await s.comments.addReply(s.owner.ctx, {
      parentReplyId: null,
      commentId: comment.value.id,
      authorId: s.owner.ctx.userId,
      body: 'working on it',
    });

    const result = await bundle(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items[0]).toMatchObject({
      quote: 'diagram node B',
      replies: [{ body: 'working on it', mine: true, depth: 1 }],
    });
  });

  it('renders document anchors, occurrence-based diagram ids and the orphan note', async () => {
    const s = await setup();
    const whole = await createComment(s.documents, s.comments, s.orgs, s.grants, s.owner, {
      documentId: s.documentId,
      body: 'overall shape',
      anchor: { type: 'document' },
    });
    if (!whole.ok) throw new Error('setup comment');
    const occurrence = await createComment(s.documents, s.comments, s.orgs, s.grants, s.owner, {
      documentId: s.documentId,
      body: 'this message',
      anchor: {
        type: 'diagram',
        blockIndex: 0,
        kind: 'message',
        stableId: { text: 'ok', index: 1 },
      },
    });
    if (!occurrence.ok) throw new Error('setup comment');
    const doomed = await createComment(s.documents, s.comments, s.orgs, s.grants, s.owner, {
      documentId: s.documentId,
      body: 'about a vanished line',
      anchor: textAnchor('retries twice'),
    });
    if (!doomed.ok) throw new Error('setup comment');
    // New version drops the quoted text entirely: the text comment orphans.
    const next = await uploadNewVersion(s.uow, s.storage, s.owner, {
      documentId: s.documentId,
      content: bytes('# Rewritten\n\nNothing from before survives here.\n'),
      source: 'web',
    });
    if (!next.ok) throw new Error('setup version');

    const result = await bundle(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byBody = new Map(result.value.items.map((i) => [i.body, i]));
    expect(byBody.get('overall shape')?.quote).toBe('(whole document)');
    expect(byBody.get('this message')?.quote).toBe('diagram message message #2 "ok"');
    expect(byBody.get('about a vanished line')?.anchorState).toEqual({ kind: 'orphaned' });
    expect(result.value.prompt).toContain('no longer exists in the current version');
  });

  it('computes the 1-based line of a text quote on the current version', async () => {
    const s = await setup();
    const c = await createComment(s.documents, s.comments, s.orgs, s.grants, s.owner, {
      documentId: s.documentId,
      body: 'clarify',
      anchor: textAnchor('retries twice'),
    });
    if (!c.ok) throw new Error('setup comment');
    const result = await bundle(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // "retries twice" sits on the third line of V1.
    expect(result.value.items[0]?.location).toMatchObject({ line: 3 });
    expect(result.value.prompt).toContain('(line 3)');
  });

  it('leaves location null for document anchors and orphans', async () => {
    const s = await setup();
    const whole = await createComment(s.documents, s.comments, s.orgs, s.grants, s.owner, {
      documentId: s.documentId,
      body: 'overall',
      anchor: { type: 'document' },
    });
    if (!whole.ok) throw new Error('setup comment');
    const result = await bundle(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items[0]?.location).toBeNull();
  });

  it('orders items by upvotes desc, keeping document position as the tiebreak', async () => {
    const s = await setup();
    const first = await createComment(s.documents, s.comments, s.orgs, s.grants, s.owner, {
      documentId: s.documentId,
      body: 'first, no votes',
      anchor: { type: 'document' },
    });
    const second = await createComment(s.documents, s.comments, s.orgs, s.grants, s.owner, {
      documentId: s.documentId,
      body: 'second, two votes',
      anchor: { type: 'document' },
    });
    if (!first.ok || !second.ok) throw new Error('setup comment');
    await s.comments.toggleUpvote(s.owner.ctx, second.value.id, s.owner.ctx.userId);
    await s.comments.toggleUpvote(s.owner.ctx, second.value.id, s.stranger.ctx.userId);

    const result = await bundle(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((i) => i.body)).toEqual(['second, two votes', 'first, no votes']);
    expect(result.value.items[0]?.upvotes).toBe(2);
    expect(result.value.prompt).toContain('Upvotes: 2');
    expect(result.value.prompt).toContain('higher priority');
  });

  it('attributes replies with mine and nesting depth', async () => {
    const s = await setup();
    const c = await createComment(s.documents, s.comments, s.orgs, s.grants, s.owner, {
      documentId: s.documentId,
      body: 'root',
      anchor: { type: 'document' },
    });
    if (!c.ok) throw new Error('setup comment');
    const r1 = await s.comments.addReply(s.owner.ctx, {
      commentId: c.value.id,
      parentReplyId: null,
      authorId: s.owner.ctx.userId,
      body: 'mine at depth 1',
    });
    await s.comments.addReply(s.owner.ctx, {
      commentId: c.value.id,
      parentReplyId: r1.id,
      authorId: s.stranger.ctx.userId,
      body: 'theirs at depth 2',
    });

    const result = await bundle(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items[0]?.replies).toEqual([
      { body: 'mine at depth 1', mine: true, depth: 1 },
      { body: 'theirs at depth 2', mine: false, depth: 2 },
    ]);
    expect(result.value.prompt).toContain('Reply: mine at depth 1 (you)');
    expect(result.value.prompt).toContain('  Reply: theirs at depth 2');
  });

  it('a prompt-ready message when nothing is open', async () => {
    const s = await setup();
    const result = await bundle(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.openCount).toBe(0);
    expect(result.value.prompt).toContain('No unresolved feedback');
  });

  it('requires read access; unknown documents read as not-found', async () => {
    const s = await setup();
    const denied = await bundle(s, s.stranger);
    expect(!denied.ok && denied.error.code).toBe('document_not_found');
  });

  it('propagates no_version for a document with no uploaded content yet', async () => {
    const s = await setup();
    s.world.documents.set(s.documentId, {
      ...s.world.documents.get(s.documentId)!,
      currentVersionId: null,
    });
    const result = await bundle(s);
    expect(!result.ok && result.error.code).toBe('no_version');
  });

  it('throws on corrupted state: the version row for the current version is gone', async () => {
    const s = await setup();
    const document = s.world.documents.get(s.documentId)!;
    s.world.versions.delete(document.currentVersionId!);
    await expect(bundle(s)).rejects.toThrow('version row missing for current version');
  });

  it('throws when the access-check read of the document races ahead of a version landing', async () => {
    // requireDocumentAccess and listThreadsWithResolutions each read the
    // document independently; this simulates a version appearing between
    // the two reads so the first (access-check) snapshot is stale.
    const s = await setup();
    let calls = 0;
    const staleDocuments: DocumentRepository = {
      create: s.documents.create.bind(s.documents),
      list: s.documents.list.bind(s.documents),
      listForExport: s.documents.listForExport.bind(s.documents),
      overviewPage: s.documents.overviewPage.bind(s.documents),
      overviewCounts: s.documents.overviewCounts.bind(s.documents),
      countLiveInProject: s.documents.countLiveInProject.bind(s.documents),
      activeCount: s.documents.activeCount.bind(s.documents),
      activeCountInProject: s.documents.activeCountInProject.bind(s.documents),
      listProjectIndex: s.documents.listProjectIndex.bind(s.documents),
      documentIdAtPath: s.documents.documentIdAtPath.bind(s.documents),
      moveToProject: s.documents.moveToProject.bind(s.documents),
      setArchived: s.documents.setArchived.bind(s.documents),
      softDelete: s.documents.softDelete.bind(s.documents),
      purge: s.documents.purge.bind(s.documents),
      byId: async (ctx, id) => {
        calls += 1;
        const real = await s.documents.byId(ctx, id);
        return calls === 1 && real ? { ...real, currentVersionId: null } : real;
      },
    };
    await expect(
      getFeedbackBundle(
        staleDocuments,
        s.comments,
        s.versions,
        s.resolutions,
        s.storage,
        s.grants,
        s.reviews,
        s.orgs,
        s.owner,
        s.documentId,
      ),
    ).rejects.toThrow('document has no current version after resolution succeeded');
  });
});
