// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OverviewDocumentDto, ProjectDto } from '../api/client.js';
import { DocumentList } from './document-list.js';

const project: ProjectDto = {
  id: 'p1',
  name: 'Ops',
  color: '#0e7490',
  archivedAt: null,
  createdAt: '2026-07-01T00:00:00Z',
  createdBy: 'u1',
};

const project2: ProjectDto = {
  id: 'p2',
  name: 'Infra',
  color: '#7c3aed',
  archivedAt: null,
  createdAt: '2026-07-01T00:00:00Z',
  createdBy: 'u1',
};

function doc(overrides: Partial<OverviewDocumentDto> = {}): OverviewDocumentDto {
  return {
    id: 'd1',
    projectId: null,
    ownerId: 'u1',
    title: 'runbook.md',
    currentVersionId: 'v1',
    archivedAt: null,
    createdAt: '2026-07-02T00:00:00Z',
    path: null,
    open: 0,
    resolved: 0,
    lastActivityAt: '2026-07-02T00:00:00Z',
    reviewStatus: 'draft',
    ...overrides,
  };
}

type Handler =
  'onOpen' | 'onMove' | 'onArchive' | 'onDelete' | 'onBulkArchive' | 'onBulkMove' | 'onBulkDelete';

function renderList(
  overrides: Partial<Parameters<typeof DocumentList>[0]> = {},
): Record<Handler, ReturnType<typeof vi.fn>> {
  const handlers = {
    onOpen: vi.fn(),
    onMove: vi.fn(),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
    onBulkArchive: vi.fn(),
    onBulkMove: vi.fn(),
    onBulkDelete: vi.fn(),
  };
  render(
    <DocumentList
      documents={[doc()]}
      projects={[project]}
      archivedView={false}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

async function openMenu(title: string): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: `More actions for ${title}` }));
}

afterEach(cleanup);

describe('DocumentList', () => {
  it('shows the empty state when there is nothing to list', () => {
    renderList({ documents: [] });
    expect(screen.getByText('No documents yet')).toBeDefined();
  });

  it('renders rows with mono titles and the project rail color', () => {
    renderList({ documents: [doc({ projectId: 'p1' })] });
    const row = screen.getByTestId('doc-row');
    expect(row.textContent).toContain('runbook.md');
    expect(row.getAttribute('style')).toContain('border-left-color');
  });

  it('shows both open and resolved counts in the signal', () => {
    renderList({ documents: [doc({ open: 2, resolved: 1 })] });
    expect(screen.getByText('2 open · 1 resolved')).toBeDefined();
  });

  it('shows the resolved signal when nothing is open', () => {
    renderList({ documents: [doc({ open: 0, resolved: 3 })] });
    expect(screen.getByText('✓ 3 resolved')).toBeDefined();
  });

  it('opens the document when the row itself is clicked', async () => {
    const { onOpen } = renderList();
    await userEvent.click(screen.getByTestId('doc-row'));
    expect(onOpen).toHaveBeenCalledWith('d1');
  });

  it('opens the document exactly once when the title link is clicked', async () => {
    const { onOpen } = renderList();
    await userEvent.click(screen.getByRole('button', { name: 'runbook.md' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('d1');
  });

  it('does not open the document when the row checkbox is toggled', async () => {
    const { onOpen } = renderList();
    await userEvent.click(screen.getByLabelText('Select runbook.md'));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('marks the list as selecting once any row is checked', async () => {
    renderList();
    const list = screen.getByTestId('doc-row').closest('ul')!;
    expect(list.className).not.toContain('doc-list--selecting');
    await userEvent.click(screen.getByLabelText('Select runbook.md'));
    expect(list.className).toContain('doc-list--selecting');
  });

  it('selecting rows reveals the bulk bar and bulk-archives', async () => {
    const { onBulkArchive } = renderList({
      documents: [doc(), doc({ id: 'd2', title: 'spec.md' })],
    });
    await userEvent.click(screen.getByLabelText('Select runbook.md'));
    await userEvent.click(screen.getByLabelText('Select spec.md'));
    expect(screen.getByTestId('bulk-bar').textContent).toContain('2 selected');
    await userEvent.click(screen.getByTestId('bulk-bar').querySelector('button')!);
    expect(onBulkArchive).toHaveBeenCalledWith(['d1', 'd2'], true);
  });

  it('bulk delete passes every selected id', async () => {
    const { onBulkDelete } = renderList({
      documents: [doc(), doc({ id: 'd2', title: 'spec.md' })],
    });
    await userEvent.click(screen.getByLabelText('Select runbook.md'));
    await userEvent.click(screen.getByLabelText('Select spec.md'));
    const bar = screen.getByTestId('bulk-bar');
    const del = [...bar.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!;
    await userEvent.click(del);
    expect(onBulkDelete).toHaveBeenCalledWith(['d1', 'd2']);
  });

  describe('select-all head row', () => {
    it('is hidden until a row is selected, then appears with the right label', async () => {
      renderList({ documents: [doc(), doc({ id: 'd2', title: 'spec.md' })] });
      expect(screen.queryByLabelText('Select all')).toBeNull();
      await userEvent.click(screen.getByLabelText('Select runbook.md'));
      expect(screen.getByLabelText('Select all')).toBeDefined();
      await userEvent.click(screen.getByLabelText('Select spec.md'));
      expect(screen.getByLabelText('Deselect all')).toBeDefined();
    });
  });

  describe('kebab menu', () => {
    it('opens on click and does not open the document', async () => {
      const { onOpen } = renderList();
      await openMenu('runbook.md');
      expect(screen.getByRole('menu')).toBeDefined();
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('archives via the menu without opening the document', async () => {
      const { onArchive, onOpen } = renderList();
      await openMenu('runbook.md');
      await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
      expect(onArchive).toHaveBeenCalledWith('d1', true);
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('deletes via the menu without opening the document', async () => {
      const { onDelete, onOpen } = renderList();
      await openMenu('runbook.md');
      await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
      expect(onDelete).toHaveBeenCalledWith('d1');
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('moves to a project via the menu without opening the document', async () => {
      const { onMove, onOpen } = renderList({ projects: [project, project2] });
      await openMenu('runbook.md');
      await userEvent.click(screen.getByRole('menuitem', { name: /Infra/ }));
      expect(onMove).toHaveBeenCalledWith('d1', 'p2');
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('moves to Unfiled via the menu', async () => {
      const { onMove } = renderList({ documents: [doc({ projectId: 'p1' })] });
      await openMenu('runbook.md');
      await userEvent.click(screen.getByRole('menuitem', { name: /Unfiled/ }));
      expect(onMove).toHaveBeenCalledWith('d1', null);
    });

    it('marks the current location non-clickable and does not call onMove', async () => {
      const { onMove } = renderList();
      await openMenu('runbook.md');
      const current = screen.getByRole('menuitem', { name: /Unfiled/ });
      expect(current).toHaveProperty('disabled', true);
      await userEvent.click(current);
      expect(onMove).not.toHaveBeenCalled();
    });

    it('shows only Restore and Delete in the archived view', async () => {
      const { onArchive } = renderList({ archivedView: true });
      await openMenu('runbook.md');
      const menu = screen.getByRole('menu');
      expect(within(menu).getByRole('menuitem', { name: 'Restore' })).toBeDefined();
      expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toBeDefined();
      expect(within(menu).queryByText('Move to')).toBeNull();
      expect(within(menu).queryByRole('menuitem', { name: /Unfiled/ })).toBeNull();
      await userEvent.click(within(menu).getByRole('menuitem', { name: 'Restore' }));
      expect(onArchive).toHaveBeenCalledWith('d1', false);
    });

    it('closes on outside click', async () => {
      renderList();
      await openMenu('runbook.md');
      expect(screen.getByRole('menu')).toBeDefined();
      await userEvent.click(document.body);
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('closes on Escape', async () => {
      renderList();
      await openMenu('runbook.md');
      expect(screen.getByRole('menu')).toBeDefined();
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('only one row menu is open at a time', async () => {
      renderList({ documents: [doc(), doc({ id: 'd2', title: 'spec.md' })] });
      await openMenu('runbook.md');
      expect(screen.getAllByRole('menu')).toHaveLength(1);
      await openMenu('spec.md');
      expect(screen.getAllByRole('menu')).toHaveLength(1);
      expect(
        screen
          .queryByRole('button', { name: 'More actions for runbook.md' })
          ?.getAttribute('aria-expanded'),
      ).toBe('false');
    });
  });

  // C2: Unfiled/Archived/per-project lanes never grouped documents into
  // folders, and (before this) never showed a path either, so a repo-linked
  // project rendered flat and disorganized in exactly those lanes.
  describe('doc-row-path (C2)', () => {
    it('shows a path line under the title in the flat (ungrouped) branch', () => {
      renderList({
        groupByProject: false,
        documents: [doc({ id: 'd1', title: 'a.md', path: 'docs/specs/a.md' })],
      });
      expect(screen.getByText('docs/specs/a.md')).toBeDefined();
      expect(document.querySelectorAll('.doc-row-path')).toHaveLength(1);
    });

    it('omits the path line for a flat-branch document with no path', () => {
      renderList({
        groupByProject: false,
        documents: [doc({ id: 'd1', title: 'a.md', path: null })],
      });
      expect(document.querySelectorAll('.doc-row-path')).toHaveLength(0);
    });

    it('never shows the path line in the grouped (All-lane) branch — folder headers already say it', () => {
      renderList({
        groupByProject: true,
        projects: [project],
        documents: [
          // Root-level (single-segment) path, rendered via renderRow directly.
          doc({ id: 'd1', title: 'root.md', projectId: 'p1', path: 'root.md' }),
          // Multi-segment path, rendered nested under a folder header.
          doc({ id: 'd2', title: 'nested.md', projectId: 'p1', path: 'docs/specs/nested.md' }),
        ],
      });
      expect(document.querySelectorAll('.doc-row-path')).toHaveLength(0);
    });
  });

  describe('groupByProject', () => {
    it('stays a flat list when groupByProject is false', () => {
      renderList({
        groupByProject: false,
        documents: [
          doc({ id: 'd1', title: 'a.md', projectId: 'p1' }),
          doc({ id: 'd2', title: 'b.md' }),
        ],
      });
      expect(screen.queryByText('Ops')).toBeNull();
      expect(screen.queryByText('Unfiled')).toBeNull();
    });

    it('renders group headers with a mono count, ordered by most recent activity', () => {
      renderList({
        groupByProject: true,
        projects: [project, project2],
        documents: [
          doc({
            id: 'd1',
            title: 'old-ops.md',
            projectId: 'p1',
            lastActivityAt: '2026-07-01T00:00:00Z',
          }),
          doc({
            id: 'd2',
            title: 'unfiled-newest.md',
            projectId: null,
            lastActivityAt: '2026-07-15T00:00:00Z',
          }),
          doc({
            id: 'd3',
            title: 'infra.md',
            projectId: 'p2',
            lastActivityAt: '2026-07-10T00:00:00Z',
          }),
        ],
      });
      const headings = screen
        .getAllByText(/^(Ops|Infra|Unfiled)$/)
        .map((el) => el.closest('li')?.textContent);
      // Unfiled (Jul 15) > Infra (Jul 10) > Ops (Jul 1)
      expect(headings[0]).toContain('Unfiled');
      expect(headings[0]).toContain('1');
      expect(headings[1]).toContain('Infra');
      expect(headings[2]).toContain('Ops');
    });

    it('omits groups with no loaded documents', () => {
      renderList({
        groupByProject: true,
        projects: [project, project2],
        documents: [doc({ id: 'd1', title: 'a.md', projectId: 'p1' })],
      });
      expect(screen.getByText('Ops')).toBeDefined();
      expect(screen.queryByText('Infra')).toBeNull();
    });

    it('clicking a project group header calls onOpenProject with its id', async () => {
      const onOpenProject = vi.fn();
      renderList({
        groupByProject: true,
        onOpenProject,
        projects: [project],
        documents: [doc({ id: 'd1', title: 'a.md', projectId: 'p1' })],
      });
      await userEvent.click(screen.getByRole('button', { name: /Ops/ }));
      expect(onOpenProject).toHaveBeenCalledTimes(1);
      expect(onOpenProject).toHaveBeenCalledWith('p1');
    });

    it('the Unfiled group header is not a button and never calls onOpenProject', async () => {
      const onOpenProject = vi.fn();
      renderList({
        groupByProject: true,
        onOpenProject,
        documents: [doc({ id: 'd1', title: 'a.md', projectId: null })],
      });
      const header = screen.getByText('Unfiled').closest('li')!;
      expect(within(header).queryByRole('button')).toBeNull();
      await userEvent.click(header);
      expect(onOpenProject).not.toHaveBeenCalled();
    });

    // Phase 34.C — folder nesting within a project group.
    it('nests multi-segment paths under folder headers, keeping root-level and null-path docs flat in activity order', () => {
      renderList({
        groupByProject: true,
        projects: [project],
        documents: [
          doc({
            id: 'd1',
            title: 'newest.md',
            projectId: 'p1',
            path: null,
            lastActivityAt: '2026-07-03T00:00:00Z',
          }),
          doc({
            id: 'd2',
            title: 'a.md',
            projectId: 'p1',
            path: 'docs/specs/a.md',
            lastActivityAt: '2026-07-02T00:00:00Z',
          }),
          doc({
            id: 'd3',
            title: 'README.md',
            projectId: 'p1',
            path: 'README.md',
            lastActivityAt: '2026-07-01T00:00:00Z',
          }),
        ],
      });
      // Folder structure shows up.
      expect(screen.getByText('docs')).toBeDefined();
      expect(screen.getByText('specs')).toBeDefined();
      expect(screen.getByRole('button', { name: 'a.md' })).toBeDefined();
      // Root-level docs (null path, single-segment path) stay flat, ahead of
      // the folder, in the server's activity order — not re-sorted
      // alphabetically the way buildPathTree's own rootDocs would.
      const rows = screen.getAllByTestId('doc-row').map((r) => r.textContent);
      const newestIdx = rows.findIndex((t) => t.includes('newest.md'));
      const readmeIdx = rows.findIndex((t) => t.includes('README.md'));
      const aIdx = rows.findIndex((t) => t.includes('a.md'));
      expect(newestIdx).toBeLessThan(readmeIdx);
      expect(readmeIdx).toBeLessThan(aIdx);
    });

    it('renders a project group with no multi-segment paths exactly as before this phase (no folders)', () => {
      renderList({
        groupByProject: true,
        projects: [project],
        documents: [
          doc({ id: 'd1', title: 'a.md', projectId: 'p1', path: null }),
          doc({ id: 'd2', title: 'b.md', projectId: 'p1', path: 'b.md' }),
        ],
      });
      expect(document.querySelector('.tree-folder')).toBeNull();
      expect(screen.getAllByTestId('doc-row')).toHaveLength(2);
    });
  });

  // Phase 34.D — repo-linkage badge and confirm gates on repo-backed docs.
  describe('repo-backed documents', () => {
    it('shows a repo-link badge only for documents with a path', () => {
      renderList({
        documents: [
          doc({ id: 'd1', title: 'linked.md', path: 'linked.md' }),
          doc({ id: 'd2', title: 'manual.md', path: null }),
        ],
      });
      const rows = screen.getAllByTestId('doc-row');
      expect(within(rows[0]!).getByText('from the repo')).toBeDefined();
      expect(within(rows[1]!).queryByText('from the repo')).toBeNull();
    });

    it('archiving a repo-backed doc requires confirmation before it runs', async () => {
      const { onArchive, onBulkArchive } = renderList({
        documents: [doc({ path: 'docs/a.md' })],
      });
      await openMenu('runbook.md');
      await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
      expect(onArchive).not.toHaveBeenCalled();
      expect(onBulkArchive).not.toHaveBeenCalled();
      const dialog = await screen.findByTestId('confirm-dialog');
      expect(dialog.textContent).toContain('linked to a local folder');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
      expect(onBulkArchive).toHaveBeenCalledWith(['d1'], true);
    });

    it('restoring a repo-backed doc stays instant — restore is never destructive', async () => {
      const { onArchive } = renderList({
        archivedView: true,
        documents: [doc({ path: 'docs/a.md' })],
      });
      await openMenu('runbook.md');
      await userEvent.click(screen.getByRole('menuitem', { name: 'Restore' }));
      expect(onArchive).toHaveBeenCalledWith('d1', false);
      expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    });

    it('moving a repo-backed doc requires confirmation before it runs', async () => {
      const { onMove, onBulkMove } = renderList({
        projects: [project, project2],
        documents: [doc({ path: 'docs/a.md' })],
      });
      await openMenu('runbook.md');
      await userEvent.click(screen.getByRole('menuitem', { name: /Infra/ }));
      expect(onMove).not.toHaveBeenCalled();
      const dialog = await screen.findByTestId('confirm-dialog');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
      expect(onBulkMove).toHaveBeenCalledWith(['d1'], 'p2');
    });

    it('archiving a plain (non-repo-backed) doc stays instant, unchanged from before this phase', async () => {
      const { onArchive } = renderList();
      await openMenu('runbook.md');
      await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
      expect(onArchive).toHaveBeenCalledWith('d1', true);
      expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    });

    it('bulk-archiving gates as soon as any selected doc is repo-backed', async () => {
      const { onBulkArchive } = renderList({
        documents: [
          doc({ id: 'd1', title: 'a.md' }),
          doc({ id: 'd2', title: 'b.md', path: 'docs/b.md' }),
        ],
      });
      await userEvent.click(screen.getByLabelText('Select a.md'));
      await userEvent.click(screen.getByLabelText('Select b.md'));
      await userEvent.click(screen.getByTestId('bulk-bar').querySelector('button')!);
      expect(onBulkArchive).not.toHaveBeenCalled();
      const dialog = await screen.findByTestId('confirm-dialog');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
      expect(onBulkArchive).toHaveBeenCalledWith(['d1', 'd2'], true);
    });
  });
});
