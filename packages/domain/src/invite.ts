import type { Result } from '@vorlyn/shared';
import { err, ok } from '@vorlyn/shared';
import type { ProvisioningMode } from './entities.js';
import type { Tier } from './tier.js';
import { TIER_PROFILES } from './tier.js';

/**
 * Org invite/join flow (Phase 15). Seat ceiling is
 * `TierCeilings.maxCollaborators` — the same ceiling used everywhere else a
 * human joins an org; `null` means unlimited (Team/Enterprise).
 */

export interface SeatCapError {
  readonly code: 'seat_cap_reached';
  readonly limit: number;
}

export type InviteAcceptabilityError =
  | { readonly code: 'invite_expired' }
  | { readonly code: 'invite_already_used' }
  | { readonly code: 'invite_revoked' };

/**
 * SSO/JIT provisioning is Enterprise-only (`TIER_PROFILES`, tier.ts). Prior
 * to Phase 33 an operator could attach an SSO
 * connection to any org tier with nothing in code stopping login through
 * it — `sso_requires_enterprise_tier` closes that gap at the one place a
 * JIT join actually resolves (`canJitJoin` below).
 */
export type JitJoinError =
  | SeatCapError
  | { readonly code: 'not_allowlisted' }
  | { readonly code: 'sso_requires_enterprise_tier' };

/**
 * Occupied seats = current human members + invites still pending (sent,
 * unexpired). Returns the ceiling when it's exceeded, else null (including
 * tiers with no ceiling at all).
 */
function exceededSeatCeiling(tier: Tier, occupiedSeats: number): number | null {
  const { maxCollaborators } = TIER_PROFILES[tier].ceilings;
  if (maxCollaborators === null || occupiedSeats < maxCollaborators) return null;
  return maxCollaborators;
}

/**
 * The seat ceiling for a tier (`null` = unlimited). Exposed like
 * `commentCapLimit`/`guestCapLimit` (Phase 24): persistence re-checks
 * members + pending invites against it atomically under an advisory lock at
 * insert time, while the ceiling itself stays domain policy.
 */
export function collaboratorCapLimit(tier: Tier): number | null {
  return TIER_PROFILES[tier].ceilings.maxCollaborators;
}

/**
 * Checked at invite *send* time, not at accept time (Phase 15).
 */
export function canSendInvite(params: {
  readonly tier: Tier;
  readonly currentMemberCount: number;
  readonly pendingInviteCount: number;
}): Result<void, SeatCapError> {
  const occupied = params.currentMemberCount + params.pendingInviteCount;
  const limit = exceededSeatCeiling(params.tier, occupied);
  if (limit !== null) return err({ code: 'seat_cap_reached', limit });
  return ok(undefined);
}

/** Validates an invite is still redeemable, in priority order: revoked > used > expired. */
export function inviteAcceptability(
  invite: {
    readonly acceptedAt: Date | null;
    readonly revokedAt: Date | null;
    readonly expiresAt: Date;
  },
  now: Date,
): Result<void, InviteAcceptabilityError> {
  if (invite.revokedAt !== null) return err({ code: 'invite_revoked' });
  if (invite.acceptedAt !== null) return err({ code: 'invite_already_used' });
  if (invite.expiresAt.getTime() <= now.getTime()) return err({ code: 'invite_expired' });
  return ok(undefined);
}

/**
 * Enterprise SSO JIT join decision (Phase 15). SSO is
 * Enterprise-only (`TIER_PROFILES`, tier.ts, Phase 33) — that's
 * checked first, unconditionally, before either of the other checks even
 * run: there's no point evaluating allowlist membership or seat headroom for
 * an attempt that was never eligible to use SSO at all. Once past the tier
 * gate, `open` mode only enforces the seat ceiling; `allowlist` mode
 * additionally requires the login email to be pre-loaded. Both deny-with-message
 * on cap, never silent overage.
 */
export function canJitJoin(params: {
  readonly mode: ProvisioningMode;
  readonly email: string;
  readonly isAllowlisted: boolean;
  readonly tier: Tier;
  readonly currentMemberCount: number;
}): Result<void, JitJoinError> {
  if (params.tier !== 'enterprise') return err({ code: 'sso_requires_enterprise_tier' });
  if (params.mode === 'allowlist' && !params.isAllowlisted) {
    return err({ code: 'not_allowlisted' });
  }
  const limit = exceededSeatCeiling(params.tier, params.currentMemberCount);
  if (limit !== null) return err({ code: 'seat_cap_reached', limit });
  return ok(undefined);
}
