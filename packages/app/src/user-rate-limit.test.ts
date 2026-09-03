import { describe, expect, it } from 'vitest';
import type { UserId } from '@vorlyn/shared';
import { FakeOrganizationRepository, FakeWorld } from './test-support/fakes.js';
import {
  CachedSessionMaxResolver,
  CachedTierResolver,
  UserRateLimiter,
} from './user-rate-limit.js';

const u = (id: string): UserId => id as UserId;

describe('UserRateLimiter', () => {
  const t0 = Date.parse('2026-07-13T00:00:00Z');

  it('gives each user their own tier-sized budget', async () => {
    let now = t0;
    const limiter = new UserRateLimiter(() => now);
    for (let i = 0; i < 60; i++)
      expect((await limiter.check(u('free-user'), 'free')).ok).toBe(true);
    const blocked = await limiter.check(u('free-user'), 'free');
    expect(!blocked.ok && blocked.error).toEqual({
      code: 'rate_limited',
      retryAfterSeconds: expect.any(Number) as number,
    });
    // Another user is unaffected; a team user gets the bigger bucket.
    expect((await limiter.check(u('other-user'), 'free')).ok).toBe(true);
    for (let i = 0; i < 600; i++)
      expect((await limiter.check(u('team-user'), 'team')).ok).toBe(true);
    expect((await limiter.check(u('team-user'), 'team')).ok).toBe(false);
    // Budget refills with the clock.
    now += 2000;
    expect((await limiter.check(u('free-user'), 'free')).ok).toBe(true);
  });

  it('evicts fully-idle user state so the map stays bounded (Phase 24.F)', async () => {
    let now = t0;
    const limiter = new UserRateLimiter(() => now);
    // Three users seen; the first check also runs an empty sweep. Observed
    // via the test-only `debugStateCount()` accessor rather than a private-
    // field cast, so the assertion survives the RateLimiterPort abstraction.
    await limiter.check(u('a'), 'free');
    await limiter.check(u('b'), 'free');
    await limiter.check(u('c'), 'free');
    expect(limiter.debugStateCount()).toBe(3);

    // 25h later a fresh request triggers a sweep: the three idle entries (whose
    // budget has fully refilled and whose day window has rolled) are dropped,
    // leaving only the just-seen user. Eviction is lossless — a returning user
    // rebuilds the identical fresh state on their next request.
    now = t0 + 25 * 60 * 60 * 1000;
    await limiter.check(u('d'), 'free');
    expect(limiter.debugStateCount()).toBe(1);
  });
});

describe('CachedTierResolver', () => {
  it('caches the tier per org for the TTL, then re-reads', async () => {
    const world = new FakeWorld();
    const org = world.org({ tier: 'free' });
    const orgs = new FakeOrganizationRepository(world);
    let now = 0;
    const resolver = new CachedTierResolver(orgs, 60_000, () => now);
    const ctx = { orgId: org.id, userId: u('u1') };

    expect(await resolver.resolve(ctx)).toBe('free');
    world.orgs.set(org.id, { ...org, tier: 'team' });
    // Within TTL: stale value served.
    now = 59_000;
    expect(await resolver.resolve(ctx)).toBe('free');
    // Past TTL: fresh read.
    now = 61_000;
    expect(await resolver.resolve(ctx)).toBe('team');
  });

  it('returns undefined for an unknown org and does not cache it', async () => {
    const world = new FakeWorld();
    const orgs = new FakeOrganizationRepository(world);
    const resolver = new CachedTierResolver(orgs, 60_000, () => 0);
    const ctx = { orgId: 'ghost' as never, userId: u('u1') };
    expect(await resolver.resolve(ctx)).toBeUndefined();
  });

  it('sweeps expired cache entries so the map stays bounded (Phase 24.F)', async () => {
    const world = new FakeWorld();
    const a = world.org({ tier: 'free' });
    const b = world.org({ tier: 'team' });
    const orgs = new FakeOrganizationRepository(world);
    let now = 0;
    const resolver = new CachedTierResolver(orgs, 60_000, () => now);
    const cache = (resolver as unknown as { cache: Map<string, unknown> }).cache;
    await resolver.resolve({ orgId: a.id, userId: u('u1') });
    await resolver.resolve({ orgId: b.id, userId: u('u2') });
    expect(cache.size).toBe(2);

    // Past the sweep interval, both entries are also past their TTL; resolving a
    // third org triggers the sweep and drops the two stale rows.
    now = 2 * 60 * 60 * 1000;
    const c = world.org({ tier: 'free' });
    await resolver.resolve({ orgId: c.id, userId: u('u3') });
    expect(cache.size).toBe(1);
    expect([...cache.keys()]).toEqual([c.id]);
  });
});

describe('CachedSessionMaxResolver', () => {
  it('caches the org session max for the TTL, then re-reads', async () => {
    const world = new FakeWorld();
    const org = world.org({ sessionMaxHours: null });
    const orgs = new FakeOrganizationRepository(world);
    let now = 0;
    const resolver = new CachedSessionMaxResolver(orgs, 30_000, () => now);
    const ctx = { orgId: org.id, userId: u('u1') };

    expect(await resolver.resolve(ctx)).toBeNull();
    world.orgs.set(org.id, { ...org, sessionMaxHours: 4 });
    // Within TTL: stale value served.
    now = 29_000;
    expect(await resolver.resolve(ctx)).toBeNull();
    // Past TTL: fresh read.
    now = 31_000;
    expect(await resolver.resolve(ctx)).toBe(4);
  });

  it('resolves an unknown org to null (global default), never widening', async () => {
    const world = new FakeWorld();
    const orgs = new FakeOrganizationRepository(world);
    const resolver = new CachedSessionMaxResolver(orgs, 30_000, () => 0);
    const ctx = { orgId: 'ghost' as never, userId: u('u1') };
    expect(await resolver.resolve(ctx)).toBeNull();
  });
});
