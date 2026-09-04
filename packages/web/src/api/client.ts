/**
 * Same-origin API client. All paths go through `/api` (vite proxy in dev,
 * reverse proxy in prod) so cookies ride along without CORS.
 */

export interface Me {
  userId: string;
  orgId: string;
  role: 'admin' | 'member' | 'guest';
}

export interface ProjectDto {
  id: string;
  name: string;
  color: string;
  archivedAt: string | null;
  createdAt: string;
  /** Null for projects predating Phase 24 — the menu treats those as admin-only. */
  createdBy: string | null;
}

export interface DocumentDto {
  id: string;
  projectId: string | null;
  ownerId: string;
  title: string;
  currentVersionId: string | null;
  archivedAt: string | null;
  createdAt: string;
  /** Present on single-document reads: the caller's effective permission
   *  (`read < comment < share < edit`, ADR 0014). */
  myPermission?: 'read' | 'comment' | 'share' | 'edit';
  /** Repo-relative path from the sync CLI mirror (Phase 29); null = no repo origin,
   *  CLI-owned and read-only in the web app. */
  path: string | null;
}

export interface GrantDto {
  id: string;
  grantee: { type: 'link' } | { type: 'user'; userId: string };
  /** `share`/`edit` only ever appear on a named user grant (ADR 0008, ADR 0014). */
  permission: 'read' | 'comment' | 'share' | 'edit';
  /** Guest grants (Phase 18): external email + expiry; null for internal. */
  granteeEmail: string | null;
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
}

/** A project-level share grant (ADR 0014, org-admin only to create/revoke) —
 *  never a guest/link grantee, so no `granteeEmail`/`expiresAt` unlike
 *  `GrantDto`. A grant here confers its permission on every document
 *  currently in the project, resolved alongside any grant on the document
 *  itself (higher wins). */
export interface ProjectGrantDto {
  id: string;
  grantee: { type: 'user'; userId: string };
  permission: 'read' | 'comment' | 'share' | 'edit';
  createdBy: string;
  createdAt: string;
}

export interface OrgUserDto {
  id: string;
  displayName: string;
  /** Null when hidden by the sharing-mode policy (Phase 24): link-mode members see names only. */
  email: string | null;
  /** Never `guest` — `listUsersPage` excludes guests (they're external identities, not members). */
  role: 'admin' | 'member';
}

export interface RollupEntry {
  documentId: string;
  open: number;
  resolved: number;
  lastActivityAt: string;
}

/** One home-screen payload: lane documents + sidebar signals in one request. */
export interface OverviewDocumentDto extends DocumentDto {
  open: number;
  resolved: number;
  lastActivityAt: string;
  /** Derived sign-off status (Phase B) — the home-list review chip. */
  reviewStatus: ReviewStatusValue;
}

export interface OverviewDto {
  documents: OverviewDocumentDto[];
  nextCursor: string | null;
  projects: ProjectDto[];
  counts: { all: number; unfiled: number; archived: number };
  openByProject: { projectId: string; open: number }[];
}

export type DocumentView = 'all' | 'unfiled' | 'archived';

/** One document row in a project's workspace tree (Phase 29). Flat — the
 *  client splits `path` on `/` and builds the hierarchy. */
export interface ProjectTreeDocumentDto {
  id: string;
  title: string;
  path: string | null;
  openCommentCount: number;
  reviewStatus: ReviewStatusValue;
}

export interface ProjectTreeDto {
  projectId: string;
  /** True when the project is over the server's row bound — `documents` is
   *  empty and the caller should fall back to the paged flat list. */
  tooLarge: boolean;
  documentCount: number;
  documents: ProjectTreeDocumentDto[];
}

/* Anchor DTOs mirror the wire shape (domain types stay server-side). */
export interface TextAnchorDto {
  type: 'text';
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
}

export interface DiagramAnchorDto {
  type: 'diagram';
  blockIndex: number;
  kind: 'node' | 'edge' | 'actor' | 'message';
  stableId: string | { index: number; text: string };
}

export interface DocumentAnchorDto {
  type: 'document';
}

export type AnchorDto = TextAnchorDto | DiagramAnchorDto | DocumentAnchorDto;

/** Comment subtype (Phase C, ADR 0002): a suggestion carries proposed
 *  replacement text for its anchored range and moves through an outcome. */
export type CommentKind = 'comment' | 'suggestion';
export type SuggestionOutcome = 'open' | 'accepted' | 'rejected';

export interface CommentDto {
  id: string;
  documentId: string;
  versionId: string;
  authorId: string;
  body: string;
  anchor: AnchorDto;
  status: 'open' | 'resolved';
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
  /** Name of the API key that created this comment, if any — null for human authors. */
  viaApiKeyName: string | null;
  /** Plain discussion vs. a suggested edit — the latter carries the three
   *  fields below (Phase C). */
  kind: CommentKind;
  /** Proposed replacement text for the anchored range; null unless a suggestion. */
  proposedText: string | null;
  /** Suggestion lifecycle; null on a plain comment. */
  suggestionOutcome: SuggestionOutcome | null;
  /** Version minted when the suggestion was accepted; null otherwise. */
  appliedVersionId: string | null;
}

export interface ReplyDto {
  id: string;
  commentId: string;
  /** Threading: null = direct reply to the comment. Nesting caps at depth 5. */
  parentReplyId: string | null;
  authorId: string;
  body: string;
  createdAt: string;
  /** Name of the API key that created this reply, if any — null for human authors. */
  viaApiKeyName: string | null;
}

export interface ResolutionDto {
  method: 'exact' | 'context' | 'fuzzy' | 'orphan';
  confidence: number;
  start: number | null;
  end: number | null;
}

/** A stored @mention on a comment (ADR 0003 §D), display name joined server-side
 *  so the rail highlights it without a directory lookup (guests can't do one). */
export interface MentionDto {
  userId: string;
  displayName: string;
}

export interface ThreadDto {
  comment: CommentDto;
  replies: ReplyDto[];
  /** How the anchor lands on the current version (server re-anchoring). */
  resolution: ResolutionDto;
  /** Priority signal — reviewers upvote; `mine` = the signed-in user upvoted. */
  upvotes: { count: number; mine: boolean };
  /** People @mentioned in the comment body (ADR 0003 §D). */
  mentions: MentionDto[];
}

export interface VersionDto {
  id: string;
  seq: number;
  /** How the bytes arrived. `cli` = the repo sync CLI. */
  source: 'web' | 'mcp' | 'cli';
  createdBy: string;
  createdAt: string;
  /** Tombstone (ADR 0001): content purged by retention, row kept honest. */
  purgedAt: string | null;
  /** Name of the API key that created this version, if any — null for human uploads. */
  viaApiKeyName: string | null;
  /** What-changed note captured at upload (ADR 0003 §B); null when none. Written
   *  once, never editable — versions are immutable. */
  changeNote: string | null;
}

/**
 * Structural version diff (ADR 0003 §A). Mirrors the domain block DTO — source
 * slices, never DOM; a client renders each block through its own markdown
 * renderer. Discriminated on `type`, same shape the MCP `get_diff` tool returns.
 */
export interface DiffUnchangedBlock {
  type: 'unchanged';
  beforeIndex: number;
  afterIndex: number;
  text: string;
}
export interface DiffAddedBlock {
  type: 'added';
  afterIndex: number;
  text: string;
}
export interface DiffRemovedBlock {
  type: 'removed';
  beforeIndex: number;
  text: string;
}
/** One inline change run inside a modified block (tier 2, ADR §A.2). */
export interface DiffRunDto {
  op: 'equal' | 'ins' | 'del';
  text: string;
}
export interface DiffModifiedBlock {
  type: 'modified';
  beforeIndex: number;
  afterIndex: number;
  before: string;
  after: string;
  /**
   * Tier-2 inline runs (word) or code-fence line runs. Optional so an older
   * cached tier-1 response (or any degraded shape) renders as before-fallback.
   */
  runs?: DiffRunDto[];
  runsKind?: 'word' | 'line';
}
export type DiffBlockDto =
  DiffUnchangedBlock | DiffAddedBlock | DiffRemovedBlock | DiffModifiedBlock;

/** A version's identity in a diff: its number, immutable content hash, and note. */
export interface DiffLegDto {
  seq: number;
  contentHash: string;
  changeNote: string | null;
}

export interface DocDiffDto {
  from: DiffLegDto;
  to: DiffLegDto;
  blocks: DiffBlockDto[];
}

export interface SearchHitDto {
  documentId: string;
  title: string;
  projectId: string | null;
  /** Repo-relative path (Phase 29), shown as a secondary line; display only,
   *  not part of the match — FTS still ranks on title/content. */
  path: string | null;
  rank: number;
}

/** One comment-search hit (ADR 0003 §C) — comment-grained so the rail can jump
 *  to the exact thread. `snippet` is a server-built excerpt. */
export interface CommentHitDto {
  commentId: string;
  documentId: string;
  documentTitle: string;
  snippet: string;
  anchor: AnchorDto;
  versionId: string;
  status: 'open' | 'resolved';
  authorId: string;
  createdAt: string;
  rank: number;
}

export interface FeedbackBundleDto {
  document: { id: string; title: string; versionSeq: number };
  openCount: number;
  prompt: string;
}

/** One doc as it appears in the admin's own view of what's published (Phase
 *  23) — distinct from the unauthenticated `getPublicDocs` shape, which
 *  carries no `id`/`seq`. */
export interface PublicHubDocDto {
  id: string;
  slug: string;
  title: string;
  seq: number;
  publishedAt: string;
  updatedAt: string;
}

/** Derived sign-off status for a document (Phase B). */
export type ReviewStatusValue = 'draft' | 'in_review' | 'changes_requested' | 'approved';

export interface ReviewRequestDto {
  id: string;
  reviewerUserId: string;
  reviewerName: string;
  reviewerEmail: string;
  requestedBy: string;
  createdAt: string;
}

export interface ApprovalDto {
  id: string;
  versionId: string;
  reviewerUserId: string;
  reviewerName: string;
  reviewerEmail: string;
  verdict: 'approved' | 'changes_requested';
  note: string | null;
  createdAt: string;
  /** Agent attribution (Phase A): the API key that submitted the verdict. */
  viaApiKeyName: string | null;
}

export interface ReviewDto {
  status: ReviewStatusValue;
  gate: 'soft' | 'hard';
  openCommentCount: number;
  requests: ReviewRequestDto[];
  approvals: ApprovalDto[];
}

export interface InviteDto {
  id: string;
  email: string;
  role: 'admin' | 'member';
  /** Null for operator-triggered invites (Phase 26.C) — no `users` row to attribute to. */
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export interface AllowlistEntryDto {
  id: string;
  email: string;
  addedBy: string;
  createdAt: string;
}

/**
 * A personal API key (the credential the sync CLI and MCP clients present).
 * Deliberately never carries the key string: the server stores only a hash,
 * so the secret exists in exactly one response — `createApiKey`'s — and
 * nowhere else, ever.
 */
export interface ApiKeyDto {
  id: string;
  /** Owner. Admins see the whole org's keys, so this is how a row is
   *  attributed without a directory lookup — compare against `Me.userId`. */
  userId: string;
  name: string;
  createdAt: string;
  /** Null until the key is first presented to the API. */
  lastUsedAt: string | null;
  /** Set once revoked; the row stays so past attribution keeps resolving. */
  revokedAt: string | null;
}

export interface OrgSettingsDto {
  name: string;
  sharingMode: 'link' | 'directory';
  retentionDays: number;
  purgeImmediately: boolean;
  tier: 'free' | 'team' | 'enterprise';
  versionRetention: { keepLastN: number; keepDays: number | null } | null;
  provisioningMode: 'open' | 'allowlist';
  externalSharing: boolean;
  approvalGate: 'soft' | 'hard';
  /** Org session ceiling in hours (1..24), or null for the 24h global default. */
  sessionMaxHours: number | null;
  createdAt: string;
}

/**
 * Usage vs. tier ceilings (Phase 39.B backend, 39.C first consumer) — a
 * `null` ceiling means the tier has no cap on that lane, rendered as an
 * honest "Unlimited" row by `Meter` rather than a bar that never fills.
 */
export interface OrgUsageDto {
  tier: 'free' | 'team' | 'enterprise';
  activeDocCount: number;
  maxActiveDocs: number | null;
  memberCount: number;
  maxCollaborators: number | null;
  storageBytes: number;
  activeGuestCount: number;
  maxExternalGuests: number | null;
}

/**
 * Plan-comparison ceilings for all three tiers (Phase 39.B `listTierPlans()`,
 * relocated to `GET /org/tiers` post-billing-removal) — generated straight
 * from the same `TIER_PROFILES` constant that enforces them, so this can
 * never drift from what the org actually gets. Deliberately has no price
 * field: price points are a marketing/business decision, not an enforcement
 * ceiling.
 */
export interface TierPlanDto {
  tier: 'free' | 'team' | 'enterprise';
  maxCollaborators: number | null;
  maxActiveDocs: number | null;
  maxActiveDocsPerProject: number | null;
  maxExternalGuests: number | null;
  maxGuestShareDays: number | null;
  versionRetention: {
    keepLastNMax: number | null;
    keepDaysMax: number | null;
    defaultKeepLastN: number;
    defaultKeepDays: number | null;
  };
}

export interface OrgSettingsPatch {
  name?: string;
  sharingMode?: 'link' | 'directory';
  retentionDays?: number;
  purgeImmediately?: boolean;
  versionRetention?: { keepLastN: number; keepDays: number | null } | null;
  provisioningMode?: 'open' | 'allowlist';
  externalSharing?: boolean;
  approvalGate?: 'soft' | 'hard';
  sessionMaxHours?: number | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** Reads a non-httpOnly cookie value (used for the CSRF double-submit token). */
function readCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  for (const part of document.cookie.split('; ')) {
    if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length));
  }
  return undefined;
}

/** Every call site here passes headers as a plain record, never an array or Headers instance. */
type PlainHeaders = Record<string, string>;

async function request<T>(
  path: string,
  init?: Omit<RequestInit, 'headers'> & { headers?: PlainHeaders },
): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  // CSRF (Phase 24, CONSTITUTION.md §4): echo the readable `mdloop_csrf` cookie
  // into the header on every mutation. GET/HEAD are exempt server-side.
  const csrf = method === 'GET' || method === 'HEAD' ? undefined : readCookie('mdloop_csrf');
  const extraHeaders: PlainHeaders = init?.headers ?? {};
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...extraHeaders,
    },
  });
  if (!res.ok) {
    const code = await res
      .json()
      .then((b: { error?: string }) => b.error ?? 'request_failed')
      .catch(() => 'request_failed');
    throw new ApiError(res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface ApiClient {
  me(): Promise<Me>;
  logout(): Promise<undefined>;
  listProjects(): Promise<{ projects: ProjectDto[] }>;
  createProject(input: { name: string; color?: string }): Promise<ProjectDto>;
  patchProject(id: string, patch: { name?: string; color?: string }): Promise<ProjectDto>;
  deleteProject(id: string): Promise<void>;
  /** The project's workspace tree (Phase 29) — unpaged, flat; 404s across
   *  the tenant boundary same as any other project route. */
  getProjectTree(id: string): Promise<ProjectTreeDto>;
  /**
   * Project-level share grants (ADR 0014) — org-admin only, unlike document
   * sharing's owner/admin/share-holder set: an ordinary member can create a
   * project and later have someone else's document land in it, so opening
   * this up would be a privilege-escalation path. A grant here confers its
   * permission on every document currently in the project.
   */
  createProjectGrant(
    projectId: string,
    userId: string,
    permission: 'read' | 'comment' | 'share' | 'edit',
  ): Promise<{ grant: ProjectGrantDto }>;
  listProjectGrants(projectId: string): Promise<{ grants: ProjectGrantDto[] }>;
  revokeProjectGrant(projectId: string, grantId: string): Promise<undefined>;
  listDocuments(params?: {
    view?: DocumentView;
    projectId?: string;
  }): Promise<{ documents: DocumentDto[] }>;
  overview(params?: {
    view?: DocumentView;
    projectId?: string;
    limit?: number;
    cursor?: string;
  }): Promise<OverviewDto>;
  searchDocuments(q: string): Promise<{ hits: SearchHitDto[]; commentHits: CommentHitDto[] }>;
  uploadDocument(input: {
    title: string;
    content: string;
    projectId?: string | null;
    /** Optional "what changed" note (ADR 0003 §B); never blocks upload. */
    changeNote?: string | null;
  }): Promise<{ document: DocumentDto }>;
  patchDocument(
    id: string,
    patch: { projectId?: string | null; archived?: boolean },
  ): Promise<DocumentDto>;
  deleteDocument(id: string): Promise<{ deleted: boolean; purged: boolean }>;
  commentRollup(): Promise<{ rollup: RollupEntry[] }>;
  getDocument(id: string): Promise<DocumentDto>;
  getDocumentContent(id: string): Promise<string>;
  listThreads(
    documentId: string,
    status?: 'open' | 'resolved',
  ): Promise<{
    threads: ThreadDto[];
    nextCursor: string | null;
    counts: { open: number; resolved: number };
  }>;
  createComment(
    documentId: string,
    /** `proposedText` present (empty string included) makes this a suggested
     *  edit rather than a plain comment (Phase C). */
    input: { body: string; anchor: AnchorDto; proposedText?: string | null },
  ): Promise<CommentDto>;
  getFeedbackBundle(documentId: string): Promise<FeedbackBundleDto>;
  getReview(documentId: string): Promise<ReviewDto>;
  requestReview(documentId: string, reviewerUserId: string): Promise<ReviewRequestDto>;
  revokeReviewRequest(documentId: string, requestId: string): Promise<undefined>;
  submitReviewVerdict(
    documentId: string,
    verdict: 'approved' | 'changes_requested',
    note?: string | null,
  ): Promise<{ status: ReviewStatusValue; approval: ApprovalDto }>;
  addReply(commentId: string, body: string, parentReplyId?: string | null): Promise<ReplyDto>;
  editComment(commentId: string, body: string): Promise<CommentDto>;
  deleteComment(commentId: string): Promise<undefined>;
  resolveComment(commentId: string): Promise<undefined>;
  toggleUpvote(commentId: string): Promise<{ upvoted: boolean; count: number }>;
  /** Accept a suggestion (Phase C): re-anchors, splices, mints a new version —
   *  owner/org-admin only. `versionSeq` is the newly minted version. */
  /** Accept a suggestion (ADR 0007): metadata-only — no version is minted. */
  acceptSuggestion(commentId: string): Promise<{ comment: CommentDto }>;
  /** Reject a suggestion (Phase C): owner/org-admin only, no document mutation. */
  rejectSuggestion(commentId: string): Promise<CommentDto>;
  listVersions(documentId: string): Promise<{ versions: VersionDto[]; currentVersionId: string }>;
  getVersionContent(documentId: string, versionId: string): Promise<string>;
  uploadVersion(
    documentId: string,
    content: string,
    /** Optional "what changed" note (ADR 0003 §B); never blocks upload. */
    changeNote?: string | null,
  ): Promise<{ document: DocumentDto }>;
  /** Structural version diff (ADR 0003 §A). Throws ApiError 410 (a version purged),
   *  413 (over the diff cap — caller falls back to the source view), 404. */
  getDiff(documentId: string, fromSeq: number, toSeq: number): Promise<DocDiffDto>;
  createShareLink(
    documentId: string,
    permission: 'read' | 'comment',
  ): Promise<{ grant: GrantDto; token: string }>;
  /** The only path that may grant `share`/`edit` (ADR 0008, ADR 0014) — links
   *  and guests can't. */
  createUserGrant(
    documentId: string,
    userId: string,
    permission: 'read' | 'comment' | 'share' | 'edit',
  ): Promise<{ grant: GrantDto }>;
  createGuestShare(
    documentId: string,
    input: { email: string; permission: 'read' | 'comment'; days: number },
  ): Promise<{
    grant: { id: string; granteeEmail: string; permission: string; expiresAt: string };
    token: string;
    expiresAt: string;
  }>;
  redeemGuestShare(token: string): Promise<{ documentId: string; expiresAt: string | null }>;
  listShares(documentId: string): Promise<{ grants: GrantDto[] }>;
  revokeShare(documentId: string, grantId: string): Promise<undefined>;
  redeemShare(token: string): Promise<{ documentId: string; permission: 'read' | 'comment' }>;
  listOrgUsers(opts?: {
    q?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ users: OrgUserDto[]; nextCursor: string | null }>;
  orgSettings(): Promise<{ sharingMode: 'link' | 'directory' }>;
  getOrgSettings(): Promise<OrgSettingsDto>;
  updateOrgSettings(patch: OrgSettingsPatch): Promise<OrgSettingsDto>;
  getOrgUsage(): Promise<OrgUsageDto>;
  getTierPlans(): Promise<{ tiers: TierPlanDto[] }>;
  setUserRole(userId: string, role: 'admin' | 'member'): Promise<undefined>;
  sendInvite(input: {
    email: string;
    role: 'admin' | 'member';
  }): Promise<{ invite: InviteDto; token: string }>;
  listInvites(): Promise<{ invites: InviteDto[] }>;
  revokeInvite(id: string): Promise<undefined>;
  listAllowlist(): Promise<{ entries: AllowlistEntryDto[] }>;
  addAllowlistEntry(email: string): Promise<{ entry: AllowlistEntryDto }>;
  removeAllowlistEntry(id: string): Promise<undefined>;

  /** Own keys for a member, every key in the org for an admin — the server
   *  picks the set, so there is nothing to filter client-side. */
  listApiKeys(): Promise<{ keys: ApiKeyDto[] }>;
  /**
   * Mints a key. `key` is the raw secret and this is the only response that
   * will ever contain it — the server keeps a hash, so a caller that drops it
   * has to mint a new one. Throws `ApiError` (`invalid_name`, `forbidden`).
   */
  createApiKey(name: string): Promise<{ key: string; record: ApiKeyDto }>;
  /** Own key for anyone, any org key for an admin. Throws `key_not_found`. */
  revokeApiKey(id: string): Promise<undefined>;

  /**
   * Public Docs Hub admin surface (Phase 23): authenticated, home-org-admin
   * only (`packages/api/src/routes/public-hub-admin-routes.ts`). The GET is
   * also how the client discovers whether this org *is* the hub's home org —
   * there is no `publicHubOrgId` exposed to the frontend, so a `forbidden`
   * here (checked only after the caller already knows `me.role === 'admin'`)
   * can only mean "not the home org", never "not an admin".
   */
  listPublicHubDocs(params?: {
    cursor?: string;
    limit?: number;
  }): Promise<{ docs: PublicHubDocDto[]; nextCursor: string | null }>;
  /** Throws `ApiError` (`invalid_slug`, `document_not_found`, `version_purged`, `forbidden`). */
  publishToPublicHub(input: {
    documentId: string;
    slug: string;
    title?: string;
  }): Promise<{ id: string; slug: string; title: string; seq: number; publishedAt: string }>;
  unpublishFromPublicHub(slug: string): Promise<undefined>;

  /** Public Docs Hub (ADR 0004): genuinely unauthenticated reads — never
   *  send a cookie, since these routes never check one. */
  getPublicDocs(): Promise<{ docs: { slug: string; title: string; publishedAt: string }[] }>;
  /** Resolves to `null` on 404 so callers can render a clean not-found
   *  state instead of a catch block. */
  getPublicDoc(
    slug: string,
  ): Promise<{ slug: string; title: string; publishedAt: string; updatedAt: string } | null>;
  /** Throws `ApiError` (404 → `not_found`) — the caller already needs
   *  try/catch for the network case, so this rides the same path. */
  getPublicDocContent(slug: string): Promise<string>;
  searchPublicDocs(
    query: string,
  ): Promise<{ hits: { slug: string; title: string; snippet: string }[] }>;
}

export const api: ApiClient = {
  me: () => request('/me'),
  logout: () => request('/auth/logout', { method: 'POST' }),

  listProjects: () => request('/projects'),
  createProject: (input) => request('/projects', { method: 'POST', body: JSON.stringify(input) }),
  patchProject: (id, patch) =>
    request(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }),
  getProjectTree: (id) => request(`/projects/${id}/tree`),
  createProjectGrant: (projectId, userId, permission) =>
    request(`/projects/${projectId}/shares`, {
      method: 'POST',
      body: JSON.stringify({ userId, permission }),
    }),
  listProjectGrants: (projectId) => request(`/projects/${projectId}/shares`),
  revokeProjectGrant: (projectId, grantId) =>
    request(`/projects/${projectId}/shares/${grantId}`, { method: 'DELETE' }),

  listDocuments: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.view) qs.set('view', params.view);
    if (params.projectId) qs.set('projectId', params.projectId);
    const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
    return request(`/documents${suffix}`);
  },
  overview: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.view) qs.set('view', params.view);
    if (params.projectId) qs.set('projectId', params.projectId);
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.cursor) qs.set('cursor', params.cursor);
    const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
    return request(`/overview${suffix}`);
  },
  // POST, not GET (P0.10): search text can contain document titles or
  // comment-text fragments — org data — so it rides the JSON body, never a
  // URL query string that would land in ALB/CloudFront access logs.
  searchDocuments: (q) =>
    request('/documents/search', { method: 'POST', body: JSON.stringify({ q }) }),
  uploadDocument: (input) => request('/documents', { method: 'POST', body: JSON.stringify(input) }),
  patchDocument: (id, patch) =>
    request(`/documents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteDocument: (id) => request(`/documents/${id}`, { method: 'DELETE' }),

  commentRollup: () => request('/comments/rollup'),

  getDocument: (id) => request(`/documents/${id}`),
  getDocumentContent: async (id) => {
    const res = await fetch(`/api/documents/${id}/content`, { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, 'content_unavailable');
    return res.text();
  },
  listThreads: (documentId, status) =>
    // Phase 24.F: the thread route is now keyset-paged (default 50). The viewer
    // requests a generous single page (200, the route cap) to preserve today's
    // load-all behavior; a virtualized infinite-scroll UI over `nextCursor` is
    // a follow-up. `status` stays a plain query param alongside `limit`.
    request(`/documents/${documentId}/comments?limit=200${status ? `&status=${status}` : ''}`),
  createComment: (documentId, input) =>
    request(`/documents/${documentId}/comments`, { method: 'POST', body: JSON.stringify(input) }),
  getFeedbackBundle: (documentId) => request(`/documents/${documentId}/feedback-bundle`),
  getReview: (documentId) => request(`/documents/${documentId}/review`),
  requestReview: (documentId, reviewerUserId) =>
    request(`/documents/${documentId}/review-requests`, {
      method: 'POST',
      body: JSON.stringify({ reviewerUserId }),
    }),
  revokeReviewRequest: (documentId, requestId) =>
    request(`/documents/${documentId}/review-requests/${requestId}`, { method: 'DELETE' }),
  submitReviewVerdict: (documentId, verdict, note = null) =>
    request(`/documents/${documentId}/review/verdict`, {
      method: 'POST',
      body: JSON.stringify({ verdict, note }),
    }),
  addReply: (commentId, body, parentReplyId = null) =>
    request(`/comments/${commentId}/replies`, {
      method: 'POST',
      body: JSON.stringify({ body, parentReplyId }),
    }),
  editComment: (commentId, body) =>
    request(`/comments/${commentId}`, { method: 'PATCH', body: JSON.stringify({ body }) }),
  deleteComment: (commentId) => request(`/comments/${commentId}`, { method: 'DELETE' }),
  resolveComment: (commentId) => request(`/comments/${commentId}/resolve`, { method: 'POST' }),
  toggleUpvote: (commentId) => request(`/comments/${commentId}/upvote`, { method: 'POST' }),
  acceptSuggestion: (commentId) => request(`/comments/${commentId}/accept`, { method: 'POST' }),
  rejectSuggestion: (commentId) => request(`/comments/${commentId}/reject`, { method: 'POST' }),

  listVersions: (documentId) => request(`/documents/${documentId}/versions`),
  getVersionContent: async (documentId, versionId) => {
    const res = await fetch(`/api/documents/${documentId}/versions/${versionId}/content`, {
      credentials: 'same-origin',
    });
    if (!res.ok) throw new ApiError(res.status, 'content_unavailable');
    return res.text();
  },
  uploadVersion: (documentId, content, changeNote) =>
    request(`/documents/${documentId}/versions`, {
      method: 'POST',
      body: JSON.stringify(changeNote ? { content, changeNote } : { content }),
    }),
  getDiff: (documentId, fromSeq, toSeq) =>
    request(`/documents/${documentId}/diff?from_seq=${String(fromSeq)}&to_seq=${String(toSeq)}`),

  createShareLink: (documentId, permission) =>
    request(`/documents/${documentId}/shares`, {
      method: 'POST',
      body: JSON.stringify({ type: 'link', permission }),
    }),
  createUserGrant: (documentId, userId, permission) =>
    request(`/documents/${documentId}/shares`, {
      method: 'POST',
      body: JSON.stringify({ type: 'user', userId, permission }),
    }),
  createGuestShare: (documentId, input) =>
    request(`/documents/${documentId}/guest-shares`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  redeemGuestShare: (token) =>
    request('/guest/redeem', { method: 'POST', body: JSON.stringify({ token }) }),
  listShares: (documentId) => request(`/documents/${documentId}/shares`),
  revokeShare: (documentId, grantId) =>
    request(`/documents/${documentId}/shares/${grantId}`, { method: 'DELETE' }),
  redeemShare: (token) =>
    request('/shares/redeem', { method: 'POST', body: JSON.stringify({ token }) }),
  listOrgUsers: (opts) => {
    const params = new URLSearchParams();
    if (opts?.q) params.set('q', opts.q);
    if (opts?.cursor) params.set('cursor', opts.cursor);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return request(`/org/users${qs ? `?${qs}` : ''}`);
  },
  orgSettings: () => request('/org/settings'),
  getOrgSettings: () => request('/org/settings'),
  updateOrgSettings: (patch) =>
    request('/org/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  getOrgUsage: () => request('/org/usage'),
  getTierPlans: () => request('/org/tiers'),
  setUserRole: (userId, role) =>
    request(`/org/users/${userId}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }),

  sendInvite: (input) => request('/invites', { method: 'POST', body: JSON.stringify(input) }),
  listInvites: () => request('/invites'),
  revokeInvite: (id) => request(`/invites/${id}`, { method: 'DELETE' }),
  listAllowlist: () => request('/org/allowlist'),
  addAllowlistEntry: (email) =>
    request('/org/allowlist', { method: 'POST', body: JSON.stringify({ email }) }),
  removeAllowlistEntry: (id) => request(`/org/allowlist/${id}`, { method: 'DELETE' }),

  listApiKeys: () => request('/api-keys'),
  createApiKey: (name) => request('/api-keys', { method: 'POST', body: JSON.stringify({ name }) }),
  revokeApiKey: (id) => request(`/api-keys/${id}`, { method: 'DELETE' }),

  listPublicHubDocs: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.cursor) qs.set('cursor', params.cursor);
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
    return request(`/public-hub/documents${suffix}`);
  },
  publishToPublicHub: (input) =>
    request('/public-hub/documents', { method: 'POST', body: JSON.stringify(input) }),
  unpublishFromPublicHub: (slug) =>
    request(`/public-hub/documents/${encodeURIComponent(slug)}`, { method: 'DELETE' }),

  // /public/* is its own top-level surface, not nested under /api —
  // distinct cache behavior in prod (60s edge TTL vs /api/*'s no caching) —
  // unlike every other call in this file, these deliberately don't go
  // through the `/api${path}` wrapper.
  getPublicDocs: async () => {
    const res = await fetch('/public/docs', { credentials: 'omit' });
    if (!res.ok) throw new ApiError(res.status, 'request_failed');
    return res.json() as Promise<{
      docs: { slug: string; title: string; publishedAt: string }[];
    }>;
  },
  getPublicDoc: async (slug) => {
    const res = await fetch(`/public/docs/${encodeURIComponent(slug)}`, {
      credentials: 'omit',
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError(res.status, 'request_failed');
    return res.json() as Promise<{
      slug: string;
      title: string;
      publishedAt: string;
      updatedAt: string;
    }>;
  },
  getPublicDocContent: async (slug) => {
    const res = await fetch(`/public/docs/${encodeURIComponent(slug)}/content`, {
      credentials: 'omit',
    });
    if (!res.ok) {
      throw new ApiError(res.status, res.status === 404 ? 'not_found' : 'content_unavailable');
    }
    return res.text();
  },
  searchPublicDocs: async (query) => {
    const res = await fetch(`/public/search?q=${encodeURIComponent(query)}`, {
      credentials: 'omit',
    });
    if (!res.ok) throw new ApiError(res.status, 'request_failed');
    return res.json() as Promise<{
      hits: { slug: string; title: string; snippet: string }[];
    }>;
  },
};

/** Browser navigation target for the hosted-auth login flow. */
export const LOGIN_URL = '/api/auth/login';
