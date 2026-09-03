import type { Tier } from '@vorlyn/domain';
import { TIER_PROFILES } from '@vorlyn/domain';

/**
 * Customer-facing plan-comparison shape (Phase 39.B) — deliberately a
 * narrower DTO than `TierCeilings`. Per-doc comment/version-count ceilings
 * and rate limits are enforcement internals, not something a plan-comparison
 * table shows a customer; only the dimensions an admin actually shops on are
 * exposed. Storage has no ceiling on any tier today (see `TierCeilings`), so
 * it is intentionally absent here — `orgUsage()` reports bytes used with
 * nothing to compare against.
 */
export interface TierPlan {
  readonly tier: Tier;
  readonly maxCollaborators: number | null;
  readonly maxActiveDocs: number | null;
  readonly maxActiveDocsPerProject: number | null;
  readonly maxExternalGuests: number | null;
  readonly maxGuestShareDays: number | null;
  readonly versionRetention: {
    readonly keepLastNMax: number | null;
    readonly keepDaysMax: number | null;
    readonly defaultKeepLastN: number;
    readonly defaultKeepDays: number | null;
  };
}

const TIER_ORDER: readonly Tier[] = ['free', 'team', 'enterprise'];

/**
 * Plan comparison for all three tiers, generated straight from
 * `TIER_PROFILES` — the exact constant that enforces the ceilings elsewhere
 * in the app — so marketing/comparison copy can never drift from what is
 * actually enforced (Phase 39 design goal). Pure and synchronous: no
 * repository, no tenant context, nothing org-specific — this is the same
 * three-tier catalog for every caller.
 */
export function listTierPlans(): TierPlan[] {
  return TIER_ORDER.map((tier) => {
    const { ceilings, defaultVersionRetention } = TIER_PROFILES[tier];
    return {
      tier,
      maxCollaborators: ceilings.maxCollaborators,
      maxActiveDocs: ceilings.maxActiveDocs,
      maxActiveDocsPerProject: ceilings.maxActiveDocsPerProject,
      maxExternalGuests: ceilings.maxExternalGuests,
      maxGuestShareDays: ceilings.maxGuestShareDays,
      versionRetention: {
        keepLastNMax: ceilings.versionKeepLastNMax,
        keepDaysMax: ceilings.versionKeepDaysMax,
        defaultKeepLastN: defaultVersionRetention.keepLastN,
        defaultKeepDays: defaultVersionRetention.keepDays,
      },
    };
  });
}
