import type { RateLimitState, Tier } from '@vorlyn/domain';
import { TIER_PROFILES, consumeRequest, initialRateLimitState } from '@vorlyn/domain';
import type { Result, UserId } from '@vorlyn/shared';
import { err, ok } from '@vorlyn/shared';
import type { RateLimiterPort, RateLimitError } from './ports/rate-limiter.port.js';
import type { TenantContext } from './tenant-context.js';
import type { OrganizationRepository } from './use-cases/org-settings.js';

/** How often the in-process maps are swept for evictable entries (Phase 24.F). */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * A rate-limit state is fully idle — and reconstructs identically from
 * `initialRateLimitState` — once its token bucket has certainly refilled to
 * the cap AND its daily window has certainly rolled. 24h of inactivity clears
 * both, so dropping the entry then is lossless: the next request rebuilds the
 * same fresh state. Bounds `states` by *active* users, not every user the
 * process has ever seen.
 */
const RATE_LIMIT_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Time-gated sweep: runs the pruner at most once per SWEEP_INTERVAL_MS, so the
 * hot path stays O(1) amortized and the map walk is rare. `nextSweep[0]` is the
 * caller's mutable next-run timestamp.
 */
function maybeSweep(nextSweep: [number], nowMs: number, prune: () => void): void {
  if (nowMs < nextSweep[0]) return;
  nextSweep[0] = nowMs + SWEEP_INTERVAL_MS;
  prune();
}

/**
 * Per-user tier-aware request budgets (`RateLimitProfile`, tier.ts): shared by
 * the HTTP API and the MCP server so agents and browsers draw from the same
 * budget — agents act as their owning user. State is in-process (single-node
 * MVP); `RedisRateLimiter` (`packages/persistence`) moves the state to a
 * shared store behind the same `RateLimiterPort` interface for a multi-node
 * deployment. `check` is `async` to satisfy
 * that shared interface even though this implementation has no I/O — the
 * body is fully synchronous under the hood. Idle entries are evicted
 * opportunistically (Phase 24.F) so the map stays bounded by active users
 * over a long-lived process.
 */
export class UserRateLimiter implements RateLimiterPort {
  private readonly states = new Map<UserId, RateLimitState>();
  private readonly nextSweep: [number] = [0];

  constructor(private readonly clock: () => number = Date.now) {}

  // Not declared `async` (no `await` in the body — nothing to await, zero
  // I/O) so `@typescript-eslint/require-await` stays enabled/meaningful for
  // this file; `Promise.resolve(...)` alone satisfies `RateLimiterPort`'s
  // async signature.
  check(userId: UserId, tier: Tier): Promise<Result<void, RateLimitError>> {
    const profile = TIER_PROFILES[tier].ceilings.rateLimit;
    const nowMs = this.clock();
    maybeSweep(this.nextSweep, nowMs, () => {
      for (const [id, state] of this.states) {
        if (nowMs - state.lastRefillMs >= RATE_LIMIT_IDLE_TTL_MS) this.states.delete(id);
      }
    });
    const state = this.states.get(userId) ?? initialRateLimitState(profile, nowMs);
    const decision = consumeRequest(state, profile, nowMs);
    this.states.set(userId, decision.state);
    if (!decision.allowed) {
      return Promise.resolve(
        err({ code: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds }),
      );
    }
    return Promise.resolve(ok(undefined));
  }

  /** Test-only: number of users currently tracked (eviction assertions). */
  debugStateCount(): number {
    return this.states.size;
  }
}

/**
 * Always-allow rate limiter (models `NoopTelemetry`): no real limiting at
 * all. Real production export for the self-host composition root
 * (`packages/api/src/selfhost-main.ts`) — self-host is single-instance/
 * single-org, so the per-user monthly-budget limiting `UserRateLimiter`
 * exists to protect a shared multi-tenant deployment from one noisy tenant
 * doesn't apply. `packages/app/src/test-support/fakes.ts` re-exports this same class
 * under its old name for existing test/harness imports (e.g. `e2e-main.ts`).
 */
export class UnlimitedRateLimiter implements RateLimiterPort {
  check(): Promise<Result<void, RateLimitError>> {
    return Promise.resolve(ok(undefined));
  }
}

/**
 * Org tier lookup with a short in-process cache, so the per-request rate
 * check doesn't add a DB read per request. 60s staleness after a tier change
 * is acceptable for limits enforcement. Expired entries for orgs that stop
 * being accessed are swept opportunistically (Phase 24.F).
 */
export class CachedTierResolver {
  private readonly cache = new Map<string, { tier: Tier; expiresAtMs: number }>();
  private readonly nextSweep: [number] = [0];

  constructor(
    private readonly orgs: OrganizationRepository,
    private readonly ttlMs = 60_000,
    private readonly clock: () => number = Date.now,
  ) {}

  async resolve(ctx: TenantContext): Promise<Tier | undefined> {
    const nowMs = this.clock();
    maybeSweep(this.nextSweep, nowMs, () => {
      for (const [key, entry] of this.cache) {
        if (entry.expiresAtMs <= nowMs) this.cache.delete(key);
      }
    });
    const hit = this.cache.get(ctx.orgId);
    if (hit && hit.expiresAtMs > nowMs) return hit.tier;
    const org = await this.orgs.current(ctx);
    if (!org) return undefined;
    this.cache.set(ctx.orgId, { tier: org.tier, expiresAtMs: nowMs + this.ttlMs });
    return org.tier;
  }
}

/**
 * Org session-max lookup with a short in-process cache (Phase 24), mirroring
 * `CachedTierResolver`: the session guard runs on every authed request and must
 * know the org's `sessionMaxHours` to enforce a shortened window, so the value
 * is cached (~30s) to avoid a DB read per request. A missing/absent org resolves
 * to `null` (the global default) — the guard never widens the window on a miss.
 * Expired entries are swept opportunistically (Phase 24.F).
 */
export class CachedSessionMaxResolver {
  private readonly cache = new Map<string, { maxHours: number | null; expiresAtMs: number }>();
  private readonly nextSweep: [number] = [0];

  constructor(
    private readonly orgs: OrganizationRepository,
    private readonly ttlMs = 30_000,
    private readonly clock: () => number = Date.now,
  ) {}

  async resolve(ctx: TenantContext): Promise<number | null> {
    const nowMs = this.clock();
    maybeSweep(this.nextSweep, nowMs, () => {
      for (const [key, entry] of this.cache) {
        if (entry.expiresAtMs <= nowMs) this.cache.delete(key);
      }
    });
    const hit = this.cache.get(ctx.orgId);
    if (hit && hit.expiresAtMs > nowMs) return hit.maxHours;
    const org = await this.orgs.current(ctx);
    const maxHours = org?.sessionMaxHours ?? null;
    this.cache.set(ctx.orgId, { maxHours, expiresAtMs: nowMs + this.ttlMs });
    return maxHours;
  }
}
