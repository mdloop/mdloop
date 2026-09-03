import type { FastifyInstance } from 'fastify';
import type {
  AllowlistRepository,
  EmailPort,
  OrganizationRepository,
  OrgInviteRepository,
} from '@vorlyn/app';
import type { AllowlistEntry, OrgInvite } from '@vorlyn/domain';
import {
  addAllowlistEntry,
  listAllowlist,
  listInvites,
  removeAllowlistEntry,
  revokeInvite,
  sendInvite,
} from '@vorlyn/app';
import type { AllowlistEntryId, InviteId } from '@vorlyn/shared';
import { requireAdmin } from '../auth/guards.js';
import { actorOf } from '../auth/actor.js';

function inviteDto(i: OrgInvite) {
  return {
    id: i.id,
    email: i.email,
    role: i.role,
    invitedBy: i.invitedBy,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    acceptedAt: i.acceptedAt,
    revokedAt: i.revokedAt,
  };
}

function allowlistDto(a: AllowlistEntry) {
  return { id: a.id, email: a.email, addedBy: a.addedBy, createdAt: a.createdAt };
}

export interface InviteRouteDeps {
  organizations: OrganizationRepository;
  invites: OrgInviteRepository;
  allowlist: AllowlistRepository;
  email: EmailPort;
  webAppUrl: string;
}

export function registerInviteRoutes(server: FastifyInstance, deps: InviteRouteDeps): void {
  server.post<{ Body: { email: string; role: 'admin' | 'member' } }>(
    '/invites',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['email', 'role'],
          additionalProperties: false,
          properties: {
            email: { type: 'string' },
            role: { enum: ['admin', 'member'] },
          },
        },
      },
    },
    async (req, reply) => {
      const result = await sendInvite(deps.organizations, deps.invites, deps.email, actorOf(req), {
        email: req.body.email,
        role: req.body.role,
        // Lands on our own /invite/accept screen first (Phase 38.C), not
        // straight at the WorkOS hosted-auth round trip — the invitee sees
        // our card and copy before the handoff. That screen's own Continue
        // button carries the token on into /api/auth/login?invite= from
        // there, same destination as before, one hop later.
        acceptUrlBase: `${deps.webAppUrl}/invite/accept?token=`,
      });
      if (!result.ok) {
        const status = result.error.code === 'forbidden' ? 403 : 400;
        return reply.code(status).send({ error: result.error.code });
      }
      // The token is embedded in the emailed accept URL and never stored raw.
      return reply
        .code(201)
        .send({ invite: inviteDto(result.value.invite), token: result.value.token });
    },
  );

  server.get('/invites', { preHandler: requireAdmin }, async (req, reply) => {
    const result = await listInvites(deps.invites, actorOf(req));
    if (!result.ok) return reply.code(403).send({ error: result.error.code });
    return { invites: result.value.map(inviteDto) };
  });

  server.delete<{ Params: { id: string } }>(
    '/invites/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const result = await revokeInvite(deps.invites, actorOf(req), req.params.id as InviteId);
      if (!result.ok) {
        const status = result.error.code === 'forbidden' ? 403 : 404;
        return reply.code(status).send({ error: result.error.code });
      }
      return reply.code(204).send();
    },
  );

  server.get('/org/allowlist', { preHandler: requireAdmin }, async (req, reply) => {
    const result = await listAllowlist(deps.allowlist, actorOf(req));
    if (!result.ok) return reply.code(403).send({ error: result.error.code });
    return { entries: result.value.map(allowlistDto) };
  });

  server.post<{ Body: { email: string } }>(
    '/org/allowlist',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          properties: { email: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const result = await addAllowlistEntry(deps.allowlist, actorOf(req), req.body.email);
      if (!result.ok) return reply.code(403).send({ error: result.error.code });
      return reply.code(201).send({ entry: allowlistDto(result.value) });
    },
  );

  server.delete<{ Params: { id: string } }>(
    '/org/allowlist/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const result = await removeAllowlistEntry(
        deps.allowlist,
        actorOf(req),
        req.params.id as AllowlistEntryId,
      );
      if (!result.ok) {
        const status = result.error.code === 'forbidden' ? 403 : 404;
        return reply.code(status).send({ error: result.error.code });
      }
      return reply.code(204).send();
    },
  );
}
