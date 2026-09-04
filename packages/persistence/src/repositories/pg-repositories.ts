import type { Pool, PoolClient } from 'pg';
import type {
  AnchorResolution,
  AnchorResolutionRepository,
  CommentMention,
  CommentRepository,
  CommentKeyset,
  CommentRollup,
  CommentRollupReader,
  CommentSearchHit,
  DirectoryRepository,
  GuestUserRepository,
  DocumentExportKeyset,
  DocumentListFilter,
  DocumentRepository,
  NewComment,
  NewDocument,
  NewProject,
  NewReply,
  NewShareGrant,
  NewVersion,
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
  SearchHit,
  SearchRepository,
  ShareGrantRepository,
  TenantContext,
  UploadLedgerRepository,
  UploadTx,
  UploadUnitOfWork,
  VersionPurgeSweepRepository,
  VersionRepository,
} from '@mdloop/app';
import type {
  Anchor,
  Comment,
  CommentReply,
  Document,
  DocumentVersion,
  MentionCandidate,
  OrgInvite,
  Organization,
  Project,
  ShareGrant,
  User,
  UserRole,
} from '@mdloop/domain';
import type {
  CommentId,
  DocumentId,
  InviteId,
  OrgId,
  ProjectId,
  PublicDocId,
  UserId,
  VersionId,
} from '@mdloop/shared';
import { withProvisioner, withPublicReader, withTenant } from '../db.js';
import * as q from './queries.js';
import {
  toComment,
  toDocument,
  toGrant,
  toOrganization,
  toOrgInvite,
  toProject,
  toReply,
  toUser,
  toVersion,
} from './row-mappers.js';
import type {
  CommentRow,
  DocumentRow,
  GrantRow,
  OrganizationRow,
  OrgInviteRow,
  ProjectRow,
  ReplyRow,
  UserRow,
  VersionRow,
} from './row-mappers.js';

/** First row of a RETURNING/select that must yield exactly one row. */
function one<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error('expected a row, got none');
  return row;
}

/**
 * The comment INSERT, shared by `create` and `createWithinCap` so both paths
 * emit identical SQL. Caller is already inside a withTenant transaction.
 * Suggested edits (Phase C): a non-null proposedText makes this a suggestion
 * (kind + outcome derived here, honoring the DB's kind-iff-proposed_text
 * invariant). Null → a plain comment.
 */
async function insertComment(c: PoolClient, orgId: OrgId, input: NewComment): Promise<Comment> {
  const proposedText = input.proposedText ?? null;
  const isSuggestion = proposedText !== null;
  const { rows } = await c.query<CommentRow>(
    `insert into comments
       (org_id, document_id, version_id, author_id, body, anchor, via_api_key_id,
        kind, proposed_text, suggestion_outcome)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
    [
      orgId,
      input.documentId,
      input.versionId,
      input.authorId,
      input.body,
      input.anchor,
      input.viaApiKeyId ?? null,
      isSuggestion ? 'suggestion' : 'comment',
      proposedText,
      isSuggestion ? 'open' : null,
    ],
  );
  // Comments are activity for the idle free-org lifecycle (Phase 13).
  await c.query('update organizations set last_activity_at = now() where id = $1', [orgId]);
  return toComment(one(rows));
}

export class PgProjectRepository implements ProjectRepository {
  constructor(private readonly pool: Pool) {}

  async create(ctx: TenantContext, input: NewProject): Promise<Project> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<ProjectRow>(
        'insert into projects (org_id, name, color, created_by) values ($1, $2, $3, $4) returning *',
        [ctx.orgId, input.name, input.color, input.createdBy ?? null],
      );
      return toProject(one(rows));
    });
  }

  async byId(ctx: TenantContext, id: ProjectId): Promise<Project | undefined> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<ProjectRow>('select * from projects where id = $1', [id]);
      return rows[0] ? toProject(rows[0]) : undefined;
    });
  }

  async list(ctx: TenantContext): Promise<Project[]> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<ProjectRow>('select * from projects order by created_at');
      return rows.map(toProject);
    });
  }

  async update(
    ctx: TenantContext,
    id: ProjectId,
    patch: ProjectPatch,
  ): Promise<Project | undefined> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<ProjectRow>(
        `update projects
         set name = coalesce($2, name), color = coalesce($3, color)
         where id = $1 returning *`,
        [id, patch.name ?? null, patch.color ?? null],
      );
      return rows[0] ? toProject(rows[0]) : undefined;
    });
  }

  async setArchived(ctx: TenantContext, id: ProjectId, archived: boolean): Promise<boolean> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rowCount } = await c.query(
        'update projects set archived_at = case when $2 then now() else null end where id = $1',
        [id, archived],
      );
      return (rowCount ?? 0) > 0;
    });
  }

  async remove(ctx: TenantContext, id: ProjectId): Promise<boolean> {
    return withTenant(this.pool, ctx, async (c) => {
      await c.query('update documents set project_id = null where project_id = $1', [id]);
      // ADR 0014: `subject_id` on share_grants is deliberately un-FK'd (the
      // subject is polymorphic — document or project), so a project grant
      // would otherwise dangle past the project's deletion and could later
      // match a recycled uuid. Explicit cleanup in the same transaction.
      await c.query(`delete from share_grants where subject_type = 'project' and subject_id = $1`, [
        id,
      ]);
      const { rowCount } = await c.query('delete from projects where id = $1', [id]);
      return (rowCount ?? 0) > 0;
    });
  }
}

export class PgDocumentRepository implements DocumentRepository {
  constructor(private readonly pool: Pool) {}

  async create(ctx: TenantContext, input: NewDocument): Promise<Document> {
    return withTenant(this.pool, ctx, (c) => q.insertDocument(c, ctx.orgId, input));
  }

  async byId(ctx: TenantContext, id: DocumentId): Promise<Document | undefined> {
    return withTenant(this.pool, ctx, (c) => q.documentById(c, id));
  }

  async list(ctx: TenantContext, filter?: DocumentListFilter): Promise<Document[]> {
    const view = filter?.view ?? 'all';
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<DocumentRow>(
        `select * from documents
         where deleted_at is null
           and (archived_at is not null) = $1
           and ($2::uuid is null or project_id = $2)
           and (not $3 or project_id is null)
         order by created_at`,
        [view === 'archived', filter?.projectId ?? null, view === 'unfiled'],
      );
      return rows.map(toDocument);
    });
  }

  async listForExport(
    ctx: TenantContext,
    after: DocumentExportKeyset | null,
    limit: number,
  ): Promise<Document[]> {
    return withTenant(this.pool, ctx, async (c) => {
      // Keyset over (created_at, id): uuid text and pg uuid compare identically,
      // so `id > $2` agrees with the cursor's textual ordering. No access
      // predicate — export is admin/whole-org, so this stays in SQL.
      //
      // `created_at` is truncated to milliseconds on both sides of the
      // comparison and in the ORDER BY: the cursor is a JS `Date` (millisecond
      // precision, Phase 24 ADR 0003 completeness pass), but the column is a
      // microsecond-precision `timestamptz`. Comparing the untruncated column
      // against a millisecond-truncated cursor let the boundary row satisfy
      // `created_at > $1` against its OWN (rounded-down) cursor value — it
      // would reappear as the first row of the next page any time a
      // document's real timestamp had a nonzero sub-millisecond component,
      // which is the common case, not an edge case (caught by export-api.test.ts
      // walking a real page boundary rather than fixed, hand-set timestamps).
      const { rows } = await c.query<DocumentRow>(
        `select * from documents
         where deleted_at is null
           and ($1::timestamptz is null
                or date_trunc('milliseconds', created_at) > $1
                or (date_trunc('milliseconds', created_at) = $1 and id > $2::uuid))
         order by date_trunc('milliseconds', created_at), id
         limit $3`,
        [after?.createdAt ?? null, after?.id ?? null, limit],
      );
      return rows.map(toDocument);
    });
  }

  async overviewPage(
    ctx: TenantContext,
    access: OverviewAccess,
    lane: DocumentListFilter,
    after: OverviewKeyset | null,
    limit: number,
  ): Promise<OverviewPageRow[]> {
    const view = lane.view ?? 'all';
    return withTenant(this.pool, ctx, async (c) => {
      // One query for the whole home page: the lane + access filter, the
      // comment/version activity aggregate, the (last_activity desc, id desc)
      // sort and the keyset slice all run in SQL (Phase 24.F). The access
      // predicate REPLICATES PgSearchRepository.search's owner/grant/admin
      // rule; RLS is the backstop, this is the visibility filter. Deleted
      // comments never count (matches statusCounts). Ordering on the computed
      // column forces the CTE so the keyset can reference it.
      //
      // `last_activity_at` is truncated to milliseconds in both the keyset
      // comparison and the ORDER BY, same fix and same reason as
      // `listForExport`: the cursor round-trips through a JS `Date` (ms
      // precision), but `greatest(...)` over timestamptz columns carries
      // microsecond precision. Comparing the untruncated expression against a
      // ms-truncated cursor silently DROPS any document whose real activity
      // timestamp falls strictly between the truncated cursor and its true
      // value — not a duplicate like the export bug, a gap: a document simply
      // never appears on any page. Real (not hand-set) insert timestamps
      // under any concurrent write load hit this routinely, which is exactly
      // the "thousands of documents" scale this query exists for.
      const { rows } = await c.query<
        DocumentRow & { open_count: number; resolved_count: number; last_activity_at: Date }
      >(
        `with scoped as (
           select d.*,
                  coalesce(cs.open, 0)::int as open_count,
                  coalesce(cs.resolved, 0)::int as resolved_count,
                  greatest(d.created_at, cs.last_comment_at, vs.last_version_at) as last_activity_at
           from documents d
           left join (
             select document_id,
                    count(*) filter (where status = 'open') as open,
                    count(*) filter (where status = 'resolved') as resolved,
                    max(created_at) as last_comment_at
             from comments where deleted_at is null group by document_id
           ) cs on cs.document_id = d.id
           left join (
             select document_id, max(created_at) as last_version_at
             from document_versions group by document_id
           ) vs on vs.document_id = d.id
           where d.deleted_at is null
             and (d.archived_at is not null) = $1
             and ($2::uuid is null or d.project_id = $2)
             and (not $3 or d.project_id is null)
             and (
               $4 = 'admin'
               or d.owner_id = $5
               -- ADR 0014: two separate EXISTS, not one EXISTS with an
               -- internal OR across subject_type — see the note on
               -- overviewCounts.accessPredicate below for why: a single
               -- EXISTS correlated on both d.id and d.project_id can't be
               -- hoisted into a hashed subplan and forces a per-row
               -- correlated share_grants scan (a measured ~350x regression
               -- at 20k documents / 300 grants). Two single-column-correlated
               -- EXISTS clauses each hash-materialize independently.
               or exists (
                 select 1 from share_grants sg
                 where sg.grantee_type = 'user' and sg.grantee_user_id = $5
                   and sg.revoked_at is null
                   and (sg.expires_at is null or sg.expires_at > now())
                   and sg.subject_type = 'document' and sg.subject_id = d.id
               )
               or exists (
                 select 1 from share_grants sg
                 where sg.grantee_type = 'user' and sg.grantee_user_id = $5
                   and sg.revoked_at is null
                   and (sg.expires_at is null or sg.expires_at > now())
                   and sg.subject_type = 'project' and sg.subject_id = d.project_id
               )
             )
         )
         select * from scoped
         where $6::timestamptz is null
            or date_trunc('milliseconds', last_activity_at) < $6
            or (date_trunc('milliseconds', last_activity_at) = $6 and id < $7::uuid)
         order by date_trunc('milliseconds', last_activity_at) desc, id desc
         limit $8`,
        [
          view === 'archived',
          lane.projectId ?? null,
          view === 'unfiled',
          access.role,
          access.userId,
          after?.lastActivityAt ?? null,
          after?.id ?? null,
          limit,
        ],
      );
      return rows.map((r) => ({
        document: toDocument(r),
        open: r.open_count,
        resolved: r.resolved_count,
        lastActivityAt: r.last_activity_at,
      }));
    });
  }

  async overviewCounts(ctx: TenantContext, access: OverviewAccess): Promise<OverviewCounts> {
    return withTenant(this.pool, ctx, async (c) => {
      // Same owner/grant/admin predicate as overviewPage, over bounded
      // COUNT/SUM aggregates — never the document rows themselves.
      // ADR 0014: two separate EXISTS, not one EXISTS with an internal OR
      // across subject_type. Measured with EXPLAIN ANALYZE against a seeded
      // 20k-document / 300-grant org: a single EXISTS correlated on both
      // d.id and d.project_id can't be hoisted into a hashed subplan, so the
      // planner falls back to a per-outer-row correlated scan of every one
      // of the caller's share_grants rows — ~1.2s for this predicate alone
      // (vs. ~4.5ms split). Splitting on subject_type restores two
      // independent single-column correlations, each of which hashes.
      const accessPredicate = `(
        $1 = 'admin'
        or d.owner_id = $2
        or exists (
          select 1 from share_grants sg
          where sg.grantee_type = 'user' and sg.grantee_user_id = $2
            and sg.revoked_at is null
            and (sg.expires_at is null or sg.expires_at > now())
            and sg.subject_type = 'document' and sg.subject_id = d.id
        )
        or exists (
          select 1 from share_grants sg
          where sg.grantee_type = 'user' and sg.grantee_user_id = $2
            and sg.revoked_at is null
            and (sg.expires_at is null or sg.expires_at > now())
            and sg.subject_type = 'project' and sg.subject_id = d.project_id
        )
      )`;
      const { rows: countRows } = await c.query<{ all: number; unfiled: number; archived: number }>(
        `select
           count(*) filter (where d.archived_at is null)::int as all,
           count(*) filter (where d.archived_at is null and d.project_id is null)::int as unfiled,
           count(*) filter (where d.archived_at is not null)::int as archived
         from documents d
         where d.deleted_at is null and ${accessPredicate}`,
        [access.role, access.userId],
      );
      const { rows: projectRows } = await c.query<{ project_id: string; open: number }>(
        `select d.project_id as project_id, sum(oc.open)::int as open
         from documents d
         join (
           select document_id, count(*) as open from comments
           where status = 'open' and deleted_at is null group by document_id
         ) oc on oc.document_id = d.id
         where d.deleted_at is null and d.archived_at is null and d.project_id is not null
           and ${accessPredicate}
         group by d.project_id
         having sum(oc.open) > 0`,
        [access.role, access.userId],
      );
      const counts = countRows[0] ?? { all: 0, unfiled: 0, archived: 0 };
      return {
        all: counts.all,
        unfiled: counts.unfiled,
        archived: counts.archived,
        openByProject: projectRows.map((r) => ({
          projectId: r.project_id as ProjectId,
          open: r.open,
        })),
      };
    });
  }

  async countLiveInProject(
    ctx: TenantContext,
    access: OverviewAccess,
    projectId: ProjectId,
  ): Promise<number> {
    return withTenant(this.pool, ctx, async (c) => {
      // Same owner/grant/admin predicate as overviewPage, but only COUNT(*) —
      // the workspace tree's size bound (Phase 29) has to be cheap even when
      // the answer is "far too many to render". Two EXISTS, not one with an
      // internal OR — see overviewCounts.accessPredicate's comment.
      const { rows } = await c.query<{ n: number }>(
        `select count(*)::int as n from documents d
         where d.deleted_at is null and d.archived_at is null and d.project_id = $1
           and (
             $2 = 'admin'
             or d.owner_id = $3
             or exists (
               select 1 from share_grants sg
               where sg.grantee_type = 'user' and sg.grantee_user_id = $3
                 and sg.revoked_at is null
                 and (sg.expires_at is null or sg.expires_at > now())
                 and sg.subject_type = 'document' and sg.subject_id = d.id
             )
             or exists (
               select 1 from share_grants sg
               where sg.grantee_type = 'user' and sg.grantee_user_id = $3
                 and sg.revoked_at is null
                 and (sg.expires_at is null or sg.expires_at > now())
                 and sg.subject_type = 'project' and sg.subject_id = d.project_id
             )
           )`,
        [projectId, access.role, access.userId],
      );
      return rows[0]?.n ?? 0;
    });
  }

  async listProjectIndex(
    ctx: TenantContext,
    access: OverviewAccess,
    projectId: ProjectId,
  ): Promise<ProjectIndexRow[]> {
    return withTenant(this.pool, ctx, async (c) => {
      // The whole project index in one query (Phase 29): the same lane +
      // owner/grant/admin predicate `overviewPage` uses, joined to the open
      // comment count. Deliberately unpaged — a folder's aggregate is only
      // honest over the whole project — and bounded by the caller's
      // `countLiveInProject` pre-check instead. Deleted comments never count,
      // matching every other comment aggregate in this file. Ordered by path
      // then title purely for a stable payload; the client builds the tree.
      const { rows } = await c.query<DocumentRow & { open_count: number }>(
        `select d.*, coalesce(cs.open, 0)::int as open_count
         from documents d
         left join (
           select document_id, count(*) filter (where status = 'open') as open
           from comments where deleted_at is null group by document_id
         ) cs on cs.document_id = d.id
         where d.deleted_at is null and d.archived_at is null and d.project_id = $1
           and (
             $2 = 'admin'
             or d.owner_id = $3
             -- ADR 0014: two EXISTS, not one with an internal OR — see
             -- overviewCounts.accessPredicate's comment.
             or exists (
               select 1 from share_grants sg
               where sg.grantee_type = 'user' and sg.grantee_user_id = $3
                 and sg.revoked_at is null
                 and (sg.expires_at is null or sg.expires_at > now())
                 and sg.subject_type = 'document' and sg.subject_id = d.id
             )
             or exists (
               select 1 from share_grants sg
               where sg.grantee_type = 'user' and sg.grantee_user_id = $3
                 and sg.revoked_at is null
                 and (sg.expires_at is null or sg.expires_at > now())
                 and sg.subject_type = 'project' and sg.subject_id = d.project_id
             )
           )
         order by d.path nulls last, d.title, d.id`,
        [projectId, access.role, access.userId],
      );
      return rows.map((r) => ({ document: toDocument(r), open: r.open_count }));
    });
  }

  async documentIdAtPath(
    ctx: TenantContext,
    projectId: ProjectId | null,
    path: string,
  ): Promise<DocumentId | undefined> {
    return withTenant(this.pool, ctx, (c) => q.documentIdAtPath(c, projectId, path));
  }

  async moveToProject(
    ctx: TenantContext,
    id: DocumentId,
    projectId: ProjectId | null,
  ): Promise<boolean> {
    return withTenant(this.pool, ctx, async (c) => {
      // `path` is deliberately absent from this UPDATE: a project move is a
      // human action and never rewrites the repo path the CLI owns (Phase 29).
      const { rowCount } = await c.query(
        'update documents set project_id = $2 where id = $1 and deleted_at is null',
        [id, projectId],
      );
      return (rowCount ?? 0) > 0;
    });
  }

  async setArchived(ctx: TenantContext, id: DocumentId, archived: boolean): Promise<boolean> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rowCount } = await c.query(
        `update documents set archived_at = case when $2 then now() else null end
         where id = $1 and deleted_at is null`,
        [id, archived],
      );
      return (rowCount ?? 0) > 0;
    });
  }

  async purge(ctx: TenantContext, id: DocumentId): Promise<void> {
    await withTenant(this.pool, ctx, (c) => q.purgeDocument(c, id));
  }

  async softDelete(ctx: TenantContext, id: DocumentId, purgeAfter: Date): Promise<boolean> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rowCount } = await c.query(
        'update documents set deleted_at = now(), purge_after = $2 where id = $1 and deleted_at is null',
        [id, purgeAfter],
      );
      return (rowCount ?? 0) > 0;
    });
  }

  async activeCount(ctx: TenantContext): Promise<number> {
    return withTenant(this.pool, ctx, (c) => q.countActiveDocs(c));
  }

  async activeCountInProject(ctx: TenantContext, projectId: ProjectId): Promise<number> {
    return withTenant(this.pool, ctx, (c) => q.countActiveDocsInProject(c, projectId));
  }
}

export class PgVersionRepository implements VersionRepository {
  constructor(private readonly pool: Pool) {}

  async append(ctx: TenantContext, input: NewVersion): Promise<DocumentVersion> {
    return withTenant(this.pool, ctx, (c) => q.appendVersion(c, ctx.orgId, input));
  }

  async byId(ctx: TenantContext, id: VersionId): Promise<DocumentVersion | undefined> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<VersionRow>('select * from document_versions where id = $1', [
        id,
      ]);
      return rows[0] ? toVersion(rows[0]) : undefined;
    });
  }

  async listForDocument(ctx: TenantContext, documentId: DocumentId): Promise<DocumentVersion[]> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<VersionRow>(
        'select * from document_versions where document_id = $1 order by seq',
        [documentId],
      );
      return rows.map(toVersion);
    });
  }

  async tombstone(ctx: TenantContext, id: VersionId): Promise<DocumentVersion | undefined> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<VersionRow>(
        'update document_versions set purged_at = now() where id = $1 and purged_at is null returning *',
        [id],
      );
      const tombstoned = rows[0] ? toVersion(rows[0]) : undefined;
      if (tombstoned) {
        // search_index is one row per document (queries.ts indexVersion),
        // pointing at whichever version was last indexed — normally the
        // current one. The version_id match here makes this a no-op when the
        // row already points elsewhere (the common case); it only fires when
        // the row is still stale against the version we just purged, mirroring
        // the whole-document purge's search_index cleanup (queries.ts purgeDocument).
        await c.query('delete from search_index where document_id = $1 and version_id = $2', [
          tombstoned.documentId,
          tombstoned.id,
        ]);
      }
      return tombstoned;
    });
  }

  async storageBytesUsed(ctx: TenantContext): Promise<number> {
    return withTenant(this.pool, ctx, (c) => q.sumLiveStorageBytes(c));
  }
}

export class PgAnchorResolutionRepository implements AnchorResolutionRepository {
  constructor(private readonly pool: Pool) {}

  async forVersion(ctx: TenantContext, versionId: VersionId): Promise<AnchorResolution[]> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<{
        comment_id: string;
        version_id: string;
        method: AnchorResolution['method'];
        confidence: number;
        start_offset: number | null;
        end_offset: number | null;
      }>('select * from comment_anchor_resolutions where version_id = $1', [versionId]);
      return rows.map((r) => ({
        commentId: r.comment_id as CommentId,
        versionId: r.version_id as VersionId,
        method: r.method,
        confidence: r.confidence,
        start: r.start_offset,
        end: r.end_offset,
      }));
    });
  }

  async upsert(ctx: TenantContext, resolution: AnchorResolution): Promise<void> {
    await withTenant(this.pool, ctx, async (c) => {
      await c.query(
        `insert into comment_anchor_resolutions
           (comment_id, version_id, org_id, method, confidence, start_offset, end_offset)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (comment_id, version_id) do update
           set method = excluded.method, confidence = excluded.confidence,
               start_offset = excluded.start_offset, end_offset = excluded.end_offset,
               computed_at = now()`,
        [
          resolution.commentId,
          resolution.versionId,
          ctx.orgId,
          resolution.method,
          resolution.confidence,
          resolution.start,
          resolution.end,
        ],
      );
    });
  }

  async pruneStale(ctx: TenantContext, olderThan: Date): Promise<number> {
    return withTenant(this.pool, ctx, async (c) => {
      // A version is "current" iff a document points at it; a resolution for
      // any other version is a superseded/tombstoned cache row, safe to drop
      // and recompute on demand. RLS scopes both sides to the caller's org.
      const { rowCount } = await c.query(
        `delete from comment_anchor_resolutions
         where computed_at < $1
           and version_id not in (
             select current_version_id from documents where current_version_id is not null
           )`,
        [olderThan],
      );
      return rowCount ?? 0;
    });
  }
}

export class PgCommentRollupReader implements CommentRollupReader {
  constructor(private readonly pool: Pool) {}

  async rollup(ctx: TenantContext): Promise<CommentRollup[]> {
    return withTenant(this.pool, ctx, async (c) => {
      // One row per live document; aggregates pre-grouped in subqueries so
      // comments and versions never cross-join. greatest() skips nulls.
      const { rows } = await c.query<{
        document_id: string;
        open: string | null;
        resolved: string | null;
        last_activity_at: Date;
      }>(
        `select d.id as document_id,
                cs.open, cs.resolved,
                greatest(d.created_at, cs.last_comment_at, vs.last_version_at) as last_activity_at
         from documents d
         left join (
           select document_id,
                  count(*) filter (where status = 'open') as open,
                  count(*) filter (where status = 'resolved') as resolved,
                  max(created_at) as last_comment_at
           from comments group by document_id
         ) cs on cs.document_id = d.id
         left join (
           select document_id, max(created_at) as last_version_at
           from document_versions group by document_id
         ) vs on vs.document_id = d.id
         where d.deleted_at is null`,
      );
      return rows.map((r) => ({
        documentId: r.document_id as DocumentId,
        open: Number(r.open ?? 0),
        resolved: Number(r.resolved ?? 0),
        lastActivityAt: r.last_activity_at,
      }));
    });
  }
}

export class PgCommentRepository implements CommentRepository {
  constructor(private readonly pool: Pool) {}

  async create(ctx: TenantContext, input: NewComment): Promise<Comment> {
    return withTenant(this.pool, ctx, (c) => insertComment(c, ctx.orgId, input));
  }

  async createWithinCap(
    ctx: TenantContext,
    input: NewComment,
    limit: number | null,
  ): Promise<Comment | undefined> {
    return withTenant(this.pool, ctx, async (c) => {
      // Per-org advisory lock held for the whole transaction (Phase 24): it
      // serializes the count→insert against every other cap-checked comment
      // create in this org, so two concurrent creates at ceiling-1 can never
      // both commit. hashtextextended maps the org uuid to the bigint the lock
      // key wants; the '0' namespace keeps it distinct from other lock families.
      await c.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [ctx.orgId]);
      if (limit !== null) {
        const { rows } = await c.query<{ n: string }>(
          'select count(*) as n from comments where document_id = $1 and deleted_at is null',
          [input.documentId],
        );
        if (Number(one(rows).n) >= limit) return undefined;
      }
      return insertComment(c, ctx.orgId, input);
    });
  }

  async byId(ctx: TenantContext, id: CommentId): Promise<Comment | undefined> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<CommentRow>(
        'select * from comments where id = $1 and deleted_at is null',
        [id],
      );
      return rows[0] ? toComment(rows[0]) : undefined;
    });
  }

  async listForDocument(
    ctx: TenantContext,
    documentId: DocumentId,
    status?: 'open' | 'resolved',
  ): Promise<Comment[]> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<CommentRow>(
        `select * from comments where document_id = $1
           and deleted_at is null
           and ($2::text is null or status = $2)
         order by created_at`,
        [documentId, status ?? null],
      );
      return rows.map(toComment);
    });
  }

  async listForDocumentPage(
    ctx: TenantContext,
    documentId: DocumentId,
    status: 'open' | 'resolved' | undefined,
    after: CommentKeyset | null,
    limit: number,
  ): Promise<Comment[]> {
    return withTenant(this.pool, ctx, async (c) => {
      // Keyset over (created_at, id) ascending — the order the thread list has
      // always used (oldest first). Backed by comments_doc_created_idx (0025).
      const { rows } = await c.query<CommentRow>(
        `select * from comments
         where document_id = $1
           and deleted_at is null
           and ($2::text is null or status = $2)
           and ($3::timestamptz is null
                or created_at > $3
                or (created_at = $3 and id > $4::uuid))
         order by created_at, id
         limit $5`,
        [documentId, status ?? null, after?.createdAt ?? null, after?.id ?? null, limit],
      );
      return rows.map(toComment);
    });
  }

  async countForDocument(ctx: TenantContext, documentId: DocumentId): Promise<number> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<{ n: string }>(
        'select count(*) as n from comments where document_id = $1 and deleted_at is null',
        [documentId],
      );
      return Number(one(rows).n);
    });
  }

  async statusCounts(
    ctx: TenantContext,
    documentId: DocumentId,
  ): Promise<{ open: number; resolved: number }> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<{ open: string; resolved: string }>(
        `select count(*) filter (where status = 'open') as open,
                count(*) filter (where status = 'resolved') as resolved
         from comments where document_id = $1 and deleted_at is null`,
        [documentId],
      );
      return { open: Number(one(rows).open), resolved: Number(one(rows).resolved) };
    });
  }

  async openCommentVersionIds(ctx: TenantContext, documentId: DocumentId): Promise<VersionId[]> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<{ version_id: string }>(
        `select distinct version_id from comments
         where document_id = $1 and status = 'open' and deleted_at is null`,
        [documentId],
      );
      return rows.map((r) => r.version_id as VersionId);
    });
  }

  async resolve(ctx: TenantContext, id: CommentId, resolvedBy: UserId): Promise<boolean> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rowCount } = await c.query(
        `update comments set status = 'resolved', resolved_by = $2, resolved_at = now()
         where id = $1 and status = 'open' and deleted_at is null`,
        [id, resolvedBy],
      );
      return (rowCount ?? 0) > 0;
    });
  }

  async setSuggestionOutcome(
    ctx: TenantContext,
    id: CommentId,
    outcome: 'accepted' | 'rejected',
    appliedVersionId: VersionId | null,
  ): Promise<Comment | undefined> {
    return withTenant(this.pool, ctx, async (c) => {
      // Conditional on kind='suggestion' AND outcome='open': a concurrent
      // accept/reject that already resolved this row matches zero rows here, so
      // double-resolve is a lost update (undefined), never a silent overwrite.
      const { rows } = await c.query<CommentRow>(
        `update comments
           set suggestion_outcome = $2, applied_version_id = $3
         where id = $1 and kind = 'suggestion' and suggestion_outcome = 'open'
           and deleted_at is null
         returning *`,
        [id, outcome, appliedVersionId],
      );
      return rows[0] ? toComment(rows[0]) : undefined;
    });
  }

  async markSuggestionApplied(
    ctx: TenantContext,
    id: CommentId,
    appliedVersionId: VersionId,
  ): Promise<Comment | undefined> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<CommentRow>(
        `update comments
           set applied_version_id = $2
         where id = $1 and kind = 'suggestion' and suggestion_outcome = 'accepted'
           and applied_version_id is null and deleted_at is null
         returning *`,
        [id, appliedVersionId],
      );
      return rows[0] ? toComment(rows[0]) : undefined;
    });
  }

  async update(ctx: TenantContext, id: CommentId, body: string): Promise<Comment> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<CommentRow>(
        'update comments set body = $2 where id = $1 and deleted_at is null returning *',
        [id, body],
      );
      return toComment(one(rows));
    });
  }

  async delete(ctx: TenantContext, id: CommentId): Promise<boolean> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rowCount } = await c.query(
        'update comments set deleted_at = now() where id = $1 and deleted_at is null',
        [id],
      );
      return (rowCount ?? 0) > 0;
    });
  }

  async addReply(ctx: TenantContext, input: NewReply): Promise<CommentReply> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<ReplyRow>(
        `insert into comment_replies (org_id, comment_id, parent_reply_id, author_id, body, via_api_key_id)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [
          ctx.orgId,
          input.commentId,
          input.parentReplyId,
          input.authorId,
          input.body,
          input.viaApiKeyId ?? null,
        ],
      );
      return toReply(one(rows));
    });
  }

  async listReplies(ctx: TenantContext, commentId: CommentId): Promise<CommentReply[]> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<ReplyRow>(
        'select * from comment_replies where comment_id = $1 order by created_at',
        [commentId],
      );
      return rows.map(toReply);
    });
  }

  async listRepliesForDocument(
    ctx: TenantContext,
    documentId: DocumentId,
  ): Promise<CommentReply[]> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<ReplyRow>(
        `select r.* from comment_replies r
         join comments c on c.id = r.comment_id and c.org_id = r.org_id
         where c.document_id = $1
         order by r.created_at`,
        [documentId],
      );
      return rows.map(toReply);
    });
  }

  async listRepliesForComments(
    ctx: TenantContext,
    commentIds: CommentId[],
  ): Promise<CommentReply[]> {
    if (commentIds.length === 0) return [];
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<ReplyRow>(
        'select * from comment_replies where comment_id = any($1::uuid[]) order by created_at',
        [commentIds],
      );
      return rows.map(toReply);
    });
  }

  async toggleUpvote(
    ctx: TenantContext,
    commentId: CommentId,
    userId: UserId,
  ): Promise<{ upvoted: boolean; count: number }> {
    return withTenant(this.pool, ctx, async (c) => {
      const inserted = await c.query(
        `insert into comment_upvotes (comment_id, org_id, user_id)
         values ($1, $2, $3) on conflict (comment_id, user_id) do nothing`,
        [commentId, ctx.orgId, userId],
      );
      const upvoted = (inserted.rowCount ?? 0) > 0;
      if (!upvoted) {
        await c.query('delete from comment_upvotes where comment_id = $1 and user_id = $2', [
          commentId,
          userId,
        ]);
      }
      const { rows } = await c.query<{ n: string }>(
        'select count(*) as n from comment_upvotes where comment_id = $1',
        [commentId],
      );
      return { upvoted, count: Number(one(rows).n) };
    });
  }

  async upvotesForDocument(
    ctx: TenantContext,
    documentId: DocumentId,
    userId: UserId,
  ): Promise<Map<CommentId, { count: number; mine: boolean }>> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<{ comment_id: string; count: string; mine: boolean }>(
        `select u.comment_id,
                count(*) as count,
                bool_or(u.user_id = $2) as mine
         from comment_upvotes u
         join comments c on c.id = u.comment_id and c.org_id = u.org_id
         where c.document_id = $1
         group by u.comment_id`,
        [documentId, userId],
      );
      return new Map(
        rows.map((r) => [r.comment_id as CommentId, { count: Number(r.count), mine: r.mine }]),
      );
    });
  }

  async upvotesForComments(
    ctx: TenantContext,
    commentIds: CommentId[],
    userId: UserId,
  ): Promise<Map<CommentId, { count: number; mine: boolean }>> {
    if (commentIds.length === 0) return new Map();
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<{ comment_id: string; count: string; mine: boolean }>(
        `select comment_id,
                count(*) as count,
                bool_or(user_id = $2) as mine
         from comment_upvotes
         where comment_id = any($1::uuid[])
         group by comment_id`,
        [commentIds, userId],
      );
      return new Map(
        rows.map((r) => [r.comment_id as CommentId, { count: Number(r.count), mine: r.mine }]),
      );
    });
  }

  async mentionCandidates(ctx: TenantContext, documentId: DocumentId): Promise<MentionCandidate[]> {
    return withTenant(this.pool, ctx, async (c) => {
      // The doc-scoped set (ADR 0003 §D): owner + everyone who authored a
      // comment or reply on the doc + its requested reviewers. RLS keeps every
      // subquery in-org; distinct collapses people who appear in several roles.
      const { rows } = await c.query<{ id: string; display_name: string }>(
        `select distinct u.id, u.display_name
         from users u
         where u.id in (select owner_id from documents where id = $1)
            or u.id in (
              select author_id from comments
              where document_id = $1 and deleted_at is null
            )
            or u.id in (
              select cr.author_id from comment_replies cr
              join comments c on c.id = cr.comment_id and c.org_id = cr.org_id
              where c.document_id = $1 and c.deleted_at is null
            )
            or u.id in (
              select reviewer_user_id from review_requests
              where document_id = $1 and revoked_at is null
            )`,
        [documentId],
      );
      return rows.map((r) => ({ id: r.id as UserId, displayName: r.display_name }));
    });
  }

  async replaceMentions(
    ctx: TenantContext,
    commentId: CommentId,
    mentionedUserIds: UserId[],
  ): Promise<void> {
    await withTenant(this.pool, ctx, async (c) => {
      // Delete-all + re-insert so re-parsing an edited body is idempotent.
      await c.query('delete from comment_mentions where comment_id = $1', [commentId]);
      if (mentionedUserIds.length === 0) return;
      await c.query(
        `insert into comment_mentions (org_id, comment_id, mentioned_user_id)
         select $1, $2, unnest($3::uuid[])
         on conflict (comment_id, mentioned_user_id) do nothing`,
        [ctx.orgId, commentId, mentionedUserIds],
      );
    });
  }

  async mentionsForDocument(
    ctx: TenantContext,
    documentId: DocumentId,
  ): Promise<Map<CommentId, CommentMention[]>> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<{
        comment_id: string;
        user_id: string;
        display_name: string;
      }>(
        `select m.comment_id, m.mentioned_user_id as user_id, u.display_name
         from comment_mentions m
         join comments c on c.id = m.comment_id and c.org_id = m.org_id
         join users u on u.id = m.mentioned_user_id and u.org_id = m.org_id
         where c.document_id = $1 and c.deleted_at is null
         order by u.display_name`,
        [documentId],
      );
      const out = new Map<CommentId, CommentMention[]>();
      for (const r of rows) {
        const key = r.comment_id as CommentId;
        const mention: CommentMention = {
          userId: r.user_id as UserId,
          displayName: r.display_name,
        };
        const bucket = out.get(key);
        if (bucket) bucket.push(mention);
        else out.set(key, [mention]);
      }
      return out;
    });
  }

  async mentionsForComments(
    ctx: TenantContext,
    commentIds: CommentId[],
  ): Promise<Map<CommentId, CommentMention[]>> {
    if (commentIds.length === 0) return new Map();
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<{
        comment_id: string;
        user_id: string;
        display_name: string;
      }>(
        `select m.comment_id, m.mentioned_user_id as user_id, u.display_name
         from comment_mentions m
         join users u on u.id = m.mentioned_user_id and u.org_id = m.org_id
         where m.comment_id = any($1::uuid[])
         order by u.display_name`,
        [commentIds],
      );
      const out = new Map<CommentId, CommentMention[]>();
      for (const r of rows) {
        const key = r.comment_id as CommentId;
        const mention: CommentMention = {
          userId: r.user_id as UserId,
          displayName: r.display_name,
        };
        const bucket = out.get(key);
        if (bucket) bucket.push(mention);
        else out.set(key, [mention]);
      }
      return out;
    });
  }
}

async function insertGrant(c: PoolClient, orgId: OrgId, input: NewShareGrant): Promise<ShareGrant> {
  const { rows } = await c.query<GrantRow>(
    `insert into share_grants
       (org_id, subject_type, subject_id, grantee_type, grantee_user_id, permission, token_hash,
        expires_at, grantee_email, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
    [
      orgId,
      input.subject.type,
      input.subject.id,
      input.grantee.type,
      input.grantee.type === 'user' ? input.grantee.userId : null,
      input.permission,
      input.tokenHash,
      input.expiresAt ?? null,
      input.granteeEmail ?? null,
      input.createdBy,
    ],
  );
  return toGrant(one(rows));
}

/**
 * The caller's highest-ranked active grant on one document (ADR 0008), OR on
 * the project it currently lives in (ADR 0014) — the input the upload and
 * share gates need. `projectId` is optional so call sites that already know
 * the document has no project (or don't care) can skip the extra `or`.
 * Ranking mirrors the domain lattice (`read < comment < share < edit`); the
 * active filter mirrors `listForUser`, so a revoked or expired grant buys
 * nothing here either.
 */
async function highestGrantFor(
  c: PoolClient,
  documentId: DocumentId,
  userId: UserId,
  projectId?: ProjectId | null,
): Promise<ShareGrant | undefined> {
  const { rows } = await c.query<GrantRow>(
    `select * from share_grants
     where grantee_type = 'user' and grantee_user_id = $2
       and revoked_at is null and (expires_at is null or expires_at > now())
       and (
         (subject_type = 'document' and subject_id = $1)
         or (subject_type = 'project' and subject_id = $3::uuid)
       )
     order by case permission
                when 'edit' then 3 when 'share' then 2 when 'comment' then 1 else 0
              end desc,
              created_at desc
     limit 1`,
    [documentId, userId, projectId ?? null],
  );
  return rows[0] ? toGrant(rows[0]) : undefined;
}

export class PgShareGrantRepository implements ShareGrantRepository {
  constructor(private readonly pool: Pool) {}

  async create(ctx: TenantContext, input: NewShareGrant): Promise<ShareGrant> {
    return withTenant(this.pool, ctx, (c) => insertGrant(c, ctx.orgId, input));
  }

  async createWithinGuestCap(
    ctx: TenantContext,
    input: NewShareGrant,
    guestEmail: string,
    limit: number | null,
  ): Promise<ShareGrant | undefined> {
    return withTenant(this.pool, ctx, async (c) => {
      // Same per-org advisory lock family as the other cap-checked creates
      // (Phase 24): serializes recount-then-insert so concurrent shares to two
      // new guest emails at ceiling-1 cannot both commit. Seats already held
      // by this email are excluded — a re-share never consumes a new seat.
      await c.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [ctx.orgId]);
      if (limit !== null) {
        const { rows } = await c.query<{ n: string }>(
          `select count(distinct lower(grantee_email)) as n from share_grants
           where grantee_email is not null and lower(grantee_email) <> $1
             and revoked_at is null and (expires_at is null or expires_at > now())`,
          [guestEmail.toLowerCase()],
        );
        if (Number(one(rows).n) >= limit) return undefined;
      }
      return insertGrant(c, ctx.orgId, input);
    });
  }

  async listForDocument(ctx: TenantContext, documentId: DocumentId): Promise<ShareGrant[]> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<GrantRow>(
        `select * from share_grants
         where subject_type = 'document' and subject_id = $1 and revoked_at is null
         order by created_at`,
        [documentId],
      );
      return rows.map(toGrant);
    });
  }

  /**
   * Grants on a project itself (ADR 0014) — deliberately separate from
   * `listForDocument`: a project grant is never spliced into a document's own
   * grant list, it's listed on the project's own share surface.
   */
  async listForProject(ctx: TenantContext, projectId: ProjectId): Promise<ShareGrant[]> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<GrantRow>(
        `select * from share_grants
         where subject_type = 'project' and subject_id = $1 and revoked_at is null
         order by created_at`,
        [projectId],
      );
      return rows.map(toGrant);
    });
  }

  async listForUser(ctx: TenantContext, userId: UserId): Promise<ShareGrant[]> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<GrantRow>(
        `select * from share_grants
         where grantee_type = 'user' and grantee_user_id = $1 and revoked_at is null
           and (expires_at is null or expires_at > now())
         order by created_at`,
        [userId],
      );
      return rows.map(toGrant);
    });
  }

  async byTokenHash(ctx: TenantContext, tokenHash: string): Promise<ShareGrant | undefined> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<GrantRow>(
        `select * from share_grants where token_hash = $1 and revoked_at is null
           and (expires_at is null or expires_at > now())`,
        [tokenHash],
      );
      return rows[0] ? toGrant(rows[0]) : undefined;
    });
  }

  async activeGuestEmails(ctx: TenantContext): Promise<string[]> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<{ email: string }>(
        `select distinct lower(grantee_email) as email from share_grants
         where grantee_email is not null and revoked_at is null
           and (expires_at is null or expires_at > now())`,
      );
      return rows.map((r) => r.email);
    });
  }

  async extendGuestGrant(
    ctx: TenantContext,
    id: ShareGrant['id'],
    patch: { permission: ShareGrant['permission']; tokenHash: string; expiresAt: Date },
  ): Promise<ShareGrant> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<GrantRow>(
        `update share_grants
         set permission = $2, token_hash = $3, expires_at = $4
         where id = $1 and grantee_email is not null and revoked_at is null
         returning *`,
        [id, patch.permission, patch.tokenHash, patch.expiresAt],
      );
      return toGrant(one(rows));
    });
  }

  async revoke(ctx: TenantContext, id: ShareGrant['id']): Promise<boolean> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rowCount } = await c.query(
        'update share_grants set revoked_at = now() where id = $1 and revoked_at is null',
        [id],
      );
      return (rowCount ?? 0) > 0;
    });
  }
}

export class PgUploadLedgerRepository implements UploadLedgerRepository {
  constructor(private readonly pool: Pool) {}

  async record(ctx: TenantContext, versionId: VersionId, byteSize: number): Promise<void> {
    await withTenant(this.pool, ctx, (c) =>
      q.recordUpload(c, ctx.orgId, ctx.userId, versionId, byteSize),
    );
  }
}

/**
 * The upload money path: one withTenant transaction spanning the quota read,
 * document/version inserts and ledger write (CONSTITUTION.md §4). The blob
 * write happens inside the callback too — a storage failure rolls the whole
 * upload back.
 */
export class PgUploadUnitOfWork implements UploadUnitOfWork {
  constructor(private readonly pool: Pool) {}

  run<T>(ctx: TenantContext, fn: (tx: UploadTx) => Promise<T>): Promise<T> {
    return withTenant(this.pool, ctx, (c) =>
      fn({
        org: () => q.currentOrg(c),
        activeDocCount: () => q.activeDocCount(c),
        activeDocCountInProject: (projectId) => q.activeDocCountInProject(c, projectId),
        liveVersionCount: (documentId) => q.liveVersionCount(c, documentId),
        documentById: (id) => q.documentById(c, id),
        projectById: (id) => q.projectById(c, id),
        createDocument: (input) => q.insertDocument(c, ctx.orgId, input),
        documentIdAtPath: (projectId, path) => q.documentIdAtPath(c, projectId, path),
        setDocumentPath: (id, path) => q.setDocumentPath(c, id, path),
        currentVersion: (documentId) => q.currentVersion(c, documentId),
        reserveVersionSeq: (documentId) => q.reserveVersionSeq(c, documentId),
        insertVersionAtSeq: (seq, input) => q.insertVersionAtSeq(c, ctx.orgId, seq, input),
        recordUpload: (versionId, byteSize) =>
          q.recordUpload(c, ctx.orgId, ctx.userId, versionId, byteSize),
        indexVersion: (input) => q.indexVersion(c, ctx.orgId, input),
        markSuggestionAccepted: (id, appliedVersionId) =>
          q.markSuggestionAccepted(c, id, appliedVersionId),
        highestGrantFor: (documentId, userId, projectId) =>
          highestGrantFor(c, documentId, userId, projectId),
        purgeDocumentRow: (id) => q.purgeDocument(c, id),
      }),
    );
  }
}

/**
 * Permission-scoped full-text search (ARCHITECTURE.md §9): RLS bounds rows
 * to the caller's org; the `where` clause further narrows to documents the
 * caller owns or is granted, mirroring `listAccessibleDocuments` — admins
 * see the whole org, nobody else sees org-wide results.
 */
export class PgSearchRepository implements SearchRepository {
  constructor(private readonly pool: Pool) {}

  async search(
    ctx: TenantContext,
    userId: UserId,
    role: UserRole,
    query: string,
  ): Promise<SearchHit[]> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<{
        document_id: string;
        title: string;
        project_id: string | null;
        path: string | null;
        rank: number;
      }>(
        `select d.id as document_id, d.title, d.project_id, d.path,
                ts_rank(si.tsv, websearch_to_tsquery('english', $1)) as rank
         from search_index si
         join documents d on d.id = si.document_id and d.org_id = si.org_id
         where si.tsv @@ websearch_to_tsquery('english', $1)
           and d.deleted_at is null
           and d.archived_at is null
           and (
             $2 = 'admin'
             or d.owner_id = $3
             -- ADR 0014: two EXISTS, not one with an internal OR — see
             -- overviewCounts.accessPredicate's comment.
             or exists (
               select 1 from share_grants sg
               where sg.grantee_type = 'user' and sg.grantee_user_id = $3
                 and sg.revoked_at is null
                 and (sg.expires_at is null or sg.expires_at > now())
                 and sg.subject_type = 'document' and sg.subject_id = d.id
             )
             or exists (
               select 1 from share_grants sg
               where sg.grantee_type = 'user' and sg.grantee_user_id = $3
                 and sg.revoked_at is null
                 and (sg.expires_at is null or sg.expires_at > now())
                 and sg.subject_type = 'project' and sg.subject_id = d.project_id
             )
           )
         order by rank desc
         limit 50`,
        [query, role, userId],
      );
      return rows.map((r) => ({
        kind: 'document' as const,
        documentId: r.document_id as DocumentId,
        title: r.title,
        projectId: r.project_id as ProjectId | null,
        path: r.path,
        rank: r.rank,
      }));
    });
  }

  /**
   * Comment full-text search (ADR 0003 §C). RLS bounds rows to the caller's
   * org; the `where` clause REPLICATES the owner/grant/admin predicate from
   * `search` above (joined through the comment's document), plus excludes
   * soft-deleted comments — RLS is the backstop, never the filter. The GIN
   * `search_vector` covers body + suggestion proposed_text; `ts_headline`
   * builds a snippet (org content — fine in the response, never in a log).
   */
  async searchComments(
    ctx: TenantContext,
    userId: UserId,
    role: UserRole,
    query: string,
  ): Promise<CommentSearchHit[]> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<{
        comment_id: string;
        document_id: string;
        document_title: string;
        anchor: Anchor;
        version_id: string;
        status: 'open' | 'resolved';
        author_id: string;
        created_at: Date;
        snippet: string;
        rank: number;
      }>(
        `select cm.id as comment_id, cm.document_id, d.title as document_title,
                cm.anchor, cm.version_id, cm.status, cm.author_id, cm.created_at,
                ts_rank(cm.search_vector, websearch_to_tsquery('english', $1)) as rank,
                ts_headline('english', cm.body, websearch_to_tsquery('english', $1),
                  'StartSel=«,StopSel=»,MaxFragments=1,MaxWords=20,MinWords=6') as snippet
         from comments cm
         join documents d on d.id = cm.document_id and d.org_id = cm.org_id
         where cm.search_vector @@ websearch_to_tsquery('english', $1)
           and cm.deleted_at is null
           and d.deleted_at is null
           and d.archived_at is null
           and (
             $2 = 'admin'
             or d.owner_id = $3
             -- ADR 0014: two EXISTS, not one with an internal OR — see
             -- overviewCounts.accessPredicate's comment.
             or exists (
               select 1 from share_grants sg
               where sg.grantee_type = 'user' and sg.grantee_user_id = $3
                 and sg.revoked_at is null
                 and (sg.expires_at is null or sg.expires_at > now())
                 and sg.subject_type = 'document' and sg.subject_id = d.id
             )
             or exists (
               select 1 from share_grants sg
               where sg.grantee_type = 'user' and sg.grantee_user_id = $3
                 and sg.revoked_at is null
                 and (sg.expires_at is null or sg.expires_at > now())
                 and sg.subject_type = 'project' and sg.subject_id = d.project_id
             )
           )
         order by rank desc
         limit 50`,
        [query, role, userId],
      );
      return rows.map((r) => ({
        kind: 'comment' as const,
        commentId: r.comment_id as CommentId,
        documentId: r.document_id as DocumentId,
        documentTitle: r.document_title,
        snippet: r.snippet,
        anchor: r.anchor,
        versionId: r.version_id as VersionId,
        status: r.status,
        authorId: r.author_id as UserId,
        createdAt: r.created_at,
        rank: r.rank,
      }));
    });
  }
}

/**
 * Retention sweep: the due-scan runs as the provisioner (system job, no
 * tenant on the call stack) but reads only opaque ids; each purge re-enters
 * the normal RLS-scoped path for its org. The bound userId is a placeholder —
 * withTenant only binds orgId to the session.
 */
export class PgRetentionSweepRepository implements RetentionSweepRepository {
  constructor(private readonly pool: Pool) {}

  async listDue(now: Date, limit = 100): Promise<{ orgId: OrgId; documentId: DocumentId }[]> {
    return withProvisioner(this.pool, async (c) => {
      const { rows } = await c.query<{ id: string; org_id: string }>(
        `select id, org_id from documents
         where deleted_at is not null and purge_after <= $1
         order by purge_after limit $2`,
        [now, limit],
      );
      return rows.map((r) => ({ orgId: r.org_id as OrgId, documentId: r.id as DocumentId }));
    });
  }

  async purge(orgId: OrgId, documentId: DocumentId): Promise<void> {
    const ctx: TenantContext = { orgId, userId: 'system-retention-sweep' as UserId };
    await withTenant(this.pool, ctx, (c) => q.purgeDocument(c, documentId));
  }
}

/**
 * Version auto-purge sweep (ADR 0001): the org scan runs as the provisioner
 * (system job, no tenant on the call stack) but returns only opaque org ids;
 * every read and tombstone write re-enters the RLS-scoped repositories.
 */
export class PgVersionPurgeSweepRepository implements VersionPurgeSweepRepository {
  constructor(private readonly pool: Pool) {}

  async listOrgIds(limit = 1000): Promise<OrgId[]> {
    return withProvisioner(this.pool, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        'select id from organizations order by created_at limit $1',
        [limit],
      );
      return rows.map((r) => r.id as OrgId);
    });
  }
}

export class PgDirectoryRepository implements DirectoryRepository {
  constructor(private readonly pool: Pool) {}

  async createOrganization(
    name: string,
    tier: 'free' | 'team' | 'enterprise' = 'team',
  ): Promise<Organization> {
    return withProvisioner(this.pool, async (c) => {
      const { rows } = await c.query<OrganizationRow>(
        'insert into organizations (name, tier) values ($1, $2) returning *',
        [name, tier],
      );
      return toOrganization(one(rows));
    });
  }

  async createUser(
    orgId: OrgId,
    input: Pick<User, 'workosUserId' | 'email' | 'displayName' | 'role'>,
  ): Promise<User> {
    return withProvisioner(this.pool, async (c) => {
      const { rows } = await c.query<UserRow>(
        `insert into users (org_id, workos_user_id, email, display_name, role)
         values ($1, $2, $3, $4, $5) returning *`,
        [orgId, input.workosUserId, input.email, input.displayName, input.role],
      );
      return toUser(one(rows));
    });
  }

  async createUserWithinSeatCap(
    orgId: OrgId,
    input: Pick<User, 'workosUserId' | 'email' | 'displayName' | 'role'>,
    limit: number | null,
  ): Promise<User | undefined> {
    return withProvisioner(this.pool, async (c) => {
      // Same per-org advisory lock family as the other cap-checked creates
      // (Phase 24): recount-then-insert is serialized so concurrent JIT joins
      // at ceiling-1 cannot both commit. Guests never occupy a seat (Phase 18).
      await c.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [orgId]);
      if (limit !== null) {
        const { rows } = await c.query<{ n: string }>(
          `select count(*) as n from users where org_id = $1 and role <> 'guest'`,
          [orgId],
        );
        if (Number(one(rows).n) >= limit) return undefined;
      }
      const { rows } = await c.query<UserRow>(
        `insert into users (org_id, workos_user_id, email, display_name, role)
         values ($1, $2, $3, $4, $5) returning *`,
        [orgId, input.workosUserId, input.email, input.displayName, input.role],
      );
      return toUser(one(rows));
    });
  }

  async organizationById(id: OrgId): Promise<Organization | undefined> {
    return withProvisioner(this.pool, async (c) => {
      const { rows } = await c.query<OrganizationRow>('select * from organizations where id = $1', [
        id,
      ]);
      return rows[0] ? toOrganization(rows[0]) : undefined;
    });
  }

  async userByWorkosId(workosUserId: string): Promise<User | undefined> {
    return withProvisioner(this.pool, async (c) => {
      const { rows } = await c.query<UserRow>('select * from users where workos_user_id = $1', [
        workosUserId,
      ]);
      return rows[0] ? toUser(rows[0]) : undefined;
    });
  }

  async memberCount(orgId: OrgId): Promise<number> {
    return withProvisioner(this.pool, async (c) => {
      // Guests never occupy a seat (Phase 18).
      const { rows } = await c.query<{ count: string }>(
        `select count(*) from users where org_id = $1 and role <> 'guest'`,
        [orgId],
      );
      return Number(rows[0]?.count ?? 0);
    });
  }

  async organizationBySsoConnection(connectionId: string): Promise<Organization | undefined> {
    return withProvisioner(this.pool, async (c) => {
      const { rows } = await c.query<OrganizationRow>(
        'select * from organizations where sso_connection_id = $1',
        [connectionId],
      );
      return rows[0] ? toOrganization(rows[0]) : undefined;
    });
  }

  async isAllowlisted(orgId: OrgId, email: string): Promise<boolean> {
    return withProvisioner(this.pool, async (c) => {
      const { rows } = await c.query(
        'select 1 from org_allowlist_entries where org_id = $1 and lower(email) = lower($2)',
        [orgId, email],
      );
      return rows.length > 0;
    });
  }

  async inviteByTokenHash(tokenHash: string): Promise<OrgInvite | undefined> {
    return withProvisioner(this.pool, async (c) => {
      const { rows } = await c.query<OrgInviteRow>(
        'select * from org_invites where token_hash = $1',
        [tokenHash],
      );
      return rows[0] ? toOrgInvite(rows[0]) : undefined;
    });
  }

  async markInviteAccepted(id: InviteId): Promise<void> {
    await withProvisioner(this.pool, async (c) => {
      await c.query('update org_invites set accepted_at = now() where id = $1', [id]);
    });
  }

  async guestGrantByTokenHash(tokenHash: string): Promise<ShareGrant | undefined> {
    return withProvisioner(this.pool, async (c) => {
      // Cross-org lookup by hash (Phase 18): revoke/expiry deliberately not
      // filtered here — the use case checks them to answer honestly.
      const { rows } = await c.query<GrantRow>(
        'select * from share_grants where token_hash = $1 and grantee_email is not null',
        [tokenHash],
      );
      return rows[0] ? toGrant(rows[0]) : undefined;
    });
  }
}

/**
 * Guest users (Phase 18): tenant-scoped find-or-create for the synthetic
 * users row backing an external guest share. `workos_user_id` is
 * `guest:<uuid>` so a real WorkOS sign-in can never resolve to a guest.
 */
export class PgGuestUserRepository implements GuestUserRepository {
  constructor(private readonly pool: Pool) {}

  async guestByEmail(ctx: TenantContext, email: string): Promise<User | undefined> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<UserRow>(
        `select * from users where role = 'guest' and lower(email) = lower($1)`,
        [email],
      );
      return rows[0] ? toUser(rows[0]) : undefined;
    });
  }

  async createGuest(ctx: TenantContext, email: string): Promise<User> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<UserRow>(
        `insert into users (org_id, workos_user_id, email, display_name, role)
         values ($1, $2, lower($3), lower($3), 'guest') returning *`,
        [ctx.orgId, `guest:${crypto.randomUUID()}`, email],
      );
      return toUser(one(rows));
    });
  }
}

interface PublicDocRow {
  id: string;
  slug: string;
  title: string;
  content_hash: string;
  byte_size: number;
  seq: number;
  published_at: Date;
  updated_at: Date;
}

function toPublicDoc(row: PublicDocRow): PublicDoc {
  return {
    id: row.id as PublicDocId,
    slug: row.slug,
    title: row.title,
    contentHash: row.content_hash,
    byteSize: row.byte_size,
    seq: row.seq,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Public Docs Hub persistence (ADR 0004). `publish`/`unpublish` are the one
 * bridge from the tenant model into the public store and run via
 * `withProvisioner` (bypasses RLS, the same role that bootstraps
 * organizations/users). The read methods run via `withPublicReader` — the
 * role with SELECT on `public_documents` and nothing else — and take no
 * TenantContext at all, since there is no tenant on the anonymous read path.
 *
 * Like `search_index`, the document body itself is never stored as a column
 * here (it lives only in blob storage) — only its tsvector contribution
 * (weight B) survives. `search()`'s snippet is therefore built from `title`
 * only: a body-only match still ranks and returns the row, just without a
 * highlighted excerpt (same tradeoff PgSearchRepository makes for `SearchHit`).
 */
export class PgPublicHubRepository implements PublicHubRepository {
  constructor(private readonly pool: Pool) {}

  async publish(input: {
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
    return withProvisioner(this.pool, async (c) => {
      const { rows } = await c.query<PublicDocRow>(
        `insert into public_documents
           (slug, title, content_hash, byte_size, seq,
            source_org_id, source_document_id, source_version_id, published_by, tsv)
         values ($1, $2, $3, $4, 1, $5, $6, $7, $8,
           setweight(to_tsvector('english', $2), 'A') || setweight(to_tsvector('english', $9), 'B'))
         on conflict (slug) do update set
           title = excluded.title,
           content_hash = excluded.content_hash,
           byte_size = excluded.byte_size,
           seq = public_documents.seq + 1,
           source_org_id = excluded.source_org_id,
           source_document_id = excluded.source_document_id,
           source_version_id = excluded.source_version_id,
           published_by = excluded.published_by,
           tsv = excluded.tsv,
           updated_at = now()
         returning *`,
        [
          input.slug,
          input.title,
          input.contentHash,
          input.byteSize,
          input.sourceOrgId,
          input.sourceDocumentId,
          input.sourceVersionId,
          input.publishedBy,
          input.body,
        ],
      );
      return toPublicDoc(one(rows));
    });
  }

  async getBySlug(slug: string): Promise<PublicDoc | null> {
    return withPublicReader(this.pool, async (c) => {
      const { rows } = await c.query<PublicDocRow>(
        'select * from public_documents where slug = $1',
        [slug],
      );
      return rows[0] ? toPublicDoc(rows[0]) : null;
    });
  }

  async list(after?: PublicHubKeyset | null, limit = 100): Promise<PublicDoc[]> {
    return withPublicReader(this.pool, async (c) => {
      // Keyset over (published_at, id) descending (Phase 24.F), backed by
      // public_documents_published_idx (0025) — the anonymous list no longer
      // seq-scans + sorts the whole hub. `after` null = first (newest) page.
      const { rows } = await c.query<PublicDocRow>(
        `select * from public_documents
         where $1::timestamptz is null
            or published_at < $1
            or (published_at = $1 and id < $2::uuid)
         order by published_at desc, id desc
         limit $3`,
        [after?.publishedAt ?? null, after?.id ?? null, limit],
      );
      return rows.map(toPublicDoc);
    });
  }

  async search(query: string): Promise<(PublicDoc & { snippet: string })[]> {
    return withPublicReader(this.pool, async (c) => {
      const { rows } = await c.query<PublicDocRow & { snippet: string }>(
        `select *,
                ts_headline('english', title, websearch_to_tsquery('english', $1),
                  'StartSel=«,StopSel=»,MaxFragments=1,MaxWords=20,MinWords=6') as snippet
         from public_documents
         where tsv @@ websearch_to_tsquery('english', $1)
         order by ts_rank(tsv, websearch_to_tsquery('english', $1)) desc
         limit 50`,
        [query],
      );
      return rows.map((r) => ({ ...toPublicDoc(r), snippet: r.snippet }));
    });
  }

  async unpublish(slug: string): Promise<void> {
    await withProvisioner(this.pool, (c) =>
      c.query('delete from public_documents where slug = $1', [slug]),
    );
  }
}
