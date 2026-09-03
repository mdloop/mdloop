import type {
  AllowlistEntry,
  Approval,
  ApprovalVerdict,
  Comment,
  CommentReply,
  Document,
  DocumentVersion,
  MentionCandidate,
  OrgInvite,
  Organization,
  Project,
  ReviewRequest,
  ReviewStatus,
  ShareGrant,
  User,
  UserRole,
} from '@vorlyn/domain';
import type {
  AllowlistEntryId,
  CommentId,
  DocumentId,
  InviteId,
  OrgId,
  ProjectId,
  PublicDocId,
  ReviewRequestId,
  UserId,
  VersionId,
} from '@vorlyn/shared';
import type { TenantContext } from '../tenant-context.js';

/** Inputs for creation are the entity minus server-assigned fields. */
export type NewProject = Pick<Project, 'name' | 'color'> & {
  /** The creating member (Phase 24); omitted/null only for legacy or system-seeded rows. */
  createdBy?: UserId | null;
};
export type NewDocument = Pick<Document, 'projectId' | 'title'> & {
  ownerId: UserId;
  /**
   * Repo-relative path (Phase 29); omitted/null for every manual upload, which
   * is why it is optional rather than required — only the sync CLI supplies one.
   */
  path?: string | null;
};
export type NewVersion = Pick<
  DocumentVersion,
  'documentId' | 'contentHash' | 'byteSize' | 'source'
> & {
  createdBy: UserId;
  viaApiKeyId?: string | null;
  /** Optional "what changed" note (ADR 0003 §B); persisted with the version, never editable after. */
  changeNote?: string | null;
};
export type NewComment = Pick<Comment, 'documentId' | 'versionId' | 'body' | 'anchor'> & {
  authorId: UserId;
  viaApiKeyId?: string | null;
  /**
   * Suggested-edit subtype (Phase C): the proposed replacement text. `null`
   * (or absent) creates a plain comment; a non-null value — an empty string
   * included (a "delete this" suggestion) — creates a suggestion with outcome
   * `open`. The repository derives `kind`/`suggestion_outcome` from this, so
   * the DB's kind-iff-proposed_text invariant is honored by construction.
   */
  proposedText?: string | null;
};
export type NewReply = Pick<CommentReply, 'commentId' | 'parentReplyId' | 'body'> & {
  authorId: UserId;
  viaApiKeyId?: string | null;
};
export type NewShareGrant = Pick<ShareGrant, 'subject' | 'grantee' | 'permission' | 'tokenHash'> & {
  createdBy: UserId;
  /** Guest grants (Phase 18) carry these; all org-internal grants leave them null. */
  expiresAt?: Date | null;
  granteeEmail?: string | null;
};
export type NewOrgInvite = Pick<OrgInvite, 'email' | 'role' | 'tokenHash' | 'expiresAt'> & {
  invitedBy: UserId | null;
};
export type NewAllowlistEntry = Pick<AllowlistEntry, 'email'> & { addedBy: UserId };

/**
 * Tenant-scoped repositories. Every method takes a TenantContext; persistence
 * sets the RLS session variable from it inside the same transaction. None of
 * these methods can be called without naming the tenant.
 */
export interface ProjectPatch {
  readonly name?: string;
  readonly color?: string;
}

export interface ProjectRepository {
  create(ctx: TenantContext, input: NewProject): Promise<Project>;
  byId(ctx: TenantContext, id: ProjectId): Promise<Project | undefined>;
  list(ctx: TenantContext): Promise<Project[]>;
  update(ctx: TenantContext, id: ProjectId, patch: ProjectPatch): Promise<Project | undefined>;
  setArchived(ctx: TenantContext, id: ProjectId, archived: boolean): Promise<boolean>;
  /** Deletes project; documents in it are unfiled (project_id -> null), not deleted. */
  remove(ctx: TenantContext, id: ProjectId): Promise<boolean>;
}

/**
 * Listing view: `all` = live documents, `unfiled` = live without a project,
 * `archived` = archived but not deleted. Soft-deleted rows never list.
 */
export interface DocumentListFilter {
  readonly view?: 'all' | 'unfiled' | 'archived';
  readonly projectId?: ProjectId;
}

/** Keyset cursor position for org-export paging — (created_at, id) ascending. */
export interface DocumentExportKeyset {
  readonly createdAt: Date;
  readonly id: DocumentId;
}

/**
 * Who is asking, for the home-overview access predicate (Phase 24.F): admins
 * see the whole org, everyone else only documents they own or are granted —
 * the exact owner/grant/admin rule `PgSearchRepository.search` enforces, now
 * pushed into the overview page query instead of filtered in JS after a full
 * org scan.
 */
export interface OverviewAccess {
  readonly userId: UserId;
  readonly role: UserRole;
}

/** Keyset cursor position for the home-overview page — (lastActivityAt, id) descending. */
export interface OverviewKeyset {
  readonly lastActivityAt: Date;
  readonly id: DocumentId;
}

/** One home-overview page row: the document plus its comment counts and activity time. */
export interface OverviewPageRow {
  readonly document: Document;
  readonly open: number;
  readonly resolved: number;
  readonly lastActivityAt: Date;
}

/**
 * One project-index row (Phase 29): the document plus its open-comment count.
 * Sibling of `OverviewPageRow` — same access predicate, same aggregate — but
 * unpaged and open-only, because the workspace tree has to total a folder's
 * unresolved comments across the WHOLE project. Aggregating over `/overview`'s
 * 50-row page would under-report every folder past the first page.
 */
export interface ProjectIndexRow {
  readonly document: Document;
  readonly open: number;
}

/** Home-overview lane counts + per-project open-comment signal, access-scoped. */
export interface OverviewCounts {
  readonly all: number;
  readonly unfiled: number;
  readonly archived: number;
  readonly openByProject: { readonly projectId: ProjectId; readonly open: number }[];
}

export interface DocumentRepository {
  create(ctx: TenantContext, input: NewDocument): Promise<Document>;
  byId(ctx: TenantContext, id: DocumentId): Promise<Document | undefined>;
  list(ctx: TenantContext, filter?: DocumentListFilter): Promise<Document[]>;
  /**
   * Keyset-paged read for org export (whole-org, admin-only): every
   * non-deleted document — live AND archived, current version or not — ordered
   * (created_at, id) ascending, strictly after `after` (null = first page).
   * Returns at most `limit` rows. Unlike `list`, there is no access predicate
   * and the keyset lives in SQL, so export memory stays flat at any org size.
   */
  listForExport(
    ctx: TenantContext,
    after: DocumentExportKeyset | null,
    limit: number,
  ): Promise<Document[]>;
  /**
   * The home screen's page in ONE query (Phase 24.F): documents in the lane
   * the caller can access (owner/grant/admin predicate, same as search),
   * joined to their comment counts + activity time, ordered
   * (lastActivityAt desc, id desc) and keyset-sliced to `limit`. The whole
   * scan, sort and access filter live in SQL — the previous path pulled the
   * full org document set into JS (twice) and sorted there. Fetch `limit + 1`
   * to detect a further page. `lane` reuses the `DocumentListFilter` views.
   */
  overviewPage(
    ctx: TenantContext,
    access: OverviewAccess,
    lane: DocumentListFilter,
    after: OverviewKeyset | null,
    limit: number,
  ): Promise<OverviewPageRow[]>;
  /**
   * Access-scoped lane counts (all/unfiled/archived) and per-project open
   * signal for the home sidebar (Phase 24.F) — bounded COUNT/SUM aggregates,
   * never the full document rows the old path materialized in JS.
   */
  overviewCounts(ctx: TenantContext, access: OverviewAccess): Promise<OverviewCounts>;
  /**
   * Access-scoped count of the LIVE (non-archived, non-deleted) documents in
   * one project (Phase 29) — the cheap pre-check the workspace tree runs
   * before committing to the unpaged fetch below, so an oversized project
   * costs one COUNT rather than thousands of rows plus their aggregates.
   */
  countLiveInProject(
    ctx: TenantContext,
    access: OverviewAccess,
    projectId: ProjectId,
  ): Promise<number>;
  /**
   * Every live document in one project with its open-comment count (Phase 29),
   * access-scoped exactly like `overviewPage`, deliberately UNPAGED — see
   * `ProjectIndexRow`. Callers must bound it with `countLiveInProject` first.
   */
  listProjectIndex(
    ctx: TenantContext,
    access: OverviewAccess,
    projectId: ProjectId,
  ): Promise<ProjectIndexRow[]>;
  /**
   * The live document occupying `path` in `projectId`, if any (Phase 29) —
   * the pre-check behind `path_taken`, mirroring
   * `documents_project_path_uniq` (deleted rows exempt, archived rows not, a
   * null `projectId` matched as a value). The index is still the guarantee;
   * this only turns the common collision into a typed error.
   */
  documentIdAtPath(
    ctx: TenantContext,
    projectId: ProjectId | null,
    path: string,
  ): Promise<DocumentId | undefined>;
  /**
   * Reassigns a document's project. Deliberately does NOT touch `path`: the
   * two are orthogonal (Phase 29) — a project move is a human action in the
   * web app, the in-project path is the sync CLI's.
   */
  moveToProject(ctx: TenantContext, id: DocumentId, projectId: ProjectId | null): Promise<boolean>;
  setArchived(ctx: TenantContext, id: DocumentId, archived: boolean): Promise<boolean>;
  softDelete(ctx: TenantContext, id: DocumentId, purgeAfter: Date): Promise<boolean>;
  /** Permanently removes the document row and all dependent rows (versions, comments, grants). */
  purge(ctx: TenantContext, id: DocumentId): Promise<void>;
  /**
   * Non-deleted documents in the org (Phase 33.D) — the tier doc cap counts
   * these. Mirrors `UploadTx.activeDocCount`'s semantics but reachable outside
   * the upload transaction, for read-only pre-flight status checks (e.g. the
   * sync CLI warning about headroom before a batch push starts). Unlike
   * `UploadTx.activeDocCount`, this does NOT take the per-org advisory lock —
   * there is no following insert in the same transaction for it to serialize
   * against, so taking the lock here would only contend against real uploads
   * for no benefit.
   */
  activeCount(ctx: TenantContext): Promise<number>;
  /**
   * Non-deleted documents in one project (Phase 33.D) — the tier per-project
   * doc cap counts these. Read-only sibling of `activeCount`, same no-lock
   * reasoning.
   */
  activeCountInProject(ctx: TenantContext, projectId: ProjectId): Promise<number>;
}

export interface VersionRepository {
  /** Appends the next version (seq assigned transactionally) and moves current_version_id. */
  append(ctx: TenantContext, input: NewVersion): Promise<DocumentVersion>;
  byId(ctx: TenantContext, id: VersionId): Promise<DocumentVersion | undefined>;
  listForDocument(ctx: TenantContext, documentId: DocumentId): Promise<DocumentVersion[]>;
  /**
   * Tombstone transition (ADR 0001): sets purged_at on a live version and
   * returns the updated row (undefined if missing or already tombstoned).
   * The only permitted version UPDATE — DB trigger rejects everything else.
   */
  tombstone(ctx: TenantContext, id: VersionId): Promise<DocumentVersion | undefined>;
  /**
   * Total bytes of every LIVE (non-tombstoned) version blob in the org (Phase
   * 39.B) — the storage lane of `orgUsage()`. Tenant-scoped via RLS like every
   * other method here; unlike `pg-organization-directory-repository.ts`'s
   * identically-shaped operator-side query, this one runs as `vorlyn_app`
   * under `withTenant`, never `vorlyn_provisioner` — a customer-reachable
   * read must never take the cross-org bypass. No tier ceiling exists for
   * storage today (see `TierCeilings`), so this reports bytes used with
   * nothing to compare against.
   */
  storageBytesUsed(ctx: TenantContext): Promise<number>;
}

/** One full-text search hit — a document whose current version matched. */
export interface SearchHit {
  /** Discriminant against `CommentSearchHit` in a mixed result stream. */
  readonly kind: 'document';
  readonly documentId: DocumentId;
  readonly title: string;
  readonly projectId: ProjectId | null;
  readonly path: string | null;
  readonly rank: number;
}

/**
 * One comment-search hit (ADR 0003 §C) — comment-grained so the UI can jump to
 * the anchor, a discriminated sibling of `SearchHit`. `snippet` is a
 * server-built `ts_headline` excerpt (org content — fine in a response, never
 * in logs). `anchor`/`versionId`/`status` carry what jump-to-anchor needs.
 */
export interface CommentSearchHit {
  readonly kind: 'comment';
  readonly commentId: CommentId;
  readonly documentId: DocumentId;
  readonly documentTitle: string;
  readonly snippet: string;
  readonly anchor: Comment['anchor'];
  readonly versionId: VersionId;
  readonly status: Comment['status'];
  readonly authorId: UserId;
  readonly createdAt: Date;
  readonly rank: number;
}

/**
 * Permission-scoped full-text search. RLS bounds results to the caller's org;
 * each method further narrows to documents the caller owns, is granted, or (as
 * admin) the whole org — search is never org-wide (ARCHITECTURE.md §9). Comment
 * search (ADR 0003 §C) replicates that exact owner/grant/admin predicate joined
 * through the comment's document, plus excludes soft-deleted comments — RLS is
 * the backstop, not the filter.
 */
export interface SearchRepository {
  search(ctx: TenantContext, userId: UserId, role: UserRole, query: string): Promise<SearchHit[]>;
  searchComments(
    ctx: TenantContext,
    userId: UserId,
    role: UserRole,
    query: string,
  ): Promise<CommentSearchHit[]>;
}

export type CommentStatus = 'open' | 'resolved';

/** Keyset cursor position for the thread list — (created_at, id) ascending. */
export interface CommentKeyset {
  readonly createdAt: Date;
  readonly id: CommentId;
}

/** A stored @mention on a comment (ADR 0003 §D), display name joined at read
 *  time so it renders without a directory lookup (guests can't do one). */
export interface CommentMention {
  readonly userId: UserId;
  readonly displayName: string;
}

export interface CommentRepository {
  create(ctx: TenantContext, input: NewComment): Promise<Comment>;
  /**
   * Cap-enforcing create (Phase 24): acquires a per-org advisory lock, counts
   * live top-level comments on the document, and inserts only if the count is
   * below `limit` — all in ONE transaction, closing the read→check→insert
   * TOCTOU. `limit` null (paid tiers) skips the count entirely. Returns
   * `undefined` when the document is already at the cap, which the use-case
   * surfaces as `comment_cap_exceeded`.
   */
  createWithinCap(
    ctx: TenantContext,
    input: NewComment,
    limit: number | null,
  ): Promise<Comment | undefined>;
  byId(ctx: TenantContext, id: CommentId): Promise<Comment | undefined>;
  listForDocument(
    ctx: TenantContext,
    documentId: DocumentId,
    status?: CommentStatus,
  ): Promise<Comment[]>;
  /**
   * Keyset-paged thread list (Phase 24.F): live top-level comments on the
   * document — optionally one status lane — ordered (created_at, id) ascending,
   * strictly after `after` (null = first page), at most `limit` rows. A
   * document with thousands of comments no longer loads them all; the reply/
   * upvote/mention reads are scoped to the returned page via the `*ForComments`
   * methods below. `get_feedback_bundle` deliberately does NOT page (it is the
   * complete unresolved bundle for agents, ARCHITECTURE.md §9).
   */
  listForDocumentPage(
    ctx: TenantContext,
    documentId: DocumentId,
    status: CommentStatus | undefined,
    after: CommentKeyset | null,
    limit: number,
  ): Promise<Comment[]>;
  /** Top-level comments on the document — the tier comment cap counts these. */
  countForDocument(ctx: TenantContext, documentId: DocumentId): Promise<number>;
  /** Open/resolved split for one document — thread-list header counts. */
  statusCounts(ctx: TenantContext, documentId: DocumentId): Promise<Record<CommentStatus, number>>;
  /** Versions pinned by open comments — the purge worker never touches these (ADR 0001). */
  openCommentVersionIds(ctx: TenantContext, documentId: DocumentId): Promise<VersionId[]>;
  resolve(ctx: TenantContext, id: CommentId, resolvedBy: UserId): Promise<boolean>;
  /**
   * Resolve a suggestion (Phase C): atomically flip an OPEN suggestion to
   * `accepted` (with `appliedVersionId` = the minted version) or `rejected`
   * (null). The `where kind='suggestion' and suggestion_outcome='open'` guard
   * makes double-resolve a lost update — returns undefined then, which the
   * use-case surfaces as a conflict, never a silent second resolution.
   */
  setSuggestionOutcome(
    ctx: TenantContext,
    id: CommentId,
    outcome: 'accepted' | 'rejected',
    appliedVersionId: VersionId | null,
  ): Promise<Comment | undefined>;
  /**
   * Lazily backfill applied_version_id on an already-accepted suggestion, once
   * the re-anchor pipeline confirms the current version's text at the resolved
   * range matches the proposal exactly (ADR 0007). Conditional on
   * suggestion_outcome='accepted' AND applied_version_id IS NULL, so a
   * concurrent materialization (or a suggestion that was somehow rejected in
   * between — it can't be, outcome is terminal, but defense in depth) is a
   * no-op returning undefined, never a silent overwrite.
   */
  markSuggestionApplied(
    ctx: TenantContext,
    id: CommentId,
    appliedVersionId: VersionId,
  ): Promise<Comment | undefined>;
  /** Author-only body edit — anchor, author, and version never change. */
  update(ctx: TenantContext, id: CommentId, body: string): Promise<Comment>;
  /** Author-only soft delete — true if a row was actually deleted. */
  delete(ctx: TenantContext, id: CommentId): Promise<boolean>;
  addReply(ctx: TenantContext, input: NewReply): Promise<CommentReply>;
  listReplies(ctx: TenantContext, commentId: CommentId): Promise<CommentReply[]>;
  /** All replies on a document's comments in one read — thread listing never loops per comment. */
  listRepliesForDocument(ctx: TenantContext, documentId: DocumentId): Promise<CommentReply[]>;
  /** Replies for exactly the given comments — the paged thread list's bounded read (Phase 24.F). */
  listRepliesForComments(ctx: TenantContext, commentIds: CommentId[]): Promise<CommentReply[]>;
  /** Toggles the actor's upvote (insert if absent, else delete); returns the new state + total. */
  toggleUpvote(
    ctx: TenantContext,
    commentId: CommentId,
    userId: UserId,
  ): Promise<{ upvoted: boolean; count: number }>;
  /** Per-comment upvote counts and whether `userId` upvoted, for one document in one query. */
  upvotesForDocument(
    ctx: TenantContext,
    documentId: DocumentId,
    userId: UserId,
  ): Promise<Map<CommentId, { count: number; mine: boolean }>>;
  /** Upvote counts + `mine` for exactly the given comments (Phase 24.F paged thread list). */
  upvotesForComments(
    ctx: TenantContext,
    commentIds: CommentId[],
    userId: UserId,
  ): Promise<Map<CommentId, { count: number; mine: boolean }>>;
  /**
   * Doc-scoped @mention candidates (ADR 0003 §D): the document owner, everyone
   * who has authored a comment or reply on it, and its requested reviewers —
   * with display names, in one query. NEVER the org directory, so a guest can
   * only mention people already on the document.
   */
  mentionCandidates(ctx: TenantContext, documentId: DocumentId): Promise<MentionCandidate[]>;
  /**
   * Replaces a comment's stored mentions with exactly `mentionedUserIds`
   * (delete-all + re-insert), so re-parsing an edited body is idempotent. Store
   * + display only — writes no notification (ADR 0003 §D).
   */
  replaceMentions(
    ctx: TenantContext,
    commentId: CommentId,
    mentionedUserIds: UserId[],
  ): Promise<void>;
  /** Every comment's mentions on one document in one query, display name joined. */
  mentionsForDocument(
    ctx: TenantContext,
    documentId: DocumentId,
  ): Promise<Map<CommentId, CommentMention[]>>;
  /** Mentions for exactly the given comments, display name joined (Phase 24.F paged thread list). */
  mentionsForComments(
    ctx: TenantContext,
    commentIds: CommentId[],
  ): Promise<Map<CommentId, CommentMention[]>>;
}

export interface ShareGrantRepository {
  create(ctx: TenantContext, input: NewShareGrant): Promise<ShareGrant>;
  listForDocument(ctx: TenantContext, documentId: DocumentId): Promise<ShareGrant[]>;
  /**
   * Grants on a project itself (ADR 0014). Deliberately separate from
   * `listForDocument` — a project grant is never spliced into a document's
   * own grant list, it's listed on the project's own share surface.
   */
  listForProject(ctx: TenantContext, projectId: ProjectId): Promise<ShareGrant[]>;
  /**
   * Active (non-revoked, non-expired) grants naming this user as grantee.
   * Expiry bites here (Phase 18): a guest grant past `expires_at` grants no
   * access at permission-check time — there is no sweep.
   */
  listForUser(ctx: TenantContext, userId: UserId): Promise<ShareGrant[]>;
  /** Active (non-revoked, non-expired) grant matching this token hash — RLS scopes to the caller's org. */
  byTokenHash(ctx: TenantContext, tokenHash: string): Promise<ShareGrant | undefined>;
  /**
   * Distinct emails of active (non-revoked, non-expired) guest grants in the
   * org (Phase 18) — the external-guest cap counts these.
   */
  activeGuestEmails(ctx: TenantContext): Promise<string[]>;
  /**
   * Cap-enforcing guest-grant create (Phase 24): under a per-org advisory
   * lock, recounts distinct active guest emails *other than* `guestEmail`
   * (re-shares never consume a seat) and inserts only while under `limit`
   * (`null` = uncapped). Returns undefined when the cap would be exceeded —
   * two concurrent shares to new emails at ceiling-1 can no longer both land.
   */
  createWithinGuestCap(
    ctx: TenantContext,
    input: NewShareGrant,
    guestEmail: string,
    limit: number | null,
  ): Promise<ShareGrant | undefined>;
  /** Re-share extend (Phase 18): bump a guest grant's permission, token, and expiry. */
  extendGuestGrant(
    ctx: TenantContext,
    id: ShareGrant['id'],
    patch: { permission: ShareGrant['permission']; tokenHash: string; expiresAt: Date },
  ): Promise<ShareGrant>;
  revoke(ctx: TenantContext, id: ShareGrant['id']): Promise<boolean>;
}

/**
 * Guest users (role 'guest', Phase 18): tenant-scoped find-or-create for the
 * synthetic users row backing an external guest share. Synthetic
 * `workos_user_id` = `guest:<uuid>` guarantees a real WorkOS sign-in can
 * never resolve to a guest.
 */
export interface GuestUserRepository {
  /** Existing guest user for this org+email, if any. */
  guestByEmail(ctx: TenantContext, email: string): Promise<User | undefined>;
  /** Creates a guest user (displayName = email, role 'guest'). */
  createGuest(ctx: TenantContext, email: string): Promise<User>;
}

/** Admin-managed invites (Phase 15) — always inside the sending admin's tenant context. */
export interface OrgInviteRepository {
  create(ctx: TenantContext, input: NewOrgInvite): Promise<OrgInvite>;
  /**
   * Cap-enforcing invite create (Phase 24): under a per-org advisory lock,
   * recounts occupied seats (human members + pending invites) and inserts
   * only while under `limit` (`null` = uncapped). Returns undefined when the
   * seat ceiling would be exceeded — closes the send-time TOCTOU between the
   * domain `canSendInvite` check and the insert.
   */
  createWithinSeatCap(
    ctx: TenantContext,
    input: NewOrgInvite,
    limit: number | null,
  ): Promise<OrgInvite | undefined>;
  list(ctx: TenantContext): Promise<OrgInvite[]>;
  /** Not accepted, not revoked (may or may not be expired yet) — counts toward the seat ceiling. */
  countPending(ctx: TenantContext): Promise<number>;
  revoke(ctx: TenantContext, id: InviteId): Promise<boolean>;
  /**
   * Operator-triggered sibling of `createWithinSeatCap` (Phase 26.C): no
   * `TenantContext`/RLS to lean on, so `orgId` is explicit and both the seat
   * recount and the insert filter on it directly. `invitedBy` is always null
   * here — an operator is never a `users` row, and the composite FK on
   * `(invited_by, org_id)` is satisfied automatically when `invited_by` is
   * null (Postgres MATCH SIMPLE skips the check).
   */
  createWithinSeatCapForOrg(
    orgId: OrgId,
    input: Omit<NewOrgInvite, 'invitedBy'>,
    limit: number | null,
  ): Promise<OrgInvite | undefined>;
}

/** Admin-managed enterprise `allowlist`-mode entries (Phase 15), tenant-scoped. */
export interface AllowlistRepository {
  add(ctx: TenantContext, input: NewAllowlistEntry): Promise<AllowlistEntry>;
  list(ctx: TenantContext): Promise<AllowlistEntry[]>;
  remove(ctx: TenantContext, id: AllowlistEntryId): Promise<boolean>;
}

/**
 * Cached outcome of re-anchoring one comment against one version
 * (comment_anchor_resolutions). Offsets are null for orphans and for anchors
 * without a text position (document-level).
 */
export interface AnchorResolution {
  readonly commentId: CommentId;
  readonly versionId: VersionId;
  readonly method: 'exact' | 'context' | 'fuzzy' | 'orphan';
  readonly confidence: number;
  readonly start: number | null;
  readonly end: number | null;
}

export interface AnchorResolutionRepository {
  forVersion(ctx: TenantContext, versionId: VersionId): Promise<AnchorResolution[]>;
  upsert(ctx: TenantContext, resolution: AnchorResolution): Promise<void>;
  /**
   * Prune cache rows older than `olderThan` whose version is no longer any
   * document's current version. The resolution cache is fully recomputable and
   * otherwise grows as comments × versions (Phase 24.D); pruning stale,
   * non-current rows bounds it. Current-version rows are always kept — they are
   * the hot read path. Returns the number of rows deleted.
   */
  pruneStale(ctx: TenantContext, olderThan: Date): Promise<number>;
}

/**
 * Per-document activity summary — homepage attention signals and sorting.
 * One row per live (non-deleted) document, zero counts included;
 * `lastActivityAt` = latest of document creation, version upload, comment.
 */
export interface CommentRollup {
  readonly documentId: DocumentId;
  readonly open: number;
  readonly resolved: number;
  readonly lastActivityAt: Date;
}

export interface CommentRollupReader {
  rollup(ctx: TenantContext): Promise<CommentRollup[]>;
}

export interface NewReviewRequest {
  documentId: DocumentId;
  reviewerUserId: UserId;
  requestedBy: UserId;
}

export interface NewApproval {
  documentId: DocumentId;
  versionId: VersionId;
  reviewerUserId: UserId;
  verdict: ApprovalVerdict;
  note: string | null;
  viaApiKeyId?: string | null;
}

/** Derived review status for one live document — the /overview signal. */
export interface ReviewRollup {
  readonly documentId: DocumentId;
  readonly status: ReviewStatus;
}

/**
 * Sign-off workflow persistence (Phase B). Read methods join the reviewer's
 * display name/email at read time — guests can't call listOrgUsers, so the
 * identity travels with the row. Approvals are append-only (createApproval
 * only; no update/delete), enforced at the DB grant level.
 */
export interface ReviewRepository {
  createRequest(ctx: TenantContext, input: NewReviewRequest): Promise<ReviewRequest>;
  /** Non-revoked requests on the document, with reviewer identity joined. */
  activeRequestsForDocument(ctx: TenantContext, documentId: DocumentId): Promise<ReviewRequest[]>;
  /** Revoke (soft): true if an active request row was actually revoked. */
  revokeRequest(ctx: TenantContext, id: ReviewRequestId): Promise<boolean>;
  createApproval(ctx: TenantContext, input: NewApproval): Promise<Approval>;
  /** Every verdict on the document (all versions), newest first, identity joined. */
  approvalsForDocument(ctx: TenantContext, documentId: DocumentId): Promise<Approval[]>;
  /**
   * Derived review status in ONE grouped query joining
   * documents.current_version_id — mirrors CommentRollupReader, never a query
   * per document. `documentIds` scopes it to exactly the home page's documents
   * (Phase 24.F): the overview only decorates the ~50 rows it returns, so it no
   * longer derives status for every document in the org. Undefined = the whole
   * live org (unchanged behavior); an empty array short-circuits to `[]`.
   */
  reviewRollup(ctx: TenantContext, documentIds?: DocumentId[]): Promise<ReviewRollup[]>;
}

export interface UploadLedgerRepository {
  record(ctx: TenantContext, versionId: VersionId, byteSize: number): Promise<void>;
}

/**
 * Retention sweep support. `listDue` runs privileged (no tenant context —
 * the sweep is a system job spanning orgs) but returns only opaque IDs;
 * the purge itself goes back through the RLS-scoped document purge.
 */
export interface RetentionSweepRepository {
  listDue(now: Date, limit?: number): Promise<{ orgId: OrgId; documentId: DocumentId }[]>;
  purge(orgId: OrgId, documentId: DocumentId): Promise<void>;
}

/**
 * Version auto-purge sweep support (ADR 0001). Like the retention sweep, the
 * org scan runs privileged but returns only opaque ids; all per-org reads and
 * the tombstone writes go through the normal RLS-scoped repositories.
 */
export interface VersionPurgeSweepRepository {
  listOrgIds(limit?: number): Promise<OrgId[]>;
}

/**
 * Org + user provisioning happens outside a tenant context (there is no org
 * yet); this is the only repository that runs as a privileged, non-RLS step.
 * It never reads across orgs — only creates and looks up by unique keys.
 */
export interface DirectoryRepository {
  /** Tier defaults to 'team' (pre-billing orgs); free personal signup passes 'free'. */
  createOrganization(name: string, tier?: 'free' | 'team' | 'enterprise'): Promise<Organization>;
  createUser(
    orgId: OrgId,
    input: Pick<User, 'workosUserId' | 'email' | 'displayName' | 'role'>,
  ): Promise<User>;
  /**
   * Cap-enforcing member create (Phase 24): under a per-org advisory lock,
   * recounts human members (guests excluded) and inserts only while under
   * `limit` (`null` = uncapped). Returns undefined at the ceiling — two
   * concurrent SSO JIT joins at ceiling-1 cannot both land.
   */
  createUserWithinSeatCap(
    orgId: OrgId,
    input: Pick<User, 'workosUserId' | 'email' | 'displayName' | 'role'>,
    limit: number | null,
  ): Promise<User | undefined>;
  organizationById(id: OrgId): Promise<Organization | undefined>;
  userByWorkosId(workosUserId: string): Promise<User | undefined>;
  /**
   * Human member count — privileged read for seat sync right after a join
   * (Phase 15). Excludes role 'guest' (Phase 18): guests never occupy a seat.
   */
  memberCount(orgId: OrgId): Promise<number>;
  /** Enterprise SSO JIT: org whose sso_connection_id matches this WorkOS connection. */
  organizationBySsoConnection(connectionId: string): Promise<Organization | undefined>;
  /** Enterprise `allowlist`-mode JIT check. */
  isAllowlisted(orgId: OrgId, email: string): Promise<boolean>;
  /**
   * Invite acceptance happens before any tenant context exists (the token IS
   * the identity, pre-account) — same trust boundary as the rest of this
   * repository.
   */
  inviteByTokenHash(tokenHash: string): Promise<OrgInvite | undefined>;
  markInviteAccepted(id: InviteId): Promise<void>;
  /**
   * Guest-share redeem (Phase 18) runs before any tenant context exists — the
   * token IS the identity, same trust boundary as invite acceptance. Looks up
   * an active guest grant by token hash across orgs; the returned grant carries
   * its `orgId`, and the use case re-checks revoke/expiry and the org flag.
   */
  guestGrantByTokenHash(tokenHash: string): Promise<ShareGrant | undefined>;
}

/**
 * One published Public Docs Hub snapshot (ADR 0004). Deliberately not a
 * domain `Document`/`DocumentVersion` — it lives outside the tenant model
 * entirely, and carries only what the anonymous read routes need.
 */
/** Keyset cursor position for the public hub list — (publishedAt, id) descending. */
export interface PublicHubKeyset {
  readonly publishedAt: Date;
  readonly id: PublicDocId;
}

export interface PublicDoc {
  readonly id: PublicDocId;
  readonly slug: string;
  readonly title: string;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly seq: number;
  readonly publishedAt: Date;
  readonly updatedAt: Date;
}

/**
 * Public Docs Hub persistence (ADR 0004). `publish`/`unpublish` are the one
 * bridge from the tenant model — they run via `withProvisioner` and take
 * provenance (source org/document/version, publisher) for audit only. The
 * read methods (`getBySlug`/`list`/`search`) take no actor/TenantContext at
 * all: there is no tenant context on the anonymous read path, and they run
 * via `withPublicReader`.
 */
export interface PublicHubRepository {
  /**
   * Upsert by slug — publishing the same slug again bumps `seq` and
   * overwrites title/content_hash/tsv (re-publish, never a new row).
   */
  publish(input: {
    slug: string;
    title: string;
    /** Used to build `tsv` server-side (title weight A, body weight B) — never stored as a column. */
    body: string;
    contentHash: string;
    byteSize: number;
    sourceOrgId: OrgId;
    sourceDocumentId: DocumentId;
    sourceVersionId: VersionId;
    publishedBy: UserId;
  }): Promise<PublicDoc>;
  getBySlug(slug: string): Promise<PublicDoc | null>;
  /**
   * Published docs newest first, keyset-paged over (published_at, id)
   * descending (Phase 24.F): `after` null = first page, at most `limit` rows.
   * The unauthenticated `/public/docs` route can no longer pull the whole hub
   * in one unbounded scan.
   */
  list(after?: PublicHubKeyset | null, limit?: number): Promise<PublicDoc[]>;
  search(query: string): Promise<(PublicDoc & { snippet: string })[]>;
  unpublish(slug: string): Promise<void>;
}
