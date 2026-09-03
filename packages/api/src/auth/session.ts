import { createHmac, timingSafeEqual } from 'node:crypto';
import { GLOBAL_SESSION_MAX_MS } from '@vorlyn/domain';

/**
 * Stateless signed session token: base64url(payload).base64url(hmac-sha256).
 * httpOnly cookie; no server-side session store (ARCHITECTURE.md §1). Expiry
 * is embedded and verified on every request. Revocation story = short TTL.
 *
 * `exp` is the absolute ceiling minted from the global default (Phase 24); an
 * org may configure a *shorter* max enforced at decode time in the session
 * guard (see `@vorlyn/domain` `effectiveSessionExpiry`). `iat` (issued-at) drives
 * both that org-max math and the silent-refresh threshold.
 */
export interface SessionPayload {
  readonly userId: string;
  readonly orgId: string;
  /** 'guest' (Phase 18): external identity minted by guest-share redemption. */
  readonly role: 'admin' | 'member' | 'guest';
  /** Unix ms issued-at. */
  readonly iat: number;
  /** Unix ms absolute expiry (global-default ceiling; org max tightens it). */
  readonly exp: number;
}

export const SESSION_COOKIE = 'vorlyn_session';
/** Global session ceiling (Phase 24, was a 7-day TTL). Org max only shortens it. */
export const SESSION_TTL_MS = GLOBAL_SESSION_MAX_MS;

/**
 * CSRF: signed double-submit token (Phase 24, CONSTITUTION.md §4). The token is
 * HMAC(secret, session cookie value) — bound to the exact session, verifiable
 * server-side from the session cookie alone (no extra payload field, no store),
 * and reissued whenever the session is (silent refresh). Set as a *readable*
 * (non-httpOnly) cookie so the SPA can echo it into the `x-csrf-token` header;
 * an attacker can plant a cookie but cannot compute a value matching the
 * victim's signed session without the secret.
 */
export const CSRF_COOKIE = 'vorlyn_csrf';
export const CSRF_HEADER = 'x-csrf-token';

function sign(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export function encodeSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, secret).toString('base64url')}`;
}

/**
 * A successfully-decoded session, paired with the secret that verified it
 * (current or previous — see `decodeSession`). Callers that also need to
 * verify a CSRF token bound to this same session (guards.ts) must reuse
 * `secret` rather than re-deriving their own candidate list: a real client's
 * CSRF token was always minted under whichever secret signed its session
 * token, so the two must be verified as a pair, never independently.
 */
export interface DecodedSession {
  readonly payload: SessionPayload;
  readonly secret: string;
}

/**
 * Verifies `token` against each secret in `secrets`, in order, returning the
 * payload plus whichever secret matched (or `undefined` if none did). Callers
 * pass `[current, previous]` during a `SESSION_SECRET` rotation window (current
 * first — the common case in steady state) or just `[current]` otherwise.
 * Signing (`encodeSession`) always uses a single secret — only verification
 * ever tries more than one.
 */
export function decodeSession(
  token: string,
  secrets: readonly string[],
  now: number = Date.now(),
): DecodedSession | undefined {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1), 'base64url');
  const secret = secrets.find((candidate) => {
    const expected = sign(body, candidate);
    return mac.length === expected.length && timingSafeEqual(mac, expected);
  });
  if (secret === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const p = parsed as Record<string, unknown>;
    if (typeof p.exp !== 'number' || p.exp <= now) return undefined;
    if (typeof p.iat !== 'number') return undefined;
    if (typeof p.userId !== 'string' || typeof p.orgId !== 'string') return undefined;
    if (p.role !== 'admin' && p.role !== 'member' && p.role !== 'guest') return undefined;
    return {
      payload: { userId: p.userId, orgId: p.orgId, role: p.role, iat: p.iat, exp: p.exp },
      secret,
    };
  } catch {
    return undefined;
  }
}

/** The CSRF double-submit token bound to a given session cookie value. */
export function csrfTokenFor(sessionToken: string, secret: string): string {
  return createHmac('sha256', secret).update(`csrf:${sessionToken}`).digest('base64url');
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Valid iff the submitted header equals the csrf cookie AND both equal the token
 * bound to the session cookie. The header==cookie leg is the classic
 * double-submit check; the ==bound-token leg is the signature that a planted
 * cookie can't forge.
 */
export function csrfMatches(
  header: string | undefined,
  cookie: string | undefined,
  sessionToken: string | undefined,
  secret: string,
): boolean {
  if (!header || !cookie || !sessionToken) return false;
  const expected = csrfTokenFor(sessionToken, secret);
  return constantTimeEquals(header, cookie) && constantTimeEquals(header, expected);
}
