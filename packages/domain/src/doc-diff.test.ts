import { describe, expect, it } from 'vitest';
import {
  DIFF_MAX_BLOCKS,
  DIFF_MAX_BYTES,
  computeDocDiff,
  type DiffBlock,
  type ModifiedBlock,
} from './doc-diff.js';

/**
 * Tier-1 structural leg diff (ADR 0003 §A). Classification, GFM constructs,
 * duplicate blocks, empty legs, both cap refusals, and a pathological full
 * rewrite that must still terminate fast over the fakes' block encoding.
 */

function types(blocks: readonly DiffBlock[]): string[] {
  return blocks.map((b) => b.type);
}

function unwrap(before: string, after: string): readonly DiffBlock[] {
  const r = computeDocDiff(before, after);
  if (!r.ok) throw new Error(`unexpected diff_too_large`);
  return r.value.blocks;
}

describe('computeDocDiff — classification', () => {
  it('marks byte-identical top-level blocks unchanged', () => {
    const doc = '# Title\n\nFirst paragraph.\n\nSecond paragraph.';
    const blocks = unwrap(doc, doc);
    expect(types(blocks)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    for (const b of blocks) {
      if (b.type === 'unchanged') {
        expect(b.beforeIndex).toBe(b.afterIndex);
      }
    }
  });

  it('detects an appended block as added', () => {
    const before = '# Title\n\nOne.';
    const after = '# Title\n\nOne.\n\nTwo.';
    const blocks = unwrap(before, after);
    expect(types(blocks)).toEqual(['unchanged', 'unchanged', 'added']);
    const added = blocks.find((b) => b.type === 'added');
    expect(added?.type === 'added' && added.text).toBe('Two.');
    expect(added?.type === 'added' && added.afterIndex).toBe(2);
  });

  it('detects a deleted block as removed', () => {
    const before = '# Title\n\nOne.\n\nTwo.';
    const after = '# Title\n\nOne.';
    const blocks = unwrap(before, after);
    expect(types(blocks)).toEqual(['unchanged', 'unchanged', 'removed']);
    const removed = blocks.find((b) => b.type === 'removed');
    expect(removed?.type === 'removed' && removed.text).toBe('Two.');
    expect(removed?.type === 'removed' && removed.beforeIndex).toBe(2);
  });

  it('pairs a lightly-edited paragraph as one modified block', () => {
    const before = '# Title\n\nThe quick brown fox jumps over the lazy dog.';
    const after = '# Title\n\nThe quick brown fox leaps over the lazy dog.';
    const blocks = unwrap(before, after);
    expect(types(blocks)).toEqual(['unchanged', 'modified']);
    const mod = blocks.find((b) => b.type === 'modified');
    if (mod?.type !== 'modified') throw new Error('expected modified');
    expect(mod.before).toContain('jumps');
    expect(mod.after).toContain('leaps');
    expect(mod.beforeIndex).toBe(1);
    expect(mod.afterIndex).toBe(1);
  });

  it('splits an unrelated replacement into removed + added, not modified', () => {
    const before = '# Title\n\n- alpha';
    const after = '# Title\n\n> completely different quotation here';
    const blocks = unwrap(before, after);
    expect(types(blocks)).toEqual(['unchanged', 'removed', 'added']);
  });

  it('handles a delete run longer than the paired insert run (removed overhang)', () => {
    const before = 'The quick brown fox.\n\nSecond para.\n\nThird para.';
    const after = 'The quick brown foxes.';
    const blocks = unwrap(before, after);
    // First blocks pair as modified (similar); the two extra befores are removed.
    expect(blocks[0]?.type).toBe('modified');
    expect(blocks.filter((b) => b.type === 'removed')).toHaveLength(2);
    expect(blocks.some((b) => b.type === 'added')).toBe(false);
  });

  it('handles an insert run longer than the paired delete run (added overhang)', () => {
    const before = 'The quick brown fox.';
    const after = 'The quick brown foxes.\n\nSecond para.\n\nThird para.';
    const blocks = unwrap(before, after);
    expect(blocks[0]?.type).toBe('modified');
    expect(blocks.filter((b) => b.type === 'added')).toHaveLength(2);
    expect(blocks.some((b) => b.type === 'removed')).toBe(false);
  });
});

describe('computeDocDiff — GFM constructs', () => {
  it('treats a table as one block and detects an in-table edit as modified', () => {
    const before = '| A | B |\n| - | - |\n| 1 | 2 |';
    const after = '| A | B |\n| - | - |\n| 1 | 3 |';
    const blocks = unwrap(before, after);
    // The whole table is a single top-level block.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('modified');
  });

  it('parses strikethrough and task lists as GFM (no source noise)', () => {
    const before = '- [ ] todo ~~old~~';
    const after = '- [x] todo ~~old~~';
    const blocks = unwrap(before, after);
    // A GFM list is one block; the checkbox flip is a modification.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('modified');
  });

  it('treats a fenced code block as one unchanged block when identical', () => {
    const fence = '```ts\nconst a = 1;\nconst b = 2;\n```';
    const before = `# Code\n\n${fence}`;
    const after = `# Code\n\n${fence}`;
    const blocks = unwrap(before, after);
    expect(types(blocks)).toEqual(['unchanged', 'unchanged']);
  });

  it('detects an edit inside a fenced code block as modified', () => {
    const before = '```ts\nconst a = 1;\nconst b = 2;\n```';
    const after = '```ts\nconst a = 1;\nconst b = 3;\n```';
    const blocks = unwrap(before, after);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('modified');
  });
});

describe('computeDocDiff — edge cases', () => {
  it('handles two empty legs as an empty diff', () => {
    expect(unwrap('', '')).toEqual([]);
  });

  it('handles an empty before leg (whole doc added)', () => {
    const blocks = unwrap('', '# New\n\nBody.');
    expect(types(blocks)).toEqual(['added', 'added']);
  });

  it('handles an empty after leg (whole doc removed)', () => {
    const blocks = unwrap('# Old\n\nBody.', '');
    expect(types(blocks)).toEqual(['removed', 'removed']);
  });

  it('keeps duplicate identical blocks aligned, editing only one', () => {
    const before = 'Repeat.\n\nRepeat.\n\nRepeat.';
    const after = 'Repeat.\n\nChanged repeat line.\n\nRepeat.';
    const blocks = unwrap(before, after);
    // Two of the three identical blocks stay unchanged; the middle edit shows.
    const unchanged = blocks.filter((b) => b.type === 'unchanged');
    expect(unchanged.length).toBeGreaterThanOrEqual(2);
    expect(blocks.some((b) => b.type === 'modified' || b.type === 'added')).toBe(true);
  });
});

/** Pulls the sole modified block out of a diff, failing loudly otherwise. */
function onlyModified(before: string, after: string): ModifiedBlock {
  const mod = unwrap(before, after).find((b) => b.type === 'modified');
  if (mod?.type !== 'modified') throw new Error('expected a modified block');
  return mod;
}

/** Reconstructs the after content a client would render from word runs. */
function afterFromRuns(mod: ModifiedBlock): string {
  return mod.runs
    .filter((r) => r.op !== 'del')
    .map((r) => r.text)
    .join('');
}

describe('computeDocDiff — tier-2 word runs', () => {
  it('emits equal/del/ins runs in reading order for a word-level edit', () => {
    const mod = onlyModified(
      'The quick brown fox jumps over the lazy dog.',
      'The quick brown fox leaps over the lazy dog.',
    );
    expect(mod.runsKind).toBe('word');
    // The changed word shows as a del ('jumps') immediately followed by its
    // ins ('leaps'), bracketed by equal runs.
    const del = mod.runs.find((r) => r.op === 'del');
    const ins = mod.runs.find((r) => r.op === 'ins');
    expect(del?.text).toContain('jumps');
    expect(ins?.text).toContain('leaps');
    expect(mod.runs.some((r) => r.op === 'equal' && r.text.includes('quick brown fox'))).toBe(true);
    // Dropping del runs reconstructs the after block's flattened text.
    expect(afterFromRuns(mod)).toBe('The quick brown fox leaps over the lazy dog.');
  });

  it('carries the removed text on del runs (deletion has a place)', () => {
    const mod = onlyModified(
      'Keep this sentence and drop the trailing clause entirely.',
      'Keep this sentence.',
    );
    const removed = mod.runs
      .filter((r) => r.op === 'del')
      .map((r) => r.text)
      .join('');
    expect(removed).toContain('trailing clause');
    expect(afterFromRuns(mod)).toBe('Keep this sentence.');
  });

  it('never injects diff markers into a link — source stays intact, runs are separate', () => {
    const before = 'See the [old docs](https://example.com/old) for context here.';
    const after = 'See the [new docs](https://example.com/new) for context here.';
    const mod = onlyModified(before, after);
    // The after source slice is untouched — the link markdown survives verbatim.
    expect(mod.after).toBe(after);
    // No CriticMarkup-style markers leaked into any run text.
    for (const run of mod.runs) {
      expect(run.text).not.toContain('{++');
      expect(run.text).not.toContain('{--');
      expect(run.text).not.toContain('~~>');
    }
    // Flattening drops the URL (approach a); the visible link words still diff.
    expect(mod.runs.some((r) => r.op === 'del' && r.text.includes('old'))).toBe(true);
    expect(mod.runs.some((r) => r.op === 'ins' && r.text.includes('new'))).toBe(true);
  });

  it('diffs an in-table edit as word runs without table markers in the runs', () => {
    const before = '| Name | Role |\n| - | - |\n| Ada | author |';
    const after = '| Name | Role |\n| - | - |\n| Ada | editor |';
    const mod = onlyModified(before, after);
    expect(mod.runsKind).toBe('word');
    // Runs carry cell text, never the pipe/dash table syntax.
    for (const run of mod.runs) expect(run.text).not.toContain('|');
    expect(mod.runs.some((r) => r.op === 'del' && r.text.includes('author'))).toBe(true);
    expect(mod.runs.some((r) => r.op === 'ins' && r.text.includes('editor'))).toBe(true);
  });

  it('marks a fully-equal-word block with only an equal run when just markup shifts', () => {
    // Same words, different emphasis markup — flattened text is identical, so
    // every run is equal (the change was purely inline markup, dropped by (a)).
    const mod = onlyModified('This is *very* important text.', 'This is **very** important text.');
    expect(mod.runs.every((r) => r.op === 'equal')).toBe(true);
    expect(afterFromRuns(mod)).toBe('This is very important text.');
  });
});

describe('computeDocDiff — tier-2 line runs (code fences)', () => {
  it('emits one run per line with per-line ops for a code-fence edit', () => {
    const before = '```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```';
    const after = '```ts\nconst a = 1;\nconst b = 20;\nconst c = 3;\n```';
    const mod = onlyModified(before, after);
    expect(mod.runsKind).toBe('line');
    // The fence lines and unchanged rows stay equal; the edited line is del+ins.
    expect(mod.runs.some((r) => r.op === 'equal' && r.text === '```ts')).toBe(true);
    expect(mod.runs.some((r) => r.op === 'equal' && r.text === 'const a = 1;')).toBe(true);
    expect(mod.runs.some((r) => r.op === 'del' && r.text === 'const b = 2;')).toBe(true);
    expect(mod.runs.some((r) => r.op === 'ins' && r.text === 'const b = 20;')).toBe(true);
    // No run spans multiple lines — line runs are one row each.
    for (const run of mod.runs) expect(run.text).not.toContain('\n');
  });
});

describe('computeDocDiff — caps (honest degradation)', () => {
  it('refuses when the before leg exceeds the byte cap, pre-parse', () => {
    const huge = 'x'.repeat(DIFF_MAX_BYTES + 1);
    const r = computeDocDiff(huge, 'small');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('diff_too_large');
  });

  it('refuses when the after leg exceeds the byte cap', () => {
    const huge = 'y'.repeat(DIFF_MAX_BYTES + 1);
    const r = computeDocDiff('small', huge);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('diff_too_large');
  });

  it('counts multibyte characters by UTF-8 bytes, not code units', () => {
    // Each '€' is 3 UTF-8 bytes; well under the byte cap by code-unit count.
    const euros = '€'.repeat(Math.ceil(DIFF_MAX_BYTES / 3) + 1);
    const r = computeDocDiff(euros, 'small');
    expect(r.ok).toBe(false);
  });

  it('refuses when a leg exceeds the block cap, post-parse', () => {
    // Well under the byte cap, but far over the block cap: many tiny blocks.
    const many = Array.from({ length: DIFF_MAX_BLOCKS + 5 }, (_, i) => `p${String(i)}`).join(
      '\n\n',
    );
    expect(many.length).toBeLessThan(DIFF_MAX_BYTES);
    const r = computeDocDiff(many, 'small');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('diff_too_large');
  });

  it('terminates fast on a pathological full rewrite at the block cap', () => {
    const before = Array.from({ length: 900 }, (_, i) => `old block number ${String(i)}`).join(
      '\n\n',
    );
    const after = Array.from({ length: 900 }, (_, i) => `new block number ${String(i)}`).join(
      '\n\n',
    );
    const started = Date.now();
    const r = computeDocDiff(before, after);
    expect(r.ok).toBe(true);
    // Every block differs → all modified/removed/added; must still be quick.
    expect(Date.now() - started).toBeLessThan(2000);
    if (r.ok) expect(r.value.blocks.every((b) => b.type !== 'unchanged')).toBe(true);
  });
});
