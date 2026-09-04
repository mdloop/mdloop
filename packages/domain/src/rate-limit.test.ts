import { describe, expect, it } from 'vitest';
import { TIER_PROFILES } from './tier.js';
import type { RateLimitState } from './rate-limit.js';
import { consumeRequest, initialRateLimitState } from './rate-limit.js';

const free = TIER_PROFILES.free.ceilings.rateLimit; // 60/min, 2500/day, 7500/mo
const team = TIER_PROFILES.team.ceilings.rateLimit; // 600/min, 5000/day, 15000/mo

function drain(state: RateLimitState, n: number, nowMs: number) {
  let s = state;
  for (let i = 0; i < n; i++) {
    const d = consumeRequest(s, free, nowMs);
    if (!d.allowed) throw new Error(`unexpectedly blocked at ${String(i)}`);
    s = d.state;
  }
  return s;
}

describe('consumeRequest', () => {
  const t0 = Date.parse('2026-07-13T00:00:00Z');

  it('allows a full burst up to the per-minute budget, then 429s with honest retry', () => {
    const s = drain(initialRateLimitState(free, t0), 60, t0);
    const blocked = consumeRequest(s, free, t0);
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed) return;
    expect(blocked.retryAfterSeconds).toBe(1);
  });

  it('refills continuously: one token back per second on the free tier', () => {
    const s = drain(initialRateLimitState(free, t0), 60, t0);
    const after1s = consumeRequest(s, free, t0 + 1000);
    expect(after1s.allowed).toBe(true);
    const again = consumeRequest(after1s.allowed ? after1s.state : s, free, t0 + 1000);
    expect(again.allowed).toBe(false);
  });

  it('never refills above the bucket capacity', () => {
    const s = initialRateLimitState(free, t0);
    const later = consumeRequest(s, free, t0 + 3_600_000);
    expect(later.allowed && later.state.tokens).toBe(59);
  });

  it('enforces the daily cap with retry pointing at the window roll', () => {
    // Fabricate a state at the daily limit with a full minute bucket.
    const s: RateLimitState = {
      tokens: 60,
      lastRefillMs: t0,
      dayCount: 2500,
      dayStartMs: t0,
      monthCount: 2500,
      monthStartMs: t0,
    };
    const blocked = consumeRequest(s, free, t0 + 1000);
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed) return;
    expect(blocked.retryAfterSeconds).toBe(24 * 3600 - 1);
  });

  it('resets the daily count when the window rolls', () => {
    const s: RateLimitState = {
      tokens: 60,
      lastRefillMs: t0,
      dayCount: 2500,
      dayStartMs: t0,
      monthCount: 2500,
      monthStartMs: t0,
    };
    const nextDay = consumeRequest(s, free, t0 + 24 * 3600 * 1000);
    expect(nextDay.allowed).toBe(true);
    expect(nextDay.allowed && nextDay.state.dayCount).toBe(1);
    // The month window hasn't rolled yet — its count keeps accumulating.
    expect(nextDay.allowed && nextDay.state.monthCount).toBe(2501);
  });

  it('enforces the monthly cap even with the day and minute budgets fresh', () => {
    // A user who was active earlier in the month, went quiet, then resumed:
    // day and minute are both fully rested, but month is exhausted.
    const s: RateLimitState = {
      tokens: 60,
      lastRefillMs: t0,
      dayCount: 0,
      dayStartMs: t0,
      monthCount: 7500,
      monthStartMs: t0,
    };
    const blocked = consumeRequest(s, free, t0 + 1000);
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed) return;
    expect(blocked.retryAfterSeconds).toBe(30 * 24 * 3600 - 1);
  });

  it('resets the monthly count when the 30-day window rolls', () => {
    const s: RateLimitState = {
      tokens: 60,
      lastRefillMs: t0,
      dayCount: 0,
      dayStartMs: t0,
      monthCount: 7500,
      monthStartMs: t0,
    };
    const nextMonth = consumeRequest(s, free, t0 + 30 * 24 * 3600 * 1000);
    expect(nextMonth.allowed).toBe(true);
    expect(nextMonth.allowed && nextMonth.state.monthCount).toBe(1);
  });

  it('day is retuned to stay reachable, not vestigial, now that month exists', () => {
    // Free: day=2500, month=7500 (day = month/3). A single day at the day
    // cap should still fire on its own, with month still well short of its
    // own threshold — proves day isn't dead weight once month is the
    // tighter, cumulative cap.
    const s: RateLimitState = {
      tokens: 60,
      lastRefillMs: t0,
      dayCount: 2500,
      dayStartMs: t0,
      monthCount: 2500, // well under the 7500 month cap
      monthStartMs: t0,
    };
    const blocked = consumeRequest(s, free, t0 + 1000);
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed) return;
    // Fired on the day window (retry < 24h), not the month window (which
    // would report a retry approaching 30 days).
    expect(blocked.retryAfterSeconds).toBeLessThan(24 * 3600);
  });

  it('team tier sustains 10x the free burst', () => {
    let s: RateLimitState = initialRateLimitState(team, t0);
    for (let i = 0; i < 600; i++) {
      const d = consumeRequest(s, team, t0);
      expect(d.allowed).toBe(true);
      if (d.allowed) s = d.state;
    }
    expect(consumeRequest(s, team, t0).allowed).toBe(false);
  });
});
