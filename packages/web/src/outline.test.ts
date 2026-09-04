import { describe, expect, it } from 'vitest';
import { countBySection, parseOutline } from './outline.js';

const doc = [
  '# Title',
  'intro text',
  '```',
  '# not a heading (fenced)',
  '```',
  '## Section A',
  'body a',
  '### Sub A1',
  'body a1',
  '## Section B ##',
  'body b',
].join('\n');

describe('parseOutline', () => {
  it('finds headings with levels, skipping fenced code', () => {
    const outline = parseOutline(doc);
    expect(outline.map((e) => [e.level, e.text])).toEqual([
      [1, 'Title'],
      [2, 'Section A'],
      [3, 'Sub A1'],
      [2, 'Section B'],
    ]);
  });

  it('assigns contiguous section ranges ending at the next heading', () => {
    const outline = parseOutline(doc);
    for (let i = 0; i < outline.length - 1; i += 1) {
      expect(outline[i]?.end).toBe(outline[i + 1]?.start);
    }
    expect(outline.at(-1)?.end).toBe(doc.length);
  });

  it('indexes headings in render order for scroll targeting', () => {
    expect(parseOutline(doc).map((e) => e.index)).toEqual([0, 1, 2, 3]);
  });

  it('handles a document with no headings', () => {
    expect(parseOutline('just prose\nno headings')).toEqual([]);
  });
});

describe('countBySection', () => {
  it('buckets comment offsets into their sections, ignoring orphans', () => {
    const outline = parseOutline(doc);
    const sectionA = outline[1];
    const sectionB = outline[3];
    if (!sectionA || !sectionB) throw new Error('setup');
    const counts = countBySection(outline, [
      sectionA.start,
      sectionA.start + 1,
      sectionB.start,
      null,
    ]);
    expect(counts).toEqual([0, 2, 0, 1]);
  });
});
