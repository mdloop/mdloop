import type { FastifyInstance } from 'fastify';
import type {
  Actor,
  DirectoryRepository,
  DocumentRepository,
  EmailPort,
  GuestShareError,
  GuestUserRepository,
  OrganizationRepository,
  ShareGrantRepository,
} from '@vorlyn/app';
import { createGuestShare, redeemGuestShare, requireDocumentAccess } from '@vorlyn/app';
import type { DocumentId, OrgId, UserId } from '@vorlyn/shared';
import { actorOf } from '../auth/actor.js';
import { decodeSession, encodeSession, SESSION_COOKIE, SESSION_TTL_MS } from '../auth/session.js';
import { sessionSecrets, setAuthCookies } from '../auth/guards.js';
import type { ApiConfig } from '../config.js';

const errorStatus: Record<GuestShareError['code'], number> = {
  document_not_found: 404,
  external_sharing_disabled: 403,
  invalid_email: 400,
  guest_cap_exceeded: 403,
  guest_edit_forbidden: 403,
};

export interface GuestShareRouteDeps {
  documents: DocumentRepository;
  grants: ShareGrantRepository;
  organizations: OrganizationRepository;
  guests: GuestUserRepository;
  email: EmailPort;
  webAppUrl: string;
}

/** Authed side (Phase 18): owners/admins create guest shares. */
export function registerGuestShareRoutes(server: FastifyInstance, deps: GuestShareRouteDeps): void {
  server.post<{
    Params: { id: string };
    Body: { email: string; permission: 'read' | 'comment'; days: number };
  }>(
    '/documents/:id/guest-shares',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'permission', 'days'],
          additionalProperties: false,
          properties: {
            email: { type: 'string' },
            // Still no 'edit' here, and this one is not a policy call: an
            // external guest is capped at read/comment regardless of grant
            // (CONSTITUTION §9). ADR 0008 widened internal user grants only.
            permission: { enum: ['read', 'comment'] },
            days: { type: 'integer', minimum: 1, maximum: 365 },
          },
        },
      },
    },
    async (req, reply) => {
      const result = await createGuestShare(
        {
          documents: deps.documents,
          grants: deps.grants,
          orgs: deps.organizations,
          guests: deps.guests,
          email: deps.email,
        },
        actorOf(req),
        {
          documentId: req.params.id as DocumentId,
          email: req.body.email,
          permission: req.body.permission,
          days: req.body.days,
          redeemUrlBase: `${deps.webAppUrl}/g/`,
        },
      );
      if (!result.ok) {
        return reply.code(errorStatus[result.error.code]).send({ error: result.error.code });
      }
      // The token appears in this response (and the email) and never again.
      return reply.code(201).send({
        grant: {
          id: result.value.grant.id,
          granteeEmail: result.value.grant.granteeEmail,
          permission: result.value.grant.permission,
          expiresAt: result.value.expiresAt,
        },
        token: result.value.token,
        expiresAt: result.value.expiresAt,
      });
    },
  );
}

export interface GuestRedeemRouteDeps {
  directory: DirectoryRepository;
  documents: DocumentRepository;
  grants: ShareGrantRepository;
  config: ApiConfig;
}

/**
 * Unauthenticated redeem (Phase 18): the token is the identity, same trust
 * boundary as the auth callback. Mints the standard signed session cookie for
 * the guest user, TTL capped at the grant's expiry — unless the caller already
 * holds a session that can read this document, in which case that session is
 * left alone (see the check below).
 */
export function registerGuestRedeemRoute(
  server: FastifyInstance,
  deps: GuestRedeemRouteDeps,
): void {
  server.post<{ Body: { token: string } }>(
    '/guest/redeem',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
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
      const result = await redeemGuestShare(deps.directory, req.body.token);
      if (!result.ok) {
        // All failure modes read identically — no oracle for valid-but-off orgs.
        return reply.code(404).send({ error: 'invalid_token' });
      }
      // Don't downgrade an already-authenticated user who can already read this
      // document — e.g. the sharer opening their own link to sanity-check it.
      // Overwriting `vorlyn_session` here would strand them in guest mode
      // (viewer-only chrome, `blockGuestBeyondReview`) until that session
      // expires. Checked against real document access, not just "same org":
      // an internal member with no grant on this doc still needs the guest
      // session the token grants them.
      const existingToken = req.cookies[SESSION_COOKIE];
      const existingSession = existingToken
        ? decodeSession(existingToken, sessionSecrets(deps.config))?.payload
        : undefined;
      if (existingSession && existingSession.role !== 'guest') {
        const existingActor: Actor = {
          ctx: { orgId: existingSession.orgId as OrgId, userId: existingSession.userId as UserId },
          role: existingSession.role,
        };
        const access = await requireDocumentAccess(
          deps.documents,
          deps.grants,
          existingActor,
          result.value.documentId,
          'read',
        );
        if (access.ok) {
          return { documentId: result.value.documentId, expiresAt: result.value.expiresAt };
        }
      }
      const now = Date.now();
      // Session hard-capped at the grant expiry (Phase 18); the org max further
      // tightens it at decode time and the guest is never silently refreshed.
      const exp = Math.min(
        now + SESSION_TTL_MS,
        result.value.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY,
      );
      const token = encodeSession(
        {
          userId: result.value.userId,
          orgId: result.value.orgId,
          role: 'guest',
          iat: now,
          exp,
        },
        deps.config.sessionSecret,
      );
      setAuthCookies(
        reply,
        token,
        deps.config.sessionSecret,
        deps.config.secureCookies,
        Math.floor((exp - now) / 1000),
      );
      return { documentId: result.value.documentId, expiresAt: result.value.expiresAt };
    },
  );
}
