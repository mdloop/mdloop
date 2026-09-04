/**
 * Aligns a rendered leaf's text against its own tagged raw-source slice.
 *
 * `capture.ts` (`resolveSourceOffset`) and `highlight.ts` (`resolveStructural`)
 * both need to map an offset inside a rendered DOM leaf's text to the
 * corresponding raw-source offset, and back. The naive approach —
 * `sourceSlice.indexOf(leafText)` plus a straight 1:1 character
 * correspondence for everything after the match — breaks for a wrapped
 * (multi-line) list item: CommonMark strips the continuation-line
 * indentation (spaces aligned to the list marker width) from the *parsed*
 * text value, but `position.offset` (what `source-offsets.ts` tags
 * `data-src-start`/`data-src-end` with) still points at the *raw* source,
 * indentation included. Mid-leaf, the source has extra space characters
 * right after a `\n` that the rendered text doesn't — `indexOf` either
 * fails outright or, worse, everything after the wrap point silently
 * misaligns.
 *
 * `alignLeaf` is a strict generalization of the old `indexOf`: it walks
 * both strings in parallel from a candidate start (same "first occurrence"
 * semantics `indexOf` had), and additionally tolerates skipping a
 * source-side space that's part of a stripped continuation-line indent run.
 * With no such indentation to skip, it finds the same first exact match at
 * the same position `indexOf` would have.
 *
 * The same skip covers blockquote continuation markers for the identical
 * reason: `> ` at the start of a wrapped blockquote/callout line (including
 * nested `> > `) is stripped from the *parsed* text value by the same
 * container-marker mechanism as list indentation, but `position.offset`
 * again still points at the raw source, marker included. Both cases are one
 * class of problem — "characters right after `\n` that a container stripped
 * from the value but not from the tracked position" — so both are skippable.
 */

export interface LeafAlignment {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  sourceOffsetAt(renderedOffset: number): number;
  renderedOffsetAt(sourceOffset: number): number;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * True when `sourceSlice[si]` is a space or `>` that belongs to a stripped
 * continuation-line prefix run: a run of consecutive spaces and/or `>`
 * characters immediately preceded by a `\n`. Spaces cover list-item
 * indentation; `>` covers blockquote/callout markers (nested quotes stack
 * as `> > `, hence allowing both characters anywhere in the run rather than
 * a fixed pattern). Scans back through the whole run — indentation can be
 * more than one space wide (ordered-list markers, nested lists) — rather
 * than only checking the single preceding character.
 */
function isStrippableLinePrefixChar(sourceSlice: string, si: number): boolean {
  const c = sourceSlice[si];
  if (c !== ' ' && c !== '>') return false;
  let start = si;
  while (start > 0 && (sourceSlice[start - 1] === ' ' || sourceSlice[start - 1] === '>')) start--;
  return sourceSlice[start - 1] === '\n';
}

/**
 * Walks `sourceSlice` and `leafText` in parallel from `start`, tolerating
 * indent-run skips on the source side. Returns the per-rendered-character
 * source offsets on success (`leafToSource[k]` = source offset after
 * consuming `k` rendered characters, `leafToSource[0] = start`), or
 * `undefined` if a non-indent-run mismatch is hit before `leafText` is
 * fully consumed.
 */
function tryAlignFrom(sourceSlice: string, leafText: string, start: number): number[] | undefined {
  const leafToSource: number[] = [start];
  let si = start;
  let li = 0;
  while (li < leafText.length) {
    if (sourceSlice[si] === leafText[li]) {
      si++;
      li++;
      leafToSource.push(si);
      continue;
    }
    if (isStrippableLinePrefixChar(sourceSlice, si)) {
      si++;
      continue;
    }
    return undefined;
  }
  return leafToSource;
}

export function alignLeaf(sourceSlice: string, leafText: string): LeafAlignment | undefined {
  if (leafText.length === 0) {
    // Mirrors `''.indexOf('')` semantics: an empty needle "matches" at 0.
    return {
      sourceStart: 0,
      sourceEnd: 0,
      sourceOffsetAt: () => 0,
      renderedOffsetAt: () => 0,
    };
  }

  const first = leafText[0];
  for (let start = 0; start < sourceSlice.length; start++) {
    if (sourceSlice[start] !== first) continue;
    const leafToSource = tryAlignFrom(sourceSlice, leafText, start);
    if (!leafToSource) continue;

    const sourceEnd = leafToSource[leafText.length];
    if (sourceEnd === undefined) continue;
    return {
      sourceStart: start,
      sourceEnd,
      sourceOffsetAt(renderedOffset: number): number {
        const k = clamp(renderedOffset, 0, leafText.length);
        // `k` is always in bounds ([0, leafText.length]); the fallback only
        // satisfies noUncheckedIndexedAccess, it's never actually taken.
        return leafToSource[k] ?? sourceEnd;
      },
      renderedOffsetAt(sourceOffset: number): number {
        for (let k = 0; k < leafToSource.length; k++) {
          const value = leafToSource[k];
          if (value !== undefined && value >= sourceOffset) return k;
        }
        return leafToSource.length - 1;
      },
    };
  }
  return undefined;
}
