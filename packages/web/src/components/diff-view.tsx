import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import DiffMatchPatch from 'diff-match-patch';
import { useMemo } from 'react';
import { api, ApiError } from '../api/client.js';
import type { DiffBlockDto, ThreadDto } from '../api/client.js';
import { MarkdownView } from './markdown-view.js';
import { FeatureBoundary, FeatureFallback } from './error-boundary.js';
import { IconX } from './icons.js';

export interface DiffViewProps {
  documentId: string;
  /** Older version to diff from (comment's version / strip selection). */
  fromVersionId: string;
  fromSeq: number;
  /** The current version — Compare always diffs an older version against current. */
  toSeq: number;
  /** Current source, the "after" side of the source-tab fallback. */
  currentSource: string;
  dark: boolean;
  onClose: () => void;
  /**
   * Open threads on the current (to) version — used to overlay a neutral comment
   * count on each changed block (ADR 0003 §A.10 deferred item). Optional: absent
   * (or an empty list) means no chips. Safe by construction because the viewer
   * only ever opens Compare against the current version (`toSeq === currentSeq`), so
   * these threads' current-version offsets describe the same version `currentSource`
   * is — were Compare ever pointed at an older `to`, the caller would pass no
   * threads rather than mislead.
   */
  threads?: readonly ThreadDto[];
  /** Jump to a thread in the viewer: selects it, opening the rail when a block
   *  carries more than one. The chip closes Compare (`onClose`) alongside. */
  onOpenThread?: (commentId: string, openRail: boolean) => void;
}

/** One block's conversation overlay: the open threads bucketed onto it, and how
 *  many of them re-anchored below 0.9 (the "moved" suffix). */
export interface BlockChip {
  ids: string[];
  movedCount: number;
}

/** Content of a block as it appears in the AFTER (current) version, or null when the
 *  block has no after presence — a removed block lives only in the before version,
 *  so it has no place on the current version to carry a chip. */
function afterContentOf(block: DiffBlockDto): string | null {
  if (block.type === 'removed') return null;
  if (block.type === 'modified') return block.after;
  return block.text; // unchanged | added
}

/**
 * Buckets open threads onto the changed blocks they land in — client-side, no
 * server change. Returns a map keyed by block array index, only for `added`/
 * `modified` blocks that carry at least one thread.
 *
 * Mapping: diff blocks carry verbatim source slices of the after version (domain
 * `computeDocDiff` slices by mdast node offsets), and the after version IS the
 * current version here, so each after-present block's `[start,end)` span in
 * `currentSource` is recovered with a cumulative `indexOf` cursor — blocks are
 * ordered and non-overlapping, so scanning forward skips the whitespace between
 * them. Same technique as `mermaidBlockIndexes` in markdown-view. A text
 * thread buckets by its re-anchored offset midpoint; a diagram thread buckets
 * by matching its `blockIndex` against the nth mermaid fence among the
 * after-present blocks (standard ```mermaid fences, the same ones the viewer
 * counts). Resolved threads stay silent; orphans (below the 0.6 floor) have no
 * location and are excluded; whole-document anchors aren't tied to a block.
 */
export function mapThreadsToChips(
  blocks: readonly DiffBlockDto[],
  currentSource: string,
  threads: readonly ThreadDto[],
): Map<number, BlockChip> {
  interface BlockRange {
    index: number;
    start: number;
    end: number;
    changed: boolean;
    mermaidIndex: number | null;
  }

  const ranges: BlockRange[] = [];
  let cursor = 0;
  let mermaidCount = 0;
  blocks.forEach((block, index) => {
    const content = afterContentOf(block);
    if (content === null) return;
    const mermaidIndex = isMermaidFence(content) ? mermaidCount++ : null;
    const pos = currentSource.indexOf(content, cursor);
    if (pos === -1) return; // slice not found — should not happen under the invariant
    cursor = pos + content.length;
    ranges.push({
      index,
      start: pos,
      end: pos + content.length,
      changed: block.type === 'added' || block.type === 'modified',
      mermaidIndex,
    });
  });

  const buckets = new Map<number, BlockChip>();
  const add = (blockIndex: number, id: string, moved: boolean): void => {
    const chip = buckets.get(blockIndex) ?? { ids: [], movedCount: 0 };
    chip.ids.push(id);
    if (moved) chip.movedCount += 1;
    buckets.set(blockIndex, chip);
  };

  for (const thread of threads) {
    const { comment, resolution } = thread;
    if (comment.status !== 'open' || resolution.method === 'orphan') continue;
    const moved = resolution.confidence < 0.9;
    const anchor = comment.anchor;
    let target: BlockRange | undefined;
    if (anchor.type === 'text') {
      if (resolution.start === null || resolution.end === null) continue;
      const mid = (resolution.start + resolution.end) / 2;
      target = ranges.find((r) => r.changed && mid >= r.start && mid < r.end);
    } else if (anchor.type === 'diagram') {
      target = ranges.find((r) => r.changed && r.mermaidIndex === anchor.blockIndex);
    } else {
      continue; // whole-document anchor — no block to attach to
    }
    if (target) add(target.index, comment.id, moved);
  }
  return buckets;
}

/** Neutral count line: "N comment(s)", plus a plain "· M moved" suffix when any
 *  thread re-anchored below 0.9. No percentages, no color — conversation gets
 *  zero hue on the change surface (ADR 0003 §A.10 UX ruling). */
function chipLabel(chip: BlockChip): string {
  const n = chip.ids.length;
  const base = `${String(n)} comment${n === 1 ? '' : 's'}`;
  return chip.movedCount > 0 ? `${base} · ${String(chip.movedCount)} moved` : base;
}

/**
 * Every rendered block on the Compare sheet goes through here rather than
 * calling `MarkdownView` directly. A diff sheet renders one MarkdownView per
 * block — a document's worth of independent markdown pipelines side by side —
 * so a throw in any one of them (a diagram, a callout, a code fence) must cost
 * that block and nothing else. The block's raw source is the fallback: on a
 * change-review surface, seeing the text you can't render beats seeing an
 * apology, and it keeps the diff honest about what's there.
 *
 * `resetKey={source}` so switching legs (or the Before/After toggle below)
 * always retries rather than inheriting the previous block's failure.
 */
function DiffMarkdown({ source, dark }: { source: string; dark: boolean }): JSX.Element {
  return (
    <FeatureBoundary
      source="diff-markdown"
      resetKey={source}
      fallback={
        <FeatureFallback title="This block couldn't be displayed — here is its source.">
          <pre className="feature-fallback-source">
            <code>{source}</code>
          </pre>
        </FeatureFallback>
      }
    >
      <MarkdownView source={source} dark={dark} />
    </FeatureBoundary>
  );
}

type Tab = 'rendered' | 'source';

interface Segment {
  op: -1 | 0 | 1;
  text: string;
}

function computeSegments(before: string, after: string): Segment[] {
  const dmp = new DiffMatchPatch();
  const diffs = dmp.diff_main(before, after);
  dmp.diff_cleanupSemantic(diffs);
  return diffs.map(([op, text]) => ({ op: op as Segment['op'], text }));
}

/** A block whose markdown is a single ```mermaid fence. Diagrams are not diffed
 *  structurally (§9 keeps diagram diffs out of MVP); a changed diagram renders
 *  both versions behind a toggle instead (ADR 0003 §A.9). */
function isMermaidFence(src: string): boolean {
  return /^`{3,}\s*mermaid\b/i.test(src.trim());
}

/**
 * A modified diagram (ADR 0003 §A.9): the After diagram renders by default under
 * a neutral "Diagram changed" chip, with a Before/After toggle to see the old
 * version. No structural diagram diff — just the two versions rendered, amber tint
 * already suppressed on the Compare sheet so nothing collides on the SVG.
 */
function DiagramCompare({
  before,
  after,
  dark,
}: {
  before: string;
  after: string;
  dark: boolean;
}): JSX.Element {
  const [side, setSide] = useState<'before' | 'after'>('after');
  return (
    <div className="compare-block compare-diagram" data-testid="compare-diagram">
      <div className="compare-diagram-head">
        <span className="thread-badge compare-diagram-chip">Diagram changed</span>
        <div className="compare-diagram-toggle" role="tablist" aria-label="Diagram version">
          <button
            type="button"
            role="tab"
            aria-selected={side === 'before'}
            className={`compare-diagram-btn${side === 'before' ? ' compare-diagram-btn--on' : ''}`}
            onClick={() => {
              setSide('before');
            }}
          >
            Before
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={side === 'after'}
            className={`compare-diagram-btn${side === 'after' ? ' compare-diagram-btn--on' : ''}`}
            onClick={() => {
              setSide('after');
            }}
          >
            After
          </button>
        </div>
      </div>
      <DiffMarkdown source={side === 'before' ? before : after} dark={dark} />
    </div>
  );
}

/** One rendered block, washed by its change type — each renders real markdown
 *  through MarkdownView (no anchor/diagram props, so no conversation signal
 *  leaks in; ADR 0003 §A.8). A removed block gets a place by being rendered
 *  under strikethrough (§A.3); modified renders the after content, tier 1. */
function RenderedBlock({ block, dark }: { block: DiffBlockDto; dark: boolean }): JSX.Element {
  if (block.type === 'unchanged') {
    return (
      <div className="compare-block">
        <DiffMarkdown source={block.text} dark={dark} />
      </div>
    );
  }
  if (block.type === 'added') {
    return (
      <div className="compare-block compare-block--added" data-testid="compare-added">
        <DiffMarkdown source={block.text} dark={dark} />
      </div>
    );
  }
  if (block.type === 'removed') {
    return (
      <div className="compare-block compare-block--removed" data-testid="compare-removed">
        <DiffMarkdown source={block.text} dark={dark} />
      </div>
    );
  }
  // A changed mermaid diagram renders both legs behind a Before/After toggle
  // (ADR 0003 §A.9), never as line runs — line diffing a diagram's source is
  // noise. Non-mermaid fences fall through to the line-run branch below.
  if (isMermaidFence(block.before) && isMermaidFence(block.after)) {
    return <DiagramCompare before={block.before} after={block.after} dark={dark} />;
  }
  // Tier 2 (ADR 0003 §A.2): a modified block carries inline runs — word runs
  // over the flattened prose, or line runs for a code fence. Both render inside
  // the block's own neutral --lane-strong rail; ins/del reuse the change washes.
  if (block.runs && block.runs.length > 0) {
    if (block.runsKind === 'line') {
      // Code fence: monospace rows, whole-row wash per op, scrolling sideways
      // so long lines never force the sheet to scroll (§A.9).
      return (
        <div
          className="compare-runs compare-runs--code"
          data-testid="compare-modified"
          data-runs="line"
        >
          {block.runs.map((run, i) => (
            <span
              key={i}
              className={`compare-code-row${
                run.op === 'ins'
                  ? ' compare-code-row--ins'
                  : run.op === 'del'
                    ? ' compare-code-row--del'
                    : ''
              }`}
            >
              {run.text || ' '}
            </span>
          ))}
        </div>
      );
    }
    // Word runs read as flowing serif prose with the removed text struck in
    // place — the deletion gets a home inline, not just in a Before peek (§A.3).
    return (
      <div className="compare-runs" data-testid="compare-modified" data-runs="word">
        {block.runs.map((run, i) =>
          run.op === 'ins' ? (
            <ins key={i} className="compare-run--ins">
              {run.text}
            </ins>
          ) : run.op === 'del' ? (
            <del key={i} className="compare-run--del">
              {run.text}
            </del>
          ) : (
            <span key={i}>{run.text}</span>
          ),
        )}
      </div>
    );
  }
  // No runs (older cached tier-1 shape) → the tier-1 rendering: after content
  // with a quiet Before peek.
  return (
    <div className="compare-block compare-block--modified" data-testid="compare-modified">
      <DiffMarkdown source={block.after} dark={dark} />
      <details className="compare-before">
        <summary>Before</summary>
        <div className="compare-before-body">
          <DiffMarkdown source={block.before} dark={dark} />
        </div>
      </details>
    </div>
  );
}

/**
 * The Compare surface (ADR 0003 §A.7): a transient full-sheet view over the
 * viewer, opened from the version strip, a thread's "changed since vN", or
 * post-upload triage, and closed back to reading. Two tabs — Rendered (the
 * structural block diff, default) and Source (the diff-match-patch `<pre>`,
 * kept as the trust fallback). No conversation amber lights this sheet.
 */
export function DiffView({
  documentId,
  fromVersionId,
  fromSeq,
  toSeq,
  currentSource,
  dark,
  onClose,
  threads,
  onOpenThread,
}: DiffViewProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('rendered');
  const [blocks, setBlocks] = useState<DiffBlockDto[] | null>(null);
  const [subtitle, setSubtitle] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [purged, setPurged] = useState(false);
  const [failed, setFailed] = useState(false);
  const [segments, setSegments] = useState<Segment[] | null>(null);

  // Rendered diff: structural blocks from the server. 413 falls back to source
  // with a quiet notice; 410 is an honest tombstone; 404/network is a banner.
  useEffect(() => {
    let cancelled = false;
    api
      .getDiff(documentId, fromSeq, toSeq)
      .then((diff) => {
        if (cancelled) return;
        setBlocks([...diff.blocks]);
        setSubtitle(diff.to.changeNote);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 413) {
          setTab('source');
          setNotice('Too large to compare rendered — showing source.');
        } else if (e instanceof ApiError && e.status === 410) {
          setPurged(true);
        } else {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, fromSeq, toSeq]);

  // Source fallback is lazy: only fetch the old version's raw markdown once the
  // Source tab is actually shown (either chosen or fallen back to).
  useEffect(() => {
    if (tab !== 'source' || segments !== null || purged) return;
    api
      .getVersionContent(documentId, fromVersionId)
      .then((before) => {
        setSegments(computeSegments(before, currentSource));
      })
      .catch(() => {
        setFailed(true);
      });
  }, [tab, segments, purged, documentId, fromVersionId, currentSource]);

  // Conversation overlay: which changed block each open thread lands on. Pure
  // client-side mapping over the fetched blocks; empty when no threads passed.
  const chips = useMemo(
    () =>
      blocks && threads && threads.length > 0
        ? mapThreadsToChips(blocks, currentSource, threads)
        : new Map<number, BlockChip>(),
    [blocks, threads, currentSource],
  );

  return (
    <div
      className="compare-surface"
      role="dialog"
      aria-modal="true"
      aria-label={`Comparing v${String(fromSeq)} to v${String(toSeq)}`}
      data-testid="compare-surface"
    >
      <div className="compare-head">
        <div className="compare-head-titles">
          <h2 className="compare-title">
            Comparing v{fromSeq} → v{toSeq}
          </h2>
          {subtitle && <p className="compare-subtitle">{subtitle}</p>}
        </div>
        <div className="compare-tabs" role="tablist" aria-label="Compare view">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'rendered'}
            className={`compare-tab${tab === 'rendered' ? ' compare-tab--on' : ''}`}
            disabled={purged}
            onClick={() => {
              setTab('rendered');
            }}
          >
            Rendered
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'source'}
            className={`compare-tab${tab === 'source' ? ' compare-tab--on' : ''}`}
            disabled={purged}
            onClick={() => {
              setTab('source');
            }}
          >
            Source
          </button>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={onClose}
          aria-label="Close compare"
          title="Close compare"
        >
          <IconX />
        </button>
      </div>

      {notice && (
        <div className="compare-notice" role="status">
          {notice}
        </div>
      )}
      {failed && (
        <div className="banner-error" role="alert">
          Could not load the comparison.
        </div>
      )}

      <div className="compare-body">
        {purged ? (
          <p className="compare-purged" role="status">
            v{fromSeq} was purged by the retention policy — its content is gone, so there is nothing
            to compare.
          </p>
        ) : tab === 'rendered' ? (
          blocks && (
            <div className="viewer-content compare-sheet" data-testid="compare-rendered">
              {blocks.map((block, i) => {
                const chip = chips.get(i);
                return (
                  <div key={i} className="compare-block-slot">
                    <RenderedBlock block={block} dark={dark} />
                    {chip && (
                      <button
                        type="button"
                        className="thread-badge compare-thread-chip"
                        data-testid="compare-thread-chip"
                        title="Open this comment thread"
                        aria-label={`${chipLabel(chip)} on this change — open the thread`}
                        onClick={() => {
                          const first = chip.ids[0];
                          if (first) onOpenThread?.(first, chip.ids.length > 1);
                          onClose();
                        }}
                      >
                        {chipLabel(chip)}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )
        ) : (
          segments && (
            <pre className="diff-body" data-testid="compare-source">
              {segments.map((s, i) =>
                s.op === 0 ? (
                  <span key={i}>{s.text}</span>
                ) : s.op === 1 ? (
                  <ins key={i}>{s.text}</ins>
                ) : (
                  <del key={i}>{s.text}</del>
                ),
              )}
            </pre>
          )
        )}
      </div>
    </div>
  );
}
