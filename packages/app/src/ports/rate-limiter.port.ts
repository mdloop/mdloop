import type { Tier } from '@mdloop/domain';
import type { Result, UserId } from '@mdloop/shared';

/**
 * Identical typed error on HTTP (429 + Retry-After) and MCP — transports map
 * it, never reshape it. Lives on the port
 * (not `user-rate-limit.ts`) so `UserRateLimiter` can import it without a
 * dependency-cruiser `no-circular` violation (the port already needs to
 * name it in `check`'s signature).
 */
export interface RateLimitError {
  readonly code: 'rate_limited';
  readonly retryAfterSeconds: number;
}

/**
 * Per-user tier-aware request budget (`RateLimitProfile`, tier.ts): shared by
 * the HTTP API and the MCP server so agents and browsers draw from the same
 * budget — agents act as their owning user. Implementations: `UserRateLimiter`
 * (`packages/app/src/user-rate-limit.ts`) — in-process `Map`, the
 * single-node/dev/fallback default with zero I/O dependencies; `RedisRateLimiter`
 * (`packages/persistence/src/rate-limit/redis-rate-limiter.ts`) — ElastiCache/
 * Valkey-backed, correct per-user budgets across N replicas.
 */
export interface RateLimiterPort {
  check(userId: UserId, tier: Tier): Promise<Result<void, RateLimitError>>;
}
