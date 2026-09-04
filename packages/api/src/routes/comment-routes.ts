import type { FastifyInstance } from 'fastify';
import type {
  AnchorResolutionRepository,
  ApiKeyRepository,
  CommentError,
  CommentRepository,
  DocumentRepository,
  OrganizationRepository,
  ReviewRepository,
  ShareGrantRepository,
  StoragePort,
  SuggestionError,
  TenantContext,
  ThreadWithResolution,
  UploadUnitOfWork,
  VersionRepository,
} from '@mdloop/app';
import {
  acceptSuggestion,
  addReply,
  createComment,
  deleteComment,
  editComment,
  getFeedbackBundle,
  listThreadsWithResolutions,
  rejectSuggestion,
  requireDocumentAccess,
  resolveComment,
  toggleCommentUpvote,
} from '@mdloop/app';
import type { Anchor, Comment, CommentReply } from '@mdloop/domain';
import type { CommentId, DocumentId, ReplyId } from '@mdloop/shared';
import { actorOf } from '../auth/actor.js';

const errorStatus: Record<CommentError['code'], number> = {
  document_not_found: 404,
  comment_not_found: 404,
  no_version: 409,
  empty_body: 400,
  body_too_long: 400,
  invalid_anchor: 400,
  forbidden: 403,
  org_not_found: 404,
  org_read_only: 403,
  // Tier cap, not a rate limit: retrying won't help, upgrading will.
  comment_cap_exceeded: 403,
  parent_reply_not_found: 404,
  reply_depth_exceeded: 400,
  already_resolved: 409,
  // Suggested edits (Phase C) creation-time codes.
  proposed_text_too_long: 400,
  suggestion_requires_text_anchor: 400,
};

/** Accept/reject codes — accept is metadata-only (ADR 0007), so this is just
 *  the suggestion-specific gates plus the shared document/authority checks. */
const suggestionErrorStatus: Record<SuggestionError['code'], number> = {
  comment_not_found: 404,
  not_a_suggestion: 400,
  // Double-resolve or a stale accept — the suggestion is no longer open.
  suggestion_not_open: 409,
  document_not_found: 404,
  forbidden: 403,
};

/**
 * Anchor arrives as client JSON; the shape is fully validated in the domain
 * (validateAnchor) — the schema only gates the envelope. `proposedText`
 * (optional) turns a comment into a suggested edit (Phase C).
 */
const commentBodySchema = {
  type: 'object',
  required: ['body', 'anchor'],
  additionalProperties: false,
  properties: {
    body: { type: 'string' },
    anchor: { type: 'object' },
    proposedText: { type: ['string', 'null'] },
  },
} as const;

/** Key names never in telemetry — this map only ever feeds response DTOs. */
type ApiKeyNames = Map<string, string>;

function commentDto(c: Comment, keyNames: ApiKeyNames) {
  return {
    id: c.id,
    documentId: c.documentId,
    versionId: c.versionId,
    authorId: c.authorId,
    body: c.body,
    anchor: c.anchor,
    status: c.status,
    resolvedBy: c.resolvedBy,
    resolvedAt: c.resolvedAt,
    createdAt: c.createdAt,
    viaApiKeyName: c.viaApiKeyId ? (keyNames.get(c.viaApiKeyId) ?? null) : null,
    // Suggested-edit subtype (Phase C). Plain comments carry kind 'comment'
    // and null suggestion fields.
    kind: c.kind,
    proposedText: c.proposedText,
    suggestionOutcome: c.suggestionOutcome,
    appliedVersionId: c.appliedVersionId,
  };
}

function replyDto(r: CommentReply, keyNames: ApiKeyNames) {
  return {
    id: r.id,
    commentId: r.commentId,
    parentReplyId: r.parentReplyId,
    authorId: r.authorId,
    body: r.body,
    createdAt: r.createdAt,
    viaApiKeyName: r.viaApiKeyId ? (keyNames.get(r.viaApiKeyId) ?? null) : null,
  };
}

function threadDto(t: ThreadWithResolution, keyNames: ApiKeyNames) {
  return {
    comment: commentDto(t.comment, keyNames),
    replies: t.replies.map((r) => replyDto(r, keyNames)),
    resolution: {
      method: t.resolution.method,
      confidence: t.resolution.confidence,
      start: t.resolution.start,
      end: t.resolution.end,
    },
    upvotes: { count: t.upvotes.count, mine: t.upvotes.mine },
    // @mentions on the comment body (ADR 0003 §D) — display name joined so the
    // rail highlights them without a directory lookup (guests can't do one).
    mentions: t.mentions.map((m) => ({ userId: m.userId, displayName: m.displayName })),
  };
}

/** Distinct non-null `via_api_key_id`s across comments + replies in one thread list. */
function apiKeyIdsOf(threads: ThreadWithResolution[]): string[] {
  const ids = new Set<string>();
  for (const t of threads) {
    if (t.comment.viaApiKeyId) ids.add(t.comment.viaApiKeyId);
    for (const r of t.replies) {
      if (r.viaApiKeyId) ids.add(r.viaApiKeyId);
    }
  }
  return [...ids];
}

export interface CommentRouteDeps {
  documents: DocumentRepository;
  comments: CommentRepository;
  versions: VersionRepository;
  resolutions: AnchorResolutionRepository;
  storage: StoragePort;
  grants: ShareGrantRepository;
  organizations: OrganizationRepository;
  reviews: ReviewRepository;
  uploadUow: UploadUnitOfWork;
  apiKeys: ApiKeyRepository;
}

export function registerCommentRoutes(server: FastifyInstance, deps: CommentRouteDeps): void {
  const { documents, comments, grants, organizations, apiKeys } = deps;

  /** One namesByIds call per response — never per-comment. */
  async function namesFor(ctx: TenantContext, ids: string[]): Promise<ApiKeyNames> {
    return ids.length > 0 ? apiKeys.namesByIds(ctx, ids) : new Map();
  }

  server.get<{
    Params: { id: string };
    Querystring: { status?: 'open' | 'resolved'; cursor?: string; limit?: number };
  }>(
    '/documents/:id/comments',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { enum: ['open', 'resolved'] },
            cursor: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const access = await requireDocumentAccess(
        documents,
        grants,
        actor,
        req.params.id as DocumentId,
        'read',
      );
      if (!access.ok) return reply.code(404).send({ error: access.error.code });
      // Keyset pagination (Phase 24.F): a document with thousands of comments
      // pages instead of loading them all. `counts` stays the full open/resolved
      // split (a cheap aggregate) so the header totals are unaffected by paging.
      const [result, counts] = await Promise.all([
        listThreadsWithResolutions(
          documents,
          comments,
          deps.versions,
          deps.resolutions,
          deps.storage,
          actor,
          req.params.id as DocumentId,
          req.query.status,
          {
            ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
            ...(req.query.limit !== undefined ? { limit: req.query.limit } : {}),
          },
        ),
        comments.statusCounts(actor.ctx, req.params.id as DocumentId),
      ]);
      if (!result.ok)
        return reply.code(errorStatus[result.error.code]).send({ error: result.error.code });
      const keyNames = await namesFor(actor.ctx, apiKeyIdsOf(result.value.threads));
      return {
        threads: result.value.threads.map((t) => threadDto(t, keyNames)),
        nextCursor: result.value.nextCursor,
        counts,
      };
    },
  );

  // The agent handoff, over HTTP for the web "Copy feedback" button — the
  // same bundle the MCP get_feedback_bundle tool returns.
  server.get<{ Params: { id: string } }>('/documents/:id/feedback-bundle', async (req, reply) => {
    const result = await getFeedbackBundle(
      documents,
      comments,
      deps.versions,
      deps.resolutions,
      deps.storage,
      grants,
      deps.reviews,
      organizations,
      actorOf(req),
      req.params.id as DocumentId,
    );
    if (!result.ok) {
      const code = result.error.code;
      const status = code in errorStatus ? errorStatus[code as CommentError['code']] : 404;
      return reply.code(status).send({ error: code });
    }
    return result.value;
  });

  server.post<{
    Params: { id: string };
    Body: { body: string; anchor: Anchor; proposedText?: string | null };
  }>('/documents/:id/comments', { schema: { body: commentBodySchema } }, async (req, reply) => {
    const actor = actorOf(req);
    const access = await requireDocumentAccess(
      documents,
      grants,
      actor,
      req.params.id as DocumentId,
      'comment',
    );
    if (!access.ok) return reply.code(404).send({ error: access.error.code });
    const result = await createComment(documents, comments, organizations, grants, actor, {
      documentId: req.params.id as DocumentId,
      body: req.body.body,
      anchor: req.body.anchor,
      // Present → a suggested edit (Phase C); absent → a plain comment.
      proposedText: req.body.proposedText ?? null,
    });
    if (!result.ok) {
      return reply.code(errorStatus[result.error.code]).send({ error: result.error.code });
    }
    const keyNames = await namesFor(
      actor.ctx,
      result.value.viaApiKeyId ? [result.value.viaApiKeyId] : [],
    );
    return reply.code(201).send(commentDto(result.value, keyNames));
  });

  server.post<{ Params: { id: string }; Body: { body: string; parentReplyId?: string | null } }>(
    '/comments/:id/replies',
    {
      schema: {
        body: {
          type: 'object',
          required: ['body'],
          additionalProperties: false,
          properties: {
            body: { type: 'string' },
            parentReplyId: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const comment = await comments.byId(actor.ctx, req.params.id as CommentId);
      if (!comment) return reply.code(404).send({ error: 'comment_not_found' });
      const access = await requireDocumentAccess(
        documents,
        grants,
        actor,
        comment.documentId,
        'comment',
      );
      if (!access.ok) return reply.code(404).send({ error: access.error.code });
      const result = await addReply(
        documents,
        comments,
        grants,
        actor,
        comment.id,
        req.body.body,
        (req.body.parentReplyId ?? null) as ReplyId | null,
      );
      if (!result.ok) {
        return reply.code(errorStatus[result.error.code]).send({ error: result.error.code });
      }
      const keyNames = await namesFor(
        actor.ctx,
        result.value.viaApiKeyId ? [result.value.viaApiKeyId] : [],
      );
      return reply.code(201).send(replyDto(result.value, keyNames));
    },
  );

  server.patch<{ Params: { id: string }; Body: { body: string } }>(
    '/comments/:id',
    {
      schema: {
        body: {
          type: 'object',
          required: ['body'],
          additionalProperties: false,
          properties: { body: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const result = await editComment(comments, actor, req.params.id as CommentId, req.body.body);
      if (!result.ok) {
        return reply.code(errorStatus[result.error.code]).send({ error: result.error.code });
      }
      const keyNames = await namesFor(
        actor.ctx,
        result.value.viaApiKeyId ? [result.value.viaApiKeyId] : [],
      );
      return commentDto(result.value, keyNames);
    },
  );

  server.delete<{ Params: { id: string } }>('/comments/:id', async (req, reply) => {
    const result = await deleteComment(comments, actorOf(req), req.params.id as CommentId);
    if (!result.ok) {
      return reply.code(errorStatus[result.error.code]).send({ error: result.error.code });
    }
    return reply.code(204).send();
  });

  server.post<{ Params: { id: string } }>('/comments/:id/upvote', async (req, reply) => {
    const actor = actorOf(req);
    const comment = await comments.byId(actor.ctx, req.params.id as CommentId);
    if (!comment) return reply.code(404).send({ error: 'comment_not_found' });
    const access = await requireDocumentAccess(
      documents,
      grants,
      actor,
      comment.documentId,
      'comment',
    );
    if (!access.ok) return reply.code(404).send({ error: access.error.code });
    const result = await toggleCommentUpvote(documents, comments, grants, actor, comment.id);
    if (!result.ok) {
      return reply.code(errorStatus[result.error.code]).send({ error: result.error.code });
    }
    return result.value;
  });

  server.post<{ Params: { id: string } }>('/comments/:id/resolve', async (req, reply) => {
    const result = await resolveComment(
      documents,
      comments,
      actorOf(req),
      req.params.id as CommentId,
    );
    if (!result.ok) {
      return reply.code(errorStatus[result.error.code]).send({ error: result.error.code });
    }
    return reply.code(204).send();
  });

  // Accept a suggestion (ADR 0007): metadata-only — flips suggestion_outcome
  // to "accepted", no splice, no new version. Owner/admin only (unchanged
  // gate). NOT in GUEST_ROUTES: a guest can create a suggestion but never
  // accept one. Materialization is detected lazily later by the re-anchor
  // pipeline when a real edit's content matches the proposal.
  server.post<{ Params: { id: string } }>('/comments/:id/accept', async (req, reply) => {
    const actor = actorOf(req);
    const result = await acceptSuggestion(
      { documents, comments },
      actor,
      req.params.id as CommentId,
      'web',
    );
    if (!result.ok) {
      return reply
        .code(suggestionErrorStatus[result.error.code])
        .send({ error: result.error.code });
    }
    const keyNames = await namesFor(
      actor.ctx,
      result.value.comment.viaApiKeyId ? [result.value.comment.viaApiKeyId] : [],
    );
    return { comment: commentDto(result.value.comment, keyNames) };
  });

  // Reject a suggestion (Phase C): owner/admin only, marks it terminal. No
  // document mutation, so no read-only gate.
  server.post<{ Params: { id: string } }>('/comments/:id/reject', async (req, reply) => {
    const actor = actorOf(req);
    const result = await rejectSuggestion(
      { documents, comments },
      actor,
      req.params.id as CommentId,
    );
    if (!result.ok) {
      return reply
        .code(suggestionErrorStatus[result.error.code])
        .send({ error: result.error.code });
    }
    const keyNames = await namesFor(
      actor.ctx,
      result.value.viaApiKeyId ? [result.value.viaApiKeyId] : [],
    );
    return commentDto(result.value, keyNames);
  });
}
