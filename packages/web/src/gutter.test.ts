import { describe, expect, it } from 'vitest';
import { gutterSegments } from './gutter.js';
import { parseOutline } from './outline.js';

describe('gutterSegments', () => {
  it('returns no segments for an empty source', () => {
    expect(gutterSegments([], [], 0)).toEqual([]);
  });

  it('maps section bounds to fractions of source length', () => {
    const source = '# A\nfirst\n\n# B\nsecond\n';
    const outline = parseOutline(source);
    const segments = gutterSegments(outline, [0, 0], source.length);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.topFraction).toBe(0);
    expect(segments[1]?.topFraction).toBeCloseTo(outline[1]!.start / source.length);
    // Segments tile the whole source: last one reaches the end (fraction 1).
    const last = segments.at(-1)!;
    expect(last.topFraction + last.heightFraction).toBeCloseTo(1);
  });

  it('opacity is 0 with no open comments and scales up to the cap', () => {
    const source = '# A\nx\n\n# B\ny\n\n# C\nz\n';
    const outline = parseOutline(source);
    const segments = gutterSegments(outline, [0, 2, 9], source.length);
    expect(segments[0]?.opacity).toBe(0);
    expect(segments[1]?.opacity).toBeCloseTo(0.5);
    // Counts above the cap saturate at full opacity rather than exceeding 1.
    expect(segments[2]?.opacity).toBe(1);
  });

  it('missing counts (fewer entries than sections) default to zero opacity', () => {
    const source = '# A\nx\n\n# B\ny\n';
    const outline = parseOutline(source);
    const segments = gutterSegments(outline, [3], source.length);
    expect(segments[1]?.opacity).toBe(0);
  });
});
