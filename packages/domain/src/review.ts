import type {
  ApprovalId,
  DocumentId,
  OrgId,
  ReviewRequestId,
  UserId,
  VersionId,
} from '@mdloop/shared';

/** How strict the approval gate is (org setting, ADR 0002). */
export type ApprovalGate = 'soft' | 'hard';

/** A reviewer's verdict on a version. Append-only; latest-per-reviewer wins. */
export type ApprovalVerdict = 'approved' | 'changes_requested';

/**
 * Doc-level review state, DERIVED (never stored, ADR 0002) from active
 * requests + latest verdicts on the latest version:
 * - `draft`: no active reviewers requested.
 * - `changes_requested`: any active reviewer's latest verdict is
 *   changes_requested (this dominates — one blocker holds the mdloop).
 * - `approved`: every active reviewer's latest verdict on the latest version
 *   is approved.
 * - `in_review`: reviewers requested, not yet the above.
 */
export type ReviewStatus = 'draft' | 'in_review' | 'changes_requested' | 'approved';

/**
 * A reviewer requested on a document. Revoke (revokedAt) is the only mutation.
 * `reviewerName`/`reviewerEmail` are joined at read time — guests can't call
 * listOrgUsers, so the identity travels with the row.
 */
export interface ReviewRequest {
  readonly id: ReviewRequestId;
  readonly orgId: OrgId;
  readonly documentId: DocumentId;
  readonly reviewerUserId: UserId;
  readonly requestedBy: UserId;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
  readonly reviewerName: string;
  readonly reviewerEmail: string;
}

/**
 * A single verdict, pinned to the version it was made against. Append-only:
 * rows are never updated or deleted (enforced at the DB grant level). Agent
 * attribution (Phase A) rides via `viaApiKeyId`.
 */
export interface Approval {
  readonly id: ApprovalId;
  readonly orgId: OrgId;
  readonly documentId: DocumentId;
  readonly versionId: VersionId;
  readonly reviewerUserId: UserId;
  readonly verdict: ApprovalVerdict;
  readonly note: string | null;
  readonly viaApiKeyId: string | null;
  readonly createdAt: Date;
  readonly reviewerName: string;
  readonly reviewerEmail: string;
}

/** Longest a verdict note may be, in characters. Mirrors the DB check. */
export const MAX_APPROVAL_NOTE_LENGTH = 2_000;

/** Minimal verdict shape the derivation needs — decoupled from the row type. */
export interface DerivationVerdict {
  readonly reviewerUserId: UserId;
  readonly verdict: ApprovalVerdict;
  readonly createdAt: Date;
}

/**
 * Pure derivation of a document's review status. Inputs are the ACTIVE
 * reviewer ids and every approval row on the LATEST version (the caller pins
 * both — approvals carry a version_id, so a new version implicitly resets the
 * picture without any row being touched). Latest verdict per reviewer wins;
 * changes_requested dominates; approved needs every active reviewer approving.
 */
export function deriveReviewStatus(input: {
  readonly activeReviewerIds: readonly UserId[];
  readonly approvalsOnLatestVersion: readonly DerivationVerdict[];
}): ReviewStatus {
  const reviewers = new Set(input.activeReviewerIds);
  if (reviewers.size === 0) return 'draft';

  // Latest verdict per active reviewer (append-only table can hold several).
  const latest = new Map<UserId, DerivationVerdict>();
  for (const a of input.approvalsOnLatestVersion) {
    if (!reviewers.has(a.reviewerUserId)) continue;
    const prev = latest.get(a.reviewerUserId);
    if (!prev || a.createdAt.getTime() >= prev.createdAt.getTime()) {
      latest.set(a.reviewerUserId, a);
    }
  }

  for (const v of latest.values()) {
    if (v.verdict === 'changes_requested') return 'changes_requested';
  }
  const allApproved =
    reviewers.size === latest.size && [...latest.values()].every((v) => v.verdict === 'approved');
  return allApproved ? 'approved' : 'in_review';
}
