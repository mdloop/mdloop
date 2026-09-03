import { describe, expect, it } from 'vitest';
import {
  TIER_PROFILES,
  checkCommentAllowed,
  checkDocCreateAllowed,
  checkGuestShareAllowed,
  checkProjectDocCreateAllowed,
  checkVersionAppendAllowed,
  clampGuestShareDays,
  clampVersionRetention,
  effectiveVersionRetention,
  isTier,
  isValidVersionRetention,
} from './tier.js';

describe('isTier', () => {
  it('accepts the three tiers and nothing else', () => {
    expect(isTier('free')).toBe(true);
    expect(isTier('team')).toBe(true);
    expect(isTier('enterprise')).toBe(true);
    expect(isTier('pro')).toBe(false);
    expect(isTier('')).toBe(false);
  });
});

describe('clampVersionRetention', () => {
  it('leaves stricter-than-ceiling config untouched', () => {
    expect(clampVersionRetention({ keepLastN: 5, keepDays: 7 }, 'free')).toEqual({
      keepLastN: 5,
      keepDays: 7,
    });
  });

  it('pulls looser-than-ceiling config down to the free ceiling', () => {
    expect(clampVersionRetention({ keepLastN: 500, keepDays: 400 }, 'free')).toEqual({
      keepLastN: 20,
      keepDays: 90,
    });
  });

  it('clamps unlimited keepDays to a bounded ceiling', () => {
    expect(clampVersionRetention({ keepLastN: 10, keepDays: null }, 'free')).toEqual({
      keepLastN: 10,
      keepDays: 90,
    });
  });

  it('pulls looser-than-ceiling config down to the team ceiling', () => {
    expect(clampVersionRetention({ keepLastN: 200, keepDays: 300 }, 'team')).toEqual({
      keepLastN: 200,
      keepDays: 300,
    });
    expect(clampVersionRetention({ keepLastN: 2_000, keepDays: 30 }, 'team')).toEqual({
      keepLastN: 250,
      keepDays: 30,
    });
    // `keepDays: null` (unlimited age) has no unlimited ceiling to survive
    // under on any tier as of 2026-08-13, so it always clamps to the
    // ceiling's day count — this makes it always looser than the input,
    // which is why the admin-facing form treats "no day limit" as invalid
    // input rather than offering it.
    expect(clampVersionRetention({ keepLastN: 10, keepDays: null }, 'team')).toEqual({
      keepLastN: 10,
      keepDays: 365,
    });
  });

  it('pulls looser-than-ceiling config down to the enterprise ceiling', () => {
    expect(clampVersionRetention({ keepLastN: 10_000, keepDays: null }, 'enterprise')).toEqual({
      keepLastN: 250,
      keepDays: 365,
    });
    expect(clampVersionRetention({ keepLastN: 100, keepDays: 200 }, 'enterprise')).toEqual({
      keepLastN: 100,
      keepDays: 200,
    });
  });
});

describe('effectiveVersionRetention', () => {
  it('falls back to the tier default when the org has no config', () => {
    expect(effectiveVersionRetention('free', null)).toEqual({ keepLastN: 20, keepDays: 90 });
    expect(effectiveVersionRetention('team', null)).toEqual({ keepLastN: 50, keepDays: 90 });
    expect(effectiveVersionRetention('enterprise', null)).toEqual({
      keepLastN: 100,
      keepDays: 180,
    });
  });

  it('uses org config where set, clamped to the ceiling', () => {
    expect(effectiveVersionRetention('free', { keepLastN: 5, keepDays: 10 })).toEqual({
      keepLastN: 5,
      keepDays: 10,
    });
    expect(effectiveVersionRetention('free', { keepLastN: 999, keepDays: null })).toEqual({
      keepLastN: 20,
      keepDays: 90,
    });
  });

  it('re-clamps stored config after a tier downgrade', () => {
    const teamConfig = { keepLastN: 200, keepDays: 300 };
    expect(effectiveVersionRetention('team', teamConfig)).toEqual(teamConfig);
    expect(effectiveVersionRetention('free', teamConfig)).toEqual({ keepLastN: 20, keepDays: 90 });
  });
});

describe('isValidVersionRetention', () => {
  it('accepts positive integers and null keepDays', () => {
    expect(isValidVersionRetention({ keepLastN: 1, keepDays: 1 })).toBe(true);
    expect(isValidVersionRetention({ keepLastN: 50, keepDays: null })).toBe(true);
  });

  it('rejects zero, negatives, and fractions', () => {
    expect(isValidVersionRetention({ keepLastN: 0, keepDays: 30 })).toBe(false);
    expect(isValidVersionRetention({ keepLastN: 1.5, keepDays: 30 })).toBe(false);
    expect(isValidVersionRetention({ keepLastN: 5, keepDays: 0 })).toBe(false);
    expect(isValidVersionRetention({ keepLastN: 5, keepDays: -1 })).toBe(false);
  });
});

describe('tier caps', () => {
  it('doc cap: free blocks at 100, team at 5000, enterprise never', () => {
    expect(checkDocCreateAllowed(99, 'free').ok).toBe(true);
    const free = checkDocCreateAllowed(100, 'free');
    expect(!free.ok && free.error).toEqual({ code: 'doc_cap_exceeded', limit: 100 });
    const team = checkDocCreateAllowed(5_000, 'team');
    expect(!team.ok && team.error.code).toBe('doc_cap_exceeded');
    expect(checkDocCreateAllowed(1_000_000, 'enterprise').ok).toBe(true);
  });

  it('per-project doc cap: free blocks at 100, team at 500, enterprise never (Phase 33)', () => {
    expect(checkProjectDocCreateAllowed(99, 'free').ok).toBe(true);
    const free = checkProjectDocCreateAllowed(100, 'free');
    expect(!free.ok && free.error).toEqual({ code: 'project_doc_cap_exceeded', limit: 100 });
    expect(checkProjectDocCreateAllowed(499, 'team').ok).toBe(true);
    const team = checkProjectDocCreateAllowed(500, 'team');
    expect(!team.ok && team.error).toEqual({ code: 'project_doc_cap_exceeded', limit: 500 });
    expect(checkProjectDocCreateAllowed(1_000_000, 'enterprise').ok).toBe(true);
  });

  it('the org-wide cap and the per-project cap are independent checks', () => {
    // Under the org cap but at the project cap still blocks, and vice versa
    // — being clear of one never exempts a create from the other.
    expect(checkDocCreateAllowed(1, 'free').ok).toBe(true);
    expect(checkProjectDocCreateAllowed(100, 'free').ok).toBe(false);
    expect(checkDocCreateAllowed(100, 'free').ok).toBe(false);
    expect(checkProjectDocCreateAllowed(1, 'free').ok).toBe(true);
  });

  it('version cap counts live blobs: free blocks at 100, team at 1000', () => {
    expect(checkVersionAppendAllowed(99, 'free').ok).toBe(true);
    const free = checkVersionAppendAllowed(100, 'free');
    expect(!free.ok && free.error).toEqual({ code: 'version_cap_exceeded', limit: 100 });
    expect(checkVersionAppendAllowed(999, 'team').ok).toBe(true);
    const team = checkVersionAppendAllowed(1_000, 'team');
    expect(!team.ok && team.error.code).toBe('version_cap_exceeded');
    expect(checkVersionAppendAllowed(1_000_000, 'enterprise').ok).toBe(true);
  });

  it('comment cap: free blocks at 100, paid tiers never', () => {
    expect(checkCommentAllowed(99, 'free').ok).toBe(true);
    const free = checkCommentAllowed(100, 'free');
    expect(!free.ok && free.error).toEqual({ code: 'comment_cap_exceeded', limit: 100 });
    expect(checkCommentAllowed(1_000_000, 'team').ok).toBe(true);
    expect(checkCommentAllowed(1_000_000, 'enterprise').ok).toBe(true);
  });
});

describe('checkGuestShareAllowed (Phase 18)', () => {
  it('free blocks every guest (0 ceiling, Phase 33 — solo tier), team the 26th, enterprise never', () => {
    const free = checkGuestShareAllowed(0, 'free');
    expect(!free.ok && free.error).toEqual({ code: 'guest_cap_exceeded', limit: 0 });
    expect(checkGuestShareAllowed(24, 'team').ok).toBe(true);
    const team = checkGuestShareAllowed(25, 'team');
    expect(!team.ok && team.error).toEqual({ code: 'guest_cap_exceeded', limit: 25 });
    expect(checkGuestShareAllowed(1_000_000, 'enterprise').ok).toBe(true);
  });
});

describe('clampGuestShareDays (Phase 18)', () => {
  it('clamps to the tier ceiling, leaves stricter requests alone', () => {
    expect(clampGuestShareDays(3, 'free')).toBe(3);
    expect(clampGuestShareDays(30, 'free')).toBe(7);
    expect(clampGuestShareDays(14, 'team')).toBe(14);
    expect(clampGuestShareDays(90, 'team')).toBe(30);
    // Enterprise has no day cap — the request stands.
    expect(clampGuestShareDays(365, 'enterprise')).toBe(365);
  });
});

describe('TIER_PROFILES', () => {
  it('guest ceilings match the locked capability matrix (Phase 33: free is solo, 0 guests)', () => {
    expect(TIER_PROFILES.free.ceilings.maxExternalGuests).toBe(0);
    expect(TIER_PROFILES.free.ceilings.maxGuestShareDays).toBe(7);
    expect(TIER_PROFILES.team.ceilings.maxExternalGuests).toBe(25);
    expect(TIER_PROFILES.team.ceilings.maxGuestShareDays).toBe(30);
    expect(TIER_PROFILES.enterprise.ceilings.maxExternalGuests).toBeNull();
    expect(TIER_PROFILES.enterprise.ceilings.maxGuestShareDays).toBeNull();
  });

  it('collaborator ceilings: free is solo (1 = owner only), team/enterprise unlimited (Phase 33)', () => {
    expect(TIER_PROFILES.free.ceilings.maxCollaborators).toBe(1);
    expect(TIER_PROFILES.team.ceilings.maxCollaborators).toBeNull();
    expect(TIER_PROFILES.enterprise.ceilings.maxCollaborators).toBeNull();
  });

  it('doc ceilings (org and per-project) are set per tier (Phase 33)', () => {
    expect(TIER_PROFILES.free.ceilings.maxActiveDocs).toBe(100);
    expect(TIER_PROFILES.free.ceilings.maxActiveDocsPerProject).toBe(100);
    expect(TIER_PROFILES.team.ceilings.maxActiveDocs).toBe(5_000);
    expect(TIER_PROFILES.team.ceilings.maxActiveDocsPerProject).toBe(500);
    expect(TIER_PROFILES.enterprise.ceilings.maxActiveDocs).toBeNull();
    expect(TIER_PROFILES.enterprise.ceilings.maxActiveDocsPerProject).toBeNull();
  });

  it('free defaults equal the free ceiling', () => {
    expect(TIER_PROFILES.free.defaultVersionRetention).toEqual({ keepLastN: 20, keepDays: 90 });
  });

  it('team and enterprise defaults differ but share a ceiling (2026-08-13)', () => {
    expect(TIER_PROFILES.team.defaultVersionRetention).toEqual({ keepLastN: 50, keepDays: 90 });
    expect(TIER_PROFILES.enterprise.defaultVersionRetention).toEqual({
      keepLastN: 100,
      keepDays: 180,
    });
    expect(TIER_PROFILES.team.ceilings.versionKeepLastNMax).toBe(250);
    expect(TIER_PROFILES.team.ceilings.versionKeepDaysMax).toBe(365);
    expect(TIER_PROFILES.enterprise.ceilings.versionKeepLastNMax).toBe(250);
    expect(TIER_PROFILES.enterprise.ceilings.versionKeepDaysMax).toBe(365);
  });

  it('rate limits — minute/day/month, retuned for the unified budget (2026-08-11)', () => {
    expect(TIER_PROFILES.free.ceilings.rateLimit).toEqual({
      requestsPerMinute: 60,
      requestsPerDay: 2_500,
      requestsPerMonth: 7_500,
    });
    expect(TIER_PROFILES.team.ceilings.rateLimit).toEqual({
      requestsPerMinute: 600,
      requestsPerDay: 5_000,
      requestsPerMonth: 15_000,
    });
    // Enterprise inherits Team's rate limits outright until a contract
    // negotiates otherwise (matches the existing "unlimited with Team rate
    // limits" precedent for every other un-configured enterprise ceiling).
    expect(TIER_PROFILES.enterprise.ceilings.rateLimit).toEqual(
      TIER_PROFILES.team.ceilings.rateLimit,
    );
  });

  it('day stays strictly below month at every tier — day/3, so day is a reachable circuit breaker, never dead weight', () => {
    for (const tier of ['free', 'team', 'enterprise'] as const) {
      const { requestsPerDay, requestsPerMonth } = TIER_PROFILES[tier].ceilings.rateLimit;
      expect(requestsPerDay).toBeLessThan(requestsPerMonth);
    }
  });
});
