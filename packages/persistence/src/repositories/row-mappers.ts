import type {
  AllowlistEntry,
  Approval,
  Comment,
  CommentReply,
  Document,
  DocumentVersion,
  OrgInvite,
  Organization,
  Project,
  ReviewRequest,
  ShareGrant,
  User,
} from '@mdloop/domain';
import type {
  Anchor,
  ApprovalGate,
  ApprovalVerdict,
  ProvisioningMode,
  SubscriptionStatus,
  Tier,
  UploadSource,
  VersionRetentionConfig,
} from '@mdloop/domain';
import type {
  AllowlistEntryId,
  ApprovalId,
  CommentId,
  DocumentId,
  GrantId,
  InviteId,
  OrgId,
  ProjectId,
  ReplyId,
  ReviewRequestId,
  UserId,
  VersionId,
} from '@mdloop/shared';

/* Row shapes coming back from pg (snake_case, Dates for timestamptz). */

export interface OrganizationRow {
  id: string;
  name: string;
  sharing_mode: 'link' | 'directory';
  retention_days: number;
  purge_immediately: boolean;
  tier: Tier;
  version_retention: VersionRetentionConfig | null;
  subscription_status: SubscriptionStatus;
  billing_customer_id: string | null;
  trial_ends_at: Date | null;
  read_only_at: Date | null;
  purge_scheduled_at: Date | null;
  idle_warning_sent_at: Date | null;
  provisioning_mode: ProvisioningMode;
  sso_connection_id: string | null;
  external_sharing: boolean;
  approval_gate: ApprovalGate;
  session_max_hours: number | null;
  created_at: Date;
}

export function toOrganization(r: OrganizationRow): Organization {
  return {
    id: r.id as OrgId,
    name: r.name,
    sharingMode: r.sharing_mode,
    retentionDays: r.retention_days,
    purgeImmediately: r.purge_immediately,
    tier: r.tier,
    versionRetention: r.version_retention,
    subscriptionStatus: r.subscription_status,
    billingCustomerId: r.billing_customer_id,
    trialEndsAt: r.trial_ends_at,
    readOnlyAt: r.read_only_at,
    purgeScheduledAt: r.purge_scheduled_at,
    idleWarningSentAt: r.idle_warning_sent_at,
    provisioningMode: r.provisioning_mode,
    ssoConnectionId: r.sso_connection_id,
    externalSharing: r.external_sharing,
    approvalGate: r.approval_gate,
    sessionMaxHours: r.session_max_hours,
    createdAt: r.created_at,
  };
}

export interface UserRow {
  id: string;
  org_id: string;
  workos_user_id: string;
  email: string;
  display_name: string;
  role: 'admin' | 'member' | 'guest';
  created_at: Date;
}

export function toUser(r: UserRow): User {
  return {
    id: r.id as UserId,
    orgId: r.org_id as OrgId,
    workosUserId: r.workos_user_id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    createdAt: r.created_at,
  };
}

export interface ProjectRow {
  id: string;
  org_id: string;
  name: string;
  color: string;
  created_by: string | null;
  created_at: Date;
  archived_at: Date | null;
}

export function toProject(r: ProjectRow): Project {
  return {
    id: r.id as ProjectId,
    orgId: r.org_id as OrgId,
    name: r.name,
    color: r.color,
    createdBy: r.created_by as UserId | null,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

export interface DocumentRow {
  id: string;
  org_id: string;
  project_id: string | null;
  owner_id: string;
  title: string;
  /** Repo-relative display path (migration 0032) — never a storage key. */
  path: string | null;
  current_version_id: string | null;
  archived_at: Date | null;
  deleted_at: Date | null;
  purge_after: Date | null;
  created_at: Date;
}

export function toDocument(r: DocumentRow): Document {
  return {
    id: r.id as DocumentId,
    orgId: r.org_id as OrgId,
    projectId: r.project_id as ProjectId | null,
    ownerId: r.owner_id as UserId,
    title: r.title,
    path: r.path,
    currentVersionId: r.current_version_id as VersionId | null,
    archivedAt: r.archived_at,
    deletedAt: r.deleted_at,
    purgeAfter: r.purge_after,
    createdAt: r.created_at,
  };
}

export interface VersionRow {
  id: string;
  org_id: string;
  document_id: string;
  seq: number;
  content_hash: string;
  byte_size: number;
  created_by: string;
  /** Kept as the domain union so a widened source (Phase 20.A's `cli`) can
   *  only ever be added in one place. Mirrors the CHECK in migration 0031. */
  source: UploadSource;
  purged_at: Date | null;
  created_at: Date;
  via_api_key_id: string | null;
  change_note: string | null;
}

export function toVersion(r: VersionRow): DocumentVersion {
  return {
    id: r.id as VersionId,
    orgId: r.org_id as OrgId,
    documentId: r.document_id as DocumentId,
    seq: r.seq,
    contentHash: r.content_hash,
    byteSize: r.byte_size,
    createdBy: r.created_by as UserId,
    source: r.source,
    purgedAt: r.purged_at,
    createdAt: r.created_at,
    viaApiKeyId: r.via_api_key_id,
    changeNote: r.change_note,
  };
}

export interface CommentRow {
  id: string;
  org_id: string;
  document_id: string;
  version_id: string;
  author_id: string;
  body: string;
  anchor: Anchor;
  status: 'open' | 'resolved';
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
  /** Soft-delete marker — never surfaced on the domain Comment; every query
   *  filters it out, so nothing downstream needs to know it exists. */
  deleted_at: Date | null;
  via_api_key_id: string | null;
  kind: Comment['kind'];
  proposed_text: string | null;
  suggestion_outcome: Comment['suggestionOutcome'];
  applied_version_id: string | null;
}

export function toComment(r: CommentRow): Comment {
  return {
    id: r.id as CommentId,
    orgId: r.org_id as OrgId,
    documentId: r.document_id as DocumentId,
    versionId: r.version_id as VersionId,
    authorId: r.author_id as UserId,
    body: r.body,
    anchor: r.anchor,
    status: r.status,
    resolvedBy: r.resolved_by as UserId | null,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
    viaApiKeyId: r.via_api_key_id,
    kind: r.kind,
    proposedText: r.proposed_text,
    suggestionOutcome: r.suggestion_outcome,
    appliedVersionId: r.applied_version_id as VersionId | null,
  };
}

export interface ReplyRow {
  id: string;
  org_id: string;
  comment_id: string;
  parent_reply_id: string | null;
  author_id: string;
  body: string;
  created_at: Date;
  via_api_key_id: string | null;
}

export function toReply(r: ReplyRow): CommentReply {
  return {
    id: r.id as ReplyId,
    orgId: r.org_id as OrgId,
    commentId: r.comment_id as CommentId,
    parentReplyId: r.parent_reply_id as ReplyId | null,
    authorId: r.author_id as UserId,
    body: r.body,
    createdAt: r.created_at,
    viaApiKeyId: r.via_api_key_id,
  };
}

export interface GrantRow {
  id: string;
  org_id: string;
  subject_type: 'document' | 'project';
  subject_id: string;
  grantee_type: 'link' | 'user';
  grantee_user_id: string | null;
  // Stale since ADR 0008, fixed under ADR 0014: this must be the full
  // lattice the DB CHECK actually allows, not a narrower slice that happens
  // to widen-assign cleanly into ShareGrant.permission below.
  permission: 'read' | 'comment' | 'share' | 'edit';
  token_hash: string | null;
  expires_at: Date | null;
  grantee_email: string | null;
  created_by: string;
  created_at: Date;
  revoked_at: Date | null;
}

export function toGrant(r: GrantRow): ShareGrant {
  return {
    id: r.id as GrantId,
    orgId: r.org_id as OrgId,
    subject:
      r.subject_type === 'document'
        ? { type: 'document', id: r.subject_id as DocumentId }
        : { type: 'project', id: r.subject_id as ProjectId },
    grantee:
      r.grantee_type === 'link'
        ? { type: 'link' }
        : { type: 'user', userId: r.grantee_user_id as UserId },
    permission: r.permission,
    tokenHash: r.token_hash,
    expiresAt: r.expires_at,
    granteeEmail: r.grantee_email,
    createdBy: r.created_by as UserId,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  };
}

export interface OrgInviteRow {
  id: string;
  org_id: string;
  email: string;
  role: 'admin' | 'member';
  token_hash: string;
  invited_by: string | null;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
}

export function toOrgInvite(r: OrgInviteRow): OrgInvite {
  return {
    id: r.id as InviteId,
    orgId: r.org_id as OrgId,
    email: r.email,
    role: r.role,
    tokenHash: r.token_hash,
    invitedBy: r.invited_by as UserId | null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    acceptedAt: r.accepted_at,
    revokedAt: r.revoked_at,
  };
}

export interface AllowlistEntryRow {
  id: string;
  org_id: string;
  email: string;
  added_by: string;
  created_at: Date;
}

export function toAllowlistEntry(r: AllowlistEntryRow): AllowlistEntry {
  return {
    id: r.id as AllowlistEntryId,
    orgId: r.org_id as OrgId,
    email: r.email,
    addedBy: r.added_by as UserId,
    createdAt: r.created_at,
  };
}

/** review_requests row + the reviewer identity joined at read time. */
export interface ReviewRequestRow {
  id: string;
  org_id: string;
  document_id: string;
  reviewer_user_id: string;
  requested_by: string;
  created_at: Date;
  revoked_at: Date | null;
  reviewer_name: string;
  reviewer_email: string;
}

export function toReviewRequest(r: ReviewRequestRow): ReviewRequest {
  return {
    id: r.id as ReviewRequestId,
    orgId: r.org_id as OrgId,
    documentId: r.document_id as DocumentId,
    reviewerUserId: r.reviewer_user_id as UserId,
    requestedBy: r.requested_by as UserId,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    reviewerName: r.reviewer_name,
    reviewerEmail: r.reviewer_email,
  };
}

/** approvals row + the reviewer identity joined at read time. */
export interface ApprovalRow {
  id: string;
  org_id: string;
  document_id: string;
  version_id: string;
  reviewer_user_id: string;
  verdict: ApprovalVerdict;
  note: string | null;
  via_api_key_id: string | null;
  created_at: Date;
  reviewer_name: string;
  reviewer_email: string;
}

export function toApproval(r: ApprovalRow): Approval {
  return {
    id: r.id as ApprovalId,
    orgId: r.org_id as OrgId,
    documentId: r.document_id as DocumentId,
    versionId: r.version_id as VersionId,
    reviewerUserId: r.reviewer_user_id as UserId,
    verdict: r.verdict,
    note: r.note,
    viaApiKeyId: r.via_api_key_id,
    createdAt: r.created_at,
    reviewerName: r.reviewer_name,
    reviewerEmail: r.reviewer_email,
  };
}
