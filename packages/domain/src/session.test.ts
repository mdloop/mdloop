import { describe, expect, it } from 'vitest';
import {
  GLOBAL_SESSION_MAX_HOURS,
  GLOBAL_SESSION_MAX_MS,
  effectiveSessionExpiry,
  isValidSessionMaxHours,
} from './session.js';

const HOUR = 60 * 60 * 1000;

describe('isValidSessionMaxHours', () => {
  it('accepts integers 1..24', () => {
    expect(isValidSessionMaxHours(1)).toBe(true);
    expect(isValidSessionMaxHours(12)).toBe(true);
    expect(isValidSessionMaxHours(GLOBAL_SESSION_MAX_HOURS)).toBe(true);
  });

  it('rejects 0, >24, negatives, and non-integers', () => {
    expect(isValidSessionMaxHours(0)).toBe(false);
    expect(isValidSessionMaxHours(25)).toBe(false);
    expect(isValidSessionMaxHours(-3)).toBe(false);
    expect(isValidSessionMaxHours(1.5)).toBe(false);
    expect(isValidSessionMaxHours(Number.NaN)).toBe(false);
  });
});

describe('effectiveSessionExpiry', () => {
  const iat = 1_000_000;

  it('uses the global default when the org sets no max', () => {
    const exp = iat + GLOBAL_SESSION_MAX_MS;
    expect(effectiveSessionExpiry(iat, exp, null)).toBe(iat + GLOBAL_SESSION_MAX_MS);
  });

  it('tightens to the org max when it is shorter than the token ceiling', () => {
    const exp = iat + GLOBAL_SESSION_MAX_MS;
    expect(effectiveSessionExpiry(iat, exp, 2)).toBe(iat + 2 * HOUR);
  });

  it('never lengthens past the absolute exp (guest grant cap wins)', () => {
    const grantCappedExp = iat + 1 * HOUR;
    // Org max is 8h but the token's own ceiling is 1h — the earlier wins.
    expect(effectiveSessionExpiry(iat, grantCappedExp, 8)).toBe(grantCappedExp);
  });
});
