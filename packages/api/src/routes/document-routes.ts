import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  ApiKeyRepository,
  DocDiffError,
  DocumentListFilter,
  DocumentRepository,
  OrganizationRepository,
  ProjectRepository,
  ReviewRepository,
  SearchRepository,
  ShareGrantRepository,
  StoragePort,
  UploadError,
  UploadUnitOfWork,
  VersionRepository,
  ErasureLogPort,
} from '@mdloop/app';
import {
  computeDocDiffFromMeta,
  deleteDocument,
  getDocument,
  homeOverview,
  listAccessibleDocuments,
  moveDocument,
  requireDocumentAccess,
  resolveDocDiffMeta,
  searchComments,
  searchDocuments,
  setDocumentArchived,
  uploadNewDocument,
  uploadNewVersion,
} from '@mdloop/app';
import type { Document } from '@mdloop/domain';
import type { DocumentId, ProjectId, VersionId } from '@mdloop/shared';
import { actorOf } from '../auth/actor.js';

export interface DocumentRouteDeps {
  documents: DocumentRepository;
  projects: ProjectRepository;
  versions: VersionRepository;
  organizations: OrganizationRepository;
  uploadUow: UploadUnitOfWork;
  storage: StoragePort;
  grants: ShareGrantRepository;
  search: SearchRepository;
  erasures: ErasureLogPort;
  reviews: ReviewRepository;
  apiKeys: ApiKeyRepository;
  /** Per-user upload rate limit (requests/minute). */
  uploadRateLimitMax: number;
}

function documentDto(d: Document) {
  return {
    id: d.id,
    projectId: d.projectId,
    ownerId: d.ownerId,
    title: d.title,
    // Read-only everywhere in the web app (Phase 29) — see the upload routes.
    path: d.path,
    currentVersionId: d.currentVersionId,
    archivedAt: d.archivedAt,
    createdAt: d.createdAt,
  };
}

const uploadErrorStatus: Record<UploadError['code'], number> = {
  invalid_title: 400,
  // Unreachable from REST — these routes never accept a `path` (see
  // `uploadBodySchema`) — but the map is exhaustive over UploadError by type,
  // and both codes are real on the MCP path.
  invalid_path: 400,
  path_taken: 409,
  empty_file: 400,
  project_not_found: 404,
  document_not_found: 404,
  org_not_found: 404,
  org_read_only: 403,
  forbidden: 403,
  file_too_large: 413,
  // Content policy (ADR 0011): the bytes are not prose, so the media type is
  // what's unsupported — 415, not 400. Retrying the same bytes never helps.
  binary_signature_detected: 415,
  control_byte_detected: 415,
  replacement_char_density_exceeded: 415,
  invalid_utf8: 415,
  // Tier caps, not rate limits: retrying won't help, upgrading will.
  doc_cap_exceeded: 403,
  project_doc_cap_exceeded: 403,
  version_cap_exceeded: 403,
  comment_cap_exceeded: 403,
};

const lifecycleErrorStatus = {
  document_not_found: 404,
  project_not_found: 404,
  org_not_found: 404,
  // Moving a repo-mirrored document into a project that already holds its
  // path (Phase 29): a conflict the caller can resolve, not a server fault.
  path_taken: 409,
  forbidden: 403,
} as const;

const diffErrorStatus: Record<DocDiffError['code'], number> = {
  document_not_found: 404,
  version_not_found: 404,
  // Purged leg = tombstone, same 410 the version-content route uses (ADR 0001).
  version_purged: 410,
  // Over the cap: not a retryable error, the client renders the source <pre>.
  diff_too_large: 413,
};

/** Mirrors document_versions_change_note_len_ck (migration 0017). */
const MAX_CHANGE_NOTE = 20000;

/**
 * Note what is NOT here: `path` (Phase 29).
 *
 * `Document.path` is deliberately MCP/CLI-only. The plan's locked decision is
 * that path is "CLI-owned / read-only in the web app", and that claim is only
 * as strong as the narrowest write surface: if any cookie-authenticated caller
 * could set a path, "the CLI is its only writer" would be a convention rather
 * than a property of the API. Nothing in this phase needs it here either — a
 * human dragging a file into the web dropzone has no repo path to supply, and
 * a made-up one would silently drift from the repo until the next push
 * overwrote it, which is the exact failure the read-only rule exists to
 * prevent. `additionalProperties: false` means a client that sends one gets a
 * 400 rather than a silent drop.
 *
 * The reverse direction is open: `documentDto` returns `path`, so the tree,
 * the breadcrumb and search results can all read it.
 */
const uploadBodySchema = {
  type: 'object',
  required: ['title', 'content'],
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    projectId: { type: ['string', 'null'] },
    content: { type: 'string' },
    changeNote: { type: 'string', maxLength: MAX_CHANGE_NOTE },
  },
} as const;

export function registerDocumentRoutes(server: FastifyInstance, deps: DocumentRouteDeps): void {
  const uploadLimit = {
    rateLimit: { max: deps.uploadRateLimitMax, timeWindow: '1 minute' },
  };

  server.post<{
    Body: { title: string; projectId?: string | null; content: string; changeNote?: string };
  }>(
    '/documents',
    { schema: { body: uploadBodySchema }, config: uploadLimit },
    async (req, reply) => {
      const result = await uploadNewDocument(deps.uploadUow, deps.storage, actorOf(req), {
        title: req.body.title,
        projectId: (req.body.projectId ?? null) as ProjectId | null,
        content: Buffer.from(req.body.content, 'utf8'),
        source: 'web',
        changeNote: req.body.changeNote ?? null,
      });
      if (!result.ok) {
        return reply.code(uploadErrorStatus[result.error.code]).send({ error: result.error.code });
      }
      return reply.code(201).send({
        document: documentDto(result.value.document),
        version: { id: result.value.version.id, seq: result.value.version.seq },
        deduplicated: result.value.deduplicated,
      });
    },
  );

  server.post<{ Params: { id: string }; Body: { content: string; changeNote?: string } }>(
    '/documents/:id/versions',
    {
      schema: {
        // No `path` here either, for the reasons on `uploadBodySchema` — and
        // one more specific to this route: a repath is how a `git mv` is
        // expressed, so accepting one over REST would let a browser move a
        // document in a repo mirror it cannot see.
        body: {
          type: 'object',
          required: ['content'],
          additionalProperties: false,
          properties: {
            content: { type: 'string' },
            changeNote: { type: 'string', maxLength: MAX_CHANGE_NOTE },
          },
        },
      },
      config: uploadLimit,
    },
    async (req, reply) => {
      const result = await uploadNewVersion(deps.uploadUow, deps.storage, actorOf(req), {
        documentId: req.params.id as DocumentId,
        content: Buffer.from(req.body.content, 'utf8'),
        source: 'web',
        changeNote: req.body.changeNote ?? null,
      });
      if (!result.ok) {
        return reply.code(uploadErrorStatus[result.error.code]).send({ error: result.error.code });
      }
      return {
        document: documentDto(result.value.document),
        version: { id: result.value.version.id, seq: result.value.version.seq },
        deduplicated: result.value.deduplicated,
      };
    },
  );

  server.get<{ Querystring: { view?: 'all' | 'unfiled' | 'archived'; projectId?: string } }>(
    '/documents',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            view: { enum: ['all', 'unfiled', 'archived'] },
            projectId: { type: 'string' },
          },
        },
      },
    },
    async (req) => {
      const filter: DocumentListFilter = {
        ...(req.query.view ? { view: req.query.view } : {}),
        ...(req.query.projectId ? { projectId: req.query.projectId as ProjectId } : {}),
      };
      const docs = await listAccessibleDocuments(deps.documents, deps.grants, actorOf(req), filter);
      return { documents: docs.map(documentDto) };
    },
  );

  server.get<{
    Querystring: {
      view?: 'all' | 'unfiled' | 'archived';
      projectId?: string;
      limit?: number;
      cursor?: string;
    };
  }>(
    '/overview',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            view: { enum: ['all', 'unfiled', 'archived'] },
            projectId: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            cursor: { type: 'string' },
          },
        },
      },
    },
    async (req) => {
      const overview = await homeOverview(
        deps.documents,
        deps.projects,
        deps.reviews,
        actorOf(req),
        {
          ...(req.query.view ? { view: req.query.view } : {}),
          ...(req.query.projectId ? { projectId: req.query.projectId as ProjectId } : {}),
        },
        {
          ...(req.query.limit !== undefined ? { limit: req.query.limit } : {}),
          ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
        },
      );
      return {
        documents: overview.documents.map((entry) => ({
          ...documentDto(entry.document),
          open: entry.open,
          resolved: entry.resolved,
          lastActivityAt: entry.lastActivityAt,
          reviewStatus: entry.reviewStatus,
        })),
        nextCursor: overview.nextCursor,
        projects: overview.projects.map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          archivedAt: p.archivedAt,
          createdAt: p.createdAt,
        })),
        counts: overview.counts,
        openByProject: overview.openByProject,
      };
    },
  );

  // POST, not GET (P0.10): search text can contain document titles or
  // comment-text fragments — org data — so it must ride the JSON body,
  // never a URL query string, or it lands verbatim in a deployment's own
  // reverse proxy/edge cache access logs (CONSTITUTION.md Core Principle 3).
  server.post<{ Body: { q?: string } }>(
    '/documents/search',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { q: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const q = req.body.q ?? '';
      // Document search behavior is unchanged; comment hits (ADR 0003 §C) ride
      // the same route so the comment rail and the MCP tool reach one endpoint.
      const [docs, comments] = await Promise.all([
        searchDocuments(deps.search, actor, q),
        searchComments(deps.search, actor, q),
      ]);
      if (!docs.ok) return reply.code(400).send({ error: docs.error.code });
      return {
        hits: docs.value.map((h) => ({
          documentId: h.documentId,
          title: h.title,
          projectId: h.projectId,
          path: h.path,
          rank: h.rank,
        })),
        commentHits: comments.ok
          ? comments.value.map((h) => ({
              commentId: h.commentId,
              documentId: h.documentId,
              documentTitle: h.documentTitle,
              snippet: h.snippet,
              anchor: h.anchor,
              versionId: h.versionId,
              status: h.status,
              authorId: h.authorId,
              createdAt: h.createdAt,
              rank: h.rank,
            }))
          : [],
      };
    },
  );

  server.get<{ Params: { id: string } }>('/documents/:id', async (req, reply) => {
    const result = await requireDocumentAccess(
      deps.documents,
      deps.grants,
      actorOf(req),
      req.params.id as DocumentId,
      'read',
    );
    if (!result.ok) return reply.code(404).send({ error: result.error.code });
    return { ...documentDto(result.value.document), myPermission: result.value.permission };
  });

  server.get<{ Params: { id: string } }>('/documents/:id/content', async (req, reply) => {
    const actor = actorOf(req);
    const result = await requireDocumentAccess(
      deps.documents,
      deps.grants,
      actor,
      req.params.id as DocumentId,
      'read',
    );
    if (!result.ok) return reply.code(404).send({ error: result.error.code });
    const document = result.value.document;
    if (!document.currentVersionId) return reply.code(404).send({ error: 'no_version' });
    const version = await deps.versions.byId(actor.ctx, document.currentVersionId);
    if (!version) return reply.code(404).send({ error: 'no_version' });
    // Content-addressed revalidation: the hash names the bytes, so a match
    // means the client copy is current — skip the blob read entirely.
    const etag = `"${version.contentHash}"`;
    reply.header('etag', etag).header('cache-control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    const content = await deps.storage.get({
      orgId: actor.ctx.orgId,
      documentId: document.id,
      seq: version.seq,
    });
    return reply.type('text/markdown; charset=utf-8').send(Buffer.from(content));
  });

  server.get<{ Params: { id: string } }>('/documents/:id/versions', async (req, reply) => {
    const actor = actorOf(req);
    const result = await requireDocumentAccess(
      deps.documents,
      deps.grants,
      actor,
      req.params.id as DocumentId,
      'read',
    );
    if (!result.ok) return reply.code(404).send({ error: result.error.code });
    const versions = await deps.versions.listForDocument(actor.ctx, result.value.document.id);
    // Distinct non-null via_api_key_ids, one namesByIds call — never per-version.
    const keyIds = [...new Set(versions.flatMap((v) => (v.viaApiKeyId ? [v.viaApiKeyId] : [])))];
    const keyNames =
      keyIds.length > 0
        ? await deps.apiKeys.namesByIds(actor.ctx, keyIds)
        : new Map<string, string>();
    return {
      versions: versions.map((v) => ({
        id: v.id,
        seq: v.seq,
        source: v.source,
        createdBy: v.createdBy,
        createdAt: v.createdAt,
        // Tombstone (ADR 0001): content purged per retention policy, row honest.
        purgedAt: v.purgedAt,
        viaApiKeyName: v.viaApiKeyId ? (keyNames.get(v.viaApiKeyId) ?? null) : null,
        // What-changed note (ADR 0003 §B): surfaced in the viewing-old banner
        // and version-chip tooltip; written once at upload, immutable.
        changeNote: v.changeNote,
      })),
      currentVersionId: result.value.document.currentVersionId,
    };
  });

  server.get<{ Params: { id: string; versionId: string } }>(
    '/documents/:id/versions/:versionId/content',
    async (req, reply) => {
      const actor = actorOf(req);
      const result = await requireDocumentAccess(
        deps.documents,
        deps.grants,
        actor,
        req.params.id as DocumentId,
        'read',
      );
      if (!result.ok) return reply.code(404).send({ error: result.error.code });
      const version = await deps.versions.byId(actor.ctx, req.params.versionId as VersionId);
      if (version?.documentId !== result.value.document.id) {
        return reply.code(404).send({ error: 'version_not_found' });
      }
      // Honest tombstone (ADR 0001): 410 Gone, never a guess at the content.
      if (version.purgedAt) return reply.code(410).send({ error: 'version_purged' });
      // Versions are immutable — a matching hash can revalidate forever.
      const etag = `"${version.contentHash}"`;
      reply.header('etag', etag).header('cache-control', 'private, max-age=31536000, immutable');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      const content = await deps.storage.get({
        orgId: actor.ctx.orgId,
        documentId: result.value.document.id,
        seq: version.seq,
      });
      return reply.type('text/markdown; charset=utf-8').send(Buffer.from(content));
    },
  );

  server.get<{ Params: { id: string }; Querystring: { from_seq: number; to_seq: number } }>(
    '/documents/:id/diff',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['from_seq', 'to_seq'],
          additionalProperties: false,
          properties: {
            from_seq: { type: 'integer', minimum: 1 },
            to_seq: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const input = {
        documentId: req.params.id as DocumentId,
        fromSeq: req.query.from_seq,
        toSeq: req.query.to_seq,
      };
      // Metadata only (access check + both version rows) — no blob read yet,
      // so 410/413 and the conditional-GET 304 below are all cheap.
      const meta = await resolveDocDiffMeta(
        { documents: deps.documents, grants: deps.grants, versions: deps.versions },
        actor,
        input,
      );
      if (!meta.ok) {
        return reply.code(diffErrorStatus[meta.error.code]).send({ error: meta.error.code });
      }
      // Strong ETag over the immutable content-hash pair — same 304 pattern as
      // the content routes; the pair is immutable, so it revalidates forever.
      const etag = `"${createHash('sha256')
        .update(`${meta.value.from.contentHash}:${meta.value.to.contentHash}`)
        .digest('hex')}"`;
      reply.header('etag', etag).header('cache-control', 'private, max-age=31536000, immutable');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();

      const result = await computeDocDiffFromMeta(
        { storage: deps.storage },
        actor.ctx.orgId,
        meta.value,
      );
      if (!result.ok) {
        return reply.code(diffErrorStatus[result.error.code]).send({ error: result.error.code });
      }
      return {
        from: result.value.from,
        to: result.value.to,
        blocks: result.value.diff.blocks,
      };
    },
  );

  server.patch<{ Params: { id: string }; Body: { projectId?: string | null; archived?: boolean } }>(
    '/documents/:id',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            projectId: { type: ['string', 'null'] },
            archived: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const id = req.params.id as DocumentId;
      if (req.body.projectId !== undefined) {
        const moved = await moveDocument(
          deps.documents,
          deps.projects,
          actor,
          id,
          req.body.projectId as ProjectId | null,
        );
        if (!moved.ok) {
          return reply
            .code(lifecycleErrorStatus[moved.error.code])
            .send({ error: moved.error.code });
        }
      }
      if (req.body.archived !== undefined) {
        const archived = await setDocumentArchived(deps.documents, actor, id, req.body.archived);
        if (!archived.ok) {
          return reply
            .code(lifecycleErrorStatus[archived.error.code])
            .send({ error: archived.error.code });
        }
      }
      const result = await getDocument(deps.documents, actor, id);
      if (!result.ok) return reply.code(404).send({ error: result.error.code });
      return documentDto(result.value);
    },
  );

  server.delete<{ Params: { id: string } }>('/documents/:id', async (req, reply) => {
    const result = await deleteDocument(
      deps.documents,
      deps.organizations,
      deps.storage,
      deps.erasures,
      actorOf(req),
      req.params.id as DocumentId,
    );
    if (!result.ok) {
      return reply.code(lifecycleErrorStatus[result.error.code]).send({ error: result.error.code });
    }
    return { deleted: true, purged: result.value.purged };
  });
}
