import type {
  Approval,
  ApprovalGate,
  ApprovalVerdict,
  ReviewRequest,
  ReviewStatus,
} from '@mdloop/domain';
import { MAX_APPROVAL_NOTE_LENGTH, deriveReviewStatus, orgIsWriteLocked } from '@mdloop/domain';
import type { DocumentId, Result, ReviewRequestId, UserId } from '@mdloop/shared';
import { err, ok } from '@mdloop/shared';
import type {
  CommentRepository,
  DocumentRepository,
  ReviewRepository,
  ShareGrantRepository,
} from '../ports/repositories.port.js';
import { canManageDocument } from '../policy.js';
import type { Actor, OrganizationRepository } from './org-settings.js';
import { documentPermissionFor } from './sharing.js';

export type ReviewError =
  | { readonly code: 'document_not_found' }
  | { readonly code: 'forbidden' }
  | { readonly code: 'reviewer_not_found' }
  | { readonly code: 'reviewer_has_no_access' }
  | { readonly code: 'already_requested' }
  | { readonly code: 'org_not_found' }
  | { readonly code: 'org_read_only' }
  | { readonly code: 'request_not_found' }
  | { readonly code: 'not_a_reviewer' }
  | { readonly code: 'no_version' }
  | { readonly code: 'note_too_long' }
  | { readonly code: 'open_comments_block_approval' };

/** Everything the review header/panel needs for one document in one call. */
export interface ReviewStatusView {
  readonly status: ReviewStatus;
  readonly requests: ReviewRequest[];
  readonly approvals: Approval[];
  readonly gate: ApprovalGate;
  readonly openCommentCount: number;
}

export interface ReviewDeps {
  readonly documents: DocumentRepository;
  readonly grants: ShareGrantRepository;
  readonly comments: CommentRepository;
  readonly orgs: OrganizationRepository;
  readonly reviews: ReviewRepository;
}

/**
 * Derives the document's status from its active requests and the approvals on
 * its current version — the single place the domain rule is applied for a live
 * document (getReviewStatus + overview + submit response share it).
 */
function statusOf(
  requests: readonly ReviewRequest[],
  approvals: readonly Approval[],
  currentVersionId: string | null,
): ReviewStatus {
  return deriveReviewStatus({
    activeReviewerIds: requests.map((r) => r.reviewerUserId),
    approvalsOnLatestVersion: approvals
      .filter((a) => currentVersionId !== null && a.versionId === currentVersionId)
      .map((a) => ({
        reviewerUserId: a.reviewerUserId,
        verdict: a.verdict,
        createdAt: a.createdAt,
      })),
  });
}

/**
 * Request a reviewer on a document. Requester must be the doc owner or an org
 * admin; guests are refused as defense-in-depth behind the route allowlist.
 * The reviewer must exist in the org AND already have access to the document
 * (owner/admin, or any active grant — a guest with a comment grant qualifies).
 */
export async function requestReview(
  deps: ReviewDeps,
  actor: Actor,
  input: { documentId: DocumentId; reviewerUserId: UserId },
): Promise<Result<ReviewRequest, ReviewError>> {
  if (actor.role === 'guest') return err({ code: 'forbidden' });
  const document = await deps.documents.byId(actor.ctx, input.documentId);
  if (!document || document.deletedAt) return err({ code: 'document_not_found' });
  if (!canManageDocument(actor, document)) return err({ code: 'forbidden' });
  const org = await deps.orgs.current(actor.ctx);
  if (!org) return err({ code: 'org_not_found' });
  if (orgIsWriteLocked(org)) return err({ code: 'org_read_only' });

  const reviewer = await deps.orgs.userById(actor.ctx, input.reviewerUserId);
  if (!reviewer) return err({ code: 'reviewer_not_found' });
  const reviewerActor: Actor = {
    ctx: { orgId: actor.ctx.orgId, userId: reviewer.id },
    role: reviewer.role,
  };
  const reviewerPermission = await documentPermissionFor(deps.grants, reviewerActor, document);
  if (!reviewerPermission) return err({ code: 'reviewer_has_no_access' });

  const active = await deps.reviews.activeRequestsForDocument(actor.ctx, document.id);
  if (active.some((r) => r.reviewerUserId === reviewer.id)) {
    return err({ code: 'already_requested' });
  }
  const request = await deps.reviews.createRequest(actor.ctx, {
    documentId: document.id,
    reviewerUserId: reviewer.id,
    requestedBy: actor.ctx.userId,
  });
  return ok(request);
}

/** Revoke a review request. Owner or org admin only. */
export async function revokeReviewRequest(
  deps: ReviewDeps,
  actor: Actor,
  documentId: DocumentId,
  requestId: ReviewRequestId,
): Promise<Result<void, ReviewError>> {
  if (actor.role === 'guest') return err({ code: 'forbidden' });
  const document = await deps.documents.byId(actor.ctx, documentId);
  if (!document || document.deletedAt) return err({ code: 'document_not_found' });
  if (!canManageDocument(actor, document)) return err({ code: 'forbidden' });
  const active = await deps.reviews.activeRequestsForDocument(actor.ctx, documentId);
  if (!active.some((r) => r.id === requestId)) return err({ code: 'request_not_found' });
  const revoked = await deps.reviews.revokeRequest(actor.ctx, requestId);
  return revoked ? ok(undefined) : err({ code: 'request_not_found' });
}

/** Read the derived status, requests, approvals, gate and open-comment count. */
export async function getReviewStatus(
  deps: ReviewDeps,
  actor: Actor,
  documentId: DocumentId,
): Promise<Result<ReviewStatusView, ReviewError>> {
  const document = await deps.documents.byId(actor.ctx, documentId);
  if (!document || document.deletedAt) return err({ code: 'document_not_found' });
  // Any level of access can read the review picture (reviewers included).
  const permission = await documentPermissionFor(deps.grants, actor, document);
  if (!permission) return err({ code: 'document_not_found' });

  const org = await deps.orgs.current(actor.ctx);
  if (!org) return err({ code: 'org_not_found' });
  const [requests, approvals, counts] = await Promise.all([
    deps.reviews.activeRequestsForDocument(actor.ctx, documentId),
    deps.reviews.approvalsForDocument(actor.ctx, documentId),
    deps.comments.statusCounts(actor.ctx, documentId),
  ]);
  return ok({
    status: statusOf(requests, approvals, document.currentVersionId),
    requests,
    approvals,
    gate: org.approvalGate,
    openCommentCount: counts.open,
  });
}

/**
 * Submit a verdict. The actor must hold an active request (`not_a_reviewer`
 * otherwise). Approvals pin the document's current version. Under the hard
 * gate, an approve verdict is refused while the document still has open
 * comments — the soft gate never blocks.
 */
export async function submitReview(
  deps: ReviewDeps,
  actor: Actor,
  input: { documentId: DocumentId; verdict: ApprovalVerdict; note?: string | null },
): Promise<Result<{ approval: Approval; status: ReviewStatus }, ReviewError>> {
  const note = input.note?.trim() ? input.note.trim() : null;
  if (note !== null && note.length > MAX_APPROVAL_NOTE_LENGTH) {
    return err({ code: 'note_too_long' });
  }
  const document = await deps.documents.byId(actor.ctx, input.documentId);
  if (!document || document.deletedAt) return err({ code: 'document_not_found' });
  const requests = await deps.reviews.activeRequestsForDocument(actor.ctx, document.id);
  if (!requests.some((r) => r.reviewerUserId === actor.ctx.userId)) {
    return err({ code: 'not_a_reviewer' });
  }
  if (!document.currentVersionId) return err({ code: 'no_version' });

  const org = await deps.orgs.current(actor.ctx);
  if (!org) return err({ code: 'org_not_found' });
  if (input.verdict === 'approved' && org.approvalGate === 'hard') {
    const counts = await deps.comments.statusCounts(actor.ctx, document.id);
    if (counts.open > 0) return err({ code: 'open_comments_block_approval' });
  }

  const approval = await deps.reviews.createApproval(actor.ctx, {
    documentId: document.id,
    versionId: document.currentVersionId,
    reviewerUserId: actor.ctx.userId,
    verdict: input.verdict,
    note,
    viaApiKeyId: actor.apiKeyId ?? null,
  });
  const approvals = await deps.reviews.approvalsForDocument(actor.ctx, document.id);
  return ok({ approval, status: statusOf(requests, approvals, document.currentVersionId) });
}
