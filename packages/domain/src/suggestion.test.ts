import { describe, expect, it } from 'vitest';
import { MAX_PROPOSED_TEXT_LENGTH, spliceText } from './suggestion.js';

describe('spliceText', () => {
  const source = 'The quick brown fox.';

  it('replaces the located range with the proposed text', () => {
    // "quick" is [4, 9).
    expect(spliceText(source, 4, 9, 'slow')).toBe('The slow brown fox.');
  });

  it('deletes the range when the replacement is empty (a "remove this" suggestion)', () => {
    // "quick " is [4, 10).
    expect(spliceText(source, 4, 10, '')).toBe('The brown fox.');
  });

  it('inserts when the range is empty (start === end)', () => {
    // Insert before "fox".
    expect(spliceText(source, 16, 16, 'red ')).toBe('The quick brown red fox.');
  });

  it('replaces a leading range', () => {
    expect(spliceText(source, 0, 3, 'A')).toBe('A quick brown fox.');
  });

  it('replaces a trailing range', () => {
    expect(spliceText(source, 16, source.length, 'cat!')).toBe('The quick brown cat!');
  });

  it('is a no-op when the replacement equals the existing range text', () => {
    expect(spliceText(source, 4, 9, 'quick')).toBe(source);
  });

  it('exposes a proposed-text length cap that mirrors the DB check', () => {
    expect(MAX_PROPOSED_TEXT_LENGTH).toBe(20_000);
  });
});
