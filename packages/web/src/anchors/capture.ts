import type { TextAnchorDto } from '../api/client.js';
import { alignLeaf } from './align.js';

const CONTEXT_CHARS = 32;

/**
 * Mirrors `createTextAnchor` in `packages/domain/src/reanchor.ts:24-33`.
 * `@mdloop/web` cannot depend on `@mdloop/domain` (.dependency-cruiser
 * `web-frontend-only`), so — same reasoning as mentions.ts mirroring the
 * domain mention grammar — this is a deliberate, kept-in-lockstep copy of
 * the prefix/suffix-slicing logic rather than a shared import. Any change
 * to the domain version should be mirrored here.
 */
function createTextAnchor(source: string, start: number, end: number): TextAnchorDto {
  return {
    type: 'text',
    exact: source.slice(start, end),
    prefix: source.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: source.slice(end, end + CONTEXT_CHARS),
    start,
    end,
  };
}

/** All indexes of `needle` in `haystack`, in order. */
function findAll(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  return findAll(haystack, needle).length;
}

/** Concatenated text content of `container` up to (node, offset). */
export function textBefore(container: Node, node: Node, offset: number): string {
  let out = '';
  const doc = container.ownerDocument ?? document;
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const current = walker.currentNode;
    if (current === node) return out + (current.textContent ?? '').slice(0, offset);
    // Element start container (offset counts children) or a node after the
    // boundary: stop at the first text node not strictly before `node`.
    const position = node.compareDocumentPosition(current);
    if (position & (Node.DOCUMENT_POSITION_FOLLOWING | Node.DOCUMENT_POSITION_CONTAINED_BY)) {
      return out;
    }
    out += current.textContent ?? '';
  }
  return out;
}

/** Nearest ancestor-or-self carrying both source-offset attributes. */
function findTaggedLeaf(node: Node): HTMLElement | undefined {
  const start = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return start?.closest<HTMLElement>('[data-src-start][data-src-end]') ?? undefined;
}

/**
 * Resolves a DOM (node, offset) boundary — as produced by a `Range` — to a
 * source-string offset, using the `data-src-start`/`data-src-end` spans the
 * `sourceOffsetsPlugin` rehype plugin tags onto the render (markdown-view.tsx).
 * Fails closed (returns undefined) rather than guessing: no tagged ancestor,
 * or the leaf's rendered text doesn't literally appear in its own tagged
 * source range (entity refs, the callout-marker-stripping edge case — see
 * source-offsets.ts) both bail out here, letting the caller fall back to the
 * legacy verbatim-search path.
 */
function resolveSourceOffset(node: Node, offset: number, source: string): number | undefined {
  const leafEl = findTaggedLeaf(node);
  if (!leafEl) return undefined;
  const leafStart = Number(leafEl.dataset.srcStart);
  const leafEnd = Number(leafEl.dataset.srcEnd);
  if (!Number.isFinite(leafStart) || !Number.isFinite(leafEnd)) return undefined;

  const leafText = leafEl.textContent;
  const sourceSlice = source.slice(leafStart, leafEnd);
  const alignment = alignLeaf(sourceSlice, leafText);
  if (!alignment) return undefined;

  const offsetWithinLeaf = textBefore(leafEl, node, offset).length;
  return leafStart + alignment.sourceOffsetAt(offsetWithinLeaf);
}

/**
 * Legacy fallback: maps a browser selection inside the rendered markdown
 * back to source offsets by verbatim substring search — rendered text
 * preserves source text order, so the selection is the (k+1)-th occurrence
 * of its own string, where k = occurrences of that string in the rendered
 * text before the selection. Returns undefined when the selected string
 * does not appear verbatim in the source (selection spanning markup or a
 * paragraph boundary) — kept as a safety net for anything the structural
 * `resolveSourceOffset` path above doesn't cover, so behavior never
 * regresses below what it replaces.
 */
function captureTextAnchorLegacy(
  container: HTMLElement,
  range: Range,
  exact: string,
  source: string,
): TextAnchorDto | undefined {
  const hits = findAll(source, exact);
  if (hits.length === 0) return undefined;

  const before = textBefore(container, range.startContainer, range.startOffset);
  const occurrence = Math.min(countOccurrences(before, exact), hits.length - 1);
  const start = hits[occurrence];
  if (start === undefined) return undefined;
  const end = start + exact.length;

  return createTextAnchor(source, start, end);
}

/**
 * Maps a browser selection inside the rendered markdown back to source
 * offsets. Resolves each boundary structurally via the tagged
 * `data-src-*` spans (works across bold/italic/link/inline-code/paragraph
 * boundaries — the selection's rendered text no longer has to equal a
 * verbatim substring of the source), falling back to the legacy
 * verbatim-search path when structural resolution doesn't cover a case.
 */
export function captureTextAnchor(
  container: HTMLElement,
  selection: Selection,
  source: string,
): TextAnchorDto | undefined {
  if (selection.rangeCount === 0 || selection.isCollapsed) return undefined;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return undefined;
  const exact = selection.toString();
  if (exact.trim().length === 0) return undefined;

  const start = resolveSourceOffset(range.startContainer, range.startOffset, source);
  const end = resolveSourceOffset(range.endContainer, range.endOffset, source);
  if (start !== undefined && end !== undefined && end > start) {
    return createTextAnchor(source, start, end);
  }

  return captureTextAnchorLegacy(container, range, exact, source);
}

/** Occurrence index of the anchor's exact text at its own source offset. */
export function anchorOccurrence(source: string, exact: string, start: number): number {
  return countOccurrences(source.slice(0, start), exact);
}
