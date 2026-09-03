import type { FastifyInstance } from 'fastify';
import type {
  CommentRepository,
  DocumentRepository,
  OrganizationRepository,
  StoragePort,
  VersionRepository,
} from '@vorlyn/app';
import { exportOrg } from '@vorlyn/app';
import { requireAdmin } from '../auth/guards.js';
import { actorOf } from '../auth/actor.js';

export interface ExportRouteDeps {
  organizations: OrganizationRepository;
  documents: DocumentRepository;
  versions: VersionRepository;
  comments: CommentRepository;
  storage: StoragePort;
}

/**
 * Self-serve org export (Phase 14, GDPR Art. 20): admin-only, every tier,
 * and deliberately available in the cancellation read-only grace window —
 * export is that window's purpose, so no read-only gate applies.
 *
 * Keyset-paged: callers without `cursor`/`limit` get page 1 (unchanged shape
 * plus a `nextCursor` field); large orgs walk `cursor` = prior `nextCursor`
 * until it comes back null.
 */
export function registerExportRoutes(server: FastifyInstance, deps: ExportRouteDeps): void {
  server.get<{ Querystring: { cursor?: string; limit?: number } }>(
    '/org/export',
    {
      preHandler: requireAdmin,
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
      const result = await exportOrg(
        deps.organizations,
        deps.documents,
        deps.versions,
        deps.comments,
        deps.storage,
        actorOf(req),
        {
          ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
          ...(req.query.limit !== undefined ? { limit: req.query.limit } : {}),
        },
      );
      if (!result.ok) {
        return reply
          .code(result.error.code === 'forbidden' ? 403 : 404)
          .send({ error: result.error.code });
      }
      return reply
        .header('content-disposition', 'attachment; filename="vorlyn-export.json"')
        .send(result.value);
    },
  );
}
