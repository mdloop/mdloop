import type { RateLimitProfile } from './tier.js';

/**
 * Per-user request budget (`RateLimitProfile`, tier.ts): a continuously-refilling token
 * bucket enforces the per-minute rate; fixed windows (reset on first use
 * after expiry, not calendar-aligned) enforce the daily and monthly caps.
 * Pure math — callers own the state and the clock. Agents act as their
 * owning user, so an agent can never multiply a user's budget.
 *
 * Three independent, AND'd windows, deliberately not four or five — see
 * `RateLimitProfile`'s doc comment (tier.ts) for why hour/week don't exist
 * as enforcement here (dominated by day/month, would only add rejection
 * surface) and why month uses this same fixed-window approach rather than a
 * rolling one (this check runs on every request — no DB round-trip).
 */
export interface RateLimitState {
  readonly tokens: number;
  readonly lastRefillMs: number;
  readonly dayCount: number;
  readonly dayStartMs: number;
  readonly monthCount: number;
  readonly monthStartMs: number;
}

export type RateLimitDecision =
  | { readonly allowed: true; readonly state: RateLimitState }
  | { readonly allowed: false; readonly retryAfterSeconds: number; readonly state: RateLimitState };

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

export function initialRateLimitState(profile: RateLimitProfile, nowMs: number): RateLimitState {
  return {
    tokens: profile.requestsPerMinute,
    lastRefillMs: nowMs,
    dayCount: 0,
    dayStartMs: nowMs,
    monthCount: 0,
    monthStartMs: nowMs,
  };
}

/**
 * Takes one request from the budget. On refusal, `retryAfterSeconds` is the
 * honest wait: until the next token refills, or until the window (daily or
 * monthly, whichever rejected) rolls. Checked broadest-consequence first
 * (month, then day, then the per-minute bucket) — order only affects which
 * `retryAfterSeconds` a simultaneous multi-window breach reports, never
 * whether the request is allowed.
 */
export function consumeRequest(
  state: RateLimitState,
  profile: RateLimitProfile,
  nowMs: number,
): RateLimitDecision {
  const refillPerMs = profile.requestsPerMinute / MINUTE_MS;
  const tokens = Math.min(
    profile.requestsPerMinute,
    state.tokens + Math.max(0, nowMs - state.lastRefillMs) * refillPerMs,
  );
  const dayRolled = nowMs - state.dayStartMs >= DAY_MS;
  const dayCount = dayRolled ? 0 : state.dayCount;
  const dayStartMs = dayRolled ? nowMs : state.dayStartMs;
  const monthRolled = nowMs - state.monthStartMs >= MONTH_MS;
  const monthCount = monthRolled ? 0 : state.monthCount;
  const monthStartMs = monthRolled ? nowMs : state.monthStartMs;

  const carried = { tokens, lastRefillMs: nowMs, dayCount, dayStartMs, monthCount, monthStartMs };

  if (monthCount >= profile.requestsPerMonth) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((monthStartMs + MONTH_MS - nowMs) / 1000)),
      state: carried,
    };
  }
  if (dayCount >= profile.requestsPerDay) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((dayStartMs + DAY_MS - nowMs) / 1000)),
      state: carried,
    };
  }
  if (tokens < 1) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1000)),
      state: carried,
    };
  }
  return {
    allowed: true,
    state: {
      tokens: tokens - 1,
      lastRefillMs: nowMs,
      dayCount: dayCount + 1,
      dayStartMs,
      monthCount: monthCount + 1,
      monthStartMs,
    },
  };
}
