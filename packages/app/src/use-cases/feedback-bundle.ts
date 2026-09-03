import type { ApprovalGate, CommentReply, ReviewStatus } from '@vorlyn/domain';
import { deriveReviewStatus, replyDepth } from '@vorlyn/domain';
import type { DocumentId, ReplyId, Result, UserId } from '@vorlyn/shared';
import { ok } from '@vorlyn/shared';
import type {
  AnchorResolutionRepository,
  CommentRepository,
  DocumentRepository,
  ReviewRepository,
  ShareGrantRepository,
  VersionRepository,
} from '../ports/repositories.port.js';
import type { StoragePort } from '../ports/storage.port.js';
import type { Actor, OrganizationRepository } from './org-settings.js';
import type { CommentError } from './comments.js';
import type { ThreadWithResolution } from './reanchor-threads.js';
import { listThreadsWithResolutions } from './reanchor-threads.js';
import type { SharingError } from './sharing.js';
import { requireDocumentAccess } from './sharing.js';

export interface FeedbackReply {
  readonly body: string;
  /** True when the acting agent authored this reply — recognizing its own past work. */
  readonly mine: boolean;
  /** 1-based nesting depth (a direct reply is 1). */
  readonly depth: number;
}

export interface FeedbackItem {
  readonly commentId: string;
  readonly body: string;
  /** The text or diagram part the comment was made on. */
  readonly quote: string;
  /** Where the quote sits on the current version, or why it does not. */
  readonly anchorState:
    | { readonly kind: 'anchored'; readonly method: string; readonly confidence: number }
    | { readonly kind: 'orphaned' };
  /** Source offsets + 1-based line of the quote on the current version; null for orphans/document anchors. */
  readonly location: { readonly start: number; readonly end: number; readonly line: number } | null;
  /** Priority signal — reviewers upvote; higher counts sort first. */
  readonly upvotes: number;
  readonly replies: FeedbackReply[];
  /**
   * Suggested edit (Phase C): the proposed replacement text for the anchored
   * range, or null for a plain comment. An agent addressing feedback can apply
   * it directly. `null` distinguishes "no suggestion" from an empty-string
   * "delete this" suggestion.
   */
  readonly proposedText: string | null;
  /**
   * Suggestion decision state (ADR 0007): null for a plain comment. `accepted`
   * means the decision was made but not necessarily materialized yet — accept
   * is metadata-only, so an agent editing this document should still apply
   * `proposedText` and upload_document (see renderPrompt's wording below).
   */
  readonly suggestionOutcome: 'open' | 'accepted' | 'rejected' | null;
}

export interface FeedbackBundle {
  readonly document: { readonly id: string; readonly title: string; readonly versionSeq: number };
  readonly openCount: number;
  readonly items: FeedbackItem[];
  /**
   * Sign-off picture (Phase B) — so an agent knows whether it holds the vorlyn:
   * derived status, the reviewers still owed a verdict on the current version,
   * and how strict the gate is.
   */
  readonly review: {
    readonly status: ReviewStatus;
    readonly pendingReviewers: string[];
    readonly gate: ApprovalGate;
  };
  /** The whole bundle rendered as one prompt-ready text block. */
  readonly prompt: string;
}

function quoteOf(thread: ThreadWithResolution): string {
  const anchor = thread.comment.anchor;
  if (anchor.type === 'text') return anchor.exact;
  if (anchor.type === 'diagram') {
    const id =
      typeof anchor.stableId === 'string'
        ? anchor.stableId
        : `message #${String(anchor.stableId.index + 1)} "${anchor.stableId.text}"`;
    return `diagram ${anchor.kind} ${id}`;
  }
  return '(whole document)';
}

/** 1-based line the offset falls on: newlines in the source before it, plus one. */
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

/** Replies with author attribution (`mine`) and 1-based nesting depth from the parent chain. */
function attributeReplies(replies: CommentReply[], actorUserId: UserId): FeedbackReply[] {
  const byId = new Map<ReplyId, CommentReply>(replies.map((r) => [r.id, r]));
  return replies.map((r) => ({
    body: r.body,
    mine: r.authorId === actorUserId,
    depth: replyDepth(r.parentReplyId, byId) ?? 1,
  }));
}

/**
 * The suggested-replacement line, worded by outcome (ADR 0007 decision 3): a
 * plain comment has no `proposedText` so nothing is added; an open suggestion
 * reads as before; an accepted-but-unmaterialized one gets the explicit
 * apply-it-yourself instruction, since accepting no longer touches the
 * document; a rejected one is moot and omitted. `items` is already filtered
 * to open threads, and a rejected suggestion's thread status isn't
 * necessarily closed, so this branch is a real, reachable case, not just
 * defensive.
 */
function suggestedReplacementLine(item: FeedbackItem): string {
  if (item.proposedText === null) return '';
  if (item.suggestionOutcome === 'rejected') return '';
  if (item.suggestionOutcome === 'accepted') {
    return (
      `Suggested replacement — ACCEPTED, not yet applied to the source: ${item.proposedText}. ` +
      `If you are the one editing this document, apply this text at the anchored location, then use upload_document.`
    );
  }
  return `Suggested replacement: ${item.proposedText}`;
}

function renderPrompt(document: FeedbackBundle['document'], items: FeedbackItem[]): string {
  if (items.length === 0) {
    return `No unresolved feedback on "${document.title}" (v${String(document.versionSeq)}).`;
  }
  const parts = items.map((item, i) => {
    const on = item.location
      ? `On: ${item.quote} (line ${String(item.location.line)})`
      : `On: ${item.quote}`;
    const lines = [
      `## Feedback ${String(i + 1)} (comment_id: ${item.commentId})`,
      on,
      item.anchorState.kind === 'orphaned'
        ? 'Note: the quoted text no longer exists in the current version. No location is given — do not assume where it moved or guess a match. Read the full document first and confirm what this comment now applies to, or ask before proceeding.'
        : '',
      item.upvotes > 0 ? `Upvotes: ${String(item.upvotes)}` : '',
      `Comment: ${item.body}`,
      suggestedReplacementLine(item),
      ...item.replies.map(
        (r) => `${'  '.repeat(r.depth - 1)}Reply: ${r.body}${r.mine ? ' (you)' : ''}`,
      ),
    ];
    return lines.filter((l) => l.length > 0).join('\n');
  });
  return [
    `# Unresolved feedback on "${document.title}" (v${String(document.versionSeq)})`,
    `${String(items.length)} open comment(s), highest-upvote first — higher-upvote feedback is higher priority. Address each, upload a new version with upload_document, then reply_to_comment and/or resolve_comment (resolving needs edit rights).`,
    '',
    parts.join('\n\n'),
  ].join('\n');
}

/**
 * The agent handoff (CONSTITUTION.md "MCP feedback bundle"): every
 * unresolved comment with its quoted text, thread and anchor state against
 * the current version, plus a prompt-shaped rendering.
 */
export async function getFeedbackBundle(
  documents: DocumentRepository,
  comments: CommentRepository,
  versions: VersionRepository,
  resolutions: AnchorResolutionRepository,
  storage: StoragePort,
  grants: ShareGrantRepository,
  reviews: ReviewRepository,
  orgs: OrganizationRepository,
  actor: Actor,
  documentId: DocumentId,
): Promise<Result<FeedbackBundle, CommentError | SharingError>> {
  const access = await requireDocumentAccess(documents, grants, actor, documentId, 'read');
  if (!access.ok) return access;
  const threads = await listThreadsWithResolutions(
    documents,
    comments,
    versions,
    resolutions,
    storage,
    actor,
    documentId,
  );
  if (!threads.ok) return threads;

  // listThreadsWithResolutions already required a current version to succeed
  // (it 'no_version's otherwise); access.value.document is a separate,
  // possibly-stale read of the same row (e.g. a version landed between the
  // two reads), so both are rechecked rather than assumed.
  const currentVersionId = access.value.document.currentVersionId;
  if (!currentVersionId)
    throw new Error('document has no current version after resolution succeeded');
  const version = await versions.byId(actor.ctx, currentVersionId);
  if (!version) throw new Error('version row missing for current version');
  const document = {
    id: access.value.document.id,
    title: access.value.document.title,
    versionSeq: version.seq,
  };

  const currentSource = new TextDecoder().decode(
    await storage.get({ orgId: actor.ctx.orgId, documentId: document.id, seq: version.seq }),
  );

  const items: FeedbackItem[] = threads.value.threads
    .filter((t) => t.comment.status === 'open')
    .map((t) => {
      const { start, end } = t.resolution;
      const location =
        start !== null && end !== null ? { start, end, line: lineAt(currentSource, start) } : null;
      return {
        commentId: t.comment.id,
        body: t.comment.body,
        quote: quoteOf(t),
        anchorState:
          t.resolution.method === 'orphan'
            ? { kind: 'orphaned' as const }
            : {
                kind: 'anchored' as const,
                method: t.resolution.method,
                confidence: t.resolution.confidence,
              },
        location,
        upvotes: t.upvotes.count,
        replies: attributeReplies(t.replies, actor.ctx.userId),
        proposedText: t.comment.proposedText,
        suggestionOutcome: t.comment.kind !== 'suggestion' ? null : t.comment.suggestionOutcome,
      };
    });
  // Higher-upvote feedback first; document position (map order) breaks ties.
  items.sort((a, b) => b.upvotes - a.upvotes);

  const [requests, approvals, org] = await Promise.all([
    reviews.activeRequestsForDocument(actor.ctx, document.id),
    reviews.approvalsForDocument(actor.ctx, document.id),
    orgs.current(actor.ctx),
  ]);
  const verdictedOnCurrent = new Set(
    approvals.filter((a) => a.versionId === currentVersionId).map((a) => a.reviewerUserId),
  );
  const review = {
    status: deriveReviewStatus({
      activeReviewerIds: requests.map((r) => r.reviewerUserId),
      approvalsOnLatestVersion: approvals
        .filter((a) => a.versionId === currentVersionId)
        .map((a) => ({
          reviewerUserId: a.reviewerUserId,
          verdict: a.verdict,
          createdAt: a.createdAt,
        })),
    }),
    pendingReviewers: requests
      .filter((r) => !verdictedOnCurrent.has(r.reviewerUserId))
      .map((r) => r.reviewerName),
    gate: org?.approvalGate ?? 'soft',
  };

  return ok({
    document,
    openCount: items.length,
    items,
    review,
    prompt: renderPrompt(document, items),
  });
}
