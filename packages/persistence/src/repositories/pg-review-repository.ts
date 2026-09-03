import type { Pool } from 'pg';
import type {
  NewApproval,
  NewReviewRequest,
  ReviewRepository,
  ReviewRollup,
  TenantContext,
} from '@vorlyn/app';
import type { Approval, ApprovalVerdict, ReviewRequest } from '@vorlyn/domain';
import { deriveReviewStatus } from '@vorlyn/domain';
import type { DocumentId, ReviewRequestId, UserId } from '@vorlyn/shared';
import { withTenant } from '../db.js';
import { toApproval, toReviewRequest } from './row-mappers.js';
import type { ApprovalRow, ReviewRequestRow } from './row-mappers.js';

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error('expected a row, got none');
  return row;
}

/**
 * Sign-off workflow persistence (Phase B). Read methods join the reviewer's
 * display name/email at read time (guests can't call listOrgUsers). Approvals
 * are append-only — there is no update/delete method, matching the DB grant.
 */
export class PgReviewRepository implements ReviewRepository {
  constructor(private readonly pool: Pool) {}

  async createRequest(ctx: TenantContext, input: NewReviewRequest): Promise<ReviewRequest> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<ReviewRequestRow>(
        `with ins as (
           insert into review_requests (org_id, document_id, reviewer_user_id, requested_by)
           values ($1, $2, $3, $4)
           returning *
         )
         select ins.*, u.display_name as reviewer_name, u.email as reviewer_email
         from ins join users u on u.id = ins.reviewer_user_id and u.org_id = ins.org_id`,
        [ctx.orgId, input.documentId, input.reviewerUserId, input.requestedBy],
      );
      return toReviewRequest(one(rows));
    });
  }

  async activeRequestsForDocument(
    ctx: TenantContext,
    documentId: DocumentId,
  ): Promise<ReviewRequest[]> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<ReviewRequestRow>(
        `select r.*, u.display_name as reviewer_name, u.email as reviewer_email
         from review_requests r
         join users u on u.id = r.reviewer_user_id and u.org_id = r.org_id
         where r.document_id = $1 and r.revoked_at is null
         order by r.created_at`,
        [documentId],
      );
      return rows.map(toReviewRequest);
    });
  }

  async revokeRequest(ctx: TenantContext, id: ReviewRequestId): Promise<boolean> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rowCount } = await c.query(
        'update review_requests set revoked_at = now() where id = $1 and revoked_at is null',
        [id],
      );
      return (rowCount ?? 0) > 0;
    });
  }

  async createApproval(ctx: TenantContext, input: NewApproval): Promise<Approval> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<ApprovalRow>(
        `with ins as (
           insert into approvals
             (org_id, document_id, version_id, reviewer_user_id, verdict, note, via_api_key_id)
           values ($1, $2, $3, $4, $5, $6, $7)
           returning *
         )
         select ins.*, u.display_name as reviewer_name, u.email as reviewer_email
         from ins join users u on u.id = ins.reviewer_user_id and u.org_id = ins.org_id`,
        [
          ctx.orgId,
          input.documentId,
          input.versionId,
          input.reviewerUserId,
          input.verdict,
          input.note,
          input.viaApiKeyId ?? null,
        ],
      );
      return toApproval(one(rows));
    });
  }

  async approvalsForDocument(ctx: TenantContext, documentId: DocumentId): Promise<Approval[]> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<ApprovalRow>(
        `select a.*, u.display_name as reviewer_name, u.email as reviewer_email
         from approvals a
         join users u on u.id = a.reviewer_user_id and u.org_id = a.org_id
         where a.document_id = $1
         order by a.created_at desc`,
        [documentId],
      );
      return rows.map(toApproval);
    });
  }

  async reviewRollup(ctx: TenantContext, documentIds?: DocumentId[]): Promise<ReviewRollup[]> {
    // Empty scope short-circuits — a page with no documents needs no query.
    if (documentIds?.length === 0) return [];
    return withTenant(this.pool, ctx, async (c) => {
      // One grouped query: per live document, the active reviewers and the
      // verdicts on its current version. The domain function derives status —
      // one source of truth for the rule (never duplicated into SQL). `$1`
      // scopes to the home page's documents when given (Phase 24.F); null =
      // the whole live org (unchanged behavior for other callers).
      const { rows } = await c.query<{
        document_id: string;
        active_reviewers: string[];
        verdicts: { reviewerUserId: string; verdict: ApprovalVerdict; createdAt: string }[];
      }>(
        `select d.id as document_id,
                coalesce((
                  select json_agg(rr.reviewer_user_id)
                  from review_requests rr
                  where rr.document_id = d.id and rr.revoked_at is null
                ), '[]'::json) as active_reviewers,
                coalesce((
                  select json_agg(json_build_object(
                    'reviewerUserId', a.reviewer_user_id,
                    'verdict', a.verdict,
                    'createdAt', a.created_at))
                  from approvals a
                  where a.document_id = d.id
                    and d.current_version_id is not null
                    and a.version_id = d.current_version_id
                ), '[]'::json) as verdicts
         from documents d
         where d.deleted_at is null
           and ($1::uuid[] is null or d.id = any($1::uuid[]))`,
        [documentIds ?? null],
      );
      return rows.map((r) => ({
        documentId: r.document_id as DocumentId,
        status: deriveReviewStatus({
          activeReviewerIds: r.active_reviewers as UserId[],
          approvalsOnLatestVersion: r.verdicts.map((v) => ({
            reviewerUserId: v.reviewerUserId as UserId,
            verdict: v.verdict,
            createdAt: new Date(v.createdAt),
          })),
        }),
      }));
    });
  }
}
