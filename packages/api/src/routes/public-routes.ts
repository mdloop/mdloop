import type { FastifyInstance } from 'fastify';
import type { PublicHubRepository, StoragePort } from '@vorlyn/app';
import { getPublicDoc, listPublicDocs, searchPublicDocs } from '@vorlyn/app';

export interface PublicRouteDeps {
  publicHub: PublicHubRepository;
  storage: StoragePort;
}

/**
 * Unauthenticated Public Docs Hub read surface (ADR 0004): the named
 * exception to CONSTITUTION §4 alongside /healthz and /auth/*. Registered on
 * the base Fastify instance (server.ts), before the session-guard scope, so
 * none of the authed preHandlers (session, guest allowlist, tier rate limit)
 * ever run for these routes — only the global pre-auth IP rate limiter and
 * the request-logging hooks that wrap every route apply.
 *
 * Per-route rate limits (read traffic, no session to key on beyond IP):
 *  - /public/docs, /public/docs/:slug: 120/min — cheap index/metadata reads.
 *  - /public/docs/:slug/content: 60/min — a blob read per request, so a
 *    tighter ceiling than the metadata routes.
 *  - /public/search: 30/min — the tightest, since a full-text query is the
 *    most expensive read here and the one most attractive to scrape.
 */
export function registerPublicRoutes(server: FastifyInstance, deps: PublicRouteDeps): void {
  server.get<{ Querystring: { cursor?: string; limit?: number } }>(
    '/public/docs',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
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
      const page = await listPublicDocs(deps.publicHub, req.query.cursor, req.query.limit);
      // CDN-friendly: the hub index changes only on publish/unpublish, so a
      // short shared cache with a longer stale-while-revalidate window keeps it
      // fresh enough while absorbing scrape/refresh bursts (Phase 24.F).
      reply.header('cache-control', 'public, max-age=60, stale-while-revalidate=600');
      return {
        docs: page.docs.map((d) => ({ slug: d.slug, title: d.title, publishedAt: d.publishedAt })),
        nextCursor: page.nextCursor,
      };
    },
  );

  server.get<{ Params: { slug: string } }>(
    '/public/docs/:slug',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const result = await getPublicDoc(deps.publicHub, req.params.slug);
      if (!result.ok) return reply.code(404).send({ error: 'not_found' });
      const doc = result.value;
      reply.header('cache-control', 'public, max-age=60, stale-while-revalidate=600');
      return {
        slug: doc.slug,
        title: doc.title,
        publishedAt: doc.publishedAt,
        updatedAt: doc.updatedAt,
      };
    },
  );

  server.get<{ Params: { slug: string } }>(
    '/public/docs/:slug/content',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const result = await getPublicDoc(deps.publicHub, req.params.slug);
      if (!result.ok) return reply.code(404).send({ error: 'not_found' });
      const doc = result.value;
      // Content-addressed revalidation, same pattern as /documents/:id/content —
      // `public` (not `private`) cache-control since there is no session to vary on.
      const etag = `"${doc.contentHash}"`;
      // Version content is content-addressed and immutable, so it can cache far
      // longer than the metadata routes (Phase 24.F) — a new publish bumps the
      // seq (a new key), so this can never serve stale content for a version.
      reply
        .header('etag', etag)
        .header('cache-control', 'public, max-age=300, stale-while-revalidate=3600');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      const content = await deps.storage.getPublic({ publicDocId: doc.id, seq: doc.seq });
      return reply.type('text/markdown; charset=utf-8').send(Buffer.from(content));
    },
  );

  server.get<{ Querystring: { q?: string } }>(
    '/public/search',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const q = req.query.q ?? '';
      const result = await searchPublicDocs(deps.publicHub, q);
      if (!result.ok) return { hits: [] };
      return {
        hits: result.value.map((h) => ({ slug: h.slug, title: h.title, snippet: h.snippet })),
      };
    },
  );
}
