import type {
  AllowlistEntryId,
  CommentId,
  DocumentId,
  GrantId,
  InviteId,
  OrgId,
  ProjectId,
  ReplyId,
  UserId,
  VersionId,
} from '@mdloop/shared';
import type { Anchor } from './anchor.js';
import type { ApprovalGate } from './review.js';
import type { CommentKind, SuggestionOutcome } from './suggestion.js';
import type { GrantablePermission } from './permission.js';
import type { Tier, VersionRetentionConfig } from './tier.js';

/**
 * Where an org stood with the (now-removed) billing provider — `none`: free
 * tier, never subscribed (or trial expired); `trialing`: 14-day full-feature
 * Team trial; `active`: paying; `past_due`: payment failing; `canceled_grace`:
 * subscription ended, read-only export window running. Vestigial post
 * billing-removal (S4 spike): the column and this type stay (migration 0006
 * is never renumbered/dropped) but nothing reads it to gate behavior anymore
 * — was `domain/billing.ts`'s `SubscriptionStatus`, inlined here as its last
 * real consumer once that file's state-machine functions had none left.
 */
export type SubscriptionStatus = 'none' | 'trialing' | 'active' | 'past_due' | 'canceled_grace';

/** Org-level sharing mode, admin-toggled (CONSTITUTION.md §9). */
export type SharingMode = 'link' | 'directory';
/**
 * Enterprise SSO JIT provisioning mode (Phase 15). `open`: any user
 * authenticating via the org's verified SSO connection auto-joins. `allowlist`:
 * only pre-loaded emails auto-join. Irrelevant for orgs with no
 * `ssoConnectionId` (manual invite is the only path then).
 */
export type ProvisioningMode = 'open' | 'allowlist';
/**
 * `guest` (Phase 18) is an external, email-only identity synthesized as a
 * users row so comments' composite FK just works; a guest never owns docs,
 * never counts as a seat, and can only reach documents granted to it.
 */
export type UserRole = 'admin' | 'member' | 'guest';
export type CommentStatus = 'open' | 'resolved';
/**
 * How a version's bytes arrived. `cli` (Phase 20) is the sync
 * CLI mirroring a repo file; it is a distinct provenance from `mcp` because a
 * repo push is a mirror of a file a human can also edit outside mdloop, not an
 * agent authoring in place. Nothing emits `cli` yet — the CLI is currently
 * just another MCP client, so its pushes land as `mcp` until `upload_document`
 * can identify its caller.
 */
export type UploadSource = 'web' | 'mcp' | 'cli';

export interface Organization {
  readonly id: OrgId;
  readonly name: string;
  readonly sharingMode: SharingMode;
  readonly retentionDays: number;
  readonly purgeImmediately: boolean;
  readonly tier: Tier;
  /** Version auto-purge config; null = tier default. Clamped to tier ceiling (ADR 0001). */
  readonly versionRetention: VersionRetentionConfig | null;
  /** Former billing lifecycle (Phase 13, removed S4 spike) — vestigial,
   *  see {@link SubscriptionStatus}. Provider ids are opaque, never logged. */
  readonly subscriptionStatus: SubscriptionStatus;
  readonly billingCustomerId: string | null;
  readonly trialEndsAt: Date | null;
  readonly readOnlyAt: Date | null;
  readonly purgeScheduledAt: Date | null;
  readonly idleWarningSentAt: Date | null;
  readonly provisioningMode: ProvisioningMode;
  /** WorkOS SSO connection id; null = no SSO configured, JIT never triggers. */
  readonly ssoConnectionId: string | null;
  /**
   * External guest sharing (Phase 18) master switch. On by default for
   * free/team; enterprise admins opt in (consulting-firm mode). When off,
   * both creating guest shares and redeeming existing tokens are blocked.
   */
  readonly externalSharing: boolean;
  /**
   * Sign-off gate (Phase B, ADR 0002). `soft`: approvals are advisory.
   * `hard`: an approve verdict is blocked while the document has open
   * comments. Default `soft` — the gate never surprises an existing org.
   */
  readonly approvalGate: ApprovalGate;
  /**
   * Org-configurable session ceiling in hours (Phase 24). `null` = the global
   * 24h default. An org may only *shorten* below the default (1..24, enforced
   * by a CHECK constraint and domain validation) — never lengthen it. Enforced
   * at decode time as `min(globalDefault, orgMax)`; see `session.ts`.
   */
  readonly sessionMaxHours: number | null;
  readonly createdAt: Date;
}

export interface User {
  readonly id: UserId;
  readonly orgId: OrgId;
  readonly workosUserId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: UserRole;
  readonly createdAt: Date;
}

export interface Project {
  readonly id: ProjectId;
  readonly orgId: OrgId;
  readonly name: string;
  /** User-assignable display color, hex like "#7c3aed". */
  readonly color: string;
  /**
   * The member who created the project (Phase 24, migration 0021) — the
   * owner-or-admin mutation gate keys off this. `null` for rows created
   * before the column existed: a null-owner project is admin-only to mutate.
   */
  readonly createdBy: UserId | null;
  readonly createdAt: Date;
  readonly archivedAt: Date | null;
}

export interface Document {
  readonly id: DocumentId;
  readonly orgId: OrgId;
  /** Null = unfiled. */
  readonly projectId: ProjectId | null;
  readonly ownerId: UserId;
  readonly title: string;
  /**
   * Repo-relative POSIX path INCLUDING the filename (Phase 29), e.g.
   * `docs/specs/auth.md` — the workspace structure the sync CLI mirrored in,
   * and what the project tree and viewer breadcrumb render. `null` = no repo
   * origin (a manual web/MCP upload); those documents show in the flat list,
   * never in a tree. Validated by `isValidDocumentPath`.
   *
   * Organisational metadata ONLY — never a storage key. Blobs stay addressed
   * by `VersionKey{orgId, documentId, seq}` and no function accepts an
   * outside-supplied storage path (CONSTITUTION.md §3).
   *
   * Orthogonal to `projectId`: a project move is a human action in the web app
   * and leaves `path` untouched, while `path` is the CLI's and only the CLI
   * writes it (the REST upload routes deliberately do not accept one).
   */
  readonly path: string | null;
  readonly currentVersionId: VersionId | null;
  readonly archivedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly purgeAfter: Date | null;
  readonly createdAt: Date;
}

/**
 * Content-immutable: rows are never updated once written, except the one
 * tombstone transition — retention purge deletes the blob and sets `purgedAt`
 * (ADR 0001). Rows are never deleted; comments keep valid FKs forever.
 */
export interface DocumentVersion {
  readonly id: VersionId;
  readonly orgId: OrgId;
  readonly documentId: DocumentId;
  readonly seq: number;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly createdBy: UserId;
  readonly source: UploadSource;
  readonly purgedAt: Date | null;
  readonly createdAt: Date;
  /** API key the agent used to create this version, if any — null for web/human uploads. */
  readonly viaApiKeyId: string | null;
  /**
   * Optional "what changed" note set at upload (ADR 0003 §B). Immutable like
   * the rest of the row (INSERT-only table), org content, null when unset.
   */
  readonly changeNote: string | null;
}

export interface Comment {
  readonly id: CommentId;
  readonly orgId: OrgId;
  readonly documentId: DocumentId;
  /** Version the anchor was captured against — comments pin to versions. */
  readonly versionId: VersionId;
  readonly authorId: UserId;
  readonly body: string;
  readonly anchor: Anchor;
  readonly status: CommentStatus;
  readonly resolvedBy: UserId | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  /** API key the agent used to create this comment, if any — null for human authors. */
  readonly viaApiKeyId: string | null;
  /**
   * Suggested-edit subtype (Phase C, ADR 0002). A `comment` is plain
   * discussion; a `suggestion` additionally carries `proposedText` and moves
   * through `suggestionOutcome`.
   */
  readonly kind: CommentKind;
  /** Proposed replacement text for the anchored range; null unless a suggestion. */
  readonly proposedText: string | null;
  /** Suggestion lifecycle; null on a plain comment. */
  readonly suggestionOutcome: SuggestionOutcome | null;
  /** Version minted when the suggestion was accepted; null otherwise. */
  readonly appliedVersionId: VersionId | null;
}

export interface CommentReply {
  readonly id: ReplyId;
  readonly orgId: OrgId;
  readonly commentId: CommentId;
  /** Threading: null = direct reply to the comment; otherwise a reply to a reply. */
  readonly parentReplyId: ReplyId | null;
  readonly authorId: UserId;
  readonly body: string;
  readonly createdAt: Date;
  /** API key the agent used to create this reply, if any — null for human authors. */
  readonly viaApiKeyId: string | null;
}

/** Deepest allowed reply nesting: a direct reply is depth 1. */
export const MAX_REPLY_DEPTH = 5;

/**
 * Longest a comment or reply body may be, in characters (~350 words) —
 * enough for substantive review feedback while keeping a hostile or
 * accidental paste from bloating a row indefinitely. Comments have no count
 * cap on paid tiers (`TIER_PROFILES`, tier.ts), so length is the only guard. Starting
 * conservative; raise it if real usage needs more room.
 */
export const MAX_COMMENT_BODY_LENGTH = 2_000;

/**
 * Depth a new reply would land at, walking the parent chain. Returns
 * undefined when the chain is broken (parent not in `byId`) — callers treat
 * that as an invalid parent, never as depth 0.
 */
export function replyDepth(
  parentReplyId: ReplyId | null,
  byId: ReadonlyMap<ReplyId, CommentReply>,
): number | undefined {
  let depth = 1;
  let cursor = parentReplyId;
  while (cursor !== null) {
    const parent = byId.get(cursor);
    if (!parent) return undefined;
    depth += 1;
    // The composite self-FK makes true cycles impossible; the bound is a
    // guard against corrupted fixtures rather than expected data.
    if (depth > 1000) return undefined;
    cursor = parent.parentReplyId;
  }
  return depth;
}

/**
 * What a grant applies to. A `project` grant (ADR 0014, Phase 42) confers its
 * permission on every document currently in the project, resolved by
 * `documentPermissionFor` alongside any grant on the document itself — the
 * higher of the two wins. Project grants are named-user-only: never a link,
 * never a guest (`createProjectGrant`, org-admin gated).
 */
export type GrantSubject =
  | { readonly type: 'document'; readonly id: DocumentId }
  | { readonly type: 'project'; readonly id: ProjectId };

/**
 * Share grant. `permission` spans the full lattice as of ADR 0014 — `share`
 * buys creating/revoking grants on the subject, `edit` buys new versions and
 * inherits `share` by lattice. Both are structurally impossible on a guest
 * grant (`grantee_email` set): refused by a DB check, by grant creation, and
 * by `canEditDocument`/`canShareDocument` (CONSTITUTION.md §9). Link grants
 * stay capped at read/comment by policy (ADR 0008 decision 4, ADR 0014).
 */
export interface ShareGrant {
  readonly id: GrantId;
  readonly orgId: OrgId;
  readonly subject: GrantSubject;
  readonly grantee: { readonly type: 'link' } | { readonly type: 'user'; readonly userId: UserId };
  readonly permission: GrantablePermission;
  /** SHA-256 of the share token; token itself is shown once and never stored. */
  readonly tokenHash: string | null;
  /**
   * Expiry for external guest grants (Phase 18); `null` = never expires (all
   * org-internal link/user grants). An expired grant grants no access —
   * `listForUser`/`byTokenHash` exclude expired rows at read time.
   */
  readonly expiresAt: Date | null;
  /**
   * The external email a guest grant was issued to (Phase 18), for admin
   * display and comment attribution; `null` for all org-internal grants.
   */
  readonly granteeEmail: string | null;
  readonly createdBy: UserId;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
}

/**
 * Admin-sent invite to join an existing org (Phase 15). `tokenHash` is the
 * SHA-256 of the invite token; the token itself is shown once and never
 * stored, same pattern as `ShareGrant.tokenHash`.
 */
export interface OrgInvite {
  readonly id: InviteId;
  readonly orgId: OrgId;
  readonly email: string;
  readonly role: UserRole;
  readonly tokenHash: string;
  /** Null for operator-triggered invites (Phase 26.C) — an operator is never a `users` row. */
  readonly invitedBy: UserId | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
}

/** Enterprise `allowlist`-mode JIT membership entry (Phase 15). */
export interface AllowlistEntry {
  readonly id: AllowlistEntryId;
  readonly orgId: OrgId;
  readonly email: string;
  readonly addedBy: UserId;
  readonly createdAt: Date;
}
