// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as clientModule from '../api/client.js';
import { api, ApiError } from '../api/client.js';
import type { AnchorDto, DiffBlockDto, DocDiffDto, ThreadDto } from '../api/client.js';
import type * as markdownViewModule from './markdown-view.js';
import { DiffView, mapThreadsToChips } from './diff-view.js';

/* Passes everything through to the real MarkdownView except a sentinel source,
   which throws — standing in for any render throw in the markdown pipeline
   (a diagram, a callout, a plugin) without needing to construct one. */
vi.mock('./markdown-view.js', async () => {
  const actual = await vi.importActual<typeof markdownViewModule>('./markdown-view.js');
  return {
    MarkdownView: (props: markdownViewModule.MarkdownViewProps) => {
      if (props.source.includes('__BOOM__')) throw new Error('render exploded: secret content');
      return <actual.MarkdownView {...props} />;
    },
  };
});

vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual<typeof clientModule>('../api/client.js');
  return {
    ...actual,
    api: {
      getDiff: vi.fn(),
      getVersionContent: vi.fn(),
    },
  };
});

function diff(blocks: DiffBlockDto[], toNote: string | null = null): DocDiffDto {
  return {
    from: { seq: 1, contentHash: 'h1', changeNote: null },
    to: { seq: 2, contentHash: 'h2', changeNote: toNote },
    blocks,
  };
}

const textAnchor = (start: number, end: number): AnchorDto => ({
  type: 'text',
  exact: '',
  prefix: '',
  suffix: '',
  start,
  end,
});

function makeThread(opts: {
  id: string;
  status?: 'open' | 'resolved';
  anchor?: AnchorDto;
  method?: ThreadDto['resolution']['method'];
  confidence?: number;
  start?: number | null;
  end?: number | null;
}): ThreadDto {
  return {
    comment: {
      id: opts.id,
      documentId: 'd1',
      versionId: 'v2',
      authorId: 'u1',
      body: 'a comment',
      anchor: opts.anchor ?? textAnchor(0, 0),
      status: opts.status ?? 'open',
      resolvedBy: null,
      resolvedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
      viaApiKeyName: null,
      kind: 'comment',
      proposedText: null,
      suggestionOutcome: null,
      appliedVersionId: null,
    },
    replies: [],
    resolution: {
      method: opts.method ?? 'exact',
      confidence: opts.confidence ?? 1,
      start: opts.start ?? null,
      end: opts.end ?? null,
    },
    upvotes: { count: 0, mine: false },
    mentions: [],
  };
}

function renderDiff(): void {
  render(
    <DiffView
      documentId="d1"
      fromVersionId="v1"
      fromSeq={1}
      toSeq={2}
      currentSource="After source."
      dark={false}
      onClose={vi.fn()}
    />,
  );
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

describe('DiffView — Compare surface', () => {
  it('renders each block type with its change wash', async () => {
    vi.mocked(api.getDiff).mockResolvedValue(
      diff([
        { type: 'unchanged', beforeIndex: 0, afterIndex: 0, text: 'Kept paragraph.' },
        { type: 'added', afterIndex: 1, text: 'Fresh paragraph.' },
        { type: 'removed', beforeIndex: 1, text: 'Gone paragraph.' },
        {
          type: 'modified',
          beforeIndex: 2,
          afterIndex: 2,
          before: 'Old wording here.',
          after: 'New wording here.',
        },
      ]),
    );
    renderDiff();

    await waitFor(() => {
      expect(screen.getByTestId('compare-added')).toBeDefined();
    });
    expect(screen.getByText('Fresh paragraph.')).toBeDefined();
    expect(screen.getByTestId('compare-removed')).toBeDefined();
    expect(screen.getByText('Gone paragraph.')).toBeDefined();
    // Modified renders the AFTER content (tier 1); the before-text is a quiet peek.
    expect(screen.getByTestId('compare-modified')).toBeDefined();
    expect(screen.getByText('New wording here.')).toBeDefined();
    expect(screen.getByText('Old wording here.')).toBeDefined();
    expect(screen.getByText('Kept paragraph.')).toBeDefined();
  });

  it('renders word runs as inline ins/del prose inside the modified rail (tier 2)', async () => {
    vi.mocked(api.getDiff).mockResolvedValue(
      diff([
        {
          type: 'modified',
          beforeIndex: 0,
          afterIndex: 0,
          before: 'The quick brown fox jumps.',
          after: 'The quick brown fox leaps.',
          runsKind: 'word',
          runs: [
            { op: 'equal', text: 'The quick brown fox ' },
            { op: 'del', text: 'jumps' },
            { op: 'ins', text: 'leaps' },
            { op: 'equal', text: '.' },
          ],
        },
      ]),
    );
    renderDiff();

    const modified = await screen.findByTestId('compare-modified');
    expect(modified.getAttribute('data-runs')).toBe('word');
    // Removed word is struck in place; inserted word carries the insert wash.
    const del = modified.querySelector('del.compare-run--del');
    const ins = modified.querySelector('ins.compare-run--ins');
    expect(del?.textContent).toBe('jumps');
    expect(ins?.textContent).toBe('leaps');
    // No tier-1 Before peek when runs are present.
    expect(modified.querySelector('.compare-before')).toBeNull();
  });

  it('renders code-fence line runs as washed monospace rows in a scroll container (tier 2)', async () => {
    vi.mocked(api.getDiff).mockResolvedValue(
      diff([
        {
          type: 'modified',
          beforeIndex: 0,
          afterIndex: 0,
          before: '```ts\nconst b = 2;\n```',
          after: '```ts\nconst b = 20;\n```',
          runsKind: 'line',
          runs: [
            { op: 'equal', text: '```ts' },
            { op: 'del', text: 'const b = 2;' },
            { op: 'ins', text: 'const b = 20;' },
            { op: 'equal', text: '```' },
          ],
        },
      ]),
    );
    renderDiff();

    const modified = await screen.findByTestId('compare-modified');
    expect(modified.getAttribute('data-runs')).toBe('line');
    expect(modified.className).toContain('compare-runs--code');
    const delRow = modified.querySelector('.compare-code-row--del');
    const insRow = modified.querySelector('.compare-code-row--ins');
    expect(delRow?.textContent).toBe('const b = 2;');
    expect(insRow?.textContent).toBe('const b = 20;');
  });

  it('falls back to tier-1 after-content + Before peek for a modified block without runs', async () => {
    vi.mocked(api.getDiff).mockResolvedValue(
      diff([
        {
          type: 'modified',
          beforeIndex: 0,
          afterIndex: 0,
          before: 'Old wording here.',
          after: 'New wording here.',
        },
      ]),
    );
    renderDiff();

    const modified = await screen.findByTestId('compare-modified');
    // Tier-1 shape: renders the after content with a quiet Before disclosure.
    expect(modified.querySelector('.compare-before')).not.toBeNull();
    expect(screen.getByText('New wording here.')).toBeDefined();
    expect(screen.getByText('Old wording here.')).toBeDefined();
  });

  it('renders a changed diagram behind a Before/After toggle, not as line runs (§A.9)', async () => {
    vi.mocked(api.getDiff).mockResolvedValue(
      diff([
        {
          type: 'modified',
          beforeIndex: 0,
          afterIndex: 0,
          before: '```mermaid\ngraph TD; A-->B\n```',
          after: '```mermaid\ngraph TD; A-->C\n```',
          // Server sends line runs for any fence; the client must override for
          // mermaid and show the diagram toggle instead.
          runsKind: 'line',
          runs: [
            { op: 'equal', text: '```mermaid' },
            { op: 'del', text: 'graph TD; A-->B' },
            { op: 'ins', text: 'graph TD; A-->C' },
            { op: 'equal', text: '```' },
          ],
        },
      ]),
    );
    renderDiff();

    const diagram = await screen.findByTestId('compare-diagram');
    // The mermaid fence never falls through to the code-row line-diff branch.
    expect(screen.queryByTestId('compare-modified')).toBeNull();
    expect(screen.getByText('Diagram changed')).toBeDefined();

    const before = screen.getByRole('tab', { name: 'Before' });
    const after = screen.getByRole('tab', { name: 'After' });
    // After is the default side (ADR §A.9).
    expect(after.getAttribute('aria-selected')).toBe('true');
    expect(before.getAttribute('aria-selected')).toBe('false');

    await userEvent.click(before);
    expect(before.getAttribute('aria-selected')).toBe('true');
    expect(after.getAttribute('aria-selected')).toBe('false');
    // Still one rendered diagram surface, just the other version.
    expect(
      diagram.querySelector('[data-testid="mermaid-block"], .mermaid-fallback'),
    ).not.toBeNull();
  });

  it('scopes the sheet with .compare-surface so conversation amber is suppressed', async () => {
    vi.mocked(api.getDiff).mockResolvedValue(diff([]));
    renderDiff();
    await waitFor(() => {
      expect(screen.getByTestId('compare-surface')).toBeDefined();
    });
    expect(screen.getByTestId('compare-surface').className).toContain('compare-surface');
  });

  it('shows the to-version change note as the header subtitle', async () => {
    vi.mocked(api.getDiff).mockResolvedValue(diff([], 'Reworked the intro'));
    renderDiff();
    await waitFor(() => {
      expect(screen.getByText('Reworked the intro')).toBeDefined();
    });
    expect(screen.getByText(/Comparing v1/)).toBeDefined();
  });

  it('switches to the Source tab and diffs raw markdown', async () => {
    vi.mocked(api.getDiff).mockResolvedValue(
      diff([{ type: 'unchanged', beforeIndex: 0, afterIndex: 0, text: 'Kept.' }]),
    );
    vi.mocked(api.getVersionContent).mockResolvedValue('Before source.');
    renderDiff();
    await waitFor(() => {
      expect(screen.getByTestId('compare-rendered')).toBeDefined();
    });

    await userEvent.click(screen.getByRole('tab', { name: 'Source' }));
    await waitFor(() => {
      expect(screen.getByTestId('compare-source')).toBeDefined();
    });
    expect(api.getVersionContent).toHaveBeenCalledWith('d1', 'v1');
  });

  it('falls back to Source with a quiet notice when the diff is too large (413)', async () => {
    vi.mocked(api.getDiff).mockRejectedValue(new ApiError(413, 'diff_too_large'));
    vi.mocked(api.getVersionContent).mockResolvedValue('Before source.');
    renderDiff();

    await waitFor(() => {
      expect(screen.getByText(/Too large to compare rendered/)).toBeDefined();
    });
    expect(screen.getByRole('tab', { name: 'Source' }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => {
      expect(screen.getByTestId('compare-source')).toBeDefined();
    });
  });

  it('shows an honest tombstone message when a version was purged (410)', async () => {
    vi.mocked(api.getDiff).mockRejectedValue(new ApiError(410, 'version_purged'));
    renderDiff();
    await waitFor(() => {
      expect(screen.getByText(/v1 was purged/)).toBeDefined();
    });
    // Never fetches source for a purged version.
    expect(api.getVersionContent).not.toHaveBeenCalled();
  });

  it('shows a banner on a network/404 failure', async () => {
    vi.mocked(api.getDiff).mockRejectedValue(new ApiError(404, 'document_not_found'));
    renderDiff();
    await waitFor(() => {
      expect(screen.getByText('Could not load the comparison.')).toBeDefined();
    });
  });
});

// Layout of the shared source, block spans in it:
//   "Kept paragraph."   → [0,15)   (unchanged)
//   "Fresh paragraph."  → [17,33)  (added)
//   "New wording here." → [35,52)  (modified after)
const MAP_SOURCE = 'Kept paragraph.\n\nFresh paragraph.\n\nNew wording here.';
const MAP_BLOCKS: DiffBlockDto[] = [
  { type: 'unchanged', beforeIndex: 0, afterIndex: 0, text: 'Kept paragraph.' },
  { type: 'added', afterIndex: 1, text: 'Fresh paragraph.' },
  {
    type: 'modified',
    beforeIndex: 1,
    afterIndex: 2,
    before: 'Older wording here.',
    after: 'New wording here.',
  },
];

describe('mapThreadsToChips — thread → changed-block mapping', () => {
  it('buckets a thread whose midpoint falls in an added block', () => {
    const chips = mapThreadsToChips(MAP_BLOCKS, MAP_SOURCE, [
      makeThread({ id: 'c1', anchor: textAnchor(18, 30), start: 18, end: 30 }),
    ]);
    // Added block is at array index 1.
    expect([...chips.keys()]).toEqual([1]);
    expect(chips.get(1)).toEqual({ ids: ['c1'], movedCount: 0 });
  });

  it('buckets a thread whose midpoint falls in a modified block', () => {
    const chips = mapThreadsToChips(MAP_BLOCKS, MAP_SOURCE, [
      makeThread({ id: 'c1', anchor: textAnchor(36, 45), start: 36, end: 45 }),
    ]);
    expect(chips.get(2)).toEqual({ ids: ['c1'], movedCount: 0 });
  });

  it('gives no chip to a thread on an unchanged block', () => {
    const chips = mapThreadsToChips(MAP_BLOCKS, MAP_SOURCE, [
      makeThread({ id: 'c1', anchor: textAnchor(2, 8), start: 2, end: 8 }),
    ]);
    expect(chips.size).toBe(0);
  });

  it('gives no chip to a thread whose midpoint falls between blocks', () => {
    // start 15, end 17 → midpoint 16, the "\n\n" gap belonging to no block span.
    const chips = mapThreadsToChips(MAP_BLOCKS, MAP_SOURCE, [
      makeThread({ id: 'c1', anchor: textAnchor(15, 17), start: 15, end: 17 }),
    ]);
    expect(chips.size).toBe(0);
  });

  it('excludes orphaned threads (below the floor, no location)', () => {
    const chips = mapThreadsToChips(MAP_BLOCKS, MAP_SOURCE, [
      makeThread({
        id: 'c1',
        anchor: textAnchor(18, 30),
        method: 'orphan',
        confidence: 0.4,
        start: null,
        end: null,
      }),
    ]);
    expect(chips.size).toBe(0);
  });

  it('excludes resolved threads', () => {
    const chips = mapThreadsToChips(MAP_BLOCKS, MAP_SOURCE, [
      makeThread({ id: 'c1', status: 'resolved', anchor: textAnchor(18, 30), start: 18, end: 30 }),
    ]);
    expect(chips.size).toBe(0);
  });

  it('excludes whole-document anchors', () => {
    const chips = mapThreadsToChips(MAP_BLOCKS, MAP_SOURCE, [
      makeThread({ id: 'c1', anchor: { type: 'document' }, start: 18, end: 30 }),
    ]);
    expect(chips.size).toBe(0);
  });

  it('counts re-anchored-below-0.9 threads into the moved suffix', () => {
    const chips = mapThreadsToChips(MAP_BLOCKS, MAP_SOURCE, [
      makeThread({ id: 'c1', anchor: textAnchor(36, 45), start: 36, end: 45 }),
      makeThread({
        id: 'c2',
        anchor: textAnchor(35, 40),
        method: 'fuzzy',
        confidence: 0.8,
        start: 35,
        end: 40,
      }),
    ]);
    expect(chips.get(2)).toEqual({ ids: ['c1', 'c2'], movedCount: 1 });
  });

  it('maps a diagram thread by matching its blockIndex to a mermaid fence', () => {
    const source = '```mermaid\ngraph TD; A-->C\n```';
    const blocks: DiffBlockDto[] = [
      {
        type: 'modified',
        beforeIndex: 0,
        afterIndex: 0,
        before: '```mermaid\ngraph TD; A-->B\n```',
        after: source,
      },
    ];
    const diagramAnchor: AnchorDto = {
      type: 'diagram',
      blockIndex: 0,
      kind: 'node',
      stableId: 'A',
    };
    const chips = mapThreadsToChips(blocks, source, [
      makeThread({ id: 'c1', anchor: diagramAnchor }),
    ]);
    expect(chips.get(0)).toEqual({ ids: ['c1'], movedCount: 0 });
  });
});

describe('DiffView — thread chips on changed blocks', () => {
  const CHIP_SOURCE = 'Kept paragraph.\n\nFresh paragraph.';
  const CHIP_BLOCKS: DiffBlockDto[] = [
    { type: 'unchanged', beforeIndex: 0, afterIndex: 0, text: 'Kept paragraph.' },
    { type: 'added', afterIndex: 1, text: 'Fresh paragraph.' },
  ];

  function renderWithThreads(
    threads: ThreadDto[],
    handlers: { onOpenThread?: (id: string, openRail: boolean) => void; onClose?: () => void } = {},
  ): void {
    render(
      <DiffView
        documentId="d1"
        fromVersionId="v1"
        fromSeq={1}
        toSeq={2}
        currentSource={CHIP_SOURCE}
        dark={false}
        onClose={handlers.onClose ?? vi.fn()}
        threads={threads}
        onOpenThread={handlers.onOpenThread ?? vi.fn()}
      />,
    );
  }

  it('renders a singular neutral chip on the changed block', async () => {
    vi.mocked(api.getDiff).mockResolvedValue(diff(CHIP_BLOCKS));
    // "Fresh paragraph." spans [17,33); midpoint 24 lands in the added block.
    renderWithThreads([makeThread({ id: 'c1', anchor: textAnchor(18, 30), start: 18, end: 30 })]);

    const chip = await screen.findByTestId('compare-thread-chip');
    expect(chip.textContent).toBe('1 comment');
    // Neutral mono badge — no amber/blue, no confidence number.
    expect(chip.className).toContain('thread-badge');
    expect(chip.className).toContain('compare-thread-chip');
    expect(chip.textContent).not.toMatch(/%|\d+\s*%/);
  });

  it('pluralizes and appends the moved suffix', async () => {
    vi.mocked(api.getDiff).mockResolvedValue(diff(CHIP_BLOCKS));
    renderWithThreads([
      makeThread({ id: 'c1', anchor: textAnchor(18, 30), start: 18, end: 30 }),
      makeThread({
        id: 'c2',
        anchor: textAnchor(19, 25),
        method: 'fuzzy',
        confidence: 0.75,
        start: 19,
        end: 25,
      }),
    ]);
    const chip = await screen.findByTestId('compare-thread-chip');
    expect(chip.textContent).toBe('2 comments · 1 moved');
  });

  it('opens the single thread and closes Compare on click', async () => {
    vi.mocked(api.getDiff).mockResolvedValue(diff(CHIP_BLOCKS));
    const onOpenThread = vi.fn();
    const onClose = vi.fn();
    renderWithThreads([makeThread({ id: 'c1', anchor: textAnchor(18, 30), start: 18, end: 30 })], {
      onOpenThread,
      onClose,
    });
    const chip = await screen.findByTestId('compare-thread-chip');
    await userEvent.click(chip);
    // Single thread → select it, do NOT force the rail open.
    expect(onOpenThread).toHaveBeenCalledWith('c1', false);
    expect(onClose).toHaveBeenCalled();
  });

  it('opens the first thread and the rail when a block carries several', async () => {
    vi.mocked(api.getDiff).mockResolvedValue(diff(CHIP_BLOCKS));
    const onOpenThread = vi.fn();
    renderWithThreads(
      [
        makeThread({ id: 'c1', anchor: textAnchor(18, 30), start: 18, end: 30 }),
        makeThread({ id: 'c2', anchor: textAnchor(20, 28), start: 20, end: 28 }),
      ],
      { onOpenThread },
    );
    const chip = await screen.findByTestId('compare-thread-chip');
    await userEvent.click(chip);
    expect(onOpenThread).toHaveBeenCalledWith('c1', true);
  });

  it('shows no chips on the Source tab', async () => {
    vi.mocked(api.getDiff).mockResolvedValue(diff(CHIP_BLOCKS));
    vi.mocked(api.getVersionContent).mockResolvedValue('Before source.');
    renderWithThreads([makeThread({ id: 'c1', anchor: textAnchor(18, 30), start: 18, end: 30 })]);
    await screen.findByTestId('compare-thread-chip');

    await userEvent.click(screen.getByRole('tab', { name: 'Source' }));
    await waitFor(() => {
      expect(screen.getByTestId('compare-source')).toBeDefined();
    });
    expect(screen.queryByTestId('compare-thread-chip')).toBeNull();
  });

  it('renders no chip when no thread lands on a changed block', async () => {
    vi.mocked(api.getDiff).mockResolvedValue(diff(CHIP_BLOCKS));
    // Thread sits in the unchanged "Kept paragraph." block.
    renderWithThreads([makeThread({ id: 'c1', anchor: textAnchor(2, 8), start: 2, end: 8 })]);
    await screen.findByTestId('compare-rendered');
    expect(screen.queryByTestId('compare-thread-chip')).toBeNull();
  });
});

describe('DiffView — per-block resilience', () => {
  it('contains a block that cannot render, keeping the rest of the diff readable', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.getDiff).mockResolvedValue(
      diff([
        { type: 'unchanged', beforeIndex: 0, afterIndex: 0, text: 'Intro paragraph.' },
        { type: 'added', afterIndex: 1, text: '__BOOM__ broken block' },
        { type: 'added', afterIndex: 2, text: 'Another new paragraph.' },
      ]),
    );
    render(
      <DiffView
        documentId="d1"
        fromVersionId="v1"
        fromSeq={1}
        toSeq={2}
        currentSource="Intro paragraph."
        dark={false}
        onClose={vi.fn()}
      />,
    );

    // The failed block says so and shows its source…
    expect(
      await screen.findByText("This block couldn't be displayed — here is its source."),
    ).toBeDefined();
    expect(screen.getByRole('alert').textContent).toContain('broken block');
    // …and every other block on the sheet still rendered, as did the chrome.
    expect(screen.getByText('Intro paragraph.')).toBeDefined();
    expect(screen.getByText('Another new paragraph.')).toBeDefined();
    expect(screen.getByTestId('compare-rendered')).toBeDefined();
    // Never the whole-page fallback.
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    spy.mockRestore();
  });
});
