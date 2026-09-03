import type { Anchor, Comment, CommentCapError, CommentReply } from '@vorlyn/domain';
import {
  MAX_COMMENT_BODY_LENGTH,
  MAX_PROPOSED_TEXT_LENGTH,
  MAX_REPLY_DEPTH,
  commentCapLimit,
  matchMentions,
  orgIsWriteLocked,
  replyDepth,
  validateAnchor,
} from '@vorlyn/domain';
import type { CommentId, DocumentId, ReplyId, Result } from '@vorlyn/shared';
import { err, ok } from '@vorlyn/shared';
import type {
  CommentKeyset,
  CommentMention,
  CommentRepository,
  DocumentRepository,
  ShareGrantRepository,
} from '../ports/repositories.port.js';
import { canManageDocument } from '../policy.js';
import type { Actor, OrganizationRepository } from './org-settings.js';
import { requireDocumentAccess } from './sharing.js';

export type CommentError =
  | CommentCapError
  | { readonly code: 'document_not_found' }
  | { readonly code: 'comment_not_found' }
  | { readonly code: 'org_read_only' }
  | { readonly code: 'no_version' }
  | { readonly code: 'empty_body' }
  | { readonly code: 'body_too_long' }
  | { readonly code: 'invalid_anchor' }
  | { readonly code: 'forbidden' }
  | { readonly code: 'org_not_found' }
  | { readonly code: 'parent_reply_not_found' }
  | { readonly code: 'reply_depth_exceeded' }
  | { readonly code: 'already_resolved' }
  // Suggested edits (Phase C): a suggestion must anchor to text (there is
  // nothing to splice on a document/diagram anchor), and its proposed text is
  // length-capped like a comment body.
  | { readonly code: 'proposed_text_too_long' }
  | { readonly code: 'suggestion_requires_text_anchor' };

export interface CommentThread {
  readonly comment: Comment;
  readonly replies: CommentReply[];
  /** Priority signal (reviewers upvote); `mine` = the actor upvoted. */
  readonly upvotes: { readonly count: number; readonly mine: boolean };
  /** People @mentioned in the comment body (ADR 0003 §D), display name joined. */
  readonly mentions: CommentMention[];
}

/** Keyset paging over the thread list (Phase 24.F); absent = the whole document. */
export interface ThreadPageInput {
  readonly cursor?: string;
  readonly limit?: number;
}

export const THREAD_DEFAULT_LIMIT = 50;
const THREAD_MAX_LIMIT = 200;

/** Opaque keyset cursor over (createdAt asc, id asc) — the thread list order. */
function encodeThreadCursor(comment: Comment): string {
  return Buffer.from(`${String(comment.createdAt.getTime())}:${comment.id}`).toString('base64url');
}

function decodeThreadCursor(cursor: string): CommentKeyset | null {
  const raw = Buffer.from(cursor, 'base64url').toString();
  const sep = raw.indexOf(':');
  if (sep < 1) return null;
  const time = Number(raw.slice(0, sep));
  return Number.isFinite(time)
    ? { createdAt: new Date(time), id: raw.slice(sep + 1) as CommentId }
    : null;
}

/**
 * Comments pin to the document's current version at creation time. Passing
 * `proposedText` (a non-null string, empty included) makes this a suggested
 * edit (Phase C) rather than a plain comment — the same create path, the same
 * anchor validation, the same tier cap. A suggestion must anchor to text: the
 * accept verb splices `proposedText` over the anchor's located range, and only
 * a text anchor has a range. Guests may create suggestions (comment permission
 * suffices); they can never accept one (owner/admin-gated, Phase C).
 */
export async function createComment(
  documents: DocumentRepository,
  comments: CommentRepository,
  orgs: OrganizationRepository,
  grants: ShareGrantRepository,
  actor: Actor,
  input: { documentId: DocumentId; body: string; anchor: Anchor; proposedText?: string | null },
): Promise<Result<Comment, CommentError>> {
  const proposedText = input.proposedText ?? null;
  const isSuggestion = proposedText !== null;
  // Self-defending (Phase 24): the comment-permission gate lives in the
  // use-case, not only in the transport, so no caller can create a comment on
  // a document the actor cannot reach. Insufficient access reads as a 404 — no
  // existence oracle (matches requireDocumentAccess, which also drops deleted).
  const access = await requireDocumentAccess(documents, grants, actor, input.documentId, 'comment');
  if (!access.ok) return err({ code: 'document_not_found' });
  const document = access.value.document;
  if (input.body.trim().length === 0) return err({ code: 'empty_body' });
  if (input.body.length > MAX_COMMENT_BODY_LENGTH) return err({ code: 'body_too_long' });
  if (validateAnchor(input.anchor)) return err({ code: 'invalid_anchor' });
  if (isSuggestion) {
    if (input.anchor.type !== 'text') return err({ code: 'suggestion_requires_text_anchor' });
    if (proposedText.length > MAX_PROPOSED_TEXT_LENGTH) {
      return err({ code: 'proposed_text_too_long' });
    }
  }
  if (!document.currentVersionId) return err({ code: 'no_version' });
  const org = await orgs.current(actor.ctx);
  if (!org) return err({ code: 'org_not_found' });
  if (orgIsWriteLocked(org)) return err({ code: 'org_read_only' });
  // Free-tier abuse guard only — paid tiers are uncapped (`TIER_PROFILES`, tier.ts).
  // Suggestions count toward this cap deliberately (ADR 0002 C.4). The count
  // and insert run in one advisory-locked transaction (Phase 24): two
  // concurrent creates at ceiling-1 can no longer both slip past the cap. The
  // numeric ceiling stays a domain decision; persistence only enforces it.
  const limit = commentCapLimit(org.tier);
  const comment = await comments.createWithinCap(
    actor.ctx,
    {
      documentId: document.id,
      versionId: document.currentVersionId,
      body: input.body.trim(),
      anchor: input.anchor,
      authorId: actor.ctx.userId,
      viaApiKeyId: actor.apiKeyId ?? null,
      proposedText,
    },
    limit,
  );
  if (!comment) return err({ code: 'comment_cap_exceeded', limit: limit ?? 0 });
  await storeMentions(comments, actor, document.id, comment.id, comment.body);
  return ok(comment);
}

/**
 * Resolves the @mentions in a comment body against the DOC-SCOPED candidate set
 * (owner + participants + reviewers — never the org directory, ADR 0003 §D) and
 * stores them. Store + display only: no notification is written (that is the
 * §9-excluded webhooks arc). A body with no matches clears any prior mentions,
 * so an edit that removes a name removes its mention.
 */
async function storeMentions(
  comments: CommentRepository,
  actor: Actor,
  documentId: DocumentId,
  commentId: CommentId,
  body: string,
): Promise<void> {
  const candidates = await comments.mentionCandidates(actor.ctx, documentId);
  await comments.replaceMentions(actor.ctx, commentId, matchMentions(body, candidates));
}

export async function addReply(
  documents: DocumentRepository,
  comments: CommentRepository,
  grants: ShareGrantRepository,
  actor: Actor,
  commentId: CommentId,
  body: string,
  parentReplyId: ReplyId | null = null,
): Promise<Result<CommentReply, CommentError>> {
  if (body.trim().length === 0) return err({ code: 'empty_body' });
  if (body.length > MAX_COMMENT_BODY_LENGTH) return err({ code: 'body_too_long' });
  const comment = await comments.byId(actor.ctx, commentId);
  if (!comment) return err({ code: 'comment_not_found' });
  // Self-defending (Phase 24): replying requires comment access on the parent
  // comment's document — enforced here, not only at the transport.
  const access = await requireDocumentAccess(
    documents,
    grants,
    actor,
    comment.documentId,
    'comment',
  );
  if (!access.ok) return err({ code: 'document_not_found' });
  if (parentReplyId !== null) {
    const siblings = await comments.listReplies(actor.ctx, commentId);
    // The parent must live on this same thread — a parent id from another
    // comment is indistinguishable from a missing one on purpose.
    const depth = replyDepth(parentReplyId, new Map(siblings.map((r) => [r.id, r])));
    if (depth === undefined) return err({ code: 'parent_reply_not_found' });
    if (depth > MAX_REPLY_DEPTH) return err({ code: 'reply_depth_exceeded' });
  }
  const reply = await comments.addReply(actor.ctx, {
    commentId,
    parentReplyId,
    body: body.trim(),
    authorId: actor.ctx.userId,
    viaApiKeyId: actor.apiKeyId ?? null,
  });
  return ok(reply);
}

/** Resolve rights: document owner or org admin (ARCHITECTURE.md §7). */
export async function resolveComment(
  documents: DocumentRepository,
  comments: CommentRepository,
  actor: Actor,
  commentId: CommentId,
): Promise<Result<void, CommentError>> {
  const comment = await comments.byId(actor.ctx, commentId);
  if (!comment) return err({ code: 'comment_not_found' });
  const document = await documents.byId(actor.ctx, comment.documentId);
  if (!document) return err({ code: 'document_not_found' });
  if (!canManageDocument(actor, document)) return err({ code: 'forbidden' });
  const changed = await comments.resolve(actor.ctx, commentId, actor.ctx.userId);
  return changed ? ok(undefined) : err({ code: 'already_resolved' });
}

/** Toggles the actor's upvote on a comment; requires comment access on the doc. */
export async function toggleCommentUpvote(
  documents: DocumentRepository,
  comments: CommentRepository,
  grants: ShareGrantRepository,
  actor: Actor,
  commentId: CommentId,
): Promise<Result<{ upvoted: boolean; count: number }, CommentError>> {
  const comment = await comments.byId(actor.ctx, commentId);
  if (!comment) return err({ code: 'comment_not_found' });
  // Self-defending (Phase 24): only someone who can comment may upvote.
  const access = await requireDocumentAccess(
    documents,
    grants,
    actor,
    comment.documentId,
    'comment',
  );
  if (!access.ok) return err({ code: 'document_not_found' });
  const state = await comments.toggleUpvote(actor.ctx, commentId, actor.ctx.userId);
  return ok(state);
}

/** Edit rights: comment author only — never the document owner or admin. */
export async function editComment(
  comments: CommentRepository,
  actor: Actor,
  commentId: CommentId,
  body: string,
): Promise<Result<Comment, CommentError>> {
  if (body.trim().length === 0) return err({ code: 'empty_body' });
  if (body.length > MAX_COMMENT_BODY_LENGTH) return err({ code: 'body_too_long' });
  const comment = await comments.byId(actor.ctx, commentId);
  if (!comment) return err({ code: 'comment_not_found' });
  if (comment.authorId !== actor.ctx.userId) return err({ code: 'forbidden' });
  const updated = await comments.update(actor.ctx, commentId, body.trim());
  // Re-derive mentions against the edited body — a name added lights up, a name
  // removed goes dark (replaceMentions is a full replace).
  await storeMentions(comments, actor, updated.documentId, updated.id, updated.body);
  return ok(updated);
}

/** Delete rights: comment author only — same as edit. Soft delete; replies
 *  stay in place but the whole thread drops out of every listing. */
export async function deleteComment(
  comments: CommentRepository,
  actor: Actor,
  commentId: CommentId,
): Promise<Result<void, CommentError>> {
  const comment = await comments.byId(actor.ctx, commentId);
  if (!comment) return err({ code: 'comment_not_found' });
  if (comment.authorId !== actor.ctx.userId) return err({ code: 'forbidden' });
  await comments.delete(actor.ctx, commentId);
  return ok(undefined);
}

/**
 * Threads for a document, replies grouped under their comment, oldest first.
 * `status` narrows to open or resolved threads.
 *
 * `page` (Phase 24.F) keyset-slices the thread list so a document with
 * thousands of comments no longer loads them all: the comments come from the
 * bounded `listForDocumentPage`, and the reply/upvote/mention reads are scoped
 * to exactly that page's comments (`*ForComments`) rather than the whole
 * document. Omitting `page` keeps the complete document-wide read — the shape
 * `get_feedback_bundle` relies on (the full unresolved bundle, ARCHITECTURE.md
 * §9). Either way replies come from one read, never a query per comment.
 */
export async function listCommentThreads(
  documents: DocumentRepository,
  comments: CommentRepository,
  actor: Actor,
  documentId: DocumentId,
  status?: 'open' | 'resolved',
  page?: ThreadPageInput,
): Promise<Result<{ threads: CommentThread[]; nextCursor: string | null }, CommentError>> {
  const document = await documents.byId(actor.ctx, documentId);
  if (!document || document.deletedAt) return err({ code: 'document_not_found' });

  let list: Comment[];
  let nextCursor: string | null = null;
  if (page) {
    const limit = Math.min(Math.max(page.limit ?? THREAD_DEFAULT_LIMIT, 1), THREAD_MAX_LIMIT);
    const after = page.cursor ? decodeThreadCursor(page.cursor) : null;
    // One extra row detects a further page without a separate count.
    const rows = await comments.listForDocumentPage(
      actor.ctx,
      documentId,
      status,
      after,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    list = hasMore ? rows.slice(0, limit) : rows;
    const last = list.at(-1);
    if (hasMore && last) nextCursor = encodeThreadCursor(last);
  } else {
    list = await comments.listForDocument(actor.ctx, documentId, status);
  }

  const ids = list.map((c) => c.id);
  const [allReplies, upvotes, mentions] = await Promise.all([
    page
      ? comments.listRepliesForComments(actor.ctx, ids)
      : comments.listRepliesForDocument(actor.ctx, documentId),
    page
      ? comments.upvotesForComments(actor.ctx, ids, actor.ctx.userId)
      : comments.upvotesForDocument(actor.ctx, documentId, actor.ctx.userId),
    page
      ? comments.mentionsForComments(actor.ctx, ids)
      : comments.mentionsForDocument(actor.ctx, documentId),
  ]);
  const repliesByComment = new Map<CommentId, CommentReply[]>();
  for (const reply of allReplies) {
    const bucket = repliesByComment.get(reply.commentId);
    if (bucket) bucket.push(reply);
    else repliesByComment.set(reply.commentId, [reply]);
  }
  return ok({
    threads: list.map((comment) => ({
      comment,
      replies: repliesByComment.get(comment.id) ?? [],
      upvotes: upvotes.get(comment.id) ?? { count: 0, mine: false },
      mentions: mentions.get(comment.id) ?? [],
    })),
    nextCursor,
  });
}
