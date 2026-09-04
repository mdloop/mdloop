import { describe, expect, it } from 'vitest';
import { ANCHOR_CONTEXT_CHARS, validateAnchor } from './anchor.js';
import type { DiagramAnchor, TextAnchor } from './anchor.js';

const textAnchor = (overrides: Partial<TextAnchor> = {}): TextAnchor => ({
  type: 'text',
  exact: 'hello world',
  prefix: 'before ',
  suffix: ' after',
  start: 100,
  end: 111,
  ...overrides,
});

const diagramAnchor = (overrides: Partial<DiagramAnchor> = {}): DiagramAnchor => ({
  type: 'diagram',
  blockIndex: 0,
  kind: 'node',
  stableId: 'B',
  ...overrides,
});

describe('validateAnchor', () => {
  it('accepts a well-formed text anchor', () => {
    expect(validateAnchor(textAnchor())).toBeUndefined();
  });

  it('rejects empty selection', () => {
    expect(validateAnchor(textAnchor({ exact: '', end: 100 }))?.code).toBe('empty_selection');
  });

  it('rejects negative or inverted offsets', () => {
    expect(validateAnchor(textAnchor({ start: -1, end: 10 }))?.code).toBe('invalid_offsets');
    expect(validateAnchor(textAnchor({ start: 50, end: 50 }))?.code).toBe('invalid_offsets');
    expect(validateAnchor(textAnchor({ start: 60, end: 50 }))?.code).toBe('invalid_offsets');
  });

  it('rejects offsets that disagree with the quote length', () => {
    expect(validateAnchor(textAnchor({ end: 105 }))?.code).toBe('invalid_offsets');
  });

  it('rejects oversized context', () => {
    const big = 'x'.repeat(ANCHOR_CONTEXT_CHARS + 1);
    expect(validateAnchor(textAnchor({ prefix: big }))?.code).toBe('context_too_long');
    expect(validateAnchor(textAnchor({ suffix: big }))?.code).toBe('context_too_long');
  });

  it('accepts well-formed diagram anchors of every kind', () => {
    expect(validateAnchor(diagramAnchor())).toBeUndefined();
    expect(validateAnchor(diagramAnchor({ kind: 'edge', stableId: 'A->B' }))).toBeUndefined();
    expect(validateAnchor(diagramAnchor({ kind: 'actor', stableId: 'API' }))).toBeUndefined();
    expect(
      validateAnchor(diagramAnchor({ kind: 'message', stableId: { index: 1, text: 'putObject' } })),
    ).toBeUndefined();
  });

  it('rejects bad diagram block index and empty stableId', () => {
    expect(validateAnchor(diagramAnchor({ blockIndex: -1 }))?.code).toBe('invalid_block_index');
    expect(validateAnchor(diagramAnchor({ blockIndex: 1.5 }))?.code).toBe('invalid_block_index');
    expect(validateAnchor(diagramAnchor({ stableId: '' }))?.code).toBe('empty_selection');
  });

  it('accepts whole-document anchor', () => {
    expect(validateAnchor({ type: 'document' })).toBeUndefined();
  });
});
