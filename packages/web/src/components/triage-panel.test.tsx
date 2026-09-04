// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommentDto, ResolutionDto, ThreadDto } from '../api/client.js';
import { TriagePanel } from './triage-panel.js';

function thread(resolution: ResolutionDto, overrides: Partial<CommentDto> = {}): ThreadDto {
  const comment: CommentDto = {
    id: overrides.id ?? 'c1',
    documentId: 'd1',
    versionId: 'v2',
    authorId: 'u1',
    body: 'Please fix the wording here.',
    anchor: { type: 'text', exact: 'wording', prefix: '', suffix: '', start: 0, end: 7 },
    status: 'open',
    resolvedBy: null,
    resolvedAt: null,
    createdAt: '2026-07-01T00:00:00Z',
    viaApiKeyName: null,
    kind: 'comment',
    proposedText: null,
    suggestionOutcome: null,
    appliedVersionId: null,
    ...overrides,
  };
  return {
    comment,
    replies: [],
    resolution,
    upvotes: { count: 0, mine: false },
    mentions: [],
  };
}

afterEach(cleanup);

describe('TriagePanel — plain-language re-anchor confidence (ADR 0003 §F.2)', () => {
  it('renders nothing when no thread is orphaned or moved', () => {
    const { container } = render(
      <TriagePanel
        threads={[thread({ method: 'exact', confidence: 1, start: 0, end: 7 })]}
        newSeq={2}
        canResolve={false}
        onSelect={vi.fn()}
        onResolve={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('keeps the orphan note exactly as-is (Core Principle 2, untouched)', () => {
    render(
      <TriagePanel
        threads={[thread({ method: 'orphan', confidence: 0.2, start: null, end: null })]}
        newSeq={2}
        canResolve={false}
        onSelect={vi.fn()}
        onResolve={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('original text gone — addressed?')).toBeDefined();
  });

  it('shows plain-language "Moved" text — not a percentage — for the 0.6-0.9 confidence band', () => {
    render(
      <TriagePanel
        threads={[thread({ method: 'fuzzy', confidence: 0.75, start: 0, end: 7 })]}
        newSeq={2}
        canResolve={false}
        onSelect={vi.fn()}
        onResolve={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const note = screen.getByText('Moved — check this still fits');
    expect(note.textContent).not.toMatch(/%/);
    expect(note.title).toBe('Re-anchored · 75%');
  });

  it('omits a thread entirely once its confidence reaches 0.9 — extends exact-match silence', () => {
    const { container } = render(
      <TriagePanel
        threads={[thread({ method: 'context', confidence: 0.93, start: 0, end: 7 })]}
        newSeq={2}
        canResolve={false}
        onSelect={vi.fn()}
        onResolve={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('mixes orphaned and moved rows in one panel, each with its own note', () => {
    render(
      <TriagePanel
        threads={[
          thread({ method: 'orphan', confidence: 0.1, start: null, end: null }, { id: 'c1' }),
          thread({ method: 'fuzzy', confidence: 0.65, start: 0, end: 7 }, { id: 'c2' }),
        ]}
        newSeq={3}
        canResolve={true}
        onSelect={vi.fn()}
        onResolve={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('original text gone — addressed?')).toBeDefined();
    expect(screen.getByText('Moved — check this still fits')).toBeDefined();
    expect(screen.getByText(/2 open comments to review/)).toBeDefined();
  });
});
