import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Actor, CachedSessionMaxResolver } from '@vorlyn/app';
import type { OrgId, UserId } from '@vorlyn/shared';
import { effectiveSessionExpiry } from '@vorlyn/domain';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  csrfMatches,
  csrfTokenFor,
  decodeSession,
  encodeSession,
} from './session.js';
import type { SessionPayload } from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
    /**
     * The secret (current or previous — SESSION_SECRET rotation, P0.7) that
     * verified this request's session token, set by `requireSession`. The CSRF
     * layer (`requireCsrf`) reuses this exact secret rather than re-trying both
     * independently, so a current-secret session can never pair with a
     * previous-secret-only CSRF token or vice versa — only a pair actually
     * minted together (login/refresh) can verify.
     */
    sessionSecretUsed?: string;
  }
}

const MUTATING = (method: string): boolean =>
  method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';

export interface SessionGuardDeps {
  readonly sessionSecret: string;
  /**
   * In-flight `SESSION_SECRET` rotation only (P0.7); normally unset. When set,
   * a session/CSRF pair signed with this secret still verifies until it
   * naturally expires or is silently refreshed (which re-signs with
   * `sessionSecret`). Never used for signing — verification only.
   */
  readonly sessionSecretPrevious?: string;
  readonly secureCookies: boolean;
  /** Per-org shorter session ceiling, cached (Phase 24). */
  readonly sessionPolicy: CachedSessionMaxResolver;
  readonly clock?: () => number;
}

/**
 * Ordered verification candidates: current first (cheap optimization — far
 * more likely to match in steady state), then previous if configured.
 * Exported so any other call site decoding a session (e.g. the guest-redeem
 * route's "is the caller already logged in as a non-guest" check) gets the
 * same rotation-aware behavior instead of only checking the current secret.
 */
export function sessionSecrets(
  deps: Pick<SessionGuardDeps, 'sessionSecret' | 'sessionSecretPrevious'>,
): readonly string[] {
  return deps.sessionSecretPrevious
    ? [deps.sessionSecret, deps.sessionSecretPrevious]
    : [deps.sessionSecret];
}

/**
 * Sets the paired session + CSRF cookies (login, guest redeem, silent refresh).
 * The CSRF cookie is deliberately non-httpOnly so the SPA can echo it into the
 * `x-csrf-token` header; both share the session's flags and lifetime.
 */
export function setAuthCookies(
  reply: FastifyReply,
  token: string,
  secret: string,
  secureCookies: boolean,
  maxAgeSeconds: number = SESSION_TTL_MS / 1000,
): void {
  const opts = {
    secure: secureCookies,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
  void reply.setCookie(SESSION_COOKIE, token, { ...opts, httpOnly: true });
  void reply.setCookie(CSRF_COOKIE, csrfTokenFor(token, secret), { ...opts, httpOnly: false });
}

/**
 * Session guard: every route except health + auth callbacks requires a valid
 * session (CONSTITUTION.md §4). Attaches the Actor, enforces the org's (possibly
 * shorter) session max, and silently refreshes a session past half its effective
 * lifetime by reissuing both cookies in the same response (Phase 24).
 */
export function makeRequireSession(deps: SessionGuardDeps) {
  const clock = deps.clock ?? Date.now;
  const secrets = sessionSecrets(deps);
  return async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const now = clock();
    const token = req.cookies[SESSION_COOKIE];
    const decoded = token ? decodeSession(token, secrets, now) : undefined;
    if (!decoded) {
      await reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    const { payload: session, secret: matchedSecret } = decoded;
    // Org may shorten the window below the token's absolute ceiling; enforce it
    // here (no per-request DB read — the resolver caches ~30s).
    const orgMaxHours = await deps.sessionPolicy.resolve({
      orgId: session.orgId as OrgId,
      userId: session.userId as UserId,
    });
    const effectiveExp = effectiveSessionExpiry(session.iat, session.exp, orgMaxHours);
    if (now >= effectiveExp) {
      await reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    req.actor = {
      ctx: { orgId: session.orgId as OrgId, userId: session.userId as UserId },
      role: session.role,
    };
    // The CSRF layer must verify against this exact secret, not re-try both —
    // see the `sessionSecretUsed` doc comment above.
    req.sessionSecretUsed = matchedSecret;
    maybeRefresh(reply, session, effectiveExp, now, deps);
  };
}

/**
 * Silent refresh: past 50% of the effective lifetime, reissue with a fresh
 * iat/exp (payload otherwise unchanged) so an active user's session slides.
 * Guests are never refreshed — their window is hard-capped at the grant expiry
 * (Phase 18) and must never be extended.
 */
function maybeRefresh(
  reply: FastifyReply,
  session: SessionPayload,
  effectiveExp: number,
  now: number,
  deps: SessionGuardDeps,
): void {
  if (session.role === 'guest') return;
  const halfLife = session.iat + (effectiveExp - session.iat) / 2;
  if (now < halfLife) return;
  const fresh = encodeSession(
    {
      userId: session.userId,
      orgId: session.orgId,
      role: session.role,
      iat: now,
      exp: now + SESSION_TTL_MS,
    },
    deps.sessionSecret,
  );
  setAuthCookies(reply, fresh, deps.sessionSecret, deps.secureCookies);
}

/**
 * CSRF Origin allowlist (Phase 24): a mutating request carrying an `Origin`
 * header must match the configured web origin exactly. A request with *no*
 * Origin is allowed — non-browser clients (and same-origin `fetch` in some
 * engines) omit it, and the double-submit token still guards those.
 */
export function makeRequireOrigin(webOrigin: string) {
  return function requireOrigin(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
    if (MUTATING(req.method)) {
      const origin = req.headers.origin;
      if (typeof origin === 'string' && origin !== webOrigin) {
        void reply.code(403).send({ error: 'bad_origin' });
        return;
      }
    }
    done();
  };
}

/**
 * CSRF token layer (Phase 24): every mutating request in the authed scope must
 * carry an `x-csrf-token` header equal to the `vorlyn_csrf` cookie and bound to
 * the session cookie. Runs after the session guard, so a missing session is
 * already a 401 by here — and, critically, verifies against `req.sessionSecretUsed`
 * (the exact secret `requireSession` matched, current or previous) rather than
 * trying both secrets independently. That's what makes the current+previous
 * SESSION_SECRET pairing structural: a session verified under the current
 * secret can never be paired with a CSRF token that only checks out under the
 * previous one, and vice versa, because there is only ever one secret in play
 * per request.
 */
export function makeRequireCsrf() {
  return function requireCsrf(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
    if (MUTATING(req.method)) {
      const secret = req.sessionSecretUsed;
      if (
        !secret ||
        !csrfMatches(
          req.headers[CSRF_HEADER] as string | undefined,
          req.cookies[CSRF_COOKIE],
          req.cookies[SESSION_COOKIE],
          secret,
        )
      ) {
        void reply.code(403).send({ error: 'csrf' });
        return;
      }
    }
    done();
  };
}

/** Admin guard, layered on top of requireSession. */
export function requireAdmin(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (req.actor?.role !== 'admin') {
    void reply.code(403).send({ error: 'forbidden' });
    return;
  }
  done();
}

/**
 * Guest allowlist (Phase 18): a guest session may only reach the routes a
 * document review needs — reading the granted document and commenting on it.
 * Everything else (uploads, projects, org, keys, search, shares) is
 * 403 regardless of what per-route permission checks would say. Allowlist,
 * not blocklist: a new route is guest-closed until deliberately opened.
 *
 * Entries are matched against `req.routeOptions.url`, which is Fastify's
 * full mounted route pattern including the outer `/api` prefix
 * (server.ts) — not the bare path these route files register with.
 */
const GUEST_ROUTES = new Set([
  'GET /api/me',
  'GET /api/documents/:id',
  'GET /api/documents/:id/content',
  'GET /api/documents/:id/versions',
  'GET /api/documents/:id/versions/:versionId/content',
  // Diff is read-level: a guest with read access can compare legs (ADR 0003 §A).
  'GET /api/documents/:id/diff',
  'GET /api/documents/:id/comments',
  'GET /api/documents/:id/feedback-bundle',
  'GET /api/documents/:id/review',
  'POST /api/documents/:id/review/verdict',
  'POST /api/documents/:id/comments',
  'POST /api/comments/:id/replies',
  'POST /api/comments/:id/upvote',
  'PATCH /api/comments/:id',
]);

export function blockGuestBeyondReview(
  req: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  if (
    req.actor?.role === 'guest' &&
    !GUEST_ROUTES.has(`${req.method} ${req.routeOptions.url ?? ''}`)
  ) {
    void reply.code(403).send({ error: 'guest_forbidden' });
    return;
  }
  done();
}
