/**
 * Rehype plugin: tags every addressable text run in the rendered hast tree
 * with the raw-markdown source offsets it came from
 * (`data-src-start`/`data-src-end`), so a DOM selection can be resolved back
 * to a source position structurally instead of via verbatim text search
 * (see anchors/capture.ts, anchors/highlight.ts — both consume these
 * attributes). remark-parse's default position tracking survives mdast→hast
 * untouched in this pipeline; nothing reads it before this plugin does.
 *
 * Loosely typed on purpose: `@vorlyn/web` has no dependency on `unified` or
 * `hast` (they're transitive, pulled in only by react-markdown /
 * rehype-highlight — see .dependency-cruiser.cjs `web-frontend-only` and
 * mentions.ts for the same reasoning applied to `@vorlyn/domain`), so this
 * file duck-types the small slice of the hast shape it needs rather than
 * importing their types. `Pluggable` in unified's own types already widens
 * plugin generics to `any`, so this is structurally assignable to
 * react-markdown's `rehypePlugins` without those imports.
 *
 * Must run before rehypeHighlight in `rehypePlugins` (markdown-view.tsx) —
 * it tags fenced-code-block positions before highlight retokenizes them.
 */

import { reportClientError } from '../error-reporting.js';

interface SourcePosition {
  start: { offset?: number };
  end: { offset?: number };
}

interface HastTextNode {
  type: 'text';
  value: string;
  position?: SourcePosition;
}

interface HastElementNode {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastAnyNode[];
  position?: SourcePosition;
}

type HastAnyNode = HastTextNode | HastElementNode | { type: string; children?: HastAnyNode[] };

interface HastRootNode {
  type: 'root';
  children: HastAnyNode[];
}

interface ResolvedPosition {
  start: { offset: number };
  end: { offset: number };
}

function hasOffsets(position: SourcePosition | undefined): position is ResolvedPosition {
  return typeof position?.start.offset === 'number' && typeof position.end.offset === 'number';
}

function isText(node: HastAnyNode): node is HastTextNode {
  return node.type === 'text';
}

function isElement(node: HastAnyNode): node is HastElementNode {
  return node.type === 'element';
}

function wrapTextNode(text: HastTextNode & { position: ResolvedPosition }): HastElementNode {
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      'data-src-start': String(text.position.start.offset),
      'data-src-end': String(text.position.end.offset),
    },
    children: [text],
  };
}

/**
 * Recursively tags text runs. `node` is the parent being walked, so a
 * `<code>` child of a `<pre>` (a fenced code block, about to be tokenized by
 * rehypeHighlight) can be recognized and short-circuited to whole-block
 * tagging instead of per-text-node wrapping.
 *
 * Known, acceptable edge case (not fixed here): the `blockquote` override in
 * markdown-view.tsx strips a `[!NOTE]`-style marker prefix from a callout's
 * first text child, reaching through the wrapper span this plugin injects —
 * see `stripLeadingMarker` there. That reach-through only fixes up what's
 * *displayed*; it leaves the marker's own `data-src-*` span pointing at the
 * original (unstripped) source range, desynced from the now-shorter
 * displayed text by the marker's length. Downstream resolution fails closed
 * for it (the leaf's rendered text no longer matches its own tagged source
 * slice — see resolveSourceOffset in capture.ts), never a wrong offset.
 */
function walk(node: HastElementNode | HastRootNode): void {
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!child) continue;
    if (isText(child)) {
      if (hasOffsets(child.position)) {
        children[i] = wrapTextNode(child as HastTextNode & { position: ResolvedPosition });
      }
      continue;
    }
    if (!isElement(child)) continue;
    const isFencedCode =
      child.tagName === 'code' && node.type === 'element' && node.tagName === 'pre';
    if (isFencedCode) {
      if (hasOffsets(child.position)) {
        child.properties = {
          ...child.properties,
          'data-src-start': String(child.position.start.offset),
          'data-src-end': String(child.position.end.offset),
        };
      }
      // Leave children alone — rehypeHighlight replaces them with token
      // spans next. Per-token source positions inside highlighted code are
      // out of scope; this is deliberately block-level granularity only.
      continue;
    }
    walk(child);
  }
}

export function sourceOffsetsPlugin() {
  return (tree: HastRootNode): void => {
    /* Tagging is an enhancement, not a correctness requirement, and this walk
       does index arithmetic over a tree shaped by arbitrary document markdown
       plus whatever the remark/rehype plugins upstream produced. A throw here
       happens *during* react-markdown's render, so it would take the whole
       document (and, before the FeatureBoundary layer, the whole SPA) down
       over a decoration. Untagged — or partially tagged, since `walk` mutates
       in place and every tag is independent — is a safe outcome: anchor
       resolution already fails closed on a leaf with no `data-src-*`
       (resolveSourceOffset, capture.ts), so the document still renders and
       existing comments still resolve by quote. */
    try {
      walk(tree);
    } catch (error) {
      reportClientError('source-offsets', error);
    }
  };
}
