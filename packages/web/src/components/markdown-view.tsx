import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { JSX, ReactElement, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { DiagramAnchorDto } from '../api/client.js';
import { diagramAnchorFromTarget, findDiagramPart } from '../anchors/diagram.js';
import { sourceOffsetsPlugin } from '../anchors/source-offsets.js';
import { parseCallout, stripCalloutMarker } from '../callouts.js';
import { mermaidThemeVariables } from '../mermaid-theme.js';

export interface MarkdownViewProps {
  source: string;
  dark: boolean;
  onDiagramSelect?: (anchor: DiagramAnchorDto) => void;
  /** Diagram anchors with an open thread — matching SVG parts get an amber tint. */
  openDiagramAnchors?: DiagramAnchorDto[];
}

let mermaidSeq = 0;

function MermaidBlock({
  code,
  blockIndex,
  dark,
  onSelect,
  openAnchors,
}: {
  code: string;
  blockIndex: number;
  dark: boolean;
  onSelect: ((anchor: DiagramAnchorDto) => void) | undefined;
  openAnchors: DiagramAnchorDto[] | undefined;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  /* The last successfully rendered SVG. Held in state rather than written
     straight to the DOM from the async body below, because the container div
     does not exist while `failed` is true (the <pre> fallback is mounted in
     its place, so `ref.current` is null) — injecting from a separate effect is
     what lets a recovered diagram actually paint instead of clearing the
     fallback and leaving an empty box. */
  const [svg, setSvg] = useState<string | null>(null);
  // Read via ref inside the render effect so re-tinting doesn't force a re-render.
  const openAnchorsRef = useRef(openAnchors);
  openAnchorsRef.current = openAnchors;

  const applyOpenTint = useCallback(() => {
    const container = ref.current;
    if (!container) return;
    container.querySelectorAll('.has-open-comment').forEach((el) => {
      el.classList.remove('has-open-comment');
    });
    for (const anchor of openAnchorsRef.current ?? []) {
      if (anchor.blockIndex !== blockIndex) continue;
      findDiagramPart(container, anchor)?.classList.add('has-open-comment');
    }
  }, [blockIndex]);

  useEffect(() => {
    const state = { cancelled: false };
    void (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: mermaidThemeVariables(dark),
        });
        const rendered = await mermaid.render(`vorlyn-mermaid-${String(mermaidSeq++)}`, code);
        if (state.cancelled) return;
        /* Clearing `failed` here — on success, not at the top of the effect —
           is what un-sticks a diagram that failed once and was later corrected
           (edited, or a new leg uploaded). Clearing it up front instead would
           make a still-broken diagram flash fallback → nothing → fallback
           while the doomed retry is in flight. */
        setSvg(rendered.svg);
        setFailed(false);
      } catch {
        if (!state.cancelled) setFailed(true);
      }
    })();
    return () => {
      state.cancelled = true;
    };
  }, [code, dark]);

  /* Paint the last good SVG. Separate from the render effect above so it also
     runs on the render where `failed` flips back to false — at that moment the
     container div is mounting for the first time since the failure, and the
     async body that produced the SVG is long finished. */
  useEffect(() => {
    if (failed || svg === null) return;
    const container = ref.current;
    if (!container) return;
    container.innerHTML = svg;
    applyOpenTint();
  }, [svg, failed, applyOpenTint]);

  /* Threads open/resolve after the diagram has already rendered — re-tint
     without re-running mermaid. */
  useEffect(() => {
    applyOpenTint();
  }, [openAnchors, applyOpenTint]);

  if (failed) {
    return (
      <pre className="mermaid-fallback">
        <code>{code}</code>
      </pre>
    );
  }
  return (
    <div
      ref={ref}
      className="mermaid-block"
      data-testid="mermaid-block"
      onClick={(e) => {
        if (!onSelect || !(e.target instanceof Element)) return;
        const anchor = diagramAnchorFromTarget(e.target, blockIndex);
        if (!anchor) return;
        ref.current?.querySelectorAll('.selected-part').forEach((el) => {
          el.classList.remove('selected-part');
        });
        anchor.el.classList.add('selected-part');
        const { el, ...dto } = anchor;
        void el;
        onSelect(dto);
      }}
    />
  );
}

/** Mermaid code blocks in source order get stable block indexes. */
function mermaidBlockIndexes(source: string): Map<string, number[]> {
  const map = new Map<string, number[]>();
  let index = 0;
  const re = /^```mermaid\s*\n([\s\S]*?)^```/gm;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const code = (m[1] ?? '').trim();
    const list = map.get(code) ?? [];
    list.push(index++);
    map.set(code, list);
  }
  return map;
}

/** Flatten a React child tree to its text — enough to sniff a callout marker. */
function nodeText(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return '';
}

/** First element child (the lead paragraph), skipping whitespace text nodes. */
function firstElement(children: ReactNode): ReactElement<{ children?: ReactNode }> | undefined {
  for (const child of Children.toArray(children)) {
    if (isValidElement<{ children?: ReactNode }>(child)) return child;
  }
  return undefined;
}

/**
 * Strips a leading callout marker from the first text run, reaching through
 * a `sourceOffsetsPlugin`-injected wrapper `<span data-src-*>` if present —
 * every text run is individually tagged now (see anchors/source-offsets.ts),
 * so the marker line lives inside that span's own text child rather than
 * directly as the paragraph's first child. Note: this only fixes up what's
 * *displayed*; the wrapper span's own data-src-* attributes still describe
 * the original (unstripped) source range, desynced from the shorter
 * stripped text by the marker's length. That's fine — anchor resolution
 * fails closed for that one leaf (see resolveSourceOffset in capture.ts),
 * never producing a wrong offset, so it isn't special-cased here.
 */
function stripLeadingMarker(node: ReactNode): ReactNode {
  if (typeof node === 'string') return stripCalloutMarker(node);
  if (isValidElement<{ children?: ReactNode }>(node) && typeof node.props.children === 'string') {
    return cloneElement(node, {}, stripCalloutMarker(node.props.children));
  }
  return node;
}

/** Drop the marker line from the first paragraph, preserving inline markup. */
function stripMarkerFromChildren(children: ReactNode): ReactNode {
  let done = false;
  return Children.toArray(children).map((child) => {
    if (done || !isValidElement<{ children?: ReactNode }>(child)) return child;
    done = true;
    const inner = Children.toArray(child.props.children);
    // stripLeadingMarker never turns a child into null/undefined/boolean —
    // it only rewrites a string or clones an element with a string body —
    // so this stays within Children.toArray's narrowed element type.
    inner[0] = stripLeadingMarker(inner[0]) as (typeof inner)[0];
    return cloneElement(child, {}, ...inner);
  });
}

export function MarkdownView({
  source,
  dark,
  onDiagramSelect,
  openDiagramAnchors,
}: MarkdownViewProps): JSX.Element {
  // Both refs, read inside the memoized `code` renderer below rather than
  // closed over by value — `components` doesn't list `source` as a dep (see
  // note below), so these need to be current as of the latest render
  // regardless of whether the memo actually regenerated. `used` disambiguates
  // duplicate diagram code within one render pass and must reset every
  // render, not just when the memo regenerates.
  const blockIndexesRef = useRef<Map<string, number[]>>(new Map());
  blockIndexesRef.current = mermaidBlockIndexes(source);
  const usedRef = useRef<Map<string, number>>(new Map());
  usedRef.current = new Map();
  // Same ref-not-dep treatment as blockIndexesRef/usedRef below, for the
  // same reason: any of these changing identity (dark toggles, threads
  // mutate elsewhere causing a fresh onDiagramSelect/openDiagramAnchors)
  // must NOT regenerate `components`, or every MermaidBlock unmounts and
  // re-runs mermaid.render — visible as a flicker on completely unrelated
  // state changes (e.g. an upvote). Read fresh via ref at call time instead.
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const onDiagramSelectRef = useRef(onDiagramSelect);
  onDiagramSelectRef.current = onDiagramSelect;
  const openDiagramAnchorsRef = useRef(openDiagramAnchors);
  openDiagramAnchorsRef.current = openDiagramAnchors;

  /* ReactMarkdown's `components` map IS the element type it renders for each
     AST node — a fresh object/fresh inline functions here (the previous
     shape) means a fresh `code` component identity on every render, which
     React can't reconcile against the previous one, so it unmounts and
     remounts every code block (including MermaidBlock, tearing down and
     re-running its async mermaid.render on every single parent re-render,
     visible as flicker). Empty deps: this must never regenerate after first
     render — every value it needs comes from a ref read at call time. */
  const components = useMemo(
    () => ({
      blockquote: ({ children }: { children?: ReactNode | undefined }) => {
        /* The callout path walks and re-clones an arbitrary child tree
           (nodeText recurses it, stripMarkerFromChildren cloneElement's into
           it) shaped by whatever markdown a document happened to contain and
           by whatever the other rehype plugins did to it. A plain blockquote
           is always a correct rendering of a blockquote, so an unexpected
           shape degrades to that rather than throwing up into the boundary
           and costing the reader the whole document. */
        try {
          const callout = parseCallout(nodeText(firstElement(children)));
          if (!callout) return <blockquote>{children}</blockquote>;
          return (
            <div className={`callout callout--${callout.kind}`} data-testid="callout">
              <p className="callout-label">{callout.label}</p>
              <div className="callout-body">{stripMarkerFromChildren(children)}</div>
            </div>
          );
        } catch {
          return <blockquote>{children}</blockquote>;
        }
      },
      code: ({
        className,
        children,
        ...props
      }: {
        className?: string | undefined;
        children?: ReactNode | undefined;
      }) => {
        const language = /language-(\w+)/.exec(className ?? '')?.[1];
        if (language === 'mermaid') {
          const code = (typeof children === 'string' ? children : '').trim();
          const used = usedRef.current;
          const seen = used.get(code) ?? 0;
          used.set(code, seen + 1);
          const blockIndex = blockIndexesRef.current.get(code)?.[seen] ?? 0;
          return (
            <MermaidBlock
              code={code}
              blockIndex={blockIndex}
              dark={darkRef.current}
              onSelect={onDiagramSelectRef.current}
              openAnchors={openDiagramAnchorsRef.current}
            />
          );
        }
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      },
      // No deps: usedRef/blockIndexesRef/darkRef/onDiagramSelectRef/
      // openDiagramAnchorsRef are all refs read at call time, and usedRef is
      // rebuilt fresh every render on purpose (see comment above) — none of
      // them are meant to invalidate this memo.
    }),
    [],
  );

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[
        sourceOffsetsPlugin,
        [rehypeHighlight, { ignoreMissing: true, detect: false }],
      ]}
      components={components}
    >
      {source}
    </ReactMarkdown>
  );
}
