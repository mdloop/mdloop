/** Comment-density gutter: a thin heat strip, one segment per outline section. */

import type { OutlineEntry } from './outline.js';

export interface GutterSegment {
  /** Top offset, as a fraction of source length. */
  topFraction: number;
  /** Segment height, as a fraction of source length. */
  heightFraction: number;
  /** 0 (no open comments) to 1 (at the cap or above) — pure signal, not a count. */
  opacity: number;
}

/** Comment counts at or above this saturate the strip to full opacity. */
const OPEN_COMMENT_CAP = 4;

export function gutterSegments(
  outline: OutlineEntry[],
  counts: number[],
  sourceLength: number,
): GutterSegment[] {
  if (sourceLength <= 0) return [];
  return outline.map((section, i) => {
    const count = counts[i] ?? 0;
    return {
      topFraction: section.start / sourceLength,
      heightFraction: Math.max(0, section.end - section.start) / sourceLength,
      opacity: count <= 0 ? 0 : Math.min(count, OPEN_COMMENT_CAP) / OPEN_COMMENT_CAP,
    };
  });
}
