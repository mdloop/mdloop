import type { Comment } from '@mdloop/domain';
import type { CommentId, Result } from '@mdloop/shared';
import { err, ok } from '@mdloop/shared';
import type { CommentRepository, DocumentRepository } from '../ports/repositories.port.js';
import { canManageDocument } from '../policy.js';
import type { Actor } from './org-settings.js';

/**
 * Accepting or rejecting a suggestion (Phase C, ADR 0002; accept reworked by
 * ADR 0007). Accepting is now metadata-only: it flips `suggestion_outcome`
 * `open -> accepted` and returns — it never reads document content, never
 * re-anchors, never splices, and never mints a version. Whether the proposal
 * was actually applied is discovered later and lazily by the re-anchor
 * pipeline (`reanchor-threads.ts`), which marks it `applied` once a real
 * edit's content exactly matches the proposal at the resolved range. See
 * ADR 0007 for the full rationale.
 */
export type SuggestionError =
  | { readonly code: 'comment_not_found' }
  | { readonly code: 'not_a_suggestion' }
  | { readonly code: 'suggestion_not_open' }
  | { readonly code: 'document_not_found' }
  | { readonly code: 'forbidden' };

export interface AcceptSuggestionDeps {
  readonly documents: DocumentRepository;
  readonly comments: CommentRepository;
}

export interface RejectSuggestionDeps {
  readonly documents: DocumentRepository;
  readonly comments: CommentRepository;
}

export interface AcceptSuggestionResult {
  readonly comment: Comment;
}

/**
 * Accept a suggestion: a decision, not a mutation (ADR 0007). Owner/org-admin
 * gate is kept even though nothing is written to the document — deliberately
 * not loosened as a side effect of this change (ADR 0007 decision 4).
 */
export async function acceptSuggestion(
  deps: AcceptSuggestionDeps,
  actor: Actor,
  commentId: CommentId,
  // Kept for call-site compatibility with rejectSuggestion/uploadNewVersion's
  // shape; unused now that accept never originates a version (ADR 0007).
  _source: 'web' | 'mcp',
): Promise<Result<AcceptSuggestionResult, SuggestionError>> {
  // byId excludes soft-deleted rows — a deleted suggestion can't be accepted.
  const comment = await deps.comments.byId(actor.ctx, commentId);
  if (!comment) return err({ code: 'comment_not_found' });
  if (comment.kind !== 'suggestion') return err({ code: 'not_a_suggestion' });
  if (comment.suggestionOutcome !== 'open') return err({ code: 'suggestion_not_open' });

  const document = await deps.documents.byId(actor.ctx, comment.documentId);
  if (!document || document.deletedAt) return err({ code: 'document_not_found' });
  if (!canManageDocument(actor, document)) return err({ code: 'forbidden' });

  const resolved = await deps.comments.setSuggestionOutcome(actor.ctx, commentId, 'accepted', null);
  // Lost the open->accepted race to a concurrent accept/reject. Report the
  // conflict honestly rather than pretending success.
  if (!resolved) return err({ code: 'suggestion_not_open' });
  return ok({ comment: resolved });
}

/**
 * Reject a suggestion: owner or org admin only, valid only on an OPEN
 * suggestion. No document mutation, so no read-only gate — it only marks
 * metadata terminal.
 */
export async function rejectSuggestion(
  deps: RejectSuggestionDeps,
  actor: Actor,
  commentId: CommentId,
): Promise<Result<Comment, SuggestionError>> {
  const comment = await deps.comments.byId(actor.ctx, commentId);
  if (!comment) return err({ code: 'comment_not_found' });
  if (comment.kind !== 'suggestion') return err({ code: 'not_a_suggestion' });
  if (comment.suggestionOutcome !== 'open') return err({ code: 'suggestion_not_open' });

  const document = await deps.documents.byId(actor.ctx, comment.documentId);
  if (!document || document.deletedAt) return err({ code: 'document_not_found' });
  if (!canManageDocument(actor, document)) return err({ code: 'forbidden' });

  const resolved = await deps.comments.setSuggestionOutcome(actor.ctx, commentId, 'rejected', null);
  if (!resolved) return err({ code: 'suggestion_not_open' });
  return ok(resolved);
}
