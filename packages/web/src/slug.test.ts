import { describe, expect, it } from 'vitest';
import { slugify } from './slug.js';

describe('slugify', () => {
  it('lowercases and hyphenates punctuation/whitespace', () => {
    expect(slugify('Q3 Roadmap: Draft!!')).toBe('q3-roadmap-draft');
  });

  it('strips accents rather than dropping the whole word', () => {
    expect(slugify('Café notes')).toBe('cafe-notes');
  });

  it('trims leading/trailing hyphens produced by symbols at the edges', () => {
    expect(slugify('  --Launch Plan--  ')).toBe('launch-plan');
  });

  it('falls back to a placeholder for a title with no sluggable characters', () => {
    expect(slugify('   ')).toBe('document');
    expect(slugify('★★★')).toBe('document');
  });

  it('caps length so an extremely long title stays a reasonable URL segment', () => {
    const long = 'word '.repeat(40);
    const slug = slugify(long);
    expect(slug.length).toBeLessThanOrEqual(60);
  });
});
