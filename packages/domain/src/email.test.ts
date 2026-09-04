import { describe, expect, it } from 'vitest';
import { isDisposableEmail, isValidEmail } from './email.js';

describe('isDisposableEmail', () => {
  it('flags known burner domains, case-insensitive', () => {
    expect(isDisposableEmail('x@mailinator.com')).toBe(true);
    expect(isDisposableEmail('x@Yopmail.COM')).toBe(true);
  });

  it('passes normal domains and garbage input', () => {
    expect(isDisposableEmail('x@gmail.com')).toBe(false);
    expect(isDisposableEmail('not-an-email')).toBe(false);
  });
});

describe('isValidEmail', () => {
  it('accepts plausible addresses and rejects malformed ones', () => {
    expect(isValidEmail('client@acme.co')).toBe(true);
    expect(isValidEmail('  a.b+tag@sub.example.com ')).toBe(true);
    expect(isValidEmail('no-at-sign')).toBe(false);
    expect(isValidEmail('no@domain')).toBe(false);
    expect(isValidEmail('two @spaces.com')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });
});
