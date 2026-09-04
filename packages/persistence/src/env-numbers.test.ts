import { describe, expect, it } from 'vitest';
import { positiveIntFromEnv } from './env-numbers.js';

describe('positiveIntFromEnv', () => {
  it('returns the fallback when unset', () => {
    expect(positiveIntFromEnv(undefined, 42, 'SOME_VAR')).toBe(42);
  });

  it('returns the fallback when set to an empty string', () => {
    expect(positiveIntFromEnv('', 42, 'SOME_VAR')).toBe(42);
  });

  it('parses a valid positive integer string', () => {
    expect(positiveIntFromEnv('7', 42, 'SOME_VAR')).toBe(7);
  });

  it('throws naming the var on a non-numeric value', () => {
    expect(() => positiveIntFromEnv('nope', 42, 'SOME_VAR')).toThrow(/SOME_VAR/);
  });

  it('throws naming the var on zero', () => {
    expect(() => positiveIntFromEnv('0', 42, 'SOME_VAR')).toThrow(/SOME_VAR/);
  });

  it('throws naming the var on a negative value', () => {
    expect(() => positiveIntFromEnv('-5', 42, 'SOME_VAR')).toThrow(/SOME_VAR/);
  });

  it('throws naming the var on a non-integer value', () => {
    expect(() => positiveIntFromEnv('3.5', 42, 'SOME_VAR')).toThrow(/SOME_VAR/);
  });
});
