import type { FastifyInstance } from 'fastify';
import type {
  DocumentRepository,
  OrganizationRepository,
  ShareGrantRepository,
  SharingError,
} from '@mdloop/app';
import {
  createShareLink,
  createUserGrant,
  listShareGrants,
  redeemShareLink,
  revokeShareGrant,
} from '@mdloop/app';
import type { ShareGrant } from '@mdloop/domain';
import { isLinkGrantable } from '@mdloop/domain';
import type { DocumentId, GrantId, UserId } from '@mdloop/shared';
import { actorOf } from '../auth/actor.js';

const errorStatus: Record<SharingError['code'], number> = {
  document_not_found: 404,
  grant_not_found: 404,
  forbidden: 403,
  wrong_sharing_mode: 409,
  invalid_token: 404,
  guest_edit_forbidden: 403,
  // Delegation cap (ADR 0014): the grantor asked for a grant more powerful
  // than their own — not a rate limit, retrying with a lower permission works.
  grant_exceeds_own_permission: 403,
  // Tier cap, not a rate limit: retrying won't help, upgrading will (matches
  // doc_cap_exceeded/etc.'s convention in document-routes.ts).
  sharing_requires_paid_tier: 403,
};

function grantDto(g: ShareGrant) {
  return {
    id: g.id,
    grantee: g.grantee,
    permission: g.permission,
    // Guest grants (Phase 18): external email + expiry, null for internal.
    granteeEmail: g.granteeEmail,
    expiresAt: g.expiresAt,
    createdBy: g.createdBy,
    createdAt: g.createdAt,
  };
}

export interface ShareRouteDeps {
  documents: DocumentRepository;
  grants: ShareGrantRepository;
  organizations: OrganizationRepository;
}

export function registerShareRoutes(server: FastifyInstance, deps: ShareRouteDeps): void {
  server.post<{
    Params: { id: string };
    Body:
      | { type: 'link'; permission: 'read' | 'comment' }
      | { type: 'user'; userId: string; permission: 'read' | 'comment' | 'share' | 'edit' };
  }>(
    '/documents/:id/shares',
    {
      schema: {
        body: {
          type: 'object',
          required: ['type', 'permission'],
          additionalProperties: false,
          properties: {
            type: { enum: ['link', 'user'] },
            // 'edit' became grantable with ADR 0008, 'share' with ADR 0014,
            // both on NAMED USER GRANTS only — a link is forwardable, a named
            // grant is not. The wire schema can't express "share/edit only
            // when type=user", so the union is widened here and the link
            // branch narrows it back below. Guests are never reachable
            // through this route at all (guest-share-routes.ts owns that
            // surface, capped at read/comment).
            permission: { enum: ['read', 'comment', 'share', 'edit'] },
            userId: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const documentId = req.params.id as DocumentId;
      const body = req.body as {
        type: 'link' | 'user';
        permission: 'read' | 'comment' | 'share' | 'edit';
        userId?: string;
      };
      if (body.type === 'link') {
        if (!isLinkGrantable(body.permission)) {
          return reply.code(400).send({ error: 'permission_not_grantable_by_link' });
        }
        const result = await createShareLink(
          deps.documents,
          deps.grants,
          deps.organizations,
          actor,
          documentId,
          body.permission,
        );
        if (!result.ok) {
          return reply.code(errorStatus[result.error.code]).send({ error: result.error.code });
        }
        // The token appears in this response and never again.
        return reply
          .code(201)
          .send({ grant: grantDto(result.value.grant), token: result.value.token });
      }
      if (!body.userId) return reply.code(400).send({ error: 'user_id_required' });
      const result = await createUserGrant(
        deps.documents,
        deps.grants,
        deps.organizations,
        actor,
        documentId,
        body.userId as UserId,
        body.permission,
      );
      if (!result.ok) {
        return reply.code(errorStatus[result.error.code]).send({ error: result.error.code });
      }
      return reply.code(201).send({ grant: grantDto(result.value) });
    },
  );

  server.get<{ Params: { id: string } }>('/documents/:id/shares', async (req, reply) => {
    const result = await listShareGrants(
      deps.documents,
      deps.grants,
      actorOf(req),
      req.params.id as DocumentId,
    );
    if (!result.ok) {
      return reply.code(errorStatus[result.error.code]).send({ error: result.error.code });
    }
    return { grants: result.value.map(grantDto) };
  });

  server.delete<{ Params: { id: string; grantId: string } }>(
    '/documents/:id/shares/:grantId',
    async (req, reply) => {
      const result = await revokeShareGrant(
        deps.documents,
        deps.grants,
        actorOf(req),
        req.params.id as DocumentId,
        req.params.grantId as GrantId,
      );
      if (!result.ok) {
        return reply.code(errorStatus[result.error.code]).send({ error: result.error.code });
      }
      return reply.code(204).send();
    },
  );

  server.post<{ Body: { token: string } }>(
    '/shares/redeem',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token'],
          additionalProperties: false,
          properties: { token: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const result = await redeemShareLink(deps.grants, actorOf(req), req.body.token);
      if (!result.ok) {
        return reply.code(errorStatus[result.error.code]).send({ error: result.error.code });
      }
      return result.value;
    },
  );

  server.get<{
    Querystring: { q?: string; cursor?: string; limit?: number };
  }>(
    '/org/users',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string', maxLength: 200 },
            cursor: { type: 'string', maxLength: 500 },
            limit: { type: 'number', minimum: 1, maximum: 200 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const actor = actorOf(req);
      const org = await deps.organizations.current(actor.ctx);
      // Email visibility follows sharing_mode (Phase 24): directory mode is
      // built on explicit user grants, so members see emails; link mode shows
      // display names only. Admins always see emails (they manage the org).
      const emailsVisible = actor.role === 'admin' || org?.sharingMode === 'directory';
      const { users, nextCursor } = await deps.organizations.listUsersPage(actor.ctx, {
        ...(req.query.q ? { q: req.query.q } : {}),
        ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
        limit: req.query.limit ?? 50,
      });
      return {
        users: users.map((u) => ({
          id: u.id,
          displayName: u.displayName,
          email: emailsVisible ? u.email : null,
          role: u.role,
        })),
        nextCursor,
      };
    },
  );
}
