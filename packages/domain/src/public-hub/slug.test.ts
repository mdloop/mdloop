import { describe, expect, it } from 'vitest';
import { normalizePublicSlug } from './slug.js';

describe('normalizePublicSlug', () => {
  it('returns null for an empty string', () => {
    expect(normalizePublicSlug('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(normalizePublicSlug('   ')).toBeNull();
  });

  it('returns null when every character is stripped as non-alphanumeric', () => {
    expect(normalizePublicSlug('!!!___...')).toBeNull();
  });

  it('leaves an already-clean slug untouched', () => {
    expect(normalizePublicSlug('onboarding-guide')).toBe('onboarding-guide');
  });

  it('lowercases uppercase input', () => {
    expect(normalizePublicSlug('Onboarding Guide')).toBe('onboarding-guide');
  });

  it('collapses runs of punctuation/whitespace into a single dash', () => {
    expect(normalizePublicSlug('Runbook: Deploy --- Rollback!!')).toBe('runbook-deploy-rollback');
  });

  it('strips leading and trailing punctuation', () => {
    expect(normalizePublicSlug('  -_-Hello World-_-  ')).toBe('hello-world');
  });

  it('treats non-ASCII letters as non-alphanumeric rather than crashing', () => {
    const result = normalizePublicSlug('Café Résumé 日本語');
    expect(result).not.toBeNull();
    expect(result).toMatch(/^[a-z0-9-]+$/);
    expect(result?.startsWith('-')).toBe(false);
    expect(result?.endsWith('-')).toBe(false);
  });

  it('caps length at 80 chars and never leaves a trailing dash from the cut', () => {
    const long = 'word-'.repeat(30); // 150 chars, all clean dashed words
    const result = normalizePublicSlug(long);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(80);
    expect(result?.endsWith('-')).toBe(false);
  });

  it('handles punctuation-heavy input mixed with real words', () => {
    expect(normalizePublicSlug('!!!Getting@@@Started###2026!!!')).toBe('getting-started-2026');
  });
});
