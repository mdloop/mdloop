import type { FastifyInstance } from 'fastify';
import type {
  DocumentRepository,
  PublicHubRepository,
  PublishError,
  StoragePort,
  UnpublishError,
  VersionRepository,
} from '@vorlyn/app';
import { listPublicDocs, publishToPublicHub, unpublishPublicDoc } from '@vorlyn/app';
import type { DocumentId, OrgId } from '@vorlyn/shared';
import { actorOf } from '../auth/actor.js';
import type { ApiConfig } from '../config.js';

/** `ApiConfig.publicHubOrgId` is a plain env string; the use-case wants the branded OrgId. */
function publicHubConfigOf(config: ApiConfig): { publicHubOrgId?: OrgId } {
  return config.publicHubOrgId !== undefined
    ? { publicHubOrgId: config.publicHubOrgId as OrgId }
    : {};
}

const publishErrorStatus: Record<PublishError['code'], number> = {
  forbidden: 403,
  document_not_found: 404,
  version_purged: 404,
  invalid_slug: 400,
};

const unpublishErrorStatus: Record<UnpublishError['code'], number> = {
  forbidden: 403,
};

export interface PublicHubAdminRouteDeps {
  publicHub: PublicHubRepository;
  documents: DocumentRepository;
  versions: VersionRepository;
  storage: StoragePort;
  config: ApiConfig;
}

/**
 * Home-org-admin-only publishing surface (ADR 0004, Phase 22.B). Registered
 * inside the authed scope in server.ts — the home-org gate itself lives in
 * `canPublish` inside the use-case (config-driven, no new role concept), so
 * these handlers just map its `forbidden` outcome to 403 like any other
 * authorization failure. The GET (admin's own view of what's published) has
 * no actor-facing use-case to gate it, so the check is inlined here.
 */
export function registerPublicHubAdminRoutes(
  server: FastifyInstance,
  deps: PublicHubAdminRouteDeps,
): void {
  server.post<{ Body: { documentId: string; slug: string; title?: string } }>(
    '/public-hub/documents',
    {
      schema: {
        body: {
          type: 'object',
          required: ['documentId', 'slug'],
          additionalProperties: false,
          properties: {
            documentId: { type: 'string' },
            slug: { type: 'string' },
            title: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const result = await publishToPublicHub(
        actorOf(req),
        publicHubConfigOf(deps.config),
        {
          documents: deps.documents,
          versions: deps.versions,
          storage: deps.storage,
          publicHub: deps.publicHub,
        },
        {
          documentId: req.body.documentId as DocumentId,
          slug: req.body.slug,
          ...(req.body.title !== undefined ? { title: req.body.title } : {}),
        },
      );
      if (!result.ok) {
        return reply.code(publishErrorStatus[result.error.code]).send({ error: result.error.code });
      }
      // Deliberately narrow: no source_* provenance fields leave this route (ADR 0004).
      const doc = result.value;
      return reply.code(201).send({
        id: doc.id,
        slug: doc.slug,
        title: doc.title,
        seq: doc.seq,
        publishedAt: doc.publishedAt,
      });
    },
  );

  server.delete<{ Params: { slug: string } }>('/public-hub/documents/:slug', async (req, reply) => {
    const result = await unpublishPublicDoc(
      actorOf(req),
      publicHubConfigOf(deps.config),
      deps.publicHub,
      req.params.slug,
    );
    if (!result.ok) {
      return reply.code(unpublishErrorStatus[result.error.code]).send({ error: result.error.code });
    }
    return reply.code(204).send();
  });

  // Admin's own view of what's published — distinct from the unauthenticated
  // public index (registerPublicRoutes) since one is gated and one isn't.
  // listPublicDocs takes no actor, so the home-org-admin gate is inlined here.
  server.get<{ Querystring: { cursor?: string; limit?: number } }>(
    '/public-hub/documents',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cursor: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      if (
        actor.role !== 'admin' ||
        deps.config.publicHubOrgId === undefined ||
        (actor.ctx.orgId as string) !== deps.config.publicHubOrgId
      ) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const page = await listPublicDocs(deps.publicHub, req.query.cursor, req.query.limit);
      return {
        docs: page.docs.map((d) => ({
          id: d.id,
          slug: d.slug,
          title: d.title,
          seq: d.seq,
          publishedAt: d.publishedAt,
          updatedAt: d.updatedAt,
        })),
        nextCursor: page.nextCursor,
      };
    },
  );
}
