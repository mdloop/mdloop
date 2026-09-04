// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectTreeDocumentDto } from '../api/client.js';
import { buildPathTree } from '../path-tree.js';
import { ProjectTree } from './project-tree.js';

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
});

function doc(overrides: Partial<ProjectTreeDocumentDto> = {}): ProjectTreeDocumentDto {
  return {
    id: 'd1',
    title: 'doc.md',
    path: null,
    openCommentCount: 0,
    reviewStatus: 'draft',
    ...overrides,
  };
}

const fixture: ProjectTreeDocumentDto[] = [
  doc({ id: 'manual', title: 'manual.md', path: null }),
  doc({ id: 'a', title: 'a.md', path: 'docs/specs/a.md', openCommentCount: 2 }),
  doc({ id: 'b', title: 'b.md', path: 'docs/specs/b.md', openCommentCount: 3 }),
  doc({ id: 'c', title: 'c.md', path: 'docs/guide/c.md', openCommentCount: 0 }),
];

function renderTree(
  docs: ProjectTreeDocumentDto[] = fixture,
  projectId = 'p1',
): { onOpen: ReturnType<typeof vi.fn> } {
  const onOpen = vi.fn();
  render(<ProjectTree projectId={projectId} tree={buildPathTree(docs)} onOpen={onOpen} />);
  return { onOpen };
}

describe('ProjectTree', () => {
  it('renders nested folders and root-level documents', () => {
    renderTree();

    expect(screen.getByText('manual.md')).toBeTruthy();
    expect(screen.getByText('docs')).toBeTruthy();
    expect(screen.getByText('specs')).toBeTruthy();
    expect(screen.getByText('guide')).toBeTruthy();
    expect(screen.getByText('a.md')).toBeTruthy();
    expect(screen.getByText('b.md')).toBeTruthy();
    expect(screen.getByText('c.md')).toBeTruthy();
  });

  it('opens a document on click', async () => {
    const { onOpen } = renderTree();
    await userEvent.click(screen.getByTitle('Open manual.md'));
    expect(onOpen).toHaveBeenCalledWith('manual');
  });

  it('shows the aggregated open-comment count on folder rows, hiding it at zero', () => {
    renderTree();

    const docsRow = screen.getByTitle('docs').closest('button')!;
    expect(within(docsRow).getByText('5')).toBeTruthy(); // 2 + 3 + 0

    const specsRow = screen.getByTitle('docs/specs').closest('button')!;
    expect(within(specsRow).getByText('5')).toBeTruthy();

    const guideRow = screen.getByTitle('docs/guide').closest('button')!;
    expect(within(guideRow).queryByText('0')).toBeNull();
  });

  it('collapses and expands a folder on click, hiding its descendants', async () => {
    renderTree();
    expect(screen.getByText('specs')).toBeTruthy();

    await userEvent.click(screen.getByTitle('docs'));
    expect(screen.queryByText('specs')).toBeNull();
    expect(screen.queryByText('a.md')).toBeNull();

    await userEvent.click(screen.getByTitle('docs'));
    expect(screen.getByText('specs')).toBeTruthy();
  });

  it('persists collapse state per project across a remount', async () => {
    renderTree(fixture, 'p1');
    await userEvent.click(screen.getByTitle('docs'));
    expect(screen.queryByText('specs')).toBeNull();
    cleanup();

    // Same project id: the collapsed folder stays collapsed after "reload".
    renderTree(fixture, 'p1');
    expect(screen.queryByText('specs')).toBeNull();
    cleanup();

    // A different project id keys its own collapse state — unaffected.
    renderTree(fixture, 'p2');
    expect(screen.getByText('specs')).toBeTruthy();
  });

  it('narrows by path substring and auto-expands matching folders', async () => {
    renderTree();
    await userEvent.click(screen.getByTitle('docs')); // collapse first
    expect(screen.queryByText('guide')).toBeNull();

    await userEvent.type(screen.getByLabelText('Filter documents by path'), 'guide');

    // Auto-expanded despite being collapsed above, because it contains a match.
    expect(screen.getByText('guide')).toBeTruthy();
    expect(screen.getByText('c.md')).toBeTruthy();
    // Non-matching siblings drop out of the filtered view.
    expect(screen.queryByText('specs')).toBeNull();
    expect(screen.queryByText('a.md')).toBeNull();
    expect(screen.queryByText('manual.md')).toBeNull();
  });

  it('shows a no-match message when the filter matches nothing', async () => {
    renderTree();
    await userEvent.type(screen.getByLabelText('Filter documents by path'), 'nonexistent-path');
    expect(screen.getByText(/No paths match/)).toBeTruthy();
  });

  // Phase 34.D — repo-linkage badge, root-only (every doc inside a folder is
  // repo-linked by construction, so the badge would be redundant there).
  it('badges a repo-backed root doc but never a manual one or a nested one', () => {
    renderTree([...fixture, doc({ id: 'readme', title: 'README.md', path: 'README.md' })]);

    const manualRow = screen.getByText('manual.md').closest('button')!;
    expect(within(manualRow).queryByText('from the repo')).toBeNull();

    const readmeRow = screen.getByText('README.md').closest('button')!;
    expect(within(readmeRow).getByText('from the repo')).toBeTruthy();

    const nestedRow = screen.getByText('a.md').closest('button')!;
    expect(within(nestedRow).queryByText('from the repo')).toBeNull();
  });
});
