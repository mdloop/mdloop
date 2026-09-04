import { describe, expect, it } from 'vitest';
import type { Anchor } from '@mdloop/domain';
import type { CommentId, DocumentId, UserId, VersionId } from '@mdloop/shared';
import {
  FakeCommentRepository,
  FakeDocumentRepository,
  FakeOrganizationRepository,
  FakeShareGrantRepository,
  FakeWorld,
} from '../test-support/fakes.js';
import type { GrantId } from '@mdloop/shared';
import type { Actor } from './org-settings.js';
import { MAX_COMMENT_BODY_LENGTH, MAX_PROPOSED_TEXT_LENGTH } from '@mdloop/domain';
import {
  addReply,
  createComment,
  deleteComment,
  editComment,
  listCommentThreads,
  resolveComment,
  toggleCommentUpvote,
} from './comments.js';

const docAnchor: Anchor = { type: 'document' };

function setup() {
  const world = new FakeWorld();
  const org = world.org();
  const owner: Actor = { ctx: { orgId: org.id, userId: 'owner' as UserId }, role: 'member' };
  const member: Actor = { ctx: { orgId: org.id, userId: 'member' as UserId }, role: 'member' };
  const admin: Actor = { ctx: { orgId: org.id, userId: 'admin' as UserId }, role: 'admin' };
  const document = world.addDocument(org.id, {
    title: 'doc.md',
    projectId: null,
    ownerId: owner.ctx.userId,
  });
  world.documents.set(document.id, { ...document, currentVersionId: 'v1' as VersionId });
  const grants = new FakeShareGrantRepository(world);
  // The comment use-cases now self-defend (Phase 24): a caller needs comment
  // access on the document. `member` is neither owner nor admin, so grant it a
  // comment share here; the owner/admin paths hold 'edit' intrinsically.
  grants.grants.set('grant-member' as GrantId, {
    id: 'grant-member' as GrantId,
    orgId: org.id,
    subject: { type: 'document', id: document.id },
    grantee: { type: 'user', userId: member.ctx.userId },
    permission: 'comment',
    tokenHash: null,
    expiresAt: null,
    granteeEmail: null,
    createdBy: owner.ctx.userId,
    createdAt: new Date(),
    revokedAt: null,
  });
  return {
    world,
    org,
    owner,
    member,
    admin,
    documentId: document.id,
    documents: new FakeDocumentRepository(world),
    comments: new FakeCommentRepository(world),
    orgs: new FakeOrganizationRepository(world),
    grants,
  };
}

describe('createComment', () => {
  it('pins the comment to the current version', async () => {
    const s = setup();
    const result = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: '  needs detail  ',
      anchor: docAnchor,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.versionId).toBe('v1');
    expect(result.value.body).toBe('needs detail');
    expect(result.value.status).toBe('open');
  });

  it('rejects empty bodies and invalid anchors', async () => {
    const s = setup();
    const empty = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: '   ',
      anchor: docAnchor,
    });
    expect(!empty.ok && empty.error.code).toBe('empty_body');
    const bad = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'x',
      anchor: { type: 'text', exact: '', prefix: '', suffix: '', start: 0, end: 0 },
    });
    expect(!bad.ok && bad.error.code).toBe('invalid_anchor');
  });

  it('rejects a body over the max length, accepts one at the boundary', async () => {
    const s = setup();
    const tooLong = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'x'.repeat(MAX_COMMENT_BODY_LENGTH + 1),
      anchor: docAnchor,
    });
    expect(!tooLong.ok && tooLong.error.code).toBe('body_too_long');
    const atLimit = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'x'.repeat(MAX_COMMENT_BODY_LENGTH),
      anchor: docAnchor,
    });
    expect(atLimit.ok).toBe(true);
  });

  it('404s missing documents and refuses documents without a version', async () => {
    const s = setup();
    const missing = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: 'nope' as DocumentId,
      body: 'x',
      anchor: docAnchor,
    });
    expect(!missing.ok && missing.error.code).toBe('document_not_found');

    const bare = s.world.addDocument(s.org.id, {
      title: 'empty.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
    });
    // The owner holds intrinsic access to the bare doc; a member without a
    // grant would 404 at the access gate before ever seeing no_version.
    const noVersion = await createComment(s.documents, s.comments, s.orgs, s.grants, s.owner, {
      documentId: bare.id,
      body: 'x',
      anchor: docAnchor,
    });
    expect(!noVersion.ok && noVersion.error.code).toBe('no_version');
  });

  it('blocks the 101st comment on the free tier, never on team', async () => {
    const s = setup();
    s.world.orgs.set(s.org.id, { ...s.org, tier: 'free' });
    for (let i = 0; i < 100; i++) {
      const r = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
        documentId: s.documentId,
        body: `note ${String(i)}`,
        anchor: docAnchor,
      });
      if (!r.ok) throw new Error('setup comment');
    }
    const capped = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'over',
      anchor: docAnchor,
    });
    expect(!capped.ok && capped.error).toEqual({ code: 'comment_cap_exceeded', limit: 100 });

    s.world.orgs.set(s.org.id, { ...s.org, tier: 'team' });
    const allowed = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'over',
      anchor: docAnchor,
    });
    expect(allowed.ok).toBe(true);
  });

  it('errors when the org row is unreadable', async () => {
    const s = setup();
    s.world.orgs.delete(s.org.id);
    const r = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'x',
      anchor: docAnchor,
    });
    expect(!r.ok && r.error.code).toBe('org_not_found');
  });

  it('records the acting API key on the comment; session actors leave it null', async () => {
    const s = setup();
    const viaAgent: Actor = { ...s.member, apiKeyId: 'key-1' };
    const agentComment = await createComment(s.documents, s.comments, s.orgs, s.grants, viaAgent, {
      documentId: s.documentId,
      body: 'from an agent',
      anchor: docAnchor,
    });
    expect(agentComment.ok && agentComment.value.viaApiKeyId).toBe('key-1');

    const humanComment = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'from a human',
      anchor: docAnchor,
    });
    expect(humanComment.ok && humanComment.value.viaApiKeyId).toBeNull();
  });
});

describe('createComment as a suggested edit (Phase C)', () => {
  const textAnchor: Anchor = {
    type: 'text',
    exact: 'detail',
    prefix: 'needs ',
    suffix: '',
    start: 6,
    end: 12,
  };

  it('creates a suggestion carrying proposed text and an open outcome', async () => {
    const s = setup();
    const r = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'reword this',
      anchor: textAnchor,
      proposedText: 'clarity',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('suggestion');
    expect(r.value.proposedText).toBe('clarity');
    expect(r.value.suggestionOutcome).toBe('open');
    expect(r.value.appliedVersionId).toBeNull();
  });

  it('treats an empty proposedText as a "delete this" suggestion, not a plain comment', async () => {
    const s = setup();
    const r = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'drop this word',
      anchor: textAnchor,
      proposedText: '',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('suggestion');
    expect(r.value.proposedText).toBe('');
  });

  it('leaves kind "comment" when proposedText is absent', async () => {
    const s = setup();
    const r = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'plain note',
      anchor: textAnchor,
    });
    expect(r.ok && r.value.kind).toBe('comment');
    expect(r.ok && r.value.proposedText).toBeNull();
    expect(r.ok && r.value.suggestionOutcome).toBeNull();
  });

  it('refuses a suggestion on a non-text anchor (nothing to splice)', async () => {
    const s = setup();
    const r = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'suggest on the whole doc?',
      anchor: docAnchor,
      proposedText: 'nope',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('suggestion_requires_text_anchor');
  });

  it('rejects proposed text over the length cap', async () => {
    const s = setup();
    const r = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'huge',
      anchor: textAnchor,
      proposedText: 'x'.repeat(MAX_PROPOSED_TEXT_LENGTH + 1),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('proposed_text_too_long');
  });

  it('counts suggestions toward the free-tier comment cap (ADR C.4)', async () => {
    const s = setup();
    s.world.orgs.set(s.org.id, { ...s.org, tier: 'free' });
    // Fill the free per-doc comment cap (100) with plain comments.
    for (let i = 0; i < 100; i += 1) {
      const c = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
        documentId: s.documentId,
        body: `note ${String(i)}`,
        anchor: docAnchor,
      });
      if (!c.ok) throw new Error('setup comment failed');
    }
    const capped = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'one too many',
      anchor: textAnchor,
      proposedText: 'over cap',
    });
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.error.code).toBe('comment_cap_exceeded');
  });
});

describe('editComment', () => {
  async function withComment(s: ReturnType<typeof setup>) {
    const comment = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'original',
      anchor: docAnchor,
    });
    if (!comment.ok) throw new Error('setup');
    return comment.value.id;
  }

  it('lets the author edit their own comment, trimmed', async () => {
    const s = setup();
    const id = await withComment(s);
    const r = await editComment(s.comments, s.member, id, '  better wording  ');
    expect(r.ok && r.value.body).toBe('better wording');
    // Anchor and pinned version untouched.
    expect(s.world.comments.get(id)?.versionId).toBe('v1');
  });

  it('refuses everyone but the author — owner and admin included', async () => {
    const s = setup();
    const id = await withComment(s);
    for (const actor of [s.owner, s.admin]) {
      const r = await editComment(s.comments, actor, id, 'hijack');
      expect(!r.ok && r.error.code).toBe('forbidden');
    }
  });

  it('rejects empty bodies and missing comments', async () => {
    const s = setup();
    const id = await withComment(s);
    const empty = await editComment(s.comments, s.member, id, '   ');
    expect(!empty.ok && empty.error.code).toBe('empty_body');
    const missing = await editComment(s.comments, s.member, 'nope' as CommentId, 'x');
    expect(!missing.ok && missing.error.code).toBe('comment_not_found');
  });

  it('rejects a body over the max length', async () => {
    const s = setup();
    const id = await withComment(s);
    const r = await editComment(s.comments, s.member, id, 'x'.repeat(MAX_COMMENT_BODY_LENGTH + 1));
    expect(!r.ok && r.error.code).toBe('body_too_long');
  });
});

describe('deleteComment', () => {
  async function withComment(s: ReturnType<typeof setup>) {
    const comment = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'original',
      anchor: docAnchor,
    });
    if (!comment.ok) throw new Error('setup');
    return comment.value.id;
  }

  it('lets the author delete their own comment, dropping it from every listing', async () => {
    const s = setup();
    const id = await withComment(s);
    const r = await deleteComment(s.comments, s.member, id);
    expect(r.ok).toBe(true);
    const threads = await listCommentThreads(s.documents, s.comments, s.member, s.documentId);
    expect(threads.ok && threads.value.threads).toHaveLength(0);
  });

  it('refuses everyone but the author — owner and admin included', async () => {
    const s = setup();
    const id = await withComment(s);
    for (const actor of [s.owner, s.admin]) {
      const r = await deleteComment(s.comments, actor, id);
      expect(!r.ok && r.error.code).toBe('forbidden');
    }
  });

  it('404s a missing comment', async () => {
    const s = setup();
    const r = await deleteComment(s.comments, s.member, 'nope' as CommentId);
    expect(!r.ok && r.error.code).toBe('comment_not_found');
  });
});

describe('addReply', () => {
  it('appends a trimmed reply to an existing comment', async () => {
    const s = setup();
    const comment = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'root',
      anchor: docAnchor,
    });
    if (!comment.ok) throw new Error('setup');
    const reply = await addReply(
      s.documents,
      s.comments,
      s.grants,
      s.owner,
      comment.value.id,
      '  agreed  ',
    );
    expect(reply.ok && reply.value.body).toBe('agreed');
  });

  it('records the acting API key on the reply; session actors leave it null', async () => {
    const s = setup();
    const comment = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'root',
      anchor: docAnchor,
    });
    if (!comment.ok) throw new Error('setup');
    const viaAgent: Actor = { ...s.owner, apiKeyId: 'key-1' };
    const agentReply = await addReply(
      s.documents,
      s.comments,
      s.grants,
      viaAgent,
      comment.value.id,
      'from an agent',
    );
    expect(agentReply.ok && agentReply.value.viaApiKeyId).toBe('key-1');

    const humanReply = await addReply(
      s.documents,
      s.comments,
      s.grants,
      s.owner,
      comment.value.id,
      'from a human',
    );
    expect(humanReply.ok && humanReply.value.viaApiKeyId).toBeNull();
  });

  it('rejects empty replies and missing comments', async () => {
    const s = setup();
    const missing = await addReply(
      s.documents,
      s.comments,
      s.grants,
      s.owner,
      'nope' as CommentId,
      'hi',
    );
    expect(!missing.ok && missing.error.code).toBe('comment_not_found');
    const comment = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'root',
      anchor: docAnchor,
    });
    if (!comment.ok) throw new Error('setup');
    const empty = await addReply(
      s.documents,
      s.comments,
      s.grants,
      s.owner,
      comment.value.id,
      '  ',
    );
    expect(!empty.ok && empty.error.code).toBe('empty_body');
  });

  it('rejects a reply body over the max length', async () => {
    const s = setup();
    const comment = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'root',
      anchor: docAnchor,
    });
    if (!comment.ok) throw new Error('setup');
    const r = await addReply(
      s.documents,
      s.comments,
      s.grants,
      s.owner,
      comment.value.id,
      'x'.repeat(MAX_COMMENT_BODY_LENGTH + 1),
    );
    expect(!r.ok && r.error.code).toBe('body_too_long');
  });

  it('nests replies under a parent reply', async () => {
    const s = setup();
    const comment = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'root',
      anchor: docAnchor,
    });
    if (!comment.ok) throw new Error('setup');
    const parent = await addReply(
      s.documents,
      s.comments,
      s.grants,
      s.owner,
      comment.value.id,
      'level 1',
    );
    if (!parent.ok) throw new Error('setup');
    const child = await addReply(
      s.documents,
      s.comments,
      s.grants,
      s.member,
      comment.value.id,
      'level 2',
      parent.value.id,
    );
    expect(child.ok && child.value.parentReplyId).toBe(parent.value.id);
  });

  it('rejects a parent reply from another thread', async () => {
    const s = setup();
    const a = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'thread A',
      anchor: docAnchor,
    });
    const b = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'thread B',
      anchor: docAnchor,
    });
    if (!a.ok || !b.ok) throw new Error('setup');
    const onA = await addReply(s.documents, s.comments, s.grants, s.owner, a.value.id, 'on A');
    if (!onA.ok) throw new Error('setup');
    const cross = await addReply(
      s.documents,
      s.comments,
      s.grants,
      s.owner,
      b.value.id,
      'cross',
      onA.value.id,
    );
    expect(!cross.ok && cross.error.code).toBe('parent_reply_not_found');
  });

  it('caps nesting at depth 5', async () => {
    const s = setup();
    const comment = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'root',
      anchor: docAnchor,
    });
    if (!comment.ok) throw new Error('setup');
    let parentId: string | null = null;
    for (let depth = 1; depth <= 5; depth += 1) {
      const reply = await addReply(
        s.documents,
        s.comments,
        s.grants,
        s.owner,
        comment.value.id,
        `level ${String(depth)}`,
        parentId as never,
      );
      expect(reply.ok).toBe(true);
      if (!reply.ok) return;
      parentId = reply.value.id;
    }
    const tooDeep = await addReply(
      s.documents,
      s.comments,
      s.grants,
      s.owner,
      comment.value.id,
      'level 6',
      parentId as never,
    );
    expect(!tooDeep.ok && tooDeep.error.code).toBe('reply_depth_exceeded');
  });
});

describe('resolveComment', () => {
  async function withComment(s: ReturnType<typeof setup>) {
    const comment = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'root',
      anchor: docAnchor,
    });
    if (!comment.ok) throw new Error('setup');
    return comment.value.id;
  }

  it('lets the document owner resolve', async () => {
    const s = setup();
    const id = await withComment(s);
    expect((await resolveComment(s.documents, s.comments, s.owner, id)).ok).toBe(true);
    expect(s.world.comments.get(id)?.status).toBe('resolved');
    expect(s.world.comments.get(id)?.resolvedBy).toBe(s.owner.ctx.userId);
  });

  it('lets an org admin resolve, but not a plain member', async () => {
    const s = setup();
    const id = await withComment(s);
    const denied = await resolveComment(s.documents, s.comments, s.member, id);
    expect(!denied.ok && denied.error.code).toBe('forbidden');
    expect((await resolveComment(s.documents, s.comments, s.admin, id)).ok).toBe(true);
  });

  it('rejects double-resolution', async () => {
    const s = setup();
    const id = await withComment(s);
    await resolveComment(s.documents, s.comments, s.owner, id);
    const again = await resolveComment(s.documents, s.comments, s.owner, id);
    expect(!again.ok && again.error.code).toBe('already_resolved');
  });

  it('404s a missing comment', async () => {
    const s = setup();
    const missing = await resolveComment(s.documents, s.comments, s.owner, 'nope' as CommentId);
    expect(!missing.ok && missing.error.code).toBe('comment_not_found');
  });

  it('404s when the comment outlives its document', async () => {
    const s = setup();
    const id = await withComment(s);
    s.world.documents.delete(s.documentId);
    const gone = await resolveComment(s.documents, s.comments, s.owner, id);
    expect(!gone.ok && gone.error.code).toBe('document_not_found');
  });
});

describe('toggleCommentUpvote', () => {
  async function withComment(s: ReturnType<typeof setup>) {
    const comment = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'root',
      anchor: docAnchor,
    });
    if (!comment.ok) throw new Error('setup');
    return comment.value.id;
  }

  it('toggles on then off for the same user, tracking the count', async () => {
    const s = setup();
    const id = await withComment(s);
    const on = await toggleCommentUpvote(s.documents, s.comments, s.grants, s.member, id);
    expect(on.ok && on.value).toEqual({ upvoted: true, count: 1 });
    const off = await toggleCommentUpvote(s.documents, s.comments, s.grants, s.member, id);
    expect(off.ok && off.value).toEqual({ upvoted: false, count: 0 });
  });

  it('counts one upvote per user', async () => {
    const s = setup();
    const id = await withComment(s);
    await toggleCommentUpvote(s.documents, s.comments, s.grants, s.member, id);
    const second = await toggleCommentUpvote(s.documents, s.comments, s.grants, s.owner, id);
    expect(second.ok && second.value).toEqual({ upvoted: true, count: 2 });
    // The member re-toggling drops only their own vote.
    const memberOff = await toggleCommentUpvote(s.documents, s.comments, s.grants, s.member, id);
    expect(memberOff.ok && memberOff.value).toEqual({ upvoted: false, count: 1 });
  });

  it('404s a missing comment', async () => {
    const s = setup();
    const missing = await toggleCommentUpvote(
      s.documents,
      s.comments,
      s.grants,
      s.member,
      'nope' as CommentId,
    );
    expect(!missing.ok && missing.error.code).toBe('comment_not_found');
  });
});

describe('listCommentThreads', () => {
  it('carries per-comment upvote counts and whether the actor upvoted', async () => {
    const s = setup();
    const c = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'vote me',
      anchor: docAnchor,
    });
    if (!c.ok) throw new Error('setup');
    await toggleCommentUpvote(s.documents, s.comments, s.grants, s.owner, c.value.id);
    await toggleCommentUpvote(s.documents, s.comments, s.grants, s.member, c.value.id);

    const asMember = await listCommentThreads(s.documents, s.comments, s.member, s.documentId);
    expect(asMember.ok && asMember.value.threads[0]?.upvotes).toEqual({ count: 2, mine: true });
    const asAdmin = await listCommentThreads(s.documents, s.comments, s.admin, s.documentId);
    expect(asAdmin.ok && asAdmin.value.threads[0]?.upvotes).toEqual({ count: 2, mine: false });
  });

  it('groups replies under their comments', async () => {
    const s = setup();
    const c1 = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'first',
      anchor: docAnchor,
    });
    const c2 = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'second',
      anchor: docAnchor,
    });
    if (!c1.ok || !c2.ok) throw new Error('setup');
    await addReply(s.documents, s.comments, s.grants, s.owner, c1.value.id, 'reply A');
    await addReply(s.documents, s.comments, s.grants, s.member, c1.value.id, 'reply B');

    const threads = await listCommentThreads(s.documents, s.comments, s.member, s.documentId);
    expect(threads.ok).toBe(true);
    if (!threads.ok) return;
    expect(threads.value.threads).toHaveLength(2);
    const first = threads.value.threads.find((t) => t.comment.id === c1.value.id);
    expect(first?.replies.map((r) => r.body)).toEqual(['reply A', 'reply B']);
    const second = threads.value.threads.find((t) => t.comment.id === c2.value.id);
    expect(second?.replies).toHaveLength(0);
  });

  it('404s a missing document', async () => {
    const s = setup();
    const missing = await listCommentThreads(
      s.documents,
      s.comments,
      s.member,
      'nope' as DocumentId,
    );
    expect(!missing.ok && missing.error.code).toBe('document_not_found');
  });

  it('narrows to a status without dropping replies', async () => {
    const s = setup();
    const open = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'still open',
      anchor: docAnchor,
    });
    const done = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'done',
      anchor: docAnchor,
    });
    if (!open.ok || !done.ok) throw new Error('setup');
    await addReply(s.documents, s.comments, s.grants, s.owner, open.value.id, 'ack');
    await resolveComment(s.documents, s.comments, s.owner, done.value.id);

    const openOnly = await listCommentThreads(
      s.documents,
      s.comments,
      s.member,
      s.documentId,
      'open',
    );
    expect(openOnly.ok && openOnly.value.threads.map((t) => t.comment.body)).toEqual([
      'still open',
    ]);
    expect(openOnly.ok && openOnly.value.threads[0]?.replies.map((r) => r.body)).toEqual(['ack']);

    const resolvedOnly = await listCommentThreads(
      s.documents,
      s.comments,
      s.member,
      s.documentId,
      'resolved',
    );
    expect(resolvedOnly.ok && resolvedOnly.value.threads.map((t) => t.comment.body)).toEqual([
      'done',
    ]);
  });

  it('surfaces @mentions resolved against the doc-scoped candidate set (ADR 0003 §D)', async () => {
    const s = setup();
    // A reviewer named "Jane Doe" is on the document (a doc-scoped candidate);
    // "Ext Person" is an org member NOT on the doc — a directory name, never
    // mentionable, so @ExtPerson must resolve to nothing.
    const jane = s.world.addUser(s.org.id, {
      workosUserId: 'wos_jane',
      email: 'jane@acme.test',
      displayName: 'Jane Doe',
      role: 'member',
    });
    s.world.addUser(s.org.id, {
      workosUserId: 'wos_ext',
      email: 'ext@acme.test',
      displayName: 'Ext Person',
      role: 'member',
    });
    s.world.reviewRequests.push({
      id: 'rr-1' as never,
      orgId: s.org.id,
      documentId: s.documentId,
      reviewerUserId: jane.id,
      requestedBy: s.owner.ctx.userId,
      createdAt: new Date(),
      revokedAt: null,
    });

    const created = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'cc @JaneDoe — and @ExtPerson who is off-doc',
      anchor: docAnchor,
    });
    if (!created.ok) throw new Error('setup');

    const threads = await listCommentThreads(s.documents, s.comments, s.member, s.documentId);
    expect(threads.ok).toBe(true);
    if (!threads.ok) return;
    const thread = threads.value.threads.find((t) => t.comment.id === created.value.id);
    expect(thread?.mentions).toEqual([{ userId: jane.id, displayName: 'Jane Doe' }]);

    // Editing the body to drop the name clears the stored mention (full replace).
    const edited = await editComment(s.comments, s.member, created.value.id, 'never mind');
    expect(edited.ok).toBe(true);
    const after = await listCommentThreads(s.documents, s.comments, s.member, s.documentId);
    expect(after.ok && after.value.threads[0]?.mentions).toEqual([]);
  });

  it('paginates the thread list with a keyset cursor, scoping replies to the page', async () => {
    const s = setup();
    // Six comments, oldest first; page size 2 walks the full set with no gaps.
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const c = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
        documentId: s.documentId,
        body: `c${String(i)}`,
        anchor: docAnchor,
      });
      if (!c.ok) throw new Error('setup');
      // Force distinct, increasing createdAt so the keyset order is deterministic.
      s.world.comments.set(c.value.id, {
        ...c.value,
        createdAt: new Date(`2026-07-0${String(i + 1)}T00:00:00Z`),
      });
      ids.push(c.value.id);
    }
    await addReply(s.documents, s.comments, s.grants, s.owner, ids[0] as never, 'reply on c0');

    const seen: string[] = [];
    let cursor: string | undefined;
    const firstPageReplies: string[] = [];
    for (let guard = 0; guard < 10; guard += 1) {
      const res = await listCommentThreads(
        s.documents,
        s.comments,
        s.member,
        s.documentId,
        undefined,
        {
          limit: 2,
          ...(cursor ? { cursor } : {}),
        },
      );
      if (!res.ok) throw new Error('page failed');
      seen.push(...res.value.threads.map((t) => t.comment.id));
      if (guard === 0) {
        firstPageReplies.push(...res.value.threads.flatMap((t) => t.replies.map((r) => r.body)));
      }
      if (!res.value.nextCursor) break;
      cursor = res.value.nextCursor;
    }

    expect(seen).toEqual(ids);
    // The reply read is scoped to the page: c0 is on page 1, its reply rides along.
    expect(firstPageReplies).toEqual(['reply on c0']);
  });
});

describe('comment use-cases self-defend on document access (Phase 24)', () => {
  const stranger: Actor = {
    ctx: { orgId: '' as never, userId: 'stranger' as UserId },
    role: 'member',
  };

  function strangerIn(s: ReturnType<typeof setup>): Actor {
    return { ...stranger, ctx: { orgId: s.org.id, userId: 'stranger' as UserId } };
  }

  it('createComment refuses an ungranted member with a 404-equivalent', async () => {
    const s = setup();
    const r = await createComment(s.documents, s.comments, s.orgs, s.grants, strangerIn(s), {
      documentId: s.documentId,
      body: 'sneaky',
      anchor: docAnchor,
    });
    expect(!r.ok && r.error.code).toBe('document_not_found');
  });

  it('addReply refuses an ungranted member even on an existing comment', async () => {
    const s = setup();
    const c = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'thread root',
      anchor: docAnchor,
    });
    if (!c.ok) throw new Error('setup');
    const r = await addReply(
      s.documents,
      s.comments,
      s.grants,
      strangerIn(s),
      c.value.id,
      'me too',
    );
    expect(!r.ok && r.error.code).toBe('document_not_found');
  });

  it('toggleCommentUpvote refuses an ungranted member', async () => {
    const s = setup();
    const c = await createComment(s.documents, s.comments, s.orgs, s.grants, s.member, {
      documentId: s.documentId,
      body: 'upvote me',
      anchor: docAnchor,
    });
    if (!c.ok) throw new Error('setup');
    const r = await toggleCommentUpvote(
      s.documents,
      s.comments,
      s.grants,
      strangerIn(s),
      c.value.id,
    );
    expect(!r.ok && r.error.code).toBe('document_not_found');
  });
});
