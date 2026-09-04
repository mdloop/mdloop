import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { UserId } from '@mdloop/shared';
import { createTestRedis } from '../test-support/test-redis.js';
import type { TestRedis } from '../test-support/test-redis.js';
import { RedisRateLimiter } from './redis-rate-limiter.js';

const KEY_PREFIX = 'mdloop:rate_limit:';

/**
 * Proves the WATCH/MULTI/EXEC CAS loop's core safety claim against a real
 * concurrent-write conflict — not just "two sequential calls both succeed."
 * A broken loop (e.g. GET-then-SET with no WATCH, or a naive INCR that
 * ignores `consumeRequest`'s refusal-also-persists rule) would let more
 * requests through than the seeded budget under concurrent load; this test
 * would catch that by counting `ok` results exactly, not approximately.
 */
describe('RedisRateLimiter — concurrent-write conflict resolution', () => {
  let redis: TestRedis;

  beforeAll(async () => {
    redis = await createTestRedis();
  });

  afterAll(async () => {
    await redis.close();
  });

  afterEach(async () => {
    await redis.client.flushdb();
  });

  it('exactly the seeded token budget is allowed under real concurrent contention, no double-consumption or lost update', async () => {
    const userId = 'contended-user' as UserId;
    const key = KEY_PREFIX + userId;
    const nowMs = Date.parse('2026-01-01T00:00:00Z');

    // Seed a tight budget directly (bypassing the limiter) so a frozen clock
    // means no per-request refill can muddy the count — the only way any of
    // these concurrent calls succeeds is by actually claiming one of the 5
    // seeded tokens through a correctly-serialized CAS cycle. Concurrency is
    // held at the connection pool's default size (10) so every caller gets
    // its own connection immediately rather than queueing behind another
    // caller's already-stale WATCH — that queueing (not CAS correctness) is
    // what pushes retry counts past MAX_CAS_RETRIES under heavier storms;
    // this test is about proving the CAS loop is correct under real
    // contention, not about characterizing the retry ceiling itself.
    await redis.client.set(
      key,
      JSON.stringify({
        tokens: 5,
        lastRefillMs: nowMs,
        dayCount: 0,
        dayStartMs: nowMs,
        monthCount: 0,
        monthStartMs: nowMs,
      }),
    );

    let casConflicts = 0;
    const limiter = new RedisRateLimiter(
      redis.client,
      () => nowMs,
      () => {
        casConflicts++;
      },
    );

    const results = await Promise.all(
      Array.from({ length: 10 }, () => limiter.check(userId, 'free')),
    );

    const allowedCount = results.filter((r) => r.ok).length;
    const deniedCount = results.filter((r) => !r.ok).length;

    expect(allowedCount).toBe(5);
    expect(deniedCount).toBe(5);
    // A genuine race actually happened and was resolved by retrying, not
    // avoided by accident (e.g. requests running serially despite `Promise.all`
    // due to the connection pool never actually parallelizing them) — without
    // this assertion, a regression that silently serialized every call (e.g.
    // a pool size of 1) would still pass the count assertions above and hide
    // the very thing this test exists to prove.
    expect(casConflicts).toBeGreaterThan(0);

    const finalState = await redis.client.get(key);
    expect(finalState).not.toBeNull();
    const parsed = JSON.parse(finalState ?? '{}') as { tokens: number };
    // All 5 tokens consumed, none double-spent, none leaked back.
    expect(parsed.tokens).toBeCloseTo(0, 1);
  });

  it('every concurrent request for a distinct user still succeeds — contention on one key never blocks another', async () => {
    const nowMs = Date.parse('2026-01-01T00:00:00Z');
    const limiter = new RedisRateLimiter(redis.client, () => nowMs);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => limiter.check(`user-${String(i)}` as UserId, 'free')),
    );

    expect(results.every((r) => r.ok)).toBe(true);
  });
});
