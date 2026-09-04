import type { Result } from '@mdloop/shared';
import { err, ok } from '@mdloop/shared';

/**
 * Tier machinery (ADR 0001). A tier is a ceiling profile;
 * org configuration is clamped to its tier's ceiling in this module — the
 * single code path for all tiers. `null` means unlimited.
 */
export type Tier = 'free' | 'team' | 'enterprise';

/**
 * Three independent, AND'd request-budget windows (rate-limiting redesign
 * 2026-08-11) — deliberately not four or five. Minute is
 * pure burst/hammering protection (event-loop and connection-pool health for
 * other tenants), orthogonal to cost, so it's never tuned against revenue.
 * Day and month both bound cost: day catches a single catastrophic day, month
 * is the one that actually protects margin (billing is monthly). Hour and
 * week are deliberately absent — both are mathematically dominated by the
 * windows on either side (hour by day, week by day×7 and month) and would
 * only add rejection surface without protecting anything minute+day+month
 * don't already cover. Hourly visibility is a CloudWatch metric/alarm
 * instead of a fourth blocking window — see `quota_rejected` in
 * telemetry-definitions.ts.
 */
export interface RateLimitProfile {
  /** Token-bucket refill per user per minute; agents act as their owning user. */
  readonly requestsPerMinute: number;
  /** Fixed 24h window, reset on first use after expiry — not calendar-aligned. */
  readonly requestsPerDay: number;
  /**
   * Fixed 30-day window, same reset pattern as `requestsPerDay` — deliberately
   * not a rolling window (would need a DB round-trip on every request; this
   * check runs on every single API/MCP call, so it stays pure in-memory
   * arithmetic like the day window it sits alongside). Sized to ~10% of
   * monthly seat revenue per paid tier — this is what bounds
   * a seat's worst-case monthly infra cost, replacing the old unbounded
   * day×30 exposure. Also now the sole velocity control on uploads: the
   * former separate `uploadsPerWeek`/`uploadsPerMonth` quota (`quota.ts`) is
   * retired — its job is covered by this general budget plus the standing
   * per-org/per-doc stock ceilings below, which cap the actual outcome
   * rather than a proxy velocity number.
   */
  readonly requestsPerMonth: number;
}

export interface TierCeilings {
  /** Active (non-deleted) documents per org. */
  readonly maxActiveDocs: number | null;
  /**
   * Active (non-deleted) documents per project — a separate, tighter-scoped
   * sibling of the org-wide cap; a project is the unit a human actually
   * browses (workspace tree, doc switcher), so this exists so one runaway
   * project can't make itself unbrowsable while the org still has headroom.
   */
  readonly maxActiveDocsPerProject: number | null;
  /** Live (non-tombstoned) version blobs per document — uploads block at the cap. */
  readonly maxLiveVersionsPerDoc: number | null;
  /** Comments per document; unlimited on paid tiers (abuse guard only). */
  readonly maxCommentsPerDoc: number | null;
  /** Collaborators incl. owner; free tier demos the loop, never runs a team. */
  readonly maxCollaborators: number | null;
  /** Version auto-purge ceilings: orgs may configure stricter, never looser. */
  readonly versionKeepLastNMax: number | null;
  readonly versionKeepDaysMax: number | null;
  /** Active external guests per org (Phase 18); `null` = unlimited (enterprise). */
  readonly maxExternalGuests: number | null;
  /** Ceiling on a guest share's lifetime in days (Phase 18); `null` = no cap. */
  readonly maxGuestShareDays: number | null;
  readonly rateLimit: RateLimitProfile;
}

/** Org-configurable version auto-purge rule (ADR 0001). `null` T = unlimited age. */
export interface VersionRetentionConfig {
  readonly keepLastN: number;
  readonly keepDays: number | null;
}

export interface TierProfile {
  readonly ceilings: TierCeilings;
  /** Product defaults applied until an org admin configures otherwise. */
  readonly defaultVersionRetention: VersionRetentionConfig;
}

export const TIER_PROFILES: Record<Tier, TierProfile> = {
  // Phase 33 (2026-08-10): Personal is solo by design — 1 collaborator (the
  // owner, nobody else can be invited) and 0 external guests, so it cannot
  // share a document with anyone in any form.
  free: {
    ceilings: {
      maxActiveDocs: 100,
      // A personal org is one project, so its project cap is the same number
      // as its org cap — the org cap already covers it, this exists only so
      // the field is never null-vs-set inconsistently across tiers.
      maxActiveDocsPerProject: 100,
      maxLiveVersionsPerDoc: 100,
      maxCommentsPerDoc: 100,
      maxCollaborators: 1,
      versionKeepLastNMax: 20,
      versionKeepDaysMax: 90,
      maxExternalGuests: 0,
      maxGuestShareDays: 7,
      // Day retuned from 5,000 (was independently set) to stay a genuine,
      // reachable circuit breaker now that month exists: once month <= day,
      // day is mathematically unreachable (month's cumulative counter always
      // crosses its lower threshold no later than day's), so day is pinned
      // to month/3 — comfortably above realistic heavy-day usage (a genuinely
      // active free user realistically runs a few hundred req/day) while
      // staying strictly below month. Month = ~$0.46/mo worst case at
      // $0.061/1k requests — a free user has $0 revenue, so
      // this is sized as a small, bounded acquisition-style cost ceiling
      // rather than a percentage of revenue.
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 2_500, requestsPerMonth: 7_500 },
    },
    defaultVersionRetention: { keepLastN: 20, keepDays: 90 },
  },
  team: {
    ceilings: {
      maxActiveDocs: 5_000,
      maxActiveDocsPerProject: 500,
      maxLiveVersionsPerDoc: 1_000,
      maxCommentsPerDoc: null,
      maxCollaborators: null,
      versionKeepLastNMax: 250,
      versionKeepDaysMax: 365,
      maxExternalGuests: 25,
      maxGuestShareDays: 30,
      // Day retuned from 100,000 (now unreachable/vestigial once month
      // exists) to month/3 = 5,000 — same reasoning as free, above. Month =
      // 15,000/mo is sized to ~9.2% of the $10/seat/mo revenue at
      // $0.061/1k requests, replacing the old unbounded
      // day x 30 exposure (~$183/seat/mo) with a ~$0.92/mo worst case.
      // Still 2.5-7x above a genuinely heavy realistic daily user
      // (200-600 req/day) so it should
      // essentially never bind for real usage — only for pathological or
      // abusive patterns.
      rateLimit: { requestsPerMinute: 600, requestsPerDay: 5_000, requestsPerMonth: 15_000 },
    },
    defaultVersionRetention: { keepLastN: 50, keepDays: 90 },
  },
  // Enterprise seat/doc/guest ceilings are contract-custom; until configured
  // they are unlimited with Team rate limits (ADR 0001). Rate limits (incl.
  // the new month window) deliberately inherit Team's numbers outright
  // rather than an enterprise-specific ratio, matching this existing
  // precedent — it also happens to land Enterprise at a *tighter* percentage
  // of its own $20/seat/mo revenue (~4.6%) than the ~10% target, the safe
  // direction to default in before a contract negotiates it up.
  //
  // Version-retention ceiling is the one exception to "unlimited until
  // configured": it's pinned to the same finite N=250 / T=365 as Team
  // (2026-08-13) rather than null, closing the unbounded-storage exposure
  // (an org on any tier could otherwise set
  // `keepDays: null` and ride `keepLastN` to its ceiling with zero cost
  // signal anywhere in the product — see `clampVersionRetention`'s doc
  // comment). Default is set higher than Team's (100/180 vs 50/90) so
  // Enterprise still reads as materially more generous day-to-day, even
  // though the hard ceiling is now shared. A per-contract override remains
  // unimplemented (ADR 0001) — tracked, not fixed here.
  enterprise: {
    ceilings: {
      maxActiveDocs: null,
      maxActiveDocsPerProject: null,
      maxLiveVersionsPerDoc: null,
      maxCommentsPerDoc: null,
      maxCollaborators: null,
      versionKeepLastNMax: 250,
      versionKeepDaysMax: 365,
      maxExternalGuests: null,
      maxGuestShareDays: null,
      rateLimit: { requestsPerMinute: 600, requestsPerDay: 5_000, requestsPerMonth: 15_000 },
    },
    defaultVersionRetention: { keepLastN: 100, keepDays: 180 },
  },
};

export function isTier(value: string): value is Tier {
  return value === 'free' || value === 'team' || value === 'enterprise';
}

/**
 * Clamps an org's version-retention config to its tier ceiling: stricter than
 * the ceiling stands, looser is pulled down. `keepDays: null` (unlimited age)
 * only survives where the ceiling itself is unlimited (`versionKeepDaysMax
 * === null`) — as of 2026-08-13 no `TIER_PROFILES` entry has an unlimited
 * version-retention ceiling, so in practice `keepDays: null` is always
 * clamped to a finite number and is never valid admin input today (see
 * `isValidVersionRetention` — it's structurally allowed, but this clamp
 * makes it always looser than any real ceiling). The branch stays generic
 * for a hypothetical future unlimited tier rather than special-cased away.
 */
export function clampVersionRetention(
  config: VersionRetentionConfig,
  tier: Tier,
): VersionRetentionConfig {
  const { versionKeepLastNMax, versionKeepDaysMax } = TIER_PROFILES[tier].ceilings;
  const keepLastN =
    versionKeepLastNMax === null
      ? config.keepLastN
      : Math.min(config.keepLastN, versionKeepLastNMax);
  const keepDays =
    versionKeepDaysMax === null
      ? config.keepDays
      : Math.min(config.keepDays ?? versionKeepDaysMax, versionKeepDaysMax);
  return { keepLastN, keepDays };
}

/**
 * Resolves the version-retention rule the purge worker runs with: the org's
 * config if set, else the tier default — always clamped to the tier ceiling
 * (so a tier downgrade re-clamps without touching stored config).
 */
export function effectiveVersionRetention(
  tier: Tier,
  orgConfig: VersionRetentionConfig | null,
): VersionRetentionConfig {
  return clampVersionRetention(orgConfig ?? TIER_PROFILES[tier].defaultVersionRetention, tier);
}

/** Valid admin input for version retention: N ≥ 1 integer, T ≥ 1 integer or null. */
export function isValidVersionRetention(config: VersionRetentionConfig): boolean {
  if (!Number.isInteger(config.keepLastN) || config.keepLastN < 1) return false;
  return config.keepDays === null || (Number.isInteger(config.keepDays) && config.keepDays >= 1);
}

export interface DocCapError {
  readonly code: 'doc_cap_exceeded';
  readonly limit: number;
}
export interface ProjectDocCapError {
  readonly code: 'project_doc_cap_exceeded';
  readonly limit: number;
}
export interface VersionCapError {
  readonly code: 'version_cap_exceeded';
  readonly limit: number;
}
export interface CommentCapError {
  readonly code: 'comment_cap_exceeded';
  readonly limit: number;
}
export type TierCapError = DocCapError | ProjectDocCapError | VersionCapError | CommentCapError;

/** One more active document allowed? Cap counts non-deleted docs in the org. */
export function checkDocCreateAllowed(
  activeDocCount: number,
  tier: Tier,
): Result<void, DocCapError> {
  const limit = TIER_PROFILES[tier].ceilings.maxActiveDocs;
  if (limit !== null && activeDocCount >= limit) return err({ code: 'doc_cap_exceeded', limit });
  return ok(undefined);
}

/**
 * One more active document allowed *in this project*? A separate, tighter-
 * scoped sibling of `checkDocCreateAllowed` (Phase 33) — a
 * project is the unit a human actually browses (workspace tree, doc
 * switcher), so this exists so one runaway project can't make itself
 * unbrowsable while the org still has headroom under its own cap. Both
 * checks are independent: being under one never exempts a create from the
 * other.
 */
export function checkProjectDocCreateAllowed(
  activeDocCountInProject: number,
  tier: Tier,
): Result<void, ProjectDocCapError> {
  const limit = TIER_PROFILES[tier].ceilings.maxActiveDocsPerProject;
  if (limit !== null && activeDocCountInProject >= limit) {
    return err({ code: 'project_doc_cap_exceeded', limit });
  }
  return ok(undefined);
}

/**
 * One more version allowed? Cap counts live blobs, not tombstones (ADR 0001) —
 * auto-purge frees headroom; the cap blocks uploads, it never prunes.
 */
export function checkVersionAppendAllowed(
  liveVersionCount: number,
  tier: Tier,
): Result<void, VersionCapError> {
  const limit = TIER_PROFILES[tier].ceilings.maxLiveVersionsPerDoc;
  if (limit !== null && liveVersionCount >= limit) {
    return err({ code: 'version_cap_exceeded', limit });
  }
  return ok(undefined);
}

/** One more comment allowed on a document? */
export function checkCommentAllowed(
  commentCount: number,
  tier: Tier,
): Result<void, CommentCapError> {
  const limit = commentCapLimit(tier);
  if (limit !== null && commentCount >= limit) return err({ code: 'comment_cap_exceeded', limit });
  return ok(undefined);
}

/**
 * The numeric per-document comment ceiling for a tier (`null` = unlimited).
 * Exposed so the persistence layer can enforce count-then-insert atomically
 * under an advisory lock (Phase 24) while the ceiling decision stays in the
 * domain — the cap value is policy, the atomic compare-and-insert is not.
 */
export function commentCapLimit(tier: Tier): number | null {
  return TIER_PROFILES[tier].ceilings.maxCommentsPerDoc;
}

/**
 * The org-wide distinct-active-guest ceiling for a tier (`null` = unlimited).
 * Exposed for the same reason as `commentCapLimit`: the persistence layer
 * enforces count-then-insert atomically under an advisory lock (Phase 24)
 * while the ceiling itself stays domain policy.
 */
export function guestCapLimit(tier: Tier): number | null {
  return TIER_PROFILES[tier].ceilings.maxExternalGuests;
}

export interface GuestCapError {
  readonly code: 'guest_cap_exceeded';
  readonly limit: number;
}

/**
 * One more distinct active external guest allowed in this org (Phase 18)?
 * `activeGuestCount` is the number of distinct active (non-revoked, unexpired)
 * guest emails already sharing a document in the org; re-sharing to an email
 * already active does not consume a new seat, so the caller only checks this
 * when introducing a brand-new guest email.
 */
export function checkGuestShareAllowed(
  activeGuestCount: number,
  tier: Tier,
): Result<void, GuestCapError> {
  const limit = TIER_PROFILES[tier].ceilings.maxExternalGuests;
  if (limit !== null && activeGuestCount >= limit) {
    return err({ code: 'guest_cap_exceeded', limit });
  }
  return ok(undefined);
}

/**
 * Clamps a requested guest-share lifetime (days) to the tier ceiling (Phase
 * 18). Mirrors version-retention clamping: stricter than the ceiling stands,
 * looser is pulled down; `null` ceiling (enterprise) means no cap. Never
 * errors — the shorter of requested and ceiling always wins.
 */
export function clampGuestShareDays(requestedDays: number, tier: Tier): number {
  const max = TIER_PROFILES[tier].ceilings.maxGuestShareDays;
  return max === null ? requestedDays : Math.min(requestedDays, max);
}
