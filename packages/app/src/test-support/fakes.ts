import { randomUUID } from 'node:crypto';
import type {
  AllowlistEntry,
  Approval,
  Comment,
  CommentReply,
  Document,
  DocumentVersion,
  MentionCandidate,
  OrgInvite,
  Organization,
  Project,
  ReviewRequest,
  ShareGrant,
  Tier,
  User,
  UserRole,
} from '@mdloop/domain';
import { deriveReviewStatus, highest } from '@mdloop/domain';
import type {
  AllowlistEntryId,
  ApprovalId,
  CommentId,
  DocumentId,
  GrantId,
  InviteId,
  OrgId,
  ProjectId,
  PublicDocId,
  ReplyId,
  ReviewRequestId,
  Result,
  UserId,
  VersionId,
} from '@mdloop/shared';
import type { TenantContext } from '../tenant-context.js';
import type {
  AllowlistRepository,
  AnchorResolution,
  AnchorResolutionRepository,
  CommentKeyset,
  CommentMention,
  CommentRepository,
  CommentRollup,
  CommentRollupReader,
  CommentSearchHit,
  DirectoryRepository,
  DocumentExportKeyset,
  DocumentListFilter,
  DocumentRepository,
  GuestUserRepository,
  NewAllowlistEntry,
  NewApproval,
  NewComment,
  NewDocument,
  NewOrgInvite,
  NewProject,
  NewReply,
  NewReviewRequest,
  NewShareGrant,
  NewVersion,
  OrgInviteRepository,
  OverviewAccess,
  OverviewCounts,
  OverviewKeyset,
  OverviewPageRow,
  ProjectIndexRow,
  ProjectPatch,
  ProjectRepository,
  PublicDoc,
  PublicHubKeyset,
  PublicHubRepository,
  RetentionSweepRepository,
  ReviewRepository,
  ReviewRollup,
  SearchHit,
  SearchRepository,
  ShareGrantRepository,
} from '../ports/repositories.port.js';
import type { OrganizationRepository, OrgSettingsPatch } from '../use-cases/org-settings.js';
import { decodeNameKeysetCursor, encodeNameKeysetCursor } from '../use-cases/org-settings.js';
import type { OrgLifecyclePort } from '../ports/organization-lifecycle.port.js';
import type { EmailPort } from '../ports/email.port.js';
import type { ErasureEvent, ErasureLogPort, LoggedErasure } from '../ports/erasure-log.port.js';
import type { ApiKey, ApiKeyIdentity, ApiKeyRepository } from '../use-cases/api-keys.js';
import type { PublicDocKey, StoragePort, VersionKey } from '../ports/storage.port.js';
import { publicObjectKey, versionObjectKey } from '../ports/storage.port.js';
import type {
  TelemetryEvent,
  TelemetryFields,
  TelemetryPort,
  TelemetrySpan,
} from '../ports/telemetry.port.js';
import type { IndexVersionInput, UploadTx, UploadUnitOfWork } from '../ports/upload-uow.port.js';
import type { RateLimiterPort, RateLimitError } from '../ports/rate-limiter.port.js';
import { UserRateLimiter } from '../user-rate-limit.js';

/**
 * One in-memory world shared by all fake ports, so use-case tests exercise
 * the same orchestration the real adapters see. Tenant scoping is filtered
 * per call to mirror RLS.
 */
export class FakeWorld {
  projects = new Map<ProjectId, Project>();
  documents = new Map<DocumentId, Document>();
  /** Mirrors `documents.next_seq` (migration 0026) — a durable per-document
   *  counter, not a recomputed max(seq)+1, so `nextSeqFor` matches the real
   *  reservation semantics (a reservation that never becomes a row still
   *  permanently consumes that number). */
  private nextSeqByDocument = new Map<DocumentId, number>();
  versions = new Map<VersionId, DocumentVersion>();
  ledger: { orgId: OrgId; userId: UserId; versionId: VersionId; at: Date }[] = [];
  orgs = new Map<OrgId, Organization>();
  comments = new Map<CommentId, Comment>();
  replies: CommentReply[] = [];
  /** One row per (comment, user) upvote — mirrors comment_upvotes. */
  commentUpvotes: { commentId: CommentId; orgId: OrgId; userId: UserId }[] = [];
  /** One row per (comment, mentioned user) — mirrors comment_mentions. */
  commentMentions: { commentId: CommentId; orgId: OrgId; userId: UserId }[] = [];
  /** Role lookup for API-key identity resolution; members unless set. */
  userRoles = new Map<UserId, 'admin' | 'member' | 'guest'>();
  /** Mirrors search_index: one row per document, title + body text (never a tsvector here). */
  searchIndex = new Map<DocumentId, { orgId: OrgId; title: string; body: string }>();
  /** Directory of humans across every org (Phase 15: signIn/JIT/invite lookups). */
  users = new Map<UserId, User>();
  invites = new Map<InviteId, OrgInvite>();
  allowlist = new Map<AllowlistEntryId, AllowlistEntry>();
  /** Review workflow rows (Phase B); reviewer identity is joined from `users` on read. */
  reviewRequests: {
    id: ReviewRequestId;
    orgId: OrgId;
    documentId: DocumentId;
    reviewerUserId: UserId;
    requestedBy: UserId;
    createdAt: Date;
    revokedAt: Date | null;
  }[] = [];
  approvals: {
    id: ApprovalId;
    orgId: OrgId;
    documentId: DocumentId;
    versionId: VersionId;
    reviewerUserId: UserId;
    verdict: Approval['verdict'];
    note: string | null;
    viaApiKeyId: string | null;
    createdAt: Date;
  }[] = [];

  org(overrides: Partial<Organization> = {}): Organization {
    const org: Organization = {
      id: randomUUID() as OrgId,
      name: 'Acme',
      sharingMode: 'link',
      retentionDays: 30,
      purgeImmediately: false,
      tier: 'team',
      versionRetention: null,
      subscriptionStatus: 'none',
      billingCustomerId: null,
      trialEndsAt: null,
      readOnlyAt: null,
      purgeScheduledAt: null,
      idleWarningSentAt: null,
      provisioningMode: 'allowlist',
      ssoConnectionId: null,
      externalSharing: true,
      approvalGate: 'soft',
      sessionMaxHours: null,
      createdAt: new Date(),
      ...overrides,
    };
    this.orgs.set(org.id, org);
    return org;
  }

  addUser(
    orgId: OrgId,
    input: Pick<User, 'workosUserId' | 'email' | 'displayName' | 'role'>,
  ): User {
    const user: User = {
      id: randomUUID() as UserId,
      orgId,
      workosUserId: input.workosUserId,
      email: input.email,
      displayName: input.displayName,
      role: input.role,
      createdAt: new Date(),
    };
    this.users.set(user.id, user);
    return user;
  }

  addProject(orgId: OrgId, input: NewProject): Project {
    const project: Project = {
      id: randomUUID() as ProjectId,
      orgId,
      name: input.name,
      color: input.color,
      createdBy: input.createdBy ?? null,
      createdAt: new Date(),
      archivedAt: null,
    };
    this.projects.set(project.id, project);
    return project;
  }

  addDocument(orgId: OrgId, input: NewDocument): Document {
    const document: Document = {
      id: randomUUID() as DocumentId,
      orgId,
      projectId: input.projectId,
      ownerId: input.ownerId,
      title: input.title,
      path: input.path ?? null,
      currentVersionId: null,
      archivedAt: null,
      deletedAt: null,
      purgeAfter: null,
      createdAt: new Date(),
    };
    this.documents.set(document.id, document);
    this.nextSeqByDocument.set(document.id, 1);
    return document;
  }

  addVersion(orgId: OrgId, input: NewVersion, now = new Date()): DocumentVersion {
    return this.insertVersionAt(orgId, input, this.nextSeqFor(input.documentId), now);
  }

  /** Mirrors `reserveVersionSeq` — durably advances the per-document counter. */
  nextSeqFor(documentId: DocumentId): number {
    const seq = this.nextSeqByDocument.get(documentId) ?? 1;
    this.nextSeqByDocument.set(documentId, seq + 1);
    return seq;
  }

  /** Mirrors `insertVersionAtSeq` — inserts at an already-reserved seq. */
  insertVersionAt(orgId: OrgId, input: NewVersion, seq: number, now = new Date()): DocumentVersion {
    const version: DocumentVersion = {
      id: randomUUID() as VersionId,
      orgId,
      documentId: input.documentId,
      seq,
      contentHash: input.contentHash,
      byteSize: input.byteSize,
      createdBy: input.createdBy,
      source: input.source,
      purgedAt: null,
      createdAt: now,
      viaApiKeyId: input.viaApiKeyId ?? null,
      changeNote: input.changeNote ?? null,
    };
    this.versions.set(version.id, version);
    const doc = this.documents.get(input.documentId);
    if (doc) this.documents.set(doc.id, { ...doc, currentVersionId: version.id });
    return version;
  }
}

export class FakeUploadUnitOfWork implements UploadUnitOfWork {
  // `grants` is optional (same pattern as FakeOverviewRepository): the many
  // upload tests with no share grants at all behave exactly as before, and
  // `highestGrantFor` resolves undefined — a world where nobody is granted.
  constructor(
    private readonly world: FakeWorld,
    public now: Date = new Date(),
    private readonly grants?: FakeShareGrantRepository,
  ) {}

  run<T>(ctx: TenantContext, fn: (tx: UploadTx) => Promise<T>): Promise<T> {
    const w = this.world;
    const now = this.now;
    const grantRepo = this.grants;
    const tx: UploadTx = {
      org: () => Promise.resolve(w.orgs.get(ctx.orgId)),
      activeDocCount: () =>
        Promise.resolve(
          [...w.documents.values()].filter((d) => d.orgId === ctx.orgId && !d.deletedAt).length,
        ),
      activeDocCountInProject: (projectId) =>
        Promise.resolve(
          [...w.documents.values()].filter(
            (d) => d.orgId === ctx.orgId && d.projectId === projectId && !d.deletedAt,
          ).length,
        ),
      liveVersionCount: (documentId) =>
        Promise.resolve(
          [...w.versions.values()].filter(
            (v) => v.documentId === documentId && v.orgId === ctx.orgId && v.purgedAt === null,
          ).length,
        ),
      documentById: (id) => {
        const d = w.documents.get(id);
        return Promise.resolve(d?.orgId === ctx.orgId ? d : undefined);
      },
      projectById: (id) => {
        const p = w.projects.get(id);
        return Promise.resolve(p?.orgId === ctx.orgId ? p : undefined);
      },
      createDocument: (input) => Promise.resolve(w.addDocument(ctx.orgId, input)),
      // Mirrors `documents_project_path_uniq` / q.documentIdAtPath: live rows
      // only, archived rows included, null projectId matched as a value.
      documentIdAtPath: (projectId, path) =>
        Promise.resolve(
          [...w.documents.values()].find(
            (d) =>
              d.orgId === ctx.orgId && !d.deletedAt && d.path === path && d.projectId === projectId,
          )?.id,
        ),
      setDocumentPath: (id, path) => {
        const doc = w.documents.get(id);
        if (doc?.orgId !== ctx.orgId || doc.deletedAt) return Promise.resolve(undefined);
        const updated: Document = { ...doc, path };
        w.documents.set(id, updated);
        return Promise.resolve(updated);
      },
      currentVersion: (documentId) => {
        const all = [...w.versions.values()]
          .filter((v) => v.documentId === documentId && v.orgId === ctx.orgId)
          .sort((a, b) => b.seq - a.seq);
        return Promise.resolve(all[0]);
      },
      reserveVersionSeq: (documentId) => Promise.resolve(w.nextSeqFor(documentId)),
      insertVersionAtSeq: (seq, input) =>
        Promise.resolve(w.insertVersionAt(ctx.orgId, input, seq, now)),
      recordUpload: (versionId) => {
        w.ledger.push({ orgId: ctx.orgId, userId: ctx.userId, versionId, at: now });
        return Promise.resolve();
      },
      indexVersion: (input: IndexVersionInput) => {
        w.searchIndex.set(input.documentId, {
          orgId: ctx.orgId,
          title: input.title,
          body: input.body,
        });
        return Promise.resolve();
      },
      markSuggestionAccepted: (id, appliedVersionId) => {
        // Mirrors q.markSuggestionAccepted: only an OPEN suggestion in the
        // org flips; a lost race returns undefined.
        const comment = [...w.comments.values()].find(
          (cm) =>
            cm.id === id &&
            cm.orgId === ctx.orgId &&
            cm.kind === 'suggestion' &&
            cm.suggestionOutcome === 'open',
        );
        if (!comment) return Promise.resolve(undefined);
        const updated: Comment = {
          ...comment,
          suggestionOutcome: 'accepted',
          appliedVersionId,
        };
        w.comments.set(id, updated);
        return Promise.resolve(updated);
      },
      highestGrantFor: async (documentId, userId, projectId) => {
        if (!grantRepo) return undefined;
        const mine = await grantRepo.listForUser(ctx, userId);
        // ADR 0014: a grant on the document itself, or on the project it
        // currently lives in.
        const applicable = mine.filter(
          (g) =>
            (g.subject.type === 'document' && g.subject.id === documentId) ||
            (g.subject.type === 'project' && projectId != null && g.subject.id === projectId),
        );
        return applicable.reduce<ShareGrant | undefined>(
          (best, g) =>
            !best || highest([g.permission, best.permission]) === g.permission ? g : best,
          undefined,
        );
      },
      // Mirrors FakeRetentionSweepRepository.purge's hard-delete shape — a
      // document rolled back here never had a version, so there's nothing
      // else in `w` to clean up.
      purgeDocumentRow: (id) => {
        const doc = w.documents.get(id);
        if (doc?.orgId === ctx.orgId) {
          w.documents.delete(id);
          for (const v of [...w.versions.values()]) {
            if (v.documentId === id) w.versions.delete(v.id);
          }
        }
        return Promise.resolve();
      },
    };
    return fn(tx);
  }
}

/** No-op telemetry for use-case tests that don't care about observability. */
export class NoopTelemetry implements TelemetryPort {
  log(): void {
    // intentionally no-op
  }

  startSpan(): TelemetrySpan {
    return { end: () => undefined };
  }

  recordMetric(): void {
    // intentionally no-op
  }
}

export interface CapturedLog {
  readonly event: TelemetryEvent;
  readonly fields: TelemetryFields;
}

export interface CapturedMetric {
  readonly name: string;
  readonly value: number;
  readonly fields: TelemetryFields;
}

/**
 * Captures every log/span/metric emitted, for the redaction test to assert
 * against — the only shape it can ever hold is TelemetryFields, so there is
 * nothing to grep for beyond confirming the allowlist itself stayed narrow.
 */
export class CapturingTelemetry implements TelemetryPort {
  logs: CapturedLog[] = [];
  metrics: CapturedMetric[] = [];

  log(event: TelemetryEvent, fields: TelemetryFields): void {
    this.logs.push({ event, fields });
  }

  startSpan(event: TelemetryEvent, fields: TelemetryFields = {}): TelemetrySpan {
    return {
      end: (extra) => {
        this.logs.push({ event, fields: { ...fields, ...extra } });
      },
    };
  }

  recordMetric(name: string, value: number, fields: TelemetryFields = {}): void {
    this.metrics.push({ name, value, fields });
  }

  /** Every string value ever captured, across logs, spans and metrics. */
  allStrings(): string[] {
    const out: string[] = [];
    for (const { fields } of this.logs) {
      for (const v of Object.values(fields)) if (typeof v === 'string') out.push(v);
    }
    for (const { fields } of this.metrics) {
      for (const v of Object.values(fields)) if (typeof v === 'string') out.push(v);
    }
    return out;
  }
}

export class FakeStorage implements StoragePort {
  objects = new Map<string, Uint8Array>();

  put(key: VersionKey, content: Uint8Array): Promise<void> {
    this.objects.set(versionObjectKey(key), content);
    return Promise.resolve();
  }

  get(key: VersionKey): Promise<Uint8Array> {
    const found = this.objects.get(versionObjectKey(key));
    if (!found) return Promise.reject(new Error('not found'));
    return Promise.resolve(found);
  }

  delete(key: VersionKey): Promise<void> {
    this.objects.delete(versionObjectKey(key));
    return Promise.resolve();
  }

  deleteDocument(orgId: OrgId, documentId: DocumentId): Promise<void> {
    const prefix = `orgs/${orgId}/docs/${documentId}/`;
    for (const k of [...this.objects.keys()]) if (k.startsWith(prefix)) this.objects.delete(k);
    return Promise.resolve();
  }

  deleteOrg(orgId: OrgId): Promise<void> {
    const prefix = `orgs/${orgId}/`;
    for (const k of [...this.objects.keys()]) if (k.startsWith(prefix)) this.objects.delete(k);
    return Promise.resolve();
  }

  putPublic(key: PublicDocKey, content: Uint8Array): Promise<void> {
    this.objects.set(publicObjectKey(key), content);
    return Promise.resolve();
  }

  getPublic(key: PublicDocKey): Promise<Uint8Array> {
    const found = this.objects.get(publicObjectKey(key));
    if (!found) return Promise.reject(new Error('not found'));
    return Promise.resolve(found);
  }
}

export class FakeDocumentRepository implements DocumentRepository {
  // `grants` is optional so the many tests that never touch the overview keep
  // their `new FakeDocumentRepository(world)` call. The overview access
  // predicate needs it (owner/grant/admin); without it, only owner + admin
  // resolve — matching a world with no share grants.
  constructor(
    private readonly world: FakeWorld,
    private readonly grants?: FakeShareGrantRepository,
  ) {}

  private scoped(ctx: TenantContext): Document[] {
    return [...this.world.documents.values()].filter((d) => d.orgId === ctx.orgId);
  }

  /** Documents the access can open (owner/grant/admin) — mirrors listAccessibleDocuments. */
  private async accessible(ctx: TenantContext, access: OverviewAccess): Promise<Set<string>> {
    if (access.role === 'admin') return new Set(this.scoped(ctx).map((d) => d.id as string));
    const grants = this.grants ? await this.grants.listForUser(ctx, access.userId) : [];
    const grantedDocIds = new Set(
      grants.filter((g) => g.subject.type === 'document').map((g) => g.subject.id as string),
    );
    // ADR 0014: a project-subject grant confers access to every document
    // currently in that project.
    const grantedProjectIds = new Set(
      grants.filter((g) => g.subject.type === 'project').map((g) => g.subject.id as string),
    );
    return new Set(
      this.scoped(ctx)
        .filter(
          (d) =>
            d.ownerId === access.userId ||
            grantedDocIds.has(d.id) ||
            (d.projectId !== null && grantedProjectIds.has(d.projectId)),
        )
        .map((d) => d.id as string),
    );
  }

  /** open/resolved/lastActivityAt for one document — mirrors the overview SQL aggregate. */
  private activityOf(
    ctx: TenantContext,
    doc: Document,
  ): { open: number; resolved: number; lastActivityAt: Date } {
    const comments = [...this.world.comments.values()].filter(
      (c) => c.orgId === ctx.orgId && c.documentId === doc.id,
    );
    const versions = [...this.world.versions.values()].filter(
      (v) => v.orgId === ctx.orgId && v.documentId === doc.id,
    );
    const times = [
      doc.createdAt.getTime(),
      ...comments.map((c) => c.createdAt.getTime()),
      ...versions.map((v) => v.createdAt.getTime()),
    ];
    return {
      open: comments.filter((c) => c.status === 'open').length,
      resolved: comments.filter((c) => c.status === 'resolved').length,
      lastActivityAt: new Date(Math.max(...times)),
    };
  }

  create(ctx: TenantContext, input: NewDocument): Promise<Document> {
    return Promise.resolve(this.world.addDocument(ctx.orgId, input));
  }

  byId(ctx: TenantContext, id: DocumentId): Promise<Document | undefined> {
    return Promise.resolve(this.scoped(ctx).find((d) => d.id === id));
  }

  list(ctx: TenantContext, filter?: DocumentListFilter): Promise<Document[]> {
    const view = filter?.view ?? 'all';
    return Promise.resolve(
      this.scoped(ctx).filter((d) => {
        if (d.deletedAt) return false;
        if (view === 'archived') return d.archivedAt !== null;
        if (d.archivedAt) return false;
        if (view === 'unfiled') return d.projectId === null;
        if (filter?.projectId) return d.projectId === filter.projectId;
        return true;
      }),
    );
  }

  listForExport(
    ctx: TenantContext,
    after: DocumentExportKeyset | null,
    limit: number,
  ): Promise<Document[]> {
    const ordered = this.scoped(ctx)
      .filter((d) => !d.deletedAt)
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    const from = after
      ? ordered.findIndex(
          (d) =>
            d.createdAt.getTime() > after.createdAt.getTime() ||
            (d.createdAt.getTime() === after.createdAt.getTime() && d.id > after.id),
        )
      : 0;
    const start = from === -1 ? ordered.length : from;
    return Promise.resolve(ordered.slice(start, start + limit));
  }

  async overviewPage(
    ctx: TenantContext,
    access: OverviewAccess,
    lane: DocumentListFilter,
    after: OverviewKeyset | null,
    limit: number,
  ): Promise<OverviewPageRow[]> {
    const view = lane.view ?? 'all';
    const accessible = await this.accessible(ctx, access);
    const rows = this.scoped(ctx)
      .filter((d) => {
        if (d.deletedAt || !accessible.has(d.id)) return false;
        if (view === 'archived') return d.archivedAt !== null;
        if (d.archivedAt) return false;
        if (view === 'unfiled') return d.projectId === null;
        if (lane.projectId) return d.projectId === lane.projectId;
        return true;
      })
      .map((document) => ({ document, ...this.activityOf(ctx, document) }))
      .sort(
        (a, b) =>
          b.lastActivityAt.getTime() - a.lastActivityAt.getTime() ||
          (a.document.id < b.document.id ? 1 : a.document.id > b.document.id ? -1 : 0),
      );
    const from = after
      ? rows.findIndex(
          (r) =>
            r.lastActivityAt.getTime() < after.lastActivityAt.getTime() ||
            (r.lastActivityAt.getTime() === after.lastActivityAt.getTime() &&
              r.document.id < after.id),
        )
      : 0;
    const start = from === -1 ? rows.length : from;
    return rows.slice(start, start + limit);
  }

  async overviewCounts(ctx: TenantContext, access: OverviewAccess): Promise<OverviewCounts> {
    const accessible = await this.accessible(ctx, access);
    const live = this.scoped(ctx).filter(
      (d) => !d.deletedAt && !d.archivedAt && accessible.has(d.id),
    );
    const archived = this.scoped(ctx).filter(
      (d) => !d.deletedAt && d.archivedAt !== null && accessible.has(d.id),
    );
    const openByProject = new Map<ProjectId, number>();
    for (const d of live) {
      const open = this.activityOf(ctx, d).open;
      if (d.projectId && open > 0) {
        openByProject.set(d.projectId, (openByProject.get(d.projectId) ?? 0) + open);
      }
    }
    return {
      all: live.length,
      unfiled: live.filter((d) => d.projectId === null).length,
      archived: archived.length,
      openByProject: [...openByProject].map(([projectId, open]) => ({ projectId, open })),
    };
  }

  /** Live, non-archived, accessible documents in one project — the tree's scope. */
  private async liveInProject(
    ctx: TenantContext,
    access: OverviewAccess,
    projectId: ProjectId,
  ): Promise<Document[]> {
    const accessible = await this.accessible(ctx, access);
    return this.scoped(ctx).filter(
      (d) => !d.deletedAt && !d.archivedAt && d.projectId === projectId && accessible.has(d.id),
    );
  }

  async countLiveInProject(
    ctx: TenantContext,
    access: OverviewAccess,
    projectId: ProjectId,
  ): Promise<number> {
    return (await this.liveInProject(ctx, access, projectId)).length;
  }

  async listProjectIndex(
    ctx: TenantContext,
    access: OverviewAccess,
    projectId: ProjectId,
  ): Promise<ProjectIndexRow[]> {
    const docs = await this.liveInProject(ctx, access, projectId);
    return docs
      .map((document) => ({ document, open: this.activityOf(ctx, document).open }))
      .sort((a, b) => {
        // Mirrors the SQL's `order by path nulls last, title, id`.
        const ap = a.document.path;
        const bp = b.document.path;
        if (ap !== bp) {
          if (ap === null) return 1;
          if (bp === null) return -1;
          return ap < bp ? -1 : 1;
        }
        return (
          a.document.title.localeCompare(b.document.title) ||
          (a.document.id < b.document.id ? -1 : 1)
        );
      });
  }

  documentIdAtPath(
    ctx: TenantContext,
    projectId: ProjectId | null,
    path: string,
  ): Promise<DocumentId | undefined> {
    return Promise.resolve(
      this.scoped(ctx).find((d) => !d.deletedAt && d.path === path && d.projectId === projectId)
        ?.id,
    );
  }

  private patch(ctx: TenantContext, id: DocumentId, change: Partial<Document>): boolean {
    const doc = this.scoped(ctx).find((d) => d.id === id);
    if (!doc) return false;
    this.world.documents.set(id, { ...doc, ...change });
    return true;
  }

  moveToProject(ctx: TenantContext, id: DocumentId, projectId: ProjectId | null): Promise<boolean> {
    return Promise.resolve(this.patch(ctx, id, { projectId }));
  }

  setArchived(ctx: TenantContext, id: DocumentId, archived: boolean): Promise<boolean> {
    return Promise.resolve(this.patch(ctx, id, { archivedAt: archived ? new Date() : null }));
  }

  softDelete(ctx: TenantContext, id: DocumentId, purgeAfter: Date): Promise<boolean> {
    const doc = this.scoped(ctx).find((d) => d.id === id && !d.deletedAt);
    if (!doc) return Promise.resolve(false);
    this.world.documents.set(id, { ...doc, deletedAt: new Date(), purgeAfter });
    return Promise.resolve(true);
  }

  purge(ctx: TenantContext, id: DocumentId): Promise<void> {
    const doc = this.scoped(ctx).find((d) => d.id === id);
    if (doc) {
      this.world.documents.delete(id);
      for (const v of [...this.world.versions.values()]) {
        if (v.documentId === id) this.world.versions.delete(v.id);
      }
    }
    return Promise.resolve();
  }

  /** Mirrors `FakeUploadUnitOfWork`'s `activeDocCount`, minus the lock (Phase 33.D). */
  activeCount(ctx: TenantContext): Promise<number> {
    return Promise.resolve(this.scoped(ctx).filter((d) => !d.deletedAt).length);
  }

  /** Mirrors `FakeUploadUnitOfWork`'s `activeDocCountInProject` (Phase 33.D). */
  activeCountInProject(ctx: TenantContext, projectId: ProjectId): Promise<number> {
    return Promise.resolve(
      this.scoped(ctx).filter((d) => d.projectId === projectId && !d.deletedAt).length,
    );
  }
}

export class FakeProjectRepository implements ProjectRepository {
  constructor(private readonly world: FakeWorld) {}

  private scoped(ctx: TenantContext): Project[] {
    return [...this.world.projects.values()].filter((p) => p.orgId === ctx.orgId);
  }

  create(ctx: TenantContext, input: NewProject): Promise<Project> {
    return Promise.resolve(this.world.addProject(ctx.orgId, input));
  }

  byId(ctx: TenantContext, id: ProjectId): Promise<Project | undefined> {
    return Promise.resolve(this.scoped(ctx).find((p) => p.id === id));
  }

  list(ctx: TenantContext): Promise<Project[]> {
    return Promise.resolve(this.scoped(ctx));
  }

  update(ctx: TenantContext, id: ProjectId, patch: ProjectPatch): Promise<Project | undefined> {
    const project = this.scoped(ctx).find((p) => p.id === id);
    if (!project) return Promise.resolve(undefined);
    const updated = { ...project, ...patch };
    this.world.projects.set(id, updated);
    return Promise.resolve(updated);
  }

  setArchived(ctx: TenantContext, id: ProjectId, archived: boolean): Promise<boolean> {
    const project = this.scoped(ctx).find((p) => p.id === id);
    if (!project) return Promise.resolve(false);
    this.world.projects.set(id, { ...project, archivedAt: archived ? new Date() : null });
    return Promise.resolve(true);
  }

  remove(ctx: TenantContext, id: ProjectId): Promise<boolean> {
    const project = this.scoped(ctx).find((p) => p.id === id);
    if (!project) return Promise.resolve(false);
    for (const [docId, doc] of this.world.documents) {
      if (doc.projectId === id) this.world.documents.set(docId, { ...doc, projectId: null });
    }
    this.world.projects.delete(id);
    return Promise.resolve(true);
  }
}

export class FakeCommentRepository implements CommentRepository {
  constructor(private readonly world: FakeWorld) {}

  private scoped(ctx: TenantContext): Comment[] {
    return [...this.world.comments.values()].filter((c) => c.orgId === ctx.orgId);
  }

  create(ctx: TenantContext, input: NewComment): Promise<Comment> {
    const proposedText = input.proposedText ?? null;
    const isSuggestion = proposedText !== null;
    const comment: Comment = {
      id: randomUUID() as CommentId,
      orgId: ctx.orgId,
      documentId: input.documentId,
      versionId: input.versionId,
      authorId: input.authorId,
      body: input.body,
      anchor: input.anchor,
      status: 'open',
      resolvedBy: null,
      resolvedAt: null,
      createdAt: new Date(),
      viaApiKeyId: input.viaApiKeyId ?? null,
      // Mirrors the DB kind-iff-proposed_text invariant.
      kind: isSuggestion ? 'suggestion' : 'comment',
      proposedText,
      suggestionOutcome: isSuggestion ? 'open' : null,
      appliedVersionId: null,
    };
    this.world.comments.set(comment.id, comment);
    return Promise.resolve(comment);
  }

  async createWithinCap(
    ctx: TenantContext,
    input: NewComment,
    limit: number | null,
  ): Promise<Comment | undefined> {
    // Mirrors the Pg advisory-locked count→insert: over the fake's serial
    // in-memory world there is no real concurrency, but the cap decision is
    // identical, so use-case tests exercise the same branch.
    if (limit !== null) {
      const count = this.scoped(ctx).filter((c) => c.documentId === input.documentId).length;
      if (count >= limit) return undefined;
    }
    return this.create(ctx, input);
  }

  setSuggestionOutcome(
    ctx: TenantContext,
    id: CommentId,
    outcome: 'accepted' | 'rejected',
    appliedVersionId: VersionId | null,
  ): Promise<Comment | undefined> {
    // Guard matches the Pg conditional update: only an OPEN suggestion flips.
    const comment = this.scoped(ctx).find(
      (c) => c.id === id && c.kind === 'suggestion' && c.suggestionOutcome === 'open',
    );
    if (!comment) return Promise.resolve(undefined);
    const updated: Comment = { ...comment, suggestionOutcome: outcome, appliedVersionId };
    this.world.comments.set(id, updated);
    return Promise.resolve(updated);
  }

  markSuggestionApplied(
    ctx: TenantContext,
    id: CommentId,
    appliedVersionId: VersionId,
  ): Promise<Comment | undefined> {
    // Guard matches the Pg conditional update: only an accepted-but-unapplied
    // suggestion flips.
    const comment = this.scoped(ctx).find(
      (c) =>
        c.id === id &&
        c.kind === 'suggestion' &&
        c.suggestionOutcome === 'accepted' &&
        c.appliedVersionId === null,
    );
    if (!comment) return Promise.resolve(undefined);
    const updated: Comment = { ...comment, appliedVersionId };
    this.world.comments.set(id, updated);
    return Promise.resolve(updated);
  }

  byId(ctx: TenantContext, id: CommentId): Promise<Comment | undefined> {
    return Promise.resolve(this.scoped(ctx).find((c) => c.id === id));
  }

  listForDocument(
    ctx: TenantContext,
    documentId: DocumentId,
    status?: 'open' | 'resolved',
  ): Promise<Comment[]> {
    return Promise.resolve(
      this.scoped(ctx).filter(
        (c) => c.documentId === documentId && (status === undefined || c.status === status),
      ),
    );
  }

  listForDocumentPage(
    ctx: TenantContext,
    documentId: DocumentId,
    status: 'open' | 'resolved' | undefined,
    after: CommentKeyset | null,
    limit: number,
  ): Promise<Comment[]> {
    const ordered = this.scoped(ctx)
      .filter((c) => c.documentId === documentId && (status === undefined || c.status === status))
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    const from = after
      ? ordered.findIndex(
          (c) =>
            c.createdAt.getTime() > after.createdAt.getTime() ||
            (c.createdAt.getTime() === after.createdAt.getTime() && c.id > after.id),
        )
      : 0;
    const start = from === -1 ? ordered.length : from;
    return Promise.resolve(ordered.slice(start, start + limit));
  }

  countForDocument(ctx: TenantContext, documentId: DocumentId): Promise<number> {
    return Promise.resolve(this.scoped(ctx).filter((c) => c.documentId === documentId).length);
  }

  statusCounts(
    ctx: TenantContext,
    documentId: DocumentId,
  ): Promise<{ open: number; resolved: number }> {
    const mine = this.scoped(ctx).filter((c) => c.documentId === documentId);
    return Promise.resolve({
      open: mine.filter((c) => c.status === 'open').length,
      resolved: mine.filter((c) => c.status === 'resolved').length,
    });
  }

  openCommentVersionIds(ctx: TenantContext, documentId: DocumentId): Promise<VersionId[]> {
    return Promise.resolve([
      ...new Set(
        this.scoped(ctx)
          .filter((c) => c.documentId === documentId && c.status === 'open')
          .map((c) => c.versionId),
      ),
    ]);
  }

  resolve(ctx: TenantContext, id: CommentId, resolvedBy: UserId): Promise<boolean> {
    const comment = this.scoped(ctx).find((c) => c.id === id && c.status === 'open');
    if (!comment) return Promise.resolve(false);
    this.world.comments.set(id, {
      ...comment,
      status: 'resolved',
      resolvedBy,
      resolvedAt: new Date(),
    });
    return Promise.resolve(true);
  }

  update(ctx: TenantContext, id: CommentId, body: string): Promise<Comment> {
    const comment = this.scoped(ctx).find((c) => c.id === id);
    if (!comment) throw new Error(`comment not found: ${id}`);
    const updated = { ...comment, body };
    this.world.comments.set(id, updated);
    return Promise.resolve(updated);
  }

  delete(ctx: TenantContext, id: CommentId): Promise<boolean> {
    const comment = this.scoped(ctx).find((c) => c.id === id);
    if (!comment) return Promise.resolve(false);
    this.world.comments.delete(id);
    return Promise.resolve(true);
  }

  addReply(ctx: TenantContext, input: NewReply): Promise<CommentReply> {
    const reply: CommentReply = {
      id: randomUUID() as ReplyId,
      orgId: ctx.orgId,
      commentId: input.commentId,
      parentReplyId: input.parentReplyId,
      authorId: input.authorId,
      body: input.body,
      createdAt: new Date(),
      viaApiKeyId: input.viaApiKeyId ?? null,
    };
    this.world.replies.push(reply);
    return Promise.resolve(reply);
  }

  listReplies(ctx: TenantContext, commentId: CommentId): Promise<CommentReply[]> {
    return Promise.resolve(
      this.world.replies.filter((r) => r.commentId === commentId && r.orgId === ctx.orgId),
    );
  }

  listRepliesForDocument(ctx: TenantContext, documentId: DocumentId): Promise<CommentReply[]> {
    const commentIds = new Set(
      this.scoped(ctx)
        .filter((c) => c.documentId === documentId)
        .map((c) => c.id),
    );
    return Promise.resolve(
      this.world.replies.filter((r) => r.orgId === ctx.orgId && commentIds.has(r.commentId)),
    );
  }

  listRepliesForComments(ctx: TenantContext, commentIds: CommentId[]): Promise<CommentReply[]> {
    const ids = new Set(commentIds);
    return Promise.resolve(
      this.world.replies.filter((r) => r.orgId === ctx.orgId && ids.has(r.commentId)),
    );
  }

  toggleUpvote(
    ctx: TenantContext,
    commentId: CommentId,
    userId: UserId,
  ): Promise<{ upvoted: boolean; count: number }> {
    const at = this.world.commentUpvotes.findIndex(
      (u) => u.orgId === ctx.orgId && u.commentId === commentId && u.userId === userId,
    );
    let upvoted: boolean;
    if (at >= 0) {
      this.world.commentUpvotes.splice(at, 1);
      upvoted = false;
    } else {
      this.world.commentUpvotes.push({ commentId, orgId: ctx.orgId, userId });
      upvoted = true;
    }
    const count = this.world.commentUpvotes.filter(
      (u) => u.orgId === ctx.orgId && u.commentId === commentId,
    ).length;
    return Promise.resolve({ upvoted, count });
  }

  upvotesForDocument(
    ctx: TenantContext,
    documentId: DocumentId,
    userId: UserId,
  ): Promise<Map<CommentId, { count: number; mine: boolean }>> {
    const commentIds = new Set(
      this.scoped(ctx)
        .filter((c) => c.documentId === documentId)
        .map((c) => c.id),
    );
    const map = new Map<CommentId, { count: number; mine: boolean }>();
    for (const u of this.world.commentUpvotes) {
      if (u.orgId !== ctx.orgId || !commentIds.has(u.commentId)) continue;
      const cur = map.get(u.commentId) ?? { count: 0, mine: false };
      map.set(u.commentId, { count: cur.count + 1, mine: cur.mine || u.userId === userId });
    }
    return Promise.resolve(map);
  }

  upvotesForComments(
    ctx: TenantContext,
    commentIds: CommentId[],
    userId: UserId,
  ): Promise<Map<CommentId, { count: number; mine: boolean }>> {
    const ids = new Set(commentIds);
    const map = new Map<CommentId, { count: number; mine: boolean }>();
    for (const u of this.world.commentUpvotes) {
      if (u.orgId !== ctx.orgId || !ids.has(u.commentId)) continue;
      const cur = map.get(u.commentId) ?? { count: 0, mine: false };
      map.set(u.commentId, { count: cur.count + 1, mine: cur.mine || u.userId === userId });
    }
    return Promise.resolve(map);
  }

  mentionCandidates(ctx: TenantContext, documentId: DocumentId): Promise<MentionCandidate[]> {
    const ids = new Set<UserId>();
    const doc = this.world.documents.get(documentId);
    if (doc?.orgId === ctx.orgId) ids.add(doc.ownerId);
    for (const c of this.scoped(ctx)) {
      if (c.documentId === documentId) ids.add(c.authorId);
    }
    const docCommentIds = new Set(
      this.scoped(ctx)
        .filter((c) => c.documentId === documentId)
        .map((c) => c.id),
    );
    for (const r of this.world.replies) {
      if (r.orgId === ctx.orgId && docCommentIds.has(r.commentId)) ids.add(r.authorId);
    }
    for (const rr of this.world.reviewRequests) {
      if (rr.orgId === ctx.orgId && rr.documentId === documentId && rr.revokedAt === null) {
        ids.add(rr.reviewerUserId);
      }
    }
    const out: MentionCandidate[] = [];
    for (const id of ids) {
      const user = this.world.users.get(id);
      if (user?.orgId === ctx.orgId) out.push({ id, displayName: user.displayName });
    }
    return Promise.resolve(out);
  }

  replaceMentions(
    ctx: TenantContext,
    commentId: CommentId,
    mentionedUserIds: UserId[],
  ): Promise<void> {
    this.world.commentMentions = this.world.commentMentions.filter(
      (m) => !(m.orgId === ctx.orgId && m.commentId === commentId),
    );
    for (const userId of mentionedUserIds) {
      this.world.commentMentions.push({ commentId, orgId: ctx.orgId, userId });
    }
    return Promise.resolve();
  }

  mentionsForDocument(
    ctx: TenantContext,
    documentId: DocumentId,
  ): Promise<Map<CommentId, CommentMention[]>> {
    const docCommentIds = new Set(
      this.scoped(ctx)
        .filter((c) => c.documentId === documentId)
        .map((c) => c.id),
    );
    const map = new Map<CommentId, CommentMention[]>();
    for (const m of this.world.commentMentions) {
      if (m.orgId !== ctx.orgId || !docCommentIds.has(m.commentId)) continue;
      const user = this.world.users.get(m.userId);
      if (!user) continue;
      const bucket = map.get(m.commentId) ?? [];
      bucket.push({ userId: m.userId, displayName: user.displayName });
      map.set(m.commentId, bucket);
    }
    return Promise.resolve(map);
  }

  mentionsForComments(
    ctx: TenantContext,
    commentIds: CommentId[],
  ): Promise<Map<CommentId, CommentMention[]>> {
    const ids = new Set(commentIds);
    const map = new Map<CommentId, CommentMention[]>();
    for (const m of this.world.commentMentions) {
      if (m.orgId !== ctx.orgId || !ids.has(m.commentId)) continue;
      const user = this.world.users.get(m.userId);
      if (!user) continue;
      const bucket = map.get(m.commentId) ?? [];
      bucket.push({ userId: m.userId, displayName: user.displayName });
      map.set(m.commentId, bucket);
    }
    return Promise.resolve(map);
  }
}

/** Mirrors PgCommentRollupReader: one row per live document, zero counts included. */
export class FakeCommentRollupReader implements CommentRollupReader {
  constructor(private readonly world: FakeWorld) {}

  rollup(ctx: TenantContext): Promise<CommentRollup[]> {
    const docs = [...this.world.documents.values()].filter(
      (d) => d.orgId === ctx.orgId && d.deletedAt === null,
    );
    return Promise.resolve(
      docs.map((d) => {
        const comments = [...this.world.comments.values()].filter(
          (c) => c.documentId === d.id && c.orgId === ctx.orgId,
        );
        const versions = [...this.world.versions.values()].filter(
          (v) => v.documentId === d.id && v.orgId === ctx.orgId,
        );
        const times = [
          d.createdAt.getTime(),
          ...comments.map((c) => c.createdAt.getTime()),
          ...versions.map((v) => v.createdAt.getTime()),
        ];
        return {
          documentId: d.id,
          open: comments.filter((c) => c.status === 'open').length,
          resolved: comments.filter((c) => c.status === 'resolved').length,
          lastActivityAt: new Date(Math.max(...times)),
        };
      }),
    );
  }
}

/**
 * Mirrors PgReviewRepository over the shared world: read methods join the
 * reviewer identity from `users`; approvals are append-only (no update/delete
 * method); reviewRollup derives status per live document via the domain rule.
 */
export class FakeReviewRepository implements ReviewRepository {
  constructor(private readonly world: FakeWorld) {}

  private nameOf(id: UserId): { name: string; email: string } {
    const u = this.world.users.get(id);
    return { name: u?.displayName ?? '', email: u?.email ?? '' };
  }

  createRequest(ctx: TenantContext, input: NewReviewRequest): Promise<ReviewRequest> {
    const row = {
      id: randomUUID() as ReviewRequestId,
      orgId: ctx.orgId,
      documentId: input.documentId,
      reviewerUserId: input.reviewerUserId,
      requestedBy: input.requestedBy,
      createdAt: new Date(),
      revokedAt: null as Date | null,
    };
    this.world.reviewRequests.push(row);
    const { name, email } = this.nameOf(row.reviewerUserId);
    return Promise.resolve({ ...row, reviewerName: name, reviewerEmail: email });
  }

  activeRequestsForDocument(ctx: TenantContext, documentId: DocumentId): Promise<ReviewRequest[]> {
    return Promise.resolve(
      this.world.reviewRequests
        .filter((r) => r.orgId === ctx.orgId && r.documentId === documentId && r.revokedAt === null)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((r) => {
          const { name, email } = this.nameOf(r.reviewerUserId);
          return { ...r, reviewerName: name, reviewerEmail: email };
        }),
    );
  }

  revokeRequest(ctx: TenantContext, id: ReviewRequestId): Promise<boolean> {
    const row = this.world.reviewRequests.find(
      (r) => r.orgId === ctx.orgId && r.id === id && r.revokedAt === null,
    );
    if (!row) return Promise.resolve(false);
    row.revokedAt = new Date();
    return Promise.resolve(true);
  }

  createApproval(ctx: TenantContext, input: NewApproval): Promise<Approval> {
    const row = {
      id: randomUUID() as ApprovalId,
      orgId: ctx.orgId,
      documentId: input.documentId,
      versionId: input.versionId,
      reviewerUserId: input.reviewerUserId,
      verdict: input.verdict,
      note: input.note,
      viaApiKeyId: input.viaApiKeyId ?? null,
      createdAt: new Date(),
    };
    this.world.approvals.push(row);
    const { name, email } = this.nameOf(row.reviewerUserId);
    return Promise.resolve({ ...row, reviewerName: name, reviewerEmail: email });
  }

  approvalsForDocument(ctx: TenantContext, documentId: DocumentId): Promise<Approval[]> {
    return Promise.resolve(
      this.world.approvals
        .filter((a) => a.orgId === ctx.orgId && a.documentId === documentId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((a) => {
          const { name, email } = this.nameOf(a.reviewerUserId);
          return { ...a, reviewerName: name, reviewerEmail: email };
        }),
    );
  }

  reviewRollup(ctx: TenantContext, documentIds?: DocumentId[]): Promise<ReviewRollup[]> {
    if (documentIds?.length === 0) return Promise.resolve([]);
    const scope = documentIds ? new Set<string>(documentIds) : null;
    const docs = [...this.world.documents.values()].filter(
      (d) => d.orgId === ctx.orgId && d.deletedAt === null && (scope === null || scope.has(d.id)),
    );
    return Promise.resolve(
      docs.map((d) => {
        const activeReviewerIds = this.world.reviewRequests
          .filter((r) => r.orgId === ctx.orgId && r.documentId === d.id && r.revokedAt === null)
          .map((r) => r.reviewerUserId);
        const approvalsOnLatestVersion = this.world.approvals
          .filter(
            (a) =>
              a.orgId === ctx.orgId &&
              a.documentId === d.id &&
              d.currentVersionId !== null &&
              a.versionId === d.currentVersionId,
          )
          .map((a) => ({
            reviewerUserId: a.reviewerUserId,
            verdict: a.verdict,
            createdAt: a.createdAt,
          }));
        return {
          documentId: d.id,
          status: deriveReviewStatus({ activeReviewerIds, approvalsOnLatestVersion }),
        };
      }),
    );
  }
}

export class FakeShareGrantRepository implements ShareGrantRepository {
  grants = new Map<GrantId, ShareGrant>();

  constructor(private readonly world: FakeWorld) {}

  private scoped(ctx: TenantContext): ShareGrant[] {
    return [...this.grants.values()].filter((g) => g.orgId === ctx.orgId);
  }

  create(ctx: TenantContext, input: NewShareGrant): Promise<ShareGrant> {
    const grant: ShareGrant = {
      id: randomUUID() as GrantId,
      orgId: ctx.orgId,
      subject: input.subject,
      grantee: input.grantee,
      permission: input.permission,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt ?? null,
      granteeEmail: input.granteeEmail ?? null,
      createdBy: input.createdBy,
      createdAt: new Date(),
      revokedAt: null,
    };
    this.grants.set(grant.id, grant);
    void this.world;
    return Promise.resolve(grant);
  }

  async createWithinGuestCap(
    ctx: TenantContext,
    input: NewShareGrant,
    guestEmail: string,
    limit: number | null,
  ): Promise<ShareGrant | undefined> {
    if (limit !== null) {
      const others = new Set(
        this.scoped(ctx).flatMap((g) =>
          g.granteeEmail !== null &&
          g.granteeEmail.toLowerCase() !== guestEmail.toLowerCase() &&
          g.revokedAt === null &&
          this.unexpired(g)
            ? [g.granteeEmail.toLowerCase()]
            : [],
        ),
      );
      if (others.size >= limit) return undefined;
    }
    return this.create(ctx, input);
  }

  /** Mirrors the Pg expiry filter: null (never) or strictly in the future. */
  private unexpired(g: ShareGrant, now = Date.now()): boolean {
    return g.expiresAt === null || g.expiresAt.getTime() > now;
  }

  listForDocument(ctx: TenantContext, documentId: DocumentId): Promise<ShareGrant[]> {
    return Promise.resolve(
      this.scoped(ctx).filter(
        (g) => g.subject.type === 'document' && g.subject.id === documentId && g.revokedAt === null,
      ),
    );
  }

  listForProject(ctx: TenantContext, projectId: ProjectId): Promise<ShareGrant[]> {
    return Promise.resolve(
      this.scoped(ctx).filter(
        (g) => g.subject.type === 'project' && g.subject.id === projectId && g.revokedAt === null,
      ),
    );
  }

  listForUser(ctx: TenantContext, userId: UserId): Promise<ShareGrant[]> {
    return Promise.resolve(
      this.scoped(ctx).filter(
        (g) =>
          g.grantee.type === 'user' &&
          g.grantee.userId === userId &&
          g.revokedAt === null &&
          this.unexpired(g),
      ),
    );
  }

  byTokenHash(ctx: TenantContext, tokenHash: string): Promise<ShareGrant | undefined> {
    return Promise.resolve(
      this.scoped(ctx).find(
        (g) => g.tokenHash === tokenHash && g.revokedAt === null && this.unexpired(g),
      ),
    );
  }

  activeGuestEmails(ctx: TenantContext): Promise<string[]> {
    const emails = new Set(
      this.scoped(ctx).flatMap((g) =>
        g.granteeEmail !== null && g.revokedAt === null && this.unexpired(g)
          ? [g.granteeEmail.toLowerCase()]
          : [],
      ),
    );
    return Promise.resolve([...emails]);
  }

  extendGuestGrant(
    ctx: TenantContext,
    id: GrantId,
    patch: { permission: ShareGrant['permission']; tokenHash: string; expiresAt: Date },
  ): Promise<ShareGrant> {
    const grant = this.scoped(ctx).find((g) => g.id === id);
    if (!grant) throw new Error(`grant not found: ${id}`);
    const updated = { ...grant, ...patch };
    this.grants.set(id, updated);
    return Promise.resolve(updated);
  }

  revoke(ctx: TenantContext, id: GrantId): Promise<boolean> {
    const grant = this.scoped(ctx).find((g) => g.id === id && g.revokedAt === null);
    if (!grant) return Promise.resolve(false);
    this.grants.set(id, { ...grant, revokedAt: new Date() });
    return Promise.resolve(true);
  }
}

/**
 * Mirrors PgSearchRepository's permission scoping (owner/admin/granted) over
 * the fake world's in-memory searchIndex, so use-case tests exercise the
 * same shape without a real tsvector. Matching is a case-insensitive
 * substring test against title+body — good enough for unit tests; real
 * ranking/stemming is covered by the Postgres integration test.
 */
export class FakeSearchRepository implements SearchRepository {
  constructor(
    private readonly world: FakeWorld,
    private readonly grants: FakeShareGrantRepository,
  ) {}

  async search(
    ctx: TenantContext,
    userId: UserId,
    role: UserRole,
    query: string,
  ): Promise<SearchHit[]> {
    const needle = query.toLowerCase();
    const mine = role === 'admin' ? [] : await this.grants.listForUser(ctx, userId);
    const grantedDocIds = new Set(
      mine.filter((g) => g.subject.type === 'document').map((g) => g.subject.id as string),
    );
    // ADR 0014: a project-subject grant confers access to every document in it.
    const grantedProjectIds = new Set(
      mine.filter((g) => g.subject.type === 'project').map((g) => g.subject.id as string),
    );
    const hits: SearchHit[] = [];
    for (const [documentId, entry] of this.world.searchIndex) {
      if (entry.orgId !== ctx.orgId) continue;
      const doc = this.world.documents.get(documentId);
      if (!doc || doc.deletedAt || doc.archivedAt) continue;
      const permitted =
        role === 'admin' ||
        doc.ownerId === userId ||
        grantedDocIds.has(documentId) ||
        (doc.projectId !== null && grantedProjectIds.has(doc.projectId));
      if (!permitted) continue;
      const haystack = `${entry.title}\n${entry.body}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
      hits.push({
        kind: 'document',
        documentId,
        title: entry.title,
        projectId: doc.projectId,
        path: doc.path,
        rank: 1,
      });
    }
    return hits;
  }

  /** Mirrors PgSearchRepository.searchComments: naive substring match over
   *  body + proposed_text, replicating the owner/grant/admin predicate (RLS is
   *  the backstop, not the filter) and excluding deleted docs/comments. */
  async searchComments(
    ctx: TenantContext,
    userId: UserId,
    role: UserRole,
    query: string,
  ): Promise<CommentSearchHit[]> {
    const needle = query.toLowerCase();
    const mine = role === 'admin' ? [] : await this.grants.listForUser(ctx, userId);
    const grantedDocIds = new Set(
      mine.filter((g) => g.subject.type === 'document').map((g) => g.subject.id as string),
    );
    // ADR 0014: a project-subject grant confers access to every document in it.
    const grantedProjectIds = new Set(
      mine.filter((g) => g.subject.type === 'project').map((g) => g.subject.id as string),
    );
    const hits: CommentSearchHit[] = [];
    for (const c of this.world.comments.values()) {
      if (c.orgId !== ctx.orgId) continue;
      const doc = this.world.documents.get(c.documentId);
      if (!doc || doc.deletedAt || doc.archivedAt) continue;
      const permitted =
        role === 'admin' ||
        doc.ownerId === userId ||
        grantedDocIds.has(c.documentId) ||
        (doc.projectId !== null && grantedProjectIds.has(doc.projectId));
      if (!permitted) continue;
      const haystack = `${c.body}\n${c.proposedText ?? ''}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
      hits.push({
        kind: 'comment',
        commentId: c.id,
        documentId: c.documentId,
        documentTitle: doc.title,
        snippet: c.body,
        anchor: c.anchor,
        versionId: c.versionId,
        status: c.status,
        authorId: c.authorId,
        createdAt: c.createdAt,
        rank: 1,
      });
    }
    return hits;
  }
}

export class FakeAnchorResolutionRepository implements AnchorResolutionRepository {
  rows = new Map<string, AnchorResolution>();
  upserts = 0;
  /** Cutoff dates the cache prune was invoked with, one per org swept. */
  pruneCalls: { orgId: OrgId; olderThan: Date }[] = [];
  /** Rows the next pruneStale reports deleted — the SQL is proven in Pg tests. */
  pruneReturns = 0;

  forVersion(ctx: TenantContext, versionId: VersionId): Promise<AnchorResolution[]> {
    void ctx;
    return Promise.resolve([...this.rows.values()].filter((r) => r.versionId === versionId));
  }

  upsert(ctx: TenantContext, resolution: AnchorResolution): Promise<void> {
    void ctx;
    this.upserts += 1;
    this.rows.set(`${resolution.commentId}:${resolution.versionId}`, resolution);
    return Promise.resolve();
  }

  pruneStale(ctx: TenantContext, olderThan: Date): Promise<number> {
    this.pruneCalls.push({ orgId: ctx.orgId, olderThan });
    return Promise.resolve(this.pruneReturns);
  }
}

/** VersionRepository fake over the shared world (byId + list only). */
export class FakeVersionRepository {
  constructor(private readonly world: FakeWorld) {}

  byId(ctx: TenantContext, id: VersionId): Promise<DocumentVersion | undefined> {
    const v = this.world.versions.get(id);
    return Promise.resolve(v?.orgId === ctx.orgId ? v : undefined);
  }

  listForDocument(ctx: TenantContext, documentId: DocumentId): Promise<DocumentVersion[]> {
    return Promise.resolve(
      [...this.world.versions.values()]
        .filter((v) => v.documentId === documentId && v.orgId === ctx.orgId)
        .sort((a, b) => a.seq - b.seq),
    );
  }

  append(): Promise<DocumentVersion> {
    return Promise.reject(new Error('use FakeUploadUnitOfWork for appends'));
  }

  tombstone(ctx: TenantContext, id: VersionId): Promise<DocumentVersion | undefined> {
    const v = this.world.versions.get(id);
    if (v?.orgId !== ctx.orgId || v.purgedAt !== null) return Promise.resolve(undefined);
    const tombstoned = { ...v, purgedAt: new Date() };
    this.world.versions.set(id, tombstoned);
    return Promise.resolve(tombstoned);
  }

  /** Mirrors `PgVersionRepository.storageBytesUsed` — sums live blobs for the caller's org only. */
  storageBytesUsed(ctx: TenantContext): Promise<number> {
    return Promise.resolve(
      [...this.world.versions.values()]
        .filter((v) => v.orgId === ctx.orgId && v.purgedAt === null)
        .reduce((sum, v) => sum + v.byteSize, 0),
    );
  }
}

export class FakeOrganizationRepository implements OrganizationRepository, OrgLifecyclePort {
  purgedOrgIds: OrgId[] = [];

  constructor(private readonly world: FakeWorld) {}

  current(ctx: TenantContext): Promise<Organization | undefined> {
    return Promise.resolve(this.world.orgs.get(ctx.orgId));
  }

  /** Privileged (no tenant context) — erasure replay / operator purge only. */
  orgById(orgId: OrgId): Promise<Organization | undefined> {
    return Promise.resolve(this.world.orgs.get(orgId));
  }

  purgeOrganization(orgId: OrgId): Promise<void> {
    this.purgedOrgIds.push(orgId);
    this.world.orgs.delete(orgId);
    for (const [id, d] of [...this.world.documents])
      if (d.orgId === orgId) this.world.documents.delete(id);
    for (const [id, v] of [...this.world.versions])
      if (v.orgId === orgId) this.world.versions.delete(id);
    for (const [id, c] of [...this.world.comments])
      if (c.orgId === orgId) this.world.comments.delete(id);
    return Promise.resolve();
  }

  listUsers(ctx: TenantContext): Promise<User[]> {
    // Mirrors Pg: guests are never members/seats.
    return Promise.resolve(
      [...this.world.users.values()].filter((u) => u.orgId === ctx.orgId && u.role !== 'guest'),
    );
  }

  async listUsersPage(
    ctx: TenantContext,
    opts: { q?: string; cursor?: string; limit: number },
  ): Promise<{ users: User[]; nextCursor: string | null }> {
    const q = opts.q?.toLowerCase();
    const nameOf = (u: User): string => u.displayName.toLowerCase();
    const all = (await this.listUsers(ctx))
      .filter(
        (u) =>
          !q || u.displayName.toLowerCase().startsWith(q) || u.email.toLowerCase().startsWith(q),
      )
      .sort((a, b) => {
        const an = nameOf(a);
        const bn = nameOf(b);
        if (an !== bn) return an < bn ? -1 : 1;
        return a.id < b.id ? -1 : 1;
      });
    // Real (name, id) tuple comparison, matching the Pg repository's own
    // `(lower(display_name), id) > ($1, $2::uuid)` — not a raw string
    // compare on the opaque cursor, so this fake decodes and encodes with
    // the exact same shared codec the real repository uses
    // (encodeNameKeysetCursor/decodeNameKeysetCursor, @mdloop/app) rather
    // than a parallel, independently-delimited format that could silently
    // diverge from it again.
    const after = opts.cursor ? decodeNameKeysetCursor(opts.cursor) : null;
    const remaining = after
      ? all.filter((u) => {
          const name = nameOf(u);
          return name !== after.name ? name > after.name : u.id > after.id;
        })
      : all;
    const page = remaining.slice(0, opts.limit);
    const last = page[page.length - 1];
    const nextCursor =
      remaining.length > opts.limit && last
        ? encodeNameKeysetCursor(last.displayName, last.id)
        : null;
    return { users: page, nextCursor };
  }

  userById(ctx: TenantContext, id: UserId): Promise<User | undefined> {
    // Includes guests, unlike listUsers — Phase B validates guest reviewers.
    const user = this.world.users.get(id);
    return Promise.resolve(user?.orgId === ctx.orgId ? user : undefined);
  }

  updateSettings(ctx: TenantContext, patch: OrgSettingsPatch): Promise<Organization | undefined> {
    const org = this.world.orgs.get(ctx.orgId);
    if (!org) return Promise.resolve(undefined);
    const updated = { ...org, ...patch };
    this.world.orgs.set(org.id, updated);
    return Promise.resolve(updated);
  }
}

/** Org invites (Phase 15), tenant-scoped like the real `org_invites` RLS table. */
export class FakeOrgInviteRepository implements OrgInviteRepository {
  constructor(private readonly world: FakeWorld) {}

  private scoped(ctx: TenantContext): OrgInvite[] {
    return [...this.world.invites.values()].filter((i) => i.orgId === ctx.orgId);
  }

  create(ctx: TenantContext, input: NewOrgInvite): Promise<OrgInvite> {
    const invite: OrgInvite = {
      id: randomUUID() as InviteId,
      orgId: ctx.orgId,
      email: input.email,
      role: input.role,
      tokenHash: input.tokenHash,
      invitedBy: input.invitedBy,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
      acceptedAt: null,
      revokedAt: null,
    };
    this.world.invites.set(invite.id, invite);
    return Promise.resolve(invite);
  }

  async createWithinSeatCap(
    ctx: TenantContext,
    input: NewOrgInvite,
    limit: number | null,
  ): Promise<OrgInvite | undefined> {
    if (limit !== null) {
      const members = [...this.world.users.values()].filter(
        (u) => u.orgId === ctx.orgId && u.role !== 'guest',
      ).length;
      const pending = await this.countPending(ctx);
      if (members + pending >= limit) return undefined;
    }
    return this.create(ctx, input);
  }

  list(ctx: TenantContext): Promise<OrgInvite[]> {
    return Promise.resolve(this.scoped(ctx));
  }

  countPending(ctx: TenantContext): Promise<number> {
    return Promise.resolve(
      this.scoped(ctx).filter((i) => i.acceptedAt === null && i.revokedAt === null).length,
    );
  }

  revoke(ctx: TenantContext, id: InviteId): Promise<boolean> {
    const invite = this.scoped(ctx).find((i) => i.id === id && i.revokedAt === null);
    if (!invite) return Promise.resolve(false);
    this.world.invites.set(id, { ...invite, revokedAt: new Date() });
    return Promise.resolve(true);
  }

  createWithinSeatCapForOrg(
    orgId: OrgId,
    input: Omit<NewOrgInvite, 'invitedBy'>,
    limit: number | null,
  ): Promise<OrgInvite | undefined> {
    if (limit !== null) {
      const members = [...this.world.users.values()].filter(
        (u) => u.orgId === orgId && u.role !== 'guest',
      ).length;
      const pending = [...this.world.invites.values()].filter(
        (i) => i.orgId === orgId && i.acceptedAt === null && i.revokedAt === null,
      ).length;
      if (members + pending >= limit) return Promise.resolve(undefined);
    }
    const invite: OrgInvite = {
      id: randomUUID() as InviteId,
      orgId,
      email: input.email,
      role: input.role,
      tokenHash: input.tokenHash,
      invitedBy: null,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
      acceptedAt: null,
      revokedAt: null,
    };
    this.world.invites.set(invite.id, invite);
    return Promise.resolve(invite);
  }
}

/** Enterprise allowlist entries (Phase 15), tenant-scoped. */
export class FakeAllowlistRepository implements AllowlistRepository {
  constructor(private readonly world: FakeWorld) {}

  private scoped(ctx: TenantContext): AllowlistEntry[] {
    return [...this.world.allowlist.values()].filter((a) => a.orgId === ctx.orgId);
  }

  add(ctx: TenantContext, input: NewAllowlistEntry): Promise<AllowlistEntry> {
    const entry: AllowlistEntry = {
      id: randomUUID() as AllowlistEntryId,
      orgId: ctx.orgId,
      email: input.email,
      addedBy: input.addedBy,
      createdAt: new Date(),
    };
    this.world.allowlist.set(entry.id, entry);
    return Promise.resolve(entry);
  }

  list(ctx: TenantContext): Promise<AllowlistEntry[]> {
    return Promise.resolve(this.scoped(ctx));
  }

  remove(ctx: TenantContext, id: AllowlistEntryId): Promise<boolean> {
    const entry = this.scoped(ctx).find((a) => a.id === id);
    if (!entry) return Promise.resolve(false);
    this.world.allowlist.delete(id);
    return Promise.resolve(true);
  }
}

/**
 * Privileged directory (Phase 2 org/user bootstrap + Phase 15 invite/JIT
 * seams) over the shared world — mirrors PgDirectoryRepository's RLS-free
 * trust boundary: no tenant context, lookups by unique keys or hash only.
 */
export class FakeDirectoryRepository implements DirectoryRepository {
  constructor(
    private readonly world: FakeWorld,
    /** Needed only for guestGrantByTokenHash (Phase 18) — grants live outside the world. */
    private readonly grantRepo?: FakeShareGrantRepository,
  ) {}

  createOrganization(
    name: string,
    tier: 'free' | 'team' | 'enterprise' = 'team',
  ): Promise<Organization> {
    return Promise.resolve(this.world.org({ name, tier }));
  }

  createUser(
    orgId: OrgId,
    input: Pick<User, 'workosUserId' | 'email' | 'displayName' | 'role'>,
  ): Promise<User> {
    return Promise.resolve(this.world.addUser(orgId, input));
  }

  async createUserWithinSeatCap(
    orgId: OrgId,
    input: Pick<User, 'workosUserId' | 'email' | 'displayName' | 'role'>,
    limit: number | null,
  ): Promise<User | undefined> {
    if (limit !== null && (await this.memberCount(orgId)) >= limit) return undefined;
    return this.createUser(orgId, input);
  }

  organizationById(id: OrgId): Promise<Organization | undefined> {
    return Promise.resolve(this.world.orgs.get(id));
  }

  userByWorkosId(workosUserId: string): Promise<User | undefined> {
    return Promise.resolve(
      [...this.world.users.values()].find((u) => u.workosUserId === workosUserId),
    );
  }

  memberCount(orgId: OrgId): Promise<number> {
    // Guests never occupy a seat (Phase 18).
    return Promise.resolve(
      [...this.world.users.values()].filter((u) => u.orgId === orgId && u.role !== 'guest').length,
    );
  }

  organizationBySsoConnection(connectionId: string): Promise<Organization | undefined> {
    return Promise.resolve(
      [...this.world.orgs.values()].find((o) => o.ssoConnectionId === connectionId),
    );
  }

  isAllowlisted(orgId: OrgId, email: string): Promise<boolean> {
    return Promise.resolve(
      [...this.world.allowlist.values()].some(
        (a) => a.orgId === orgId && a.email.toLowerCase() === email.toLowerCase(),
      ),
    );
  }

  inviteByTokenHash(tokenHash: string): Promise<OrgInvite | undefined> {
    return Promise.resolve([...this.world.invites.values()].find((i) => i.tokenHash === tokenHash));
  }

  markInviteAccepted(id: InviteId): Promise<void> {
    const invite = this.world.invites.get(id);
    if (invite) this.world.invites.set(id, { ...invite, acceptedAt: new Date() });
    return Promise.resolve();
  }

  guestGrantByTokenHash(tokenHash: string): Promise<ShareGrant | undefined> {
    // Cross-org lookup by hash (Phase 18): no revoke/expiry filter here — the
    // use case checks those explicitly to answer honestly, like the Pg impl.
    return Promise.resolve(
      [...(this.grantRepo?.grants.values() ?? [])].find(
        (g) => g.tokenHash === tokenHash && g.granteeEmail !== null,
      ),
    );
  }
}

/** Guest users (Phase 18): tenant-scoped find-or-create over the shared world. */
export class FakeGuestUserRepository implements GuestUserRepository {
  constructor(private readonly world: FakeWorld) {}

  guestByEmail(ctx: TenantContext, email: string): Promise<User | undefined> {
    return Promise.resolve(
      [...this.world.users.values()].find(
        (u) => u.orgId === ctx.orgId && u.role === 'guest' && u.email === email.toLowerCase(),
      ),
    );
  }

  createGuest(ctx: TenantContext, email: string): Promise<User> {
    return Promise.resolve(
      this.world.addUser(ctx.orgId, {
        workosUserId: `guest:${randomUUID()}`,
        email: email.toLowerCase(),
        displayName: email.toLowerCase(),
        role: 'guest',
      }),
    );
  }
}

export class FakeRetentionSweepRepository implements RetentionSweepRepository {
  constructor(private readonly world: FakeWorld) {}

  listDue(now: Date): Promise<{ orgId: OrgId; documentId: DocumentId }[]> {
    return Promise.resolve(
      [...this.world.documents.values()]
        .filter((d) => d.deletedAt && d.purgeAfter && d.purgeAfter.getTime() <= now.getTime())
        .map((d) => ({ orgId: d.orgId, documentId: d.id })),
    );
  }

  purge(orgId: OrgId, documentId: DocumentId): Promise<void> {
    const doc = this.world.documents.get(documentId);
    if (doc?.orgId === orgId) {
      this.world.documents.delete(documentId);
      for (const v of [...this.world.versions.values()]) {
        if (v.documentId === documentId) this.world.versions.delete(v.id);
      }
    }
    return Promise.resolve();
  }
}

/** Append-only in memory, like the real table. */
export class FakeErasureLog implements ErasureLogPort {
  events: LoggedErasure[] = [];

  record(event: ErasureEvent): Promise<void> {
    this.events.push({ ...event, occurredAt: new Date() });
    return Promise.resolve();
  }

  list(): Promise<LoggedErasure[]> {
    return Promise.resolve([...this.events]);
  }
}

export class FakeEmail implements EmailPort {
  sent: { to: string; orgName: string; purgeAt: Date }[] = [];
  invitesSent: { to: string; orgName: string; acceptUrl: string; expiresAt: Date }[] = [];
  guestSharesSent: { to: string; documentTitle: string; url: string; expiresAt: Date }[] = [];
  /** Set true to simulate an unreachable SMTP relay — every method rejects
   *  instead of resolving, without recording a send. Exercises the
   *  best-effort `.catch(() => undefined)` callers in invites.ts and
   *  guest-sharing.ts, which must still return the already-persisted token
   *  even when this port rejects (SmtpEmailAdapter can fail for real,
   *  unlike this fake's default resolve-always behavior). */
  failing = false;

  sendIdleWarning(to: string, orgName: string, purgeAt: Date): Promise<void> {
    if (this.failing) return Promise.reject(new Error('simulated SMTP failure'));
    this.sent.push({ to, orgName, purgeAt });
    return Promise.resolve();
  }

  sendOrgInvite(to: string, orgName: string, acceptUrl: string, expiresAt: Date): Promise<void> {
    if (this.failing) return Promise.reject(new Error('simulated SMTP failure'));
    this.invitesSent.push({ to, orgName, acceptUrl, expiresAt });
    return Promise.resolve();
  }

  sendGuestShare(input: {
    to: string;
    documentTitle: string;
    url: string;
    expiresAt: Date;
  }): Promise<void> {
    if (this.failing) return Promise.reject(new Error('simulated SMTP failure'));
    this.guestSharesSent.push(input);
    return Promise.resolve();
  }
}

export class FakeApiKeyRepository implements ApiKeyRepository {
  keys = new Map<string, ApiKey & { keyHash: string }>();

  constructor(private readonly world: FakeWorld) {}

  private scoped(ctx: TenantContext): (ApiKey & { keyHash: string })[] {
    return [...this.keys.values()].filter((k) => k.orgId === ctx.orgId);
  }

  create(
    ctx: TenantContext,
    input: { userId: UserId; name: string; keyHash: string },
  ): Promise<ApiKey> {
    const record: ApiKey & { keyHash: string } = {
      id: randomUUID(),
      orgId: ctx.orgId,
      userId: input.userId,
      name: input.name,
      createdAt: new Date(),
      lastUsedAt: null,
      revokedAt: null,
      keyHash: input.keyHash,
    };
    this.keys.set(record.id, record);
    return Promise.resolve(record);
  }

  listForUser(ctx: TenantContext, userId: UserId): Promise<ApiKey[]> {
    return Promise.resolve(this.scoped(ctx).filter((k) => k.userId === userId));
  }

  listAll(ctx: TenantContext): Promise<ApiKey[]> {
    return Promise.resolve(this.scoped(ctx));
  }

  revoke(ctx: TenantContext, id: string): Promise<boolean> {
    const key = this.scoped(ctx).find((k) => k.id === id && k.revokedAt === null);
    if (!key) return Promise.resolve(false);
    this.keys.set(id, { ...key, revokedAt: new Date() });
    return Promise.resolve(true);
  }

  identityByHash(keyHash: string): Promise<ApiKeyIdentity | undefined> {
    const key = [...this.keys.values()].find((k) => k.keyHash === keyHash && k.revokedAt === null);
    if (!key) return Promise.resolve(undefined);
    this.keys.set(key.id, { ...key, lastUsedAt: new Date() });
    return Promise.resolve({
      keyId: key.id,
      orgId: key.orgId,
      userId: key.userId,
      role: this.world.userRoles.get(key.userId) ?? 'member',
    });
  }

  // Revoked keys included on purpose — mirrors PgApiKeyRepository.namesByIds.
  namesByIds(ctx: TenantContext, ids: string[]): Promise<Map<string, string>> {
    const found = this.scoped(ctx).filter((k) => ids.includes(k.id));
    return Promise.resolve(new Map(found.map((k) => [k.id, k.name])));
  }
}

/**
 * Public Docs Hub (ADR 0004): a deliberately standalone in-memory store, NOT
 * part of `FakeWorld` — the real table has no `org_id` and no tenant scoping,
 * so this fake shouldn't have any either. Keyed by slug, one row per slug.
 */
export class FakePublicHubRepository implements PublicHubRepository {
  private bySlug = new Map<string, PublicDoc>();

  publish(input: {
    slug: string;
    title: string;
    body: string;
    contentHash: string;
    byteSize: number;
    sourceOrgId: OrgId;
    sourceDocumentId: DocumentId;
    sourceVersionId: VersionId;
    publishedBy: UserId;
  }): Promise<PublicDoc> {
    const existing = this.bySlug.get(input.slug);
    const now = new Date();
    const doc: PublicDoc = {
      id: existing?.id ?? (randomUUID() as PublicDocId),
      slug: input.slug,
      title: input.title,
      contentHash: input.contentHash,
      byteSize: input.byteSize,
      seq: (existing?.seq ?? 0) + 1,
      publishedAt: existing?.publishedAt ?? now,
      updatedAt: now,
    };
    this.bySlug.set(input.slug, doc);
    return Promise.resolve(doc);
  }

  getBySlug(slug: string): Promise<PublicDoc | null> {
    return Promise.resolve(this.bySlug.get(slug) ?? null);
  }

  list(after?: PublicHubKeyset | null, limit = 100): Promise<PublicDoc[]> {
    const ordered = [...this.bySlug.values()].sort(
      (a, b) =>
        b.publishedAt.getTime() - a.publishedAt.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    const from = after
      ? ordered.findIndex(
          (d) =>
            d.publishedAt.getTime() < after.publishedAt.getTime() ||
            (d.publishedAt.getTime() === after.publishedAt.getTime() && d.id < after.id),
        )
      : 0;
    const start = from === -1 ? ordered.length : from;
    return Promise.resolve(ordered.slice(start, start + limit));
  }

  search(query: string): Promise<(PublicDoc & { snippet: string })[]> {
    const needle = query.toLowerCase();
    return Promise.resolve(
      [...this.bySlug.values()]
        .filter((d) => d.title.toLowerCase().includes(needle))
        .map((d) => ({ ...d, snippet: d.title })),
    );
  }

  unpublish(slug: string): Promise<void> {
    this.bySlug.delete(slug);
    return Promise.resolve();
  }
}

// Backward-compatible re-export (same pattern as
// packages/mcp/src/auth/workos-jwt-verifier.ts's relocation): the real
// production export now lives in ../user-rate-limit.ts, since Phase D's
// selfhost-main.ts needs a real `UnlimitedRateLimiter` and importing
// production code from `test-support` would be backwards. Existing imports
// of `UnlimitedRateLimiter` from this module (e.g. e2e-main.ts) keep
// compiling unchanged.
export { UnlimitedRateLimiter } from '../user-rate-limit.js';

/**
 * Recording rate limiter (models `FakeStorage`'s shape — a public backing
 * map, real domain math): every call is logged and the in-process token
 * bucket actually enforces tier ceilings, for tests asserting on 429/retry
 * behavior without standing up a real store.
 */
export class FakeRateLimiter implements RateLimiterPort {
  calls: { userId: UserId; tier: Tier }[] = [];
  private readonly delegate: UserRateLimiter;

  constructor(clock: () => number = Date.now) {
    this.delegate = new UserRateLimiter(clock);
  }

  check(userId: UserId, tier: Tier): Promise<Result<void, RateLimitError>> {
    this.calls.push({ userId, tier });
    return this.delegate.check(userId, tier);
  }
}
