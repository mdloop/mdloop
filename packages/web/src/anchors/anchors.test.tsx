// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MarkdownView } from '../components/markdown-view.js';
import { alignLeaf } from './align.js';
import { anchorOccurrence, captureTextAnchor, textBefore } from './capture.js';
import { applyHighlight, clearHighlights } from './highlight.js';

function container(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

function select(node: Node, start: number, end: number): Selection {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const sel = window.getSelection();
  if (!sel) throw new Error('no selection');
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

/** First text node under `root` whose value contains `needle`. */
function findTextNode(root: Node, needle: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.data.includes(needle)) return node;
  }
  throw new Error(`no text node containing "${needle}"`);
}

describe('alignLeaf', () => {
  it('behaves like the old indexOf when there is nothing to skip', () => {
    const sourceSlice = 'hello world';
    const leafText = 'world';
    const alignment = alignLeaf(sourceSlice, leafText);
    expect(alignment?.sourceStart).toBe(sourceSlice.indexOf(leafText));
    expect(alignment?.sourceEnd).toBe(sourceSlice.indexOf(leafText) + leafText.length);
    expect(alignment?.sourceOffsetAt(0)).toBe(alignment?.sourceStart);
    expect(alignment?.sourceOffsetAt(leafText.length)).toBe(alignment?.sourceEnd);
  });

  it('skips a stripped continuation-line indent run', () => {
    // Mirrors the wrapped-list-item case: the parsed leaf text has a bare
    // "\n" where the raw source has "\n" followed by marker-width indent.
    const sourceSlice = 'foo\n  bar';
    const leafText = 'foo\nbar';
    const alignment = alignLeaf(sourceSlice, leafText);
    expect(alignment).toBeDefined();
    expect(alignment?.sourceStart).toBe(0);
    expect(alignment?.sourceEnd).toBe(sourceSlice.length);
    // Rendered offset just after the "\n" (before "bar") maps to the source
    // offset immediately after the raw "\n" — ahead of the stripped indent.
    expect(alignment?.sourceOffsetAt(4)).toBe(4);
    // A source offset that falls inside the stripped indent run maps
    // forward to the next rendered position that actually exists.
    expect(alignment?.renderedOffsetAt(5)).toBe(5);
    expect(sourceSlice.slice(alignment!.sourceStart, alignment!.sourceEnd)).toBe(sourceSlice);
  });

  it('skips a stripped blockquote continuation marker', () => {
    // Mirrors the wrapped-callout case: a blockquote's second line loses its
    // "> " prefix in the parsed text value, but the tagged position still
    // spans the raw source, marker included.
    const sourceSlice = 'foo\n> bar';
    const leafText = 'foo\nbar';
    const alignment = alignLeaf(sourceSlice, leafText);
    expect(alignment).toBeDefined();
    expect(alignment?.sourceStart).toBe(0);
    expect(alignment?.sourceEnd).toBe(sourceSlice.length);
    expect(alignment?.sourceOffsetAt(4)).toBe(4);
    expect(sourceSlice.slice(alignment!.sourceStart, alignment!.sourceEnd)).toBe(sourceSlice);
  });

  it('skips a stripped nested-blockquote continuation marker', () => {
    const sourceSlice = 'foo\n> > bar';
    const leafText = 'foo\nbar';
    const alignment = alignLeaf(sourceSlice, leafText);
    expect(alignment).toBeDefined();
    expect(alignment?.sourceEnd).toBe(sourceSlice.length);
  });

  it('fails closed on a genuine (non-indentation) mismatch', () => {
    // Same class of edge case as the entity-reference / callout-marker
    // divergences documented in source-offsets.ts and capture.ts: the
    // rendered text and its tagged raw-source slice diverge by something
    // other than stripped indentation, so alignment must not guess.
    const sourceSlice = 'wait &mdash; stop';
    const leafText = 'wait — stop';
    expect(alignLeaf(sourceSlice, leafText)).toBeUndefined();
  });
});

describe('captureTextAnchor', () => {
  it('maps a selection to source offsets with context', () => {
    const source = '# Title\n\nThe payment flow retries twice before failing.\n';
    const el = container('<h1>Title</h1><p>The payment flow retries twice before failing.</p>');
    const p = el.querySelector('p')?.firstChild;
    if (!p) throw new Error('setup');
    const text = 'retries twice';
    const offset = (p.textContent ?? '').indexOf(text);
    const anchor = captureTextAnchor(el, select(p, offset, offset + text.length), source);
    expect(anchor).toMatchObject({
      type: 'text',
      exact: text,
      start: source.indexOf(text),
      end: source.indexOf(text) + text.length,
    });
    expect(anchor?.prefix.endsWith('flow ')).toBe(true);
    el.remove();
  });

  it('picks the correct occurrence of duplicated text', () => {
    const source = 'alpha beta\n\nmiddle\n\nalpha beta\n';
    const el = container('<p>alpha beta</p><p>middle</p><p>alpha beta</p>');
    const second = el.querySelectorAll('p')[2]?.firstChild;
    if (!second) throw new Error('setup');
    const anchor = captureTextAnchor(el, select(second, 0, 'alpha beta'.length), source);
    expect(anchor?.start).toBe(source.lastIndexOf('alpha beta'));
    el.remove();
  });

  it('returns undefined for collapsed selections', () => {
    const el = container('<p>words</p>');
    const sel = select(el.querySelector('p')?.firstChild as Node, 1, 1);
    expect(captureTextAnchor(el, sel, 'words')).toBeUndefined();
    el.remove();
  });
});

/**
 * These render through the real pipeline (MarkdownView, with
 * sourceOffsetsPlugin wired in) rather than hand-built HTML, because the
 * bug being fixed only reproduces against actual `data-src-*` tagging: a
 * selection whose rendered text crosses inline markup or a paragraph
 * boundary. Before the fix, every case in this block fell back to a
 * whole-document anchor (`captureTextAnchor` returning undefined).
 */
describe('captureTextAnchor — selections crossing markup (rendered pipeline)', () => {
  afterEach(cleanup);

  it('resolves a selection crossing **bold** markup to the raw source range', () => {
    const source = 'plain **bold** tail';
    const { container: root } = render(<MarkdownView dark={false} source={source} />);
    const p = root.querySelector('p');
    if (!p) throw new Error('setup');
    const startNode = findTextNode(p, 'plain');
    const endNode = findTextNode(p, 'tail');
    const range = document.createRange();
    range.setStart(startNode, 0);
    range.setEnd(endNode, 3); // " ta" — three chars into " tail"
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const expectedStart = source.indexOf('plain');
    const expectedEnd = source.indexOf(' tail') + 3;
    const anchor = captureTextAnchor(root, sel!, source);
    expect(anchor).toMatchObject({
      type: 'text',
      exact: source.slice(expectedStart, expectedEnd),
      start: expectedStart,
      end: expectedEnd,
    });
    // The whole point of the fix: exact now legitimately contains raw
    // markdown syntax, because the boundary was resolved structurally
    // instead of by verbatim rendered-text search.
    expect(anchor?.exact).toContain('**bold**');
  });

  it('resolves a selection crossing an inline link', () => {
    const source = 'See [the docs](https://example.com/x) for info.';
    const { container: root } = render(<MarkdownView dark={false} source={source} />);
    const linkText = findTextNode(root, 'the docs');
    const trailing = findTextNode(root, 'for info');
    const range = document.createRange();
    range.setStart(linkText, 0);
    range.setEnd(trailing, 4); // " for" — four chars into " for info."
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const expectedStart = source.indexOf('the docs');
    const expectedEnd = source.indexOf(' for info.') + 4;
    const anchor = captureTextAnchor(root, sel!, source);
    expect(anchor).toMatchObject({
      type: 'text',
      exact: source.slice(expectedStart, expectedEnd),
      start: expectedStart,
      end: expectedEnd,
    });
    expect(anchor?.exact).toContain('](https://example.com/x)');
  });

  it('resolves a selection crossing inline code', () => {
    const source = 'Run `npm test` before merging.';
    const { container: root } = render(<MarkdownView dark={false} source={source} />);
    const startNode = findTextNode(root, 'Run');
    const codeNode = findTextNode(root, 'npm test');
    const range = document.createRange();
    range.setStart(startNode, 0);
    range.setEnd(codeNode, codeNode.data.length);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    // The DOM range can only extend to the last *rendered* character of the
    // code span — the delimiting backticks aren't rendered, so a selection
    // ending at the text node's own end lands just before the closing `.
    const expectedStart = source.indexOf('Run');
    const expectedEnd = source.indexOf('npm test') + 'npm test'.length;
    const anchor = captureTextAnchor(root, sel!, source);
    expect(anchor).toMatchObject({
      type: 'text',
      exact: source.slice(expectedStart, expectedEnd),
      start: expectedStart,
      end: expectedEnd,
    });
    // Still crosses markup: the opening backtick delimiter is inside `exact`.
    expect(anchor?.exact).toContain('`npm test');
  });

  it('resolves a selection spanning a paragraph boundary', () => {
    const source = 'First paragraph line.\n\nSecond paragraph line.';
    const { container: root } = render(<MarkdownView dark={false} source={source} />);
    const startNode = findTextNode(root, 'paragraph line.'); // first <p>
    const endNode = findTextNode(root, 'Second paragraph');
    const range = document.createRange();
    range.setStart(startNode, startNode.data.indexOf('paragraph'));
    range.setEnd(endNode, endNode.data.indexOf('paragraph') + 'paragraph'.length);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const expectedStart = source.indexOf('paragraph line.');
    const expectedEnd = source.indexOf('Second paragraph') + 'Second paragraph'.length;
    const anchor = captureTextAnchor(root, sel!, source);
    expect(anchor).toMatchObject({
      type: 'text',
      exact: source.slice(expectedStart, expectedEnd),
      start: expectedStart,
      end: expectedEnd,
    });
    // The raw source's paragraph break is inside `exact` even though
    // `Range.toString()` would never have included it.
    expect(anchor?.exact).toContain('\n\n');
  });

  it("resolves a selection crossing a wrapped list item's stripped indentation", () => {
    // CommonMark strips the continuation-line indentation (aligned to the
    // "- " marker width) from the parsed text, but the tagged source range
    // still points at the raw source, indent included — this is exactly
    // the case align.ts's alignLeaf exists for.
    const source =
      '- some leading text that is long enough to wrap across a rendered\n' +
      '  line boundary inside the list item\n';
    const { container: root } = render(<MarkdownView dark={false} source={source} />);
    const textNode = findTextNode(root, 'wrap across');
    const rendered = textNode.data;
    const startOffset = rendered.indexOf('across');
    const endOffset = rendered.indexOf('boundary') + 'boundary'.length;
    const range = document.createRange();
    range.setStart(textNode, startOffset);
    range.setEnd(textNode, endOffset);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const expectedStart = source.indexOf('across');
    const expectedEnd = source.indexOf('boundary') + 'boundary'.length;
    const anchor = captureTextAnchor(root, sel!, source);

    // Not undefined: before the fix this fell back to the legacy path,
    // which also fails here (the rendered selection, with its indentation
    // already stripped, does not appear verbatim in the raw source).
    expect(anchor).toMatchObject({
      type: 'text',
      exact: source.slice(expectedStart, expectedEnd),
      start: expectedStart,
      end: expectedEnd,
    });
    // The raw two-space continuation indent is preserved inside `exact`.
    expect(anchor?.exact).toContain('\n  line');
  });

  it('resolves a selection crossing a wrapped callout continuation line', () => {
    // Real content from fixtures/kitchen-sink/engineering-design.md: a
    // `[!CAUTION]` callout whose body wraps onto a second blockquote line.
    // stripLeadingMarker removes "[!CAUTION]\n" from what's displayed, but
    // the wrapper span's own data-src-* still spans the raw block including
    // the marker and the second line's "> " prefix — this leaf needs both
    // the marker-desync tolerance (fails closed, see stripLeadingMarker) and
    // the blockquote-continuation skip (see align.ts) to still resolve a
    // selection that crosses the wrap point.
    const source =
      '> [!CAUTION]\n' +
      '> Do not backport this to the legacy billing path — it does not have idempotency\n' +
      '> keys and will double-charge on retry.\n';
    const { container: root } = render(<MarkdownView dark={false} source={source} />);
    const textNode = findTextNode(root, 'idempotency');
    const rendered = textNode.data;
    const startOffset = rendered.indexOf('idempotency');
    const endOffset = rendered.indexOf('keys') + 'keys'.length;
    const range = document.createRange();
    range.setStart(textNode, startOffset);
    range.setEnd(textNode, endOffset);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const anchor = captureTextAnchor(root, sel!, source);

    // Before the fix: undefined here (both structural and legacy fail),
    // which the caller treats as "no valid text anchor" and falls back to a
    // whole-document comment — not the bug this test guards against.
    expect(anchor).toBeDefined();
    expect(anchor?.exact).toBe('idempotency\n> keys');
    expect(anchor?.start).toBe(source.indexOf('idempotency'));
    expect(anchor?.end).toBe(source.indexOf('keys') + 'keys'.length);
  });
});

describe('textBefore', () => {
  it('concatenates text across elements up to the boundary', () => {
    const el = container('<p>one</p><p>two <em>three</em> four</p>');
    const em = el.querySelector('em')?.firstChild;
    if (!em) throw new Error('setup');
    expect(textBefore(el, em, 2)).toBe('onetwo th');
    el.remove();
  });
});

describe('anchorOccurrence', () => {
  it('counts prior occurrences of the exact text', () => {
    const source = 'x y x y x';
    expect(anchorOccurrence(source, 'x', 0)).toBe(0);
    expect(anchorOccurrence(source, 'x', 4)).toBe(1);
    expect(anchorOccurrence(source, 'x', 8)).toBe(2);
  });
});

describe('applyHighlight / clearHighlights', () => {
  it('wraps a single-node occurrence in a status mark (legacy fallback path)', () => {
    const el = container('<p>before target after</p>');
    const mark = applyHighlight(
      el,
      { commentId: 'c1', exact: 'target', occurrence: 0, start: 7, end: 13, status: 'open' },
      'before target after',
    );
    expect(mark?.textContent).toBe('target');
    expect(mark?.className).toContain('anchor-mark--open');
    expect(el.textContent).toBe('before target after');
    el.remove();
  });

  it('wraps the requested occurrence, spanning element boundaries (legacy fallback path)', () => {
    const el = container('<p>alpha beta</p><p>alpha <em>beta</em> end</p>');
    const source = 'alpha beta\n\nalpha beta end\n';
    const mark = applyHighlight(
      el,
      {
        commentId: 'c2',
        exact: 'alpha beta',
        occurrence: 1,
        start: 12,
        end: 22,
        status: 'replied',
      },
      source,
    );
    expect(mark).toBeDefined();
    const marks = el.querySelectorAll('mark[data-comment-id="c2"]');
    expect([...marks].map((m) => m.textContent).join('')).toBe('alpha beta');
    // First paragraph untouched.
    expect(el.querySelector('p')?.querySelector('mark')).toBeNull();
    el.remove();
  });

  it('returns undefined when the text is not present (orphan)', () => {
    const el = container('<p>content</p>');
    expect(
      applyHighlight(
        el,
        { commentId: 'c3', exact: 'missing', occurrence: 0, start: 0, end: 7, status: 'open' },
        'content',
      ),
    ).toBeUndefined();
    el.remove();
  });

  it('tags only the true first/last fragment of a multi-mark run as edges', () => {
    const el = container('<p>alpha <em>beta</em> gamma</p>');
    const source = 'alpha beta gamma';
    applyHighlight(
      el,
      {
        commentId: 'c5',
        exact: source,
        occurrence: 0,
        start: 0,
        end: source.length,
        status: 'open',
      },
      source,
    );
    const marks = [...el.querySelectorAll('mark[data-comment-id="c5"]')];
    expect(marks).toHaveLength(3);
    expect(marks[0]?.className).not.toContain('anchor-mark--continued');
    expect(marks[0]?.className).toContain('anchor-mark--more');
    expect(marks[1]?.className).toContain('anchor-mark--continued');
    expect(marks[1]?.className).toContain('anchor-mark--more');
    expect(marks[2]?.className).toContain('anchor-mark--continued');
    expect(marks[2]?.className).not.toContain('anchor-mark--more');
    el.remove();
  });

  it('leaves a single-fragment mark untagged (default full box applies)', () => {
    const el = container('<p>before target after</p>');
    applyHighlight(
      el,
      { commentId: 'c6', exact: 'target', occurrence: 0, start: 7, end: 13, status: 'open' },
      'before target after',
    );
    const mark = el.querySelector('mark[data-comment-id="c6"]');
    expect(mark?.className).not.toContain('anchor-mark--continued');
    expect(mark?.className).not.toContain('anchor-mark--more');
    el.remove();
  });

  it('clearHighlights restores the original text nodes', () => {
    const el = container('<p>keep this text intact</p>');
    applyHighlight(
      el,
      { commentId: 'c4', exact: 'this text', occurrence: 0, start: 5, end: 14, status: 'open' },
      'keep this text intact',
    );
    expect(el.querySelectorAll('mark').length).toBeGreaterThan(0);
    clearHighlights(el);
    expect(el.querySelectorAll('mark')).toHaveLength(0);
    expect(el.textContent).toBe('keep this text intact');
    el.remove();
  });
});

/**
 * Round-trips capture → highlight through the real render pipeline: the
 * anchor's `start`/`end` (raw source offsets, possibly spanning markup) must
 * resolve back to a <mark> wrapping the correct *rendered* text — the
 * inverse of the capture-side fix, exercising the structural path in
 * highlight.ts (not the legacy fallback).
 */
describe('applyHighlight — structural round-trip (rendered pipeline)', () => {
  afterEach(cleanup);

  it('highlights the rendered text under a bold-crossing anchor', () => {
    const source = 'plain **bold** tail';
    const { container: root } = render(<MarkdownView dark={false} source={source} />);
    const p = root.querySelector('p');
    if (!p) throw new Error('setup');
    const startNode = findTextNode(p, 'plain');
    const endNode = findTextNode(p, 'tail');
    const range = document.createRange();
    range.setStart(startNode, 0);
    range.setEnd(endNode, 3);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const anchor = captureTextAnchor(root, sel!, source);
    if (!anchor) throw new Error('capture failed');

    const mark = applyHighlight(
      root,
      {
        commentId: 'round-trip-1',
        exact: anchor.exact,
        occurrence: anchorOccurrence(source, anchor.exact, anchor.start),
        start: anchor.start,
        end: anchor.end,
        status: 'open',
      },
      source,
    );
    expect(mark).toBeDefined();
    const marks = [...root.querySelectorAll('mark[data-comment-id="round-trip-1"]')];
    expect(marks.length).toBeGreaterThan(0);
    // Rendered text under the mark has the markdown syntax stripped, even
    // though the stored anchor's `exact` (raw source) does not.
    expect(marks.map((m) => m.textContent).join('')).toBe('plain bold ta');
    expect(anchor.exact).toBe('plain **bold** ta');
    // See the note at the end of the next test: restore the mutated DOM
    // before testing-library's afterEach unmounts it.
    clearHighlights(root);
  });

  it('highlights the rendered text under a paragraph-spanning anchor', () => {
    const source = 'First paragraph line.\n\nSecond paragraph line.';
    const { container: root } = render(<MarkdownView dark={false} source={source} />);
    const startNode = findTextNode(root, 'paragraph line.');
    const endNode = findTextNode(root, 'Second paragraph');
    const range = document.createRange();
    range.setStart(startNode, startNode.data.indexOf('paragraph'));
    range.setEnd(endNode, endNode.data.indexOf('paragraph') + 'paragraph'.length);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const anchor = captureTextAnchor(root, sel!, source);
    if (!anchor) throw new Error('capture failed');

    const mark = applyHighlight(
      root,
      {
        commentId: 'round-trip-2',
        exact: anchor.exact,
        occurrence: anchorOccurrence(source, anchor.exact, anchor.start),
        start: anchor.start,
        end: anchor.end,
        status: 'resolved',
      },
      source,
    );
    expect(mark).toBeDefined();
    const marks = [...root.querySelectorAll('mark[data-comment-id="round-trip-2"]')];
    // The two <p> elements are marked independently, joined by a single
    // untagged whitespace text node mdast-util-to-hast leaves between
    // block-level siblings (collapses to nothing visually) — the marking
    // walk correctly spans it rather than drifting out of alignment, which
    // is what the earlier "\n\n" (source) vs "" (verbatim rendered join)
    // mismatch used to do before this fix measured both boundaries in the
    // same global text-offset space (see resolveStructural in highlight.ts).
    expect(marks.map((m) => m.textContent).join('')).toBe('paragraph line.\nSecond paragraph');
    // applyHighlight mutates the React-rendered DOM directly (splitText /
    // replaceChild, same established pattern as the pre-existing
    // highlight.ts) — restore it before testing-library's afterEach
    // unmounts the tree, same as viewer.tsx always does before any new
    // React render of this content (see the clearHighlights call at the
    // top of its highlighting effect).
    clearHighlights(root);
  });

  it('highlights the rendered text under a wrapped-list-item anchor', () => {
    const source =
      '- some leading text that is long enough to wrap across a rendered\n' +
      '  line boundary inside the list item\n';
    const { container: root } = render(<MarkdownView dark={false} source={source} />);
    const textNode = findTextNode(root, 'wrap across');
    const rendered = textNode.data;
    const startOffset = rendered.indexOf('across');
    const endOffset = rendered.indexOf('boundary') + 'boundary'.length;
    const range = document.createRange();
    range.setStart(textNode, startOffset);
    range.setEnd(textNode, endOffset);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const anchor = captureTextAnchor(root, sel!, source);
    if (!anchor) throw new Error('capture failed');

    const mark = applyHighlight(
      root,
      {
        commentId: 'round-trip-3',
        exact: anchor.exact,
        occurrence: anchorOccurrence(source, anchor.exact, anchor.start),
        start: anchor.start,
        end: anchor.end,
        status: 'open',
      },
      source,
    );
    expect(mark).toBeDefined();
    const marks = [...root.querySelectorAll('mark[data-comment-id="round-trip-3"]')];
    // Rendered text under the mark has the stripped indentation gone (no
    // "  " between "rendered" and "line"), even though the stored anchor's
    // `exact` (raw source) has it.
    expect(marks.map((m) => m.textContent).join('')).toBe('across a rendered\nline boundary');
    expect(anchor.exact).toContain('\n  line');
    clearHighlights(root);
  });

  it('highlights the rendered text under a wrapped-callout anchor', () => {
    const source =
      '> [!CAUTION]\n' +
      '> Do not backport this to the legacy billing path — it does not have idempotency\n' +
      '> keys and will double-charge on retry.\n';
    const { container: root } = render(<MarkdownView dark={false} source={source} />);
    const textNode = findTextNode(root, 'idempotency');
    const rendered = textNode.data;
    const startOffset = rendered.indexOf('idempotency');
    const endOffset = rendered.indexOf('keys') + 'keys'.length;
    const range = document.createRange();
    range.setStart(textNode, startOffset);
    range.setEnd(textNode, endOffset);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const anchor = captureTextAnchor(root, sel!, source);
    if (!anchor) throw new Error('capture failed');

    const mark = applyHighlight(
      root,
      {
        commentId: 'round-trip-4',
        exact: anchor.exact,
        occurrence: anchorOccurrence(source, anchor.exact, anchor.start),
        start: anchor.start,
        end: anchor.end,
        status: 'open',
      },
      source,
    );
    expect(mark).toBeDefined();
    const marks = [...root.querySelectorAll('mark[data-comment-id="round-trip-4"]')];
    // Before the fix: no mark at all (both structural and legacy resolution
    // failed on this leaf), not a mark around a single word — but the same
    // failure is what a partial/wrong selection elsewhere in a multi-line
    // callout would also produce, since resolveStructural fails the whole
    // highlight closed rather than marking only what it could resolve.
    expect(marks.map((m) => m.textContent).join('')).toBe('idempotency\nkeys');
    clearHighlights(root);
  });
});
