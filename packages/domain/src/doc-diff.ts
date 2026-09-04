import DiffMatchPatch from 'diff-match-patch';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { Result } from '@mdloop/shared';
import { err, ok } from '@mdloop/shared';
import { similarity } from './reanchor.js';

/**
 * Structural leg diff (ADR 0003 §A, tier 1). Parses both legs to mdast, aligns
 * top-level blocks with diff-match-patch's Myers diff (block-granularity
 * `linesToChars` trick), and classifies each block `unchanged | added |
 * removed | modified`. Rendered by a client through its own markdown renderer —
 * the DTO carries source slices, never DOM. Tier 2 (Phase 21.B) adds inline
 * `ins`/`del` runs inside modified pairs (`ModifiedBlock.runs`): word runs over
 * the block's flattened plain text, or line runs for code fences (`runsKind`).
 *
 * GFM must parse the same way the viewer renders (react-markdown + remark-gfm),
 * or block boundaries would misalign against what the reader sees — the remark
 * major is pinned identical across `web` and `domain` (ADR §A.1).
 */

/** Per-leg byte ceiling, checked BEFORE parsing — the cap is really a parse cap (ADR §A.4). */
export const DIFF_MAX_BYTES = 200_000;

/** Per-leg top-level block ceiling, checked immediately after parse, before alignment. */
export const DIFF_MAX_BLOCKS = 1_000;

/**
 * Token-similarity a delete/insert pair must clear to read as one `modified`
 * block rather than a separate `removed` + `added`. Deliberately below the 0.6
 * re-anchor honesty floor (`REANCHOR_CONFIDENCE_FLOOR`): pairing is a rendering
 * choice — a half-shared paragraph reads better as one edited block than as a
 * delete/insert pair — not the never-mislead anchor decision the 0.6 floor
 * governs, so the two thresholds are intentionally distinct.
 */
export const DIFF_MODIFIED_SIMILARITY_THRESHOLD = 0.5;

/** A block present, byte-identical, in both legs. */
export interface UnchangedBlock {
  readonly type: 'unchanged';
  readonly beforeIndex: number;
  readonly afterIndex: number;
  readonly text: string;
}

/** A block present only in the after leg. */
export interface AddedBlock {
  readonly type: 'added';
  readonly afterIndex: number;
  readonly text: string;
}

/** A block present only in the before leg. */
export interface RemovedBlock {
  readonly type: 'removed';
  readonly beforeIndex: number;
  readonly text: string;
}

/**
 * One inline change run inside a modified block (tier 2, ADR §A.2). The ordered
 * array reads as the after content with deletions spliced back in at position:
 * `equal`/`ins` runs carry after text, `del` runs carry the removed before text.
 */
export interface DiffRun {
  readonly op: 'equal' | 'ins' | 'del';
  readonly text: string;
}

/**
 * A before/after block pair whose similarity cleared the modified threshold.
 *
 * `runs` (tier 2) carries the inline ins/del breakdown. `runsKind`:
 * - `word` — the two blocks' *flattened plain text* diffed at word granularity.
 *   Inline markup (links, emphasis) is intentionally dropped: markers are NEVER
 *   injected into markdown source (the CriticMarkup failure mode — breaks link
 *   URLs and tables, ADR §A.2), so runs render as styled prose, not re-parsed
 *   markdown. `before`/`after` keep the untouched source for the tier-1 fallback.
 * - `line` — a code fence diffed line-by-line, one run per line, for row rendering.
 */
export interface ModifiedBlock {
  readonly type: 'modified';
  readonly beforeIndex: number;
  readonly afterIndex: number;
  readonly before: string;
  readonly after: string;
  readonly runs: readonly DiffRun[];
  readonly runsKind: 'word' | 'line';
}

export type DiffBlock = UnchangedBlock | AddedBlock | RemovedBlock | ModifiedBlock;

export interface DocDiff {
  readonly blocks: readonly DiffBlock[];
}

/** Either leg over the byte or block cap — the caller degrades to the source `<pre>` (ADR §A.4). */
export interface DocDiffError {
  readonly code: 'diff_too_large';
}

const encoder = new TextEncoder();
const dmp = new DiffMatchPatch();

const parseOptions = {
  extensions: [gfm()],
  mdastExtensions: [gfmFromMarkdown()],
};

/** Top-level block source slices, in document order, via node position offsets. */
function blockSlices(source: string): string[] {
  const tree = fromMarkdown(source, parseOptions);
  const slices: string[] = [];
  for (const node of tree.children) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    // from-markdown always yields positions for top-level nodes; the guard is
    // for the type, and slices the block's exact source span.
    if (start !== undefined && end !== undefined) slices.push(source.slice(start, end));
  }
  return slices;
}

/**
 * Maps each distinct block slice to a single char (shared dictionary across
 * both legs) so diff-match-patch's Myers diff aligns block sequences — identical
 * blocks (including duplicates within a leg) share a char and compare equal.
 * Bounded by DIFF_MAX_BLOCKS, so the code-unit space is never exhausted.
 */
function encodeBlocks(
  before: string[],
  after: string[],
): { encodedBefore: string; encodedAfter: string } {
  const dict = new Map<string, string>();
  let next = 1;
  const encode = (blocks: string[]): string => {
    let out = '';
    for (const block of blocks) {
      let ch = dict.get(block);
      if (ch === undefined) {
        ch = String.fromCharCode(next++);
        dict.set(block, ch);
      }
      out += ch;
    }
    return out;
  };
  return { encodedBefore: encode(before), encodedAfter: encode(after) };
}

/** Loosely-typed mdast node — enough to walk children and read text values. */
interface FlatNode {
  readonly type: string;
  readonly value?: string;
  readonly children?: readonly FlatNode[];
}

/** Block-level node types whose flattened text must not run into a sibling's. */
const FLAT_BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'listItem',
  'blockquote',
  'tableRow',
  'tableCell',
  'code',
  'thematicBreak',
]);

function parseTree(source: string): FlatNode {
  return fromMarkdown(source, parseOptions);
}

/**
 * Flattens a block's markdown to comparable plain text for word-diffing:
 * concatenates every text-bearing node, separating block-level siblings with a
 * newline so their words never merge. Inline markup (links, emphasis, code
 * marks) is dropped by design — approach (a) of ADR §A.2, "which words changed"
 * over faithful inline markup — and, critically, no diff marker is ever spliced
 * into markdown source.
 */
function flattenToText(source: string): string {
  const parts: string[] = [];
  const walk = (node: FlatNode): void => {
    if (typeof node.value === 'string') {
      parts.push(node.value);
      return;
    }
    if (node.type === 'break') {
      parts.push('\n');
      return;
    }
    if (node.children) {
      for (const child of node.children) {
        walk(child);
        if (FLAT_BLOCK_TYPES.has(child.type)) parts.push('\n');
      }
    }
  };
  walk(parseTree(source));
  return parts
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** A single fenced/indented code block reads as `line` runs, not `word` runs. */
function isCodeBlock(source: string): boolean {
  const children = parseTree(source).children;
  return children?.length === 1 && children[0]?.type === 'code';
}

/** Words and whitespace runs, alternating; joining with '' reconstructs exactly. */
function tokenizeWords(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? [];
}

/**
 * Diffs two token sequences at token granularity: char-encode each distinct
 * token (the diff-match-patch `linesToChars` trick, the same primitive as
 * `encodeBlocks`), run Myers, clean up semantically, map back. Distinct tokens
 * stay well under the UTF-16 code space because computeDocDiff enforces the
 * 200 KB per-leg byte cap before any of this runs — no code point collides.
 * `joiner` reconstructs a run's text from its tokens (`''` for word tokens that
 * already carry their whitespace, `'\n'` for newline-free line tokens).
 */
function tokenRuns(beforeTokens: string[], afterTokens: string[], joiner: string): DiffRun[] {
  const dict = new Map<string, number>();
  const tokens: string[] = [''];
  const encode = (list: string[]): string => {
    let out = '';
    for (const t of list) {
      let code = dict.get(t);
      if (code === undefined) {
        code = tokens.length;
        dict.set(t, code);
        tokens.push(t);
      }
      out += String.fromCharCode(code);
    }
    return out;
  };
  const diffs = dmp.diff_main(encode(beforeTokens), encode(afterTokens), false);
  dmp.diff_cleanupSemantic(diffs);
  return diffs.map(([op, chars]) => {
    const pieces: string[] = [];
    for (let i = 0; i < chars.length; i++) pieces.push(tokens[chars.charCodeAt(i)] ?? '');
    const run: DiffRun = {
      op: op === 0 ? 'equal' : op === 1 ? 'ins' : 'del',
      text: pieces.join(joiner),
    };
    return run;
  });
}

/** Word-granularity runs over two blocks' flattened plain text. */
function wordRuns(before: string, after: string): DiffRun[] {
  return tokenRuns(tokenizeWords(flattenToText(before)), tokenizeWords(flattenToText(after)), '');
}

/** Line-granularity runs over a code fence's raw source, one run per line. */
function lineRuns(before: string, after: string): DiffRun[] {
  const grouped = tokenRuns(before.split('\n'), after.split('\n'), '\n');
  const out: DiffRun[] = [];
  for (const run of grouped) {
    for (const line of run.text.split('\n')) out.push({ op: run.op, text: line });
  }
  return out;
}

interface RunEntry {
  readonly index: number;
  readonly text: string;
}

/**
 * Pairs a delete run against the insert run that immediately follows it,
 * positionally. Each pair is `modified` when its slices clear the threshold,
 * else a `removed` then `added`; overhang on either side is `removed`/`added`.
 */
function pairRuns(removed: RunEntry[], added: RunEntry[], out: DiffBlock[]): void {
  const paired = Math.min(removed.length, added.length);
  for (let i = 0; i < paired; i++) {
    const del = removed[i];
    const ins = added[i];
    if (del === undefined || ins === undefined) continue;
    if (similarity(del.text, ins.text) >= DIFF_MODIFIED_SIMILARITY_THRESHOLD) {
      // Tier-2 inline runs on the modified pair: line runs for a code fence
      // (rendered as diff rows), word runs otherwise. Bounded — this only runs
      // on modified pairs, themselves already under the byte and block caps.
      const codeFence = isCodeBlock(ins.text);
      out.push({
        type: 'modified',
        beforeIndex: del.index,
        afterIndex: ins.index,
        before: del.text,
        after: ins.text,
        runsKind: codeFence ? 'line' : 'word',
        runs: codeFence ? lineRuns(del.text, ins.text) : wordRuns(del.text, ins.text),
      });
    } else {
      out.push({ type: 'removed', beforeIndex: del.index, text: del.text });
      out.push({ type: 'added', afterIndex: ins.index, text: ins.text });
    }
  }
  for (let i = paired; i < removed.length; i++) {
    const del = removed[i];
    if (del !== undefined) out.push({ type: 'removed', beforeIndex: del.index, text: del.text });
  }
  for (let i = paired; i < added.length; i++) {
    const ins = added[i];
    if (ins !== undefined) out.push({ type: 'added', afterIndex: ins.index, text: ins.text });
  }
}

/**
 * Computes the tier-1 structural diff between two markdown legs. Refuses
 * (`diff_too_large`) if either leg exceeds the byte cap (pre-parse) or the
 * block cap (post-parse, pre-alignment) — honest degradation, never a blind
 * error (ADR §A.4).
 */
export function computeDocDiff(before: string, after: string): Result<DocDiff, DocDiffError> {
  // Cap FIRST, before any parsing: the byte cap is really a parse-cost cap.
  if (encoder.encode(before).length > DIFF_MAX_BYTES) return err({ code: 'diff_too_large' });
  if (encoder.encode(after).length > DIFF_MAX_BYTES) return err({ code: 'diff_too_large' });

  const beforeBlocks = blockSlices(before);
  const afterBlocks = blockSlices(after);
  if (beforeBlocks.length > DIFF_MAX_BLOCKS || afterBlocks.length > DIFF_MAX_BLOCKS) {
    return err({ code: 'diff_too_large' });
  }

  const { encodedBefore, encodedAfter } = encodeBlocks(beforeBlocks, afterBlocks);
  // checklines=false: run Myers directly over the block-encoded strings (each
  // char is one block), no line-mode heuristic. Small edit distance in typical
  // edits keeps this near-linear (ADR §A.4).
  const diffs = dmp.diff_main(encodedBefore, encodedAfter, false);

  const blocks: DiffBlock[] = [];
  let beforeIdx = 0;
  let afterIdx = 0;
  for (let i = 0; i < diffs.length; i++) {
    const entry = diffs[i];
    if (entry === undefined) continue;
    const [op, chars] = entry;
    if (op === 0) {
      const run = beforeBlocks.slice(beforeIdx, beforeIdx + chars.length);
      for (const [offset, text] of run.entries()) {
        blocks.push({
          type: 'unchanged',
          beforeIndex: beforeIdx + offset,
          afterIndex: afterIdx + offset,
          text,
        });
      }
      beforeIdx += chars.length;
      afterIdx += chars.length;
      continue;
    }
    if (op === -1) {
      // A delete run pairs with an immediately following insert run.
      const removed: RunEntry[] = beforeBlocks
        .slice(beforeIdx, beforeIdx + chars.length)
        .map((text, offset) => ({ index: beforeIdx + offset, text }));
      beforeIdx += chars.length;
      const nextEntry = diffs[i + 1];
      if (nextEntry?.[0] === 1) {
        const added: RunEntry[] = afterBlocks
          .slice(afterIdx, afterIdx + nextEntry[1].length)
          .map((text, offset) => ({ index: afterIdx + offset, text }));
        afterIdx += nextEntry[1].length;
        pairRuns(removed, added, blocks);
        i++; // consumed the paired insert run
      } else {
        for (const del of removed) {
          blocks.push({ type: 'removed', beforeIndex: del.index, text: del.text });
        }
      }
      continue;
    }
    // Standalone insert run (a delete-then-insert would have consumed it above).
    const run = afterBlocks.slice(afterIdx, afterIdx + chars.length);
    for (const [offset, text] of run.entries()) {
      blocks.push({ type: 'added', afterIndex: afterIdx + offset, text });
    }
    afterIdx += chars.length;
  }

  return ok({ blocks });
}
