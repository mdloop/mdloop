/**
 * Session duration policy (Phase 24, CONSTITUTION.md §4).
 *
 * A session cookie carries an absolute `exp` ceiling minted from the global
 * default; an org may configure a *shorter* per-org max (`sessionMaxHours`,
 * 1..24) that is enforced at decode time without re-minting the token. The
 * effective expiry is the earliest of the token's own ceiling and the org max
 * applied to the issued-at time — an org can only tighten, never loosen.
 */

/** Global session ceiling (hours). Was a 7-day TTL pre-Phase-24. */
export const GLOBAL_SESSION_MAX_HOURS = 24;

const MS_PER_HOUR = 60 * 60 * 1000;

/** Global session ceiling in milliseconds. */
export const GLOBAL_SESSION_MAX_MS = GLOBAL_SESSION_MAX_HOURS * MS_PER_HOUR;

/**
 * Valid org-configurable session max: an integer 1..24 hours, or `null` for
 * the global default. An org may only shorten below the global 24h ceiling.
 */
export function isValidSessionMaxHours(hours: number): boolean {
  return Number.isInteger(hours) && hours >= 1 && hours <= GLOBAL_SESSION_MAX_HOURS;
}

/**
 * Effective session expiry (Unix ms): the earliest of the token's own absolute
 * ceiling and `iat + orgMax`. `orgMaxHours` null → the global default applies.
 * The org max only ever tightens the window, so a `min` is always correct even
 * for guest sessions whose `absoluteExp` is already capped at their grant.
 */
export function effectiveSessionExpiry(
  iat: number,
  absoluteExp: number,
  orgMaxHours: number | null,
): number {
  const orgMaxMs = orgMaxHours === null ? GLOBAL_SESSION_MAX_MS : orgMaxHours * MS_PER_HOUR;
  return Math.min(absoluteExp, iat + orgMaxMs);
}
