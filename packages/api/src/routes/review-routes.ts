import type { FastifyInstance } from 'fastify';
import type {
  ApiKeyRepository,
  CommentRepository,
  DocumentRepository,
  OrganizationRepository,
  ReviewError,
  ReviewRepository,
  ShareGrantRepository,
  TenantContext,
} from '@vorlyn/app';
import { getReviewStatus, requestReview, revokeReviewRequest, submitReview } from '@vorlyn/app';
import type { Approval, ReviewRequest } from '@vorlyn/domain';
import type { DocumentId, ReviewRequestId, UserId } from '@vorlyn/shared';
import { actorOf } from '../auth/actor.js';

const errorStatus: Record<ReviewError['code'], number> = {
  document_not_found: 404,
  forbidden: 403,
  reviewer_not_found: 404,
  reviewer_has_no_access: 409,
  already_requested: 409,
  org_not_found: 404,
  org_read_only: 403,
  request_not_found: 404,
  not_a_reviewer: 403,
  no_version: 409,
  note_too_long: 400,
  open_comments_block_approval: 409,
};

/** Key names never in telemetry — this map only ever feeds response DTOs. */
type ApiKeyNames = Map<string, string>;

function reviewRequestDto(r: ReviewRequest) {
  return {
    id: r.id,
    reviewerUserId: r.reviewerUserId,
    reviewerName: r.reviewerName,
    reviewerEmail: r.reviewerEmail,
    requestedBy: r.requestedBy,
    createdAt: r.createdAt,
  };
}

function approvalDto(a: Approval, keyNames: ApiKeyNames) {
  return {
    id: a.id,
    versionId: a.versionId,
    reviewerUserId: a.reviewerUserId,
    reviewerName: a.reviewerName,
    reviewerEmail: a.reviewerEmail,
    verdict: a.verdict,
    note: a.note,
    createdAt: a.createdAt,
    viaApiKeyName: a.viaApiKeyId ? (keyNames.get(a.viaApiKeyId) ?? null) : null,
  };
}

export interface ReviewRouteDeps {
  documents: DocumentRepository;
  grants: ShareGrantRepository;
  comments: CommentRepository;
  organizations: OrganizationRepository;
  reviews: ReviewRepository;
  apiKeys: ApiKeyRepository;
}

export function registerReviewRoutes(server: FastifyInstance, deps: ReviewRouteDeps): void {
  const reviewDeps = {
    documents: deps.documents,
    grants: deps.grants,
    comments: deps.comments,
    orgs: deps.organizations,
    reviews: deps.reviews,
  };

  async function namesFor(ctx: TenantContext, approvals: Approval[]): Promise<ApiKeyNames> {
    const ids = [...new Set(approvals.flatMap((a) => (a.viaApiKeyId ? [a.viaApiKeyId] : [])))];
    return ids.length > 0 ? deps.apiKeys.namesByIds(ctx, ids) : new Map();
  }

  server.get<{ Params: { id: string } }>('/documents/:id/review', async (req, reply) => {
    const actor = actorOf(req);
    const result = await getReviewStatus(reviewDeps, actor, req.params.id as DocumentId);
    if (!result.ok) {
      return reply.code(errorStatus[result.error.code]).send({ error: result.error.code });
    }
    const keyNames = await namesFor(actor.ctx, result.value.approvals);
    return {
      status: result.value.status,
      gate: result.value.gate,
      openCommentCount: result.value.openCommentCount,
      requests: result.value.requests.map(reviewRequestDto),
      approvals: result.value.approvals.map((a) => approvalDto(a, keyNames)),
    };
  });

  server.post<{ Params: { id: string }; Body: { reviewerUserId: string } }>(
    '/documents/:id/review-requests',
    {
      schema: {
        body: {
          type: 'object',
          required: ['reviewerUserId'],
          additionalProperties: false,
          properties: { reviewerUserId: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const result = await requestReview(reviewDeps, actorOf(req), {
        documentId: req.params.id as DocumentId,
        reviewerUserId: req.body.reviewerUserId as UserId,
      });
      if (!result.ok) {
        return reply.code(errorStatus[result.error.code]).send({ error: result.error.code });
      }
      return reply.code(201).send(reviewRequestDto(result.value));
    },
  );

  server.delete<{ Params: { id: string; requestId: string } }>(
    '/documents/:id/review-requests/:requestId',
    async (req, reply) => {
      const result = await revokeReviewRequest(
        reviewDeps,
        actorOf(req),
        req.params.id as DocumentId,
        req.params.requestId as ReviewRequestId,
      );
      if (!result.ok) {
        return reply.code(errorStatus[result.error.code]).send({ error: result.error.code });
      }
      return reply.code(204).send();
    },
  );

  server.post<{
    Params: { id: string };
    Body: { verdict: 'approved' | 'changes_requested'; note?: string | null };
  }>(
    '/documents/:id/review/verdict',
    {
      schema: {
        body: {
          type: 'object',
          required: ['verdict'],
          additionalProperties: false,
          properties: {
            verdict: { enum: ['approved', 'changes_requested'] },
            note: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const result = await submitReview(reviewDeps, actor, {
        documentId: req.params.id as DocumentId,
        verdict: req.body.verdict,
        note: req.body.note ?? null,
      });
      if (!result.ok) {
        return reply.code(errorStatus[result.error.code]).send({ error: result.error.code });
      }
      const keyNames = await namesFor(actor.ctx, [result.value.approval]);
      return {
        status: result.value.status,
        approval: approvalDto(result.value.approval, keyNames),
      };
    },
  );
}
