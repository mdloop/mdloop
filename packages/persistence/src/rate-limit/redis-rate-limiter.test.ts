import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { UserId } from '@vorlyn/shared';
import { createTestRedis } from '../test-support/test-redis.js';
import type { TestRedis } from '../test-support/test-redis.js';
import { RedisRateLimiter } from './redis-rate-limiter.js';

/**
 * Behavioral-parity contract test against real local Valkey (ADR 0010 —
 * externals are real or skipped, never mocked, matching `fs-storage.test.ts`'s
 * precedent for `StoragePort`). Single-caller correctness only — the
 * concurrency-specific CAS-conflict proof lives in
 * `redis-rate-limiter.integration.test.ts`.
 */
describe('RedisRateLimiter', () => {
  let redis: TestRedis;
  let limiter: RedisRateLimiter;
  let nowMs: number;

  beforeAll(async () => {
    redis = await createTestRedis();
  });

  afterAll(async () => {
    await redis.close();
  });

  afterEach(async () => {
    await redis.client.flushdb();
  });

  function freshLimiter(): void {
    nowMs = Date.parse('2026-01-01T00:00:00Z');
    limiter = new RedisRateLimiter(redis.client, () => nowMs);
  }

  it('allows requests within the tier budget', async () => {
    freshLimiter();
    const userId = 'user-a' as UserId;
    const result = await limiter.check(userId, 'free');
    expect(result.ok).toBe(true);
  });

  it('denies once the per-minute token bucket is exhausted, with a positive retry-after', async () => {
    freshLimiter();
    const userId = 'user-b' as UserId;
    // free tier: 60 requests/minute (packages/domain/src/tier.ts).
    for (let i = 0; i < 60; i++) {
      const result = await limiter.check(userId, 'free');
      expect(result.ok, `request ${String(i)} should be allowed`).toBe(true);
    }
    const denied = await limiter.check(userId, 'free');
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe('rate_limited');
      expect(denied.error.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('refills tokens as the clock advances, matching the in-process token-bucket math', async () => {
    freshLimiter();
    const userId = 'user-c' as UserId;
    for (let i = 0; i < 60; i++) await limiter.check(userId, 'free');
    const denied = await limiter.check(userId, 'free');
    expect(denied.ok).toBe(false);

    // One minute later, the bucket has fully refilled.
    nowMs += 60_000;
    const allowed = await limiter.check(userId, 'free');
    expect(allowed.ok).toBe(true);
  });

  it('enforces the daily cap independently of the per-minute bucket', async () => {
    freshLimiter();
    const userId = 'user-d' as UserId;
    // free tier: 2,500 requests/day (retuned in the rate-limiting redesign,
    // 2026-08-11, to stay reachable now that month exists — tier.ts). The
    // per-minute token-bucket math is already covered by the tests above and
    // exhaustively unit-tested in packages/domain/src/rate-limit.test.ts —
    // this test's only job is to prove the *storage layer* persists and
    // reads back `dayCount`/`dayStartMs` correctly, so it seeds the state
    // directly (same technique as the concurrency integration test) rather
    // than looping thousands of real round trips through the limiter, which
    // is both slow and, under parallel test-suite load, can blow past a
    // reasonable test timeout — the earlier version of this test did exactly
    // that. `monthCount` is seeded well under its own 7,500 ceiling so this
    // test isolates the daily window specifically.
    await redis.client.set(
      'vorlyn:rate_limit:' + userId,
      JSON.stringify({
        tokens: 60,
        lastRefillMs: nowMs,
        dayCount: 2_499,
        dayStartMs: nowMs,
        monthCount: 2_499,
        monthStartMs: nowMs,
      }),
    );
    const stillAllowed = await limiter.check(userId, 'free');
    expect(stillAllowed.ok, 'the 2,500th request of the day should still be allowed').toBe(true);

    const denied = await limiter.check(userId, 'free');
    expect(denied.ok, 'the 2,501st request of the day should be denied').toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('rate_limited');
  });

  it('enforces the monthly cap independently of the daily window', async () => {
    freshLimiter();
    const userId = 'user-f' as UserId;
    // free tier: 7,500 requests/month (new window, rate-limiting redesign,
    // 2026-08-11 — tier.ts). Same storage-layer-correctness rationale as the
    // daily test above, proving `monthCount`/`monthStartMs` round-trip
    // through Redis correctly too. `dayCount` is seeded well under its own
    // 2,500 ceiling (a fresh day) so this test isolates the monthly window.
    await redis.client.set(
      'vorlyn:rate_limit:' + userId,
      JSON.stringify({
        tokens: 60,
        lastRefillMs: nowMs,
        dayCount: 0,
        dayStartMs: nowMs,
        monthCount: 7_499,
        monthStartMs: nowMs,
      }),
    );
    const stillAllowed = await limiter.check(userId, 'free');
    expect(stillAllowed.ok, 'the 7,500th request of the month should still be allowed').toBe(true);

    const denied = await limiter.check(userId, 'free');
    expect(denied.ok, 'the 7,501st request of the month should be denied').toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('rate_limited');
  });

  it('keeps separate budgets per user', async () => {
    freshLimiter();
    const alice = 'alice' as UserId;
    const bob = 'bob' as UserId;
    for (let i = 0; i < 60; i++) await limiter.check(alice, 'free');
    const aliceDenied = await limiter.check(alice, 'free');
    const bobAllowed = await limiter.check(bob, 'free');
    expect(aliceDenied.ok).toBe(false);
    expect(bobAllowed.ok).toBe(true);
  });

  it('gives a team-tier user the team ceiling, not the free one', async () => {
    freshLimiter();
    const userId = 'user-e' as UserId;
    // team tier: 600 requests/minute — well past the free-tier 60 cap.
    for (let i = 0; i < 100; i++) {
      const result = await limiter.check(userId, 'team');
      expect(result.ok, `request ${String(i)} should be allowed`).toBe(true);
    }
  });
});
