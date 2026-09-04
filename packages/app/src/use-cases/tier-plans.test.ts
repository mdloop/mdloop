import { describe, expect, it } from 'vitest';
import { TIER_PROFILES } from '@mdloop/domain';
import { listTierPlans } from './tier-plans.js';

describe('listTierPlans', () => {
  it('returns exactly free, team, enterprise in that order', () => {
    const plans = listTierPlans();
    expect(plans.map((p) => p.tier)).toEqual(['free', 'team', 'enterprise']);
  });

  it('every ceiling is read straight from TIER_PROFILES, never hardcoded separately', () => {
    for (const plan of listTierPlans()) {
      const ceilings = TIER_PROFILES[plan.tier].ceilings;
      const defaults = TIER_PROFILES[plan.tier].defaultVersionRetention;
      expect(plan.maxCollaborators).toBe(ceilings.maxCollaborators);
      expect(plan.maxActiveDocs).toBe(ceilings.maxActiveDocs);
      expect(plan.maxActiveDocsPerProject).toBe(ceilings.maxActiveDocsPerProject);
      expect(plan.maxExternalGuests).toBe(ceilings.maxExternalGuests);
      expect(plan.maxGuestShareDays).toBe(ceilings.maxGuestShareDays);
      expect(plan.versionRetention).toEqual({
        keepLastNMax: ceilings.versionKeepLastNMax,
        keepDaysMax: ceilings.versionKeepDaysMax,
        defaultKeepLastN: defaults.keepLastN,
        defaultKeepDays: defaults.keepDays,
      });
    }
  });

  it('free tier reports finite seat and guest ceilings', () => {
    const free = listTierPlans().find((p) => p.tier === 'free');
    expect(free?.maxCollaborators).toBe(1);
    expect(free?.maxExternalGuests).toBe(0);
  });

  it('enterprise tier reports unlimited (null) seat/doc/guest ceilings', () => {
    const enterprise = listTierPlans().find((p) => p.tier === 'enterprise');
    expect(enterprise?.maxCollaborators).toBeNull();
    expect(enterprise?.maxActiveDocs).toBeNull();
    expect(enterprise?.maxExternalGuests).toBeNull();
  });

  // 2026-08-13: version-retention ceiling is the one deliberate exception —
  // pinned finite (shared with Team) rather than unlimited, closing the
  // unbounded-storage cost exposure. See
  // TIER_PROFILES.enterprise's doc comment in packages/domain/src/tier.ts.
  it('enterprise tier caps version retention at the same finite ceiling as Team', () => {
    const enterprise = listTierPlans().find((p) => p.tier === 'enterprise');
    expect(enterprise?.versionRetention.keepLastNMax).toBe(250);
    expect(enterprise?.versionRetention.keepDaysMax).toBe(365);
    expect(enterprise?.versionRetention.defaultKeepLastN).toBe(100);
    expect(enterprise?.versionRetention.defaultKeepDays).toBe(180);
  });

  it('does not leak internal-only fields (rate limits, per-doc comment/version caps)', () => {
    const plan = listTierPlans()[0] as unknown as Record<string, unknown>;
    expect(plan.rateLimit).toBeUndefined();
    expect(plan.maxCommentsPerDoc).toBeUndefined();
    expect(plan.maxLiveVersionsPerDoc).toBeUndefined();
  });
});
