import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AuthPort, DirectoryRepository, SeatSyncPort } from '@mdloop/app';
import { signIn } from '@mdloop/app';
import { CSRF_COOKIE, SESSION_COOKIE, SESSION_TTL_MS, encodeSession } from '../auth/session.js';
import { setAuthCookies } from '../auth/guards.js';
import type { ApiConfig } from '../config.js';

/**
 * /api/auth/login -> WorkOS hosted page -> /api/auth/callback -> signed
 * session cookie. Registered here at bare `/auth/*` paths — `server.ts`
 * mounts this whole module under an outer `/api` prefix, so the real,
 * browser/WorkOS-visible path is `/api/auth/*`. The redirect_uri handed to
 * WorkOS and every cookie `path` below must match that real path, not the
 * bare one this file writes.
 *
 * State parameter is a random nonce stored in a short-lived cookie (CSRF
 * protection on the OAuth flow itself). An invite token (Phase 15) rides
 * along the same round trip in its own short-lived cookie so /api/auth/callback
 * can route a brand-new WorkOS identity to the inviting org instead of
 * bootstrapping a personal one.
 */
export function registerAuthRoutes(
  server: FastifyInstance,
  config: ApiConfig,
  auth: AuthPort,
  directory: DirectoryRepository,
  seatSync: SeatSyncPort,
): void {
  server.get<{ Querystring: { invite?: string } }>('/auth/login', (req, reply) => {
    const state = randomBytes(16).toString('base64url');
    void reply.setCookie('mdloop_oauth_state', state, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'lax',
      path: '/api/auth',
      maxAge: 600,
    });
    if (req.query.invite) {
      void reply.setCookie('mdloop_invite_token', req.query.invite, {
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: 'lax',
        path: '/api/auth',
        maxAge: 600,
      });
    }
    return reply.redirect(auth.authorizationUrl(`${config.baseUrl}/api/auth/callback`, state));
  });

  server.get<{ Querystring: { code?: string; state?: string } }>(
    '/auth/callback',
    async (req, reply) => {
      const { code, state } = req.query;
      const expectedState = req.cookies.mdloop_oauth_state;
      if (!code || !state || !expectedState || state !== expectedState) {
        return reply.code(400).send({ error: 'invalid_oauth_state' });
      }
      void reply.clearCookie('mdloop_oauth_state', { path: '/api/auth' });
      const inviteToken = req.cookies.mdloop_invite_token;
      if (inviteToken) void reply.clearCookie('mdloop_invite_token', { path: '/api/auth' });

      const profile = await auth.exchangeCode(code);
      const result = await signIn(directory, seatSync, profile, inviteToken);
      if (!result.ok) {
        // Abuse control (Phase 13) + invite/JIT denials (Phase 15). This is
        // a top-level browser navigation mid-way through the WorkOS round
        // trip, not a fetch() the SPA's client wraps in `ApiError` — sending
        // `{ error: code }` here used to render as a bare JSON body in the
        // browser (branding-leak cleanup, Phase 38.C). Redirect back to our
        // own login card instead; it resolves the code through the same
        // error-copy.ts map every other surface uses.
        return reply.redirect(`${config.webAppUrl}/?authError=${result.error.code}`);
      }
      const user = result.value;

      const iat = Date.now();
      const token = encodeSession(
        {
          userId: user.id,
          orgId: user.orgId,
          role: user.role,
          iat,
          exp: iat + SESSION_TTL_MS,
        },
        config.sessionSecret,
      );
      setAuthCookies(reply, token, config.sessionSecret, config.secureCookies);
      return reply.redirect(config.webAppUrl);
    },
  );

  server.post('/auth/logout', (_req, reply) => {
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    void reply.clearCookie(CSRF_COOKIE, { path: '/' });
    return reply.code(204).send();
  });
}
