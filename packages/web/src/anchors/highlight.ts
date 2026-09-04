/**
 * Wraps a stored anchor's source range in <mark> elements within the
 * currently rendered container. Anchors pin to one immutable document
 * version, and `sourceOffsetsPlugin` (markdown-view.tsx) tags every render
 * of that version's source with the same `data-src-start`/`data-src-end`
 * spans deterministically, so `spec.start`/`spec.end` (raw source offsets)
 * resolve directly against the current render — no text search needed, for
 * both old (pre-fix, rendered-text-equal) and new (markup-crossing) anchors
 * alike. Falls back to the legacy `container.textContent` + `nthIndexOf`
 * seed (inverse of capture.ts's verbatim-search fallback) when no tagged
 * leaf overlaps the anchor's range — defensive, shouldn't happen for any
 * render produced by the current markdown-view.tsx pipeline.
 */
import { alignLeaf } from './align.js';
import { textBefore } from './capture.js';

export interface HighlightSpec {
  commentId: string;
  /** Raw source text at [start, end) — may contain markdown syntax (bold
   *  delimiters, link brackets, ...). Used verbatim only by the legacy
   *  fallback path, where it's guaranteed rendered-text-equal. */
  exact: string;
  /** Occurrence of `exact` in the legacy verbatim-search sense; unused by
   *  the structural path. */
  occurrence: number;
  /** Anchor's raw source offsets — the structural path's primary input. */
  start: number;
  end: number;
  /** Mark class suffix. `orphan` is accepted for completeness (mirrors the
   *  full lane set viewer.tsx computes) but never actually reaches here in
   *  practice — the caller skips the whole spec when an anchor's resolved
   *  range is null, which is always true for an orphan resolution. */
  status: 'open' | 'replied' | 'resolved' | 'orphan' | 'accepted-pending';
}

interface TextPosition {
  node: Text;
  offset: number;
}

/** Resolves a global text offset within `container` to a (text node, offset). */
function positionAt(container: HTMLElement, target: number): TextPosition | undefined {
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const len = node.length;
    if (consumed + len >= target) return { node, offset: target - consumed };
    consumed += len;
  }
  return undefined;
}

function nthIndexOf(haystack: string, needle: string, n: number): number {
  let i = -1;
  for (let k = 0; k <= n; k++) {
    i = haystack.indexOf(needle, i + 1);
    if (i === -1) return -1;
  }
  return i;
}

interface TaggedLeaf {
  el: HTMLElement;
  start: number;
  end: number;
}

function taggedLeaves(container: HTMLElement): TaggedLeaf[] {
  return [...container.querySelectorAll<HTMLElement>('[data-src-start][data-src-end]')]
    .map((el) => ({ el, start: Number(el.dataset.srcStart), end: Number(el.dataset.srcEnd) }))
    .filter((l) => Number.isFinite(l.start) && Number.isFinite(l.end) && l.end > l.start);
}

interface StructuralSeed {
  /** Global offset into `container`'s SHOW_TEXT-walked text stream — the
   *  same space `positionAt`/`nextTextNode` (and markRun's traversal)
   *  operate in. */
  atGlobal: number;
  /** Rendered-text length to mark, starting at `atGlobal`. */
  length: number;
}

/**
 * Resolves an anchor's raw source range [start, end) to a starting global
 * text offset plus the rendered-text length to mark, using the
 * `data-src-*` spans `sourceOffsetsPlugin` tags onto the render.
 *
 * Both the start and end boundaries are resolved to (text node, offset)
 * pairs and then converted to `container`-wide global offsets via
 * `textBefore` — the *same* SHOW_TEXT-walked space `markRun` consumes
 * characters from. This matters because mdast-util-to-hast can leave an
 * untagged whitespace text node between block-level siblings (e.g. between
 * two `<p>` elements for a blank-line paragraph break); summing only the
 * tagged leaves' own overlap lengths would silently exclude that node's
 * characters, drifting `markRun`'s cursor out of alignment for any anchor
 * spanning more than one block. Measuring `atGlobal` at both ends and
 * subtracting keeps the two in the same coordinate space regardless of
 * what — tagged or not — sits between them.
 *
 * Fails closed (undefined) the moment any overlapping leaf's rendered text
 * can't be located in its own tagged source slice (entity refs, the
 * callout-marker-stripping edge case — see source-offsets.ts), mirroring
 * capture.ts's `resolveSourceOffset` — the caller falls back to the legacy
 * path for the whole spec rather than risk a partial/misaligned mark.
 */
function resolveStructural(
  container: HTMLElement,
  source: string,
  start: number,
  end: number,
): StructuralSeed | undefined {
  let startPosition: TextPosition | undefined;
  let endPosition: TextPosition | undefined;

  for (const leaf of taggedLeaves(container)) {
    if (leaf.end <= start || leaf.start >= end) continue; // no overlap
    const leafText = leaf.el.textContent;
    const sourceSlice = source.slice(leaf.start, leaf.end);
    const alignment = alignLeaf(sourceSlice, leafText);
    if (!alignment) return undefined;
    const effectiveStart = leaf.start + alignment.sourceStart;
    const effectiveEnd = leaf.start + alignment.sourceEnd;
    const overlapStart = Math.max(effectiveStart, start);
    const overlapEnd = Math.min(effectiveEnd, end);
    if (overlapEnd <= overlapStart) continue;

    if (!startPosition) {
      const seeded = positionAt(leaf.el, alignment.renderedOffsetAt(overlapStart - leaf.start));
      if (!seeded) return undefined;
      startPosition = seeded;
    }
    const seededEnd = positionAt(leaf.el, alignment.renderedOffsetAt(overlapEnd - leaf.start));
    if (!seededEnd) return undefined;
    endPosition = seededEnd;
  }

  if (!startPosition || !endPosition) return undefined;
  const atGlobal = textBefore(container, startPosition.node, startPosition.offset).length;
  const atGlobalEnd = textBefore(container, endPosition.node, endPosition.offset).length;
  const length = atGlobalEnd - atGlobal;
  return length > 0 ? { atGlobal, length } : undefined;
}

/**
 * Wraps `totalLength` rendered characters starting at `atGlobal` (a global
 * offset into `container`'s SHOW_TEXT-walked text stream) in <mark>
 * elements, one per intersected text node. Shared by both the structural
 * and legacy seeding paths — this part is already generic over crossing
 * multiple text nodes/elements.
 */
function markRun(
  container: HTMLElement,
  atGlobal: number,
  totalLength: number,
  spec: Pick<HighlightSpec, 'commentId' | 'status'>,
): HTMLElement | undefined {
  const doc = container.ownerDocument;
  let remaining = totalLength;
  let cursor = positionAt(container, atGlobal);
  const marks: HTMLElement[] = [];

  while (cursor && remaining > 0) {
    const { node, offset } = cursor;
    const take = Math.min(remaining, node.length - offset);
    if (take <= 0) {
      // Landed on a boundary; move to the next text node via a fresh scan.
      cursor = positionAt(container, atGlobal + (totalLength - remaining) + 1);
      if (!cursor) break;
      cursor = { node: cursor.node, offset: Math.max(0, cursor.offset - 1) };
      continue;
    }
    const tail = offset > 0 ? node.splitText(offset) : node;
    const rest = take < tail.length ? tail.splitText(take) : null;
    const mark = doc.createElement('mark');
    mark.className = `anchor-mark anchor-mark--${spec.status}`;
    mark.dataset.commentId = spec.commentId;
    tail.parentNode?.replaceChild(mark, tail);
    mark.appendChild(tail);
    marks.push(mark);
    remaining -= take;
    if (remaining > 0) {
      const next = rest ?? nextTextNode(container, mark);
      cursor = next ? { node: next, offset: 0 } : undefined;
    }
  }
  // A run spanning markup/paragraph boundaries splits into several sibling
  // <mark> elements (one per leaf). Tag every fragment but the true first
  // with --continued and every fragment but the true last with --more, so
  // the --selected border (styles.css) can cap only the real edges and run
  // a flush top/bottom band through the internal joins, instead of boxing
  // each fragment separately.
  if (marks.length > 1) {
    for (let i = 0; i < marks.length; i++) {
      if (i > 0) marks[i]?.classList.add('anchor-mark--continued');
      if (i < marks.length - 1) marks[i]?.classList.add('anchor-mark--more');
    }
  }
  return marks[0];
}

/** Legacy fallback: nth verbatim occurrence of `spec.exact` in rendered text. */
function applyHighlightLegacy(
  container: HTMLElement,
  spec: HighlightSpec,
): HTMLElement | undefined {
  const full = container.textContent;
  const at = nthIndexOf(full, spec.exact, spec.occurrence);
  if (at === -1) return undefined;
  return markRun(container, at, spec.exact.length, spec);
}

/**
 * Wraps the highlight; returns the first mark element, or undefined when
 * the anchor's range can neither be resolved structurally nor found by the
 * legacy verbatim search (e.g. content changed since the anchor's version —
 * shouldn't happen for a version-pinned anchor, but stays defensive).
 */
export function applyHighlight(
  container: HTMLElement,
  spec: HighlightSpec,
  source: string,
): HTMLElement | undefined {
  const structural = resolveStructural(container, source, spec.start, spec.end);
  if (structural) {
    return markRun(container, structural.atGlobal, structural.length, spec);
  }
  return applyHighlightLegacy(container, spec);
}

function nextTextNode(container: HTMLElement, after: Node): Text | undefined {
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let seen = false;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (seen && node.length > 0) return node;
    if (after.contains(node)) seen = true;
  }
  return undefined;
}

/** Removes every mark previously applied, restoring the plain text nodes.
 *  Also strips any `.anchor-suggestion-overlay` nodes (viewer.tsx's
 *  accepted-pending-suggestion inline preview, ADR 0007 decision 6) — those
 *  are plain sibling elements this module never creates, but they must not
 *  survive a re-apply pass (this runs first, before threads are re-marked)
 *  or they'd accumulate one duplicate per re-render. */
export function clearHighlights(container: HTMLElement): void {
  for (const overlay of [...container.querySelectorAll('.anchor-suggestion-overlay')]) {
    overlay.remove();
  }
  for (const mark of [...container.querySelectorAll('mark.anchor-mark')]) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }
  container.normalize();
}
