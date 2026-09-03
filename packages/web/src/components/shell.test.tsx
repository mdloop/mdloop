// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as clientModule from '../api/client.js';
import { ApiError, api } from '../api/client.js';
import type {
  Me,
  OverviewDocumentDto,
  OverviewDto,
  ProjectDto,
  ProjectTreeDto,
} from '../api/client.js';
import { Shell } from './shell.js';

vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual<typeof clientModule>('../api/client.js');
  return {
    ...actual,
    api: {
      overview: vi.fn(),
      getProjectTree: vi.fn(),
      createProject: vi.fn(),
      patchProject: vi.fn(),
      deleteProject: vi.fn(),
      uploadDocument: vi.fn(),
      patchDocument: vi.fn(),
      deleteDocument: vi.fn(),
    },
  };
});

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(cleanup);

const me: Me = { userId: 'u1', orgId: 'org1', role: 'member' };

function project(overrides: Partial<ProjectDto> = {}): ProjectDto {
  return {
    id: 'p1',
    name: 'Ops',
    color: '#7c3aed',
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: me.userId,
    ...overrides,
  };
}

function overview(projects: ProjectDto[]): OverviewDto {
  return {
    documents: [],
    nextCursor: null,
    projects,
    counts: { all: 0, unfiled: 0, archived: 0 },
    openByProject: [],
  };
}

function renderShell(projects: ProjectDto[], onOpenOrgSettings = vi.fn()): void {
  vi.mocked(api.overview).mockResolvedValue(overview(projects));
  render(
    <Shell
      me={me}
      mode="light"
      setMode={vi.fn()}
      onLogout={vi.fn()}
      onOpenDocument={vi.fn()}
      onOpenOrgSettings={onOpenOrgSettings}
    />,
  );
}

describe('Shell project management', () => {
  it('renames a project via the row menu', async () => {
    const p = project();
    renderShell([p]);
    await screen.findByTitle('Ops');

    await userEvent.click(screen.getByLabelText('More actions for Ops'));
    await userEvent.click(screen.getByRole('menuitem', { name: /Rename/ }));

    const input = screen.getByLabelText('Project name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Renamed Ops');
    vi.mocked(api.patchProject).mockResolvedValue({ ...p, name: 'Renamed Ops' });
    vi.mocked(api.overview).mockResolvedValue(overview([{ ...p, name: 'Renamed Ops' }]));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(api.patchProject).toHaveBeenCalledWith('p1', { name: 'Renamed Ops', color: p.color });
    });
    await screen.findByTitle('Renamed Ops');
  });

  it('deletes a project after confirmation', async () => {
    const p = project();
    renderShell([p]);
    await screen.findByTitle('Ops');

    await userEvent.click(screen.getByLabelText('More actions for Ops'));
    await userEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));

    const dialog = await screen.findByTestId('confirm-dialog');
    vi.mocked(api.deleteProject).mockResolvedValue(undefined);
    vi.mocked(api.overview).mockResolvedValue(overview([]));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(api.deleteProject).toHaveBeenCalledWith('p1');
    });
    await waitFor(() => {
      expect(screen.queryByTitle('Ops')).toBeNull();
    });
  });

  it('shows readable copy when a project action fails, never the raw error code', async () => {
    const p = project();
    renderShell([p]);
    await screen.findByTitle('Ops');

    await userEvent.click(screen.getByLabelText('More actions for Ops'));
    await userEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));

    const dialog = await screen.findByTestId('confirm-dialog');
    vi.mocked(api.deleteProject).mockRejectedValue(new ApiError(403, 'forbidden'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('You do not have access to do that.')).toBeDefined();
    expect(screen.queryByText(/Request failed/)).toBeNull();
    expect(screen.queryByText(/forbidden/)).toBeNull();
  });

  it('falls back to a generic apology for an unmapped code', async () => {
    const p = project();
    renderShell([p]);
    await screen.findByTitle('Ops');

    await userEvent.click(screen.getByLabelText('More actions for Ops'));
    await userEvent.click(screen.getByRole('menuitem', { name: /Rename/ }));
    const input = screen.getByLabelText('Project name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Renamed Ops');
    vi.mocked(api.patchProject).mockRejectedValue(new ApiError(400, 'some_new_server_code'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Something went wrong — try again.')).toBeDefined();
    expect(screen.queryByText(/some_new_server_code/)).toBeNull();
  });
});

describe('Shell repo-sync hint', () => {
  function doc(overrides: Partial<OverviewDocumentDto> = {}): OverviewDocumentDto {
    return {
      id: 'd1',
      projectId: 'p1',
      ownerId: me.userId,
      title: 'Runbook',
      currentVersionId: 'v1',
      archivedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
      path: null,
      open: 0,
      resolved: 0,
      lastActivityAt: '2026-01-01T00:00:00Z',
      reviewStatus: 'draft',
      ...overrides,
    };
  }

  function tree(paths: (string | null)[]): ProjectTreeDto {
    return {
      projectId: 'p1',
      tooLarge: false,
      documentCount: paths.length,
      documents: paths.map((path, i) => ({
        id: `t${String(i)}`,
        title: `Doc ${String(i)}`,
        path,
        openCommentCount: 0,
        reviewStatus: 'draft' as const,
      })),
    };
  }

  it('nudges an empty home lane toward vorlyn link', async () => {
    renderShell([]);
    const hint = await screen.findByTestId('cli-hint');
    expect(hint.textContent).toContain('local folder');
    // Command is collapsed by default (Phase 34.E) — expand to see it.
    await userEvent.click(within(hint).getByRole('button', { name: /local folder/i }));
    expect(hint.textContent).toContain('vorlyn link');
  });

  it('points at org settings, the only route a member has to an API key', async () => {
    const onOpenOrgSettings = vi.fn();
    renderShell([], onOpenOrgSettings);
    const hint = await screen.findByTestId('cli-hint');

    await userEvent.click(within(hint).getByRole('button', { name: 'Learn more' }));
    expect(onOpenOrgSettings).toHaveBeenCalled();
  });

  it('keeps nudging inside a project that the CLI has never touched, with the project id baked into the command', async () => {
    renderShell([project()]);
    await screen.findByTitle('Ops');
    vi.mocked(api.overview).mockResolvedValue({ ...overview([project()]), documents: [doc()] });
    vi.mocked(api.getProjectTree).mockResolvedValue(tree([null]));

    await userEvent.click(screen.getByTitle('Ops'));
    const hint = await screen.findByTestId('cli-hint');
    await userEvent.click(within(hint).getByRole('button', { name: /local folder/i }));
    expect(hint.textContent).toContain('vorlyn link --project p1');
  });

  it('copies the project-scoped command to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderShell([project()]);
    await screen.findByTitle('Ops');
    vi.mocked(api.overview).mockResolvedValue({ ...overview([project()]), documents: [doc()] });
    vi.mocked(api.getProjectTree).mockResolvedValue(tree([null]));

    await userEvent.click(screen.getByTitle('Ops'));
    const hint = await screen.findByTestId('cli-hint');
    await userEvent.click(within(hint).getByRole('button', { name: /local folder/i }));
    await userEvent.click(within(hint).getByTitle('Copy command'));
    expect(writeText).toHaveBeenCalledWith('vorlyn link --project p1');
  });

  it('replaces the hint with a persistent linked indicator once the project is CLI-linked', async () => {
    renderShell([project()]);
    await screen.findByTitle('Ops');
    vi.mocked(api.overview).mockResolvedValue({
      ...overview([project()]),
      documents: [doc({ path: 'docs/runbook.md' })],
    });
    vi.mocked(api.getProjectTree).mockResolvedValue(tree(['docs/runbook.md']));

    await userEvent.click(screen.getByTitle('Ops'));
    await screen.findByText('docs');
    expect(screen.queryByTestId('cli-hint')).toBeNull();
    expect(screen.getByTestId('cli-linked-indicator').textContent).toContain(
      'Linked to local folder',
    );
  });

  it('shows the unlinked hint at the top of a project view even when it has other documents', async () => {
    renderShell([project()]);
    await screen.findByTitle('Ops');
    vi.mocked(api.overview).mockResolvedValue({ ...overview([project()]), documents: [doc()] });
    vi.mocked(api.getProjectTree).mockResolvedValue(tree([null]));

    await userEvent.click(screen.getByTitle('Ops'));
    await screen.findByTestId('cli-hint');
    expect(screen.queryByTestId('cli-linked-indicator')).toBeNull();
  });

  it('stays out of the archived lane', async () => {
    renderShell([]);
    await screen.findByTestId('cli-hint');
    await userEvent.click(screen.getByTitle('Archived documents'));
    await waitFor(() => {
      expect(screen.queryByTestId('cli-hint')).toBeNull();
    });
  });
});

describe('Shell mobile lane drawer (Phase 39.F)', () => {
  it('opens via the header trigger and closes on lane selection', async () => {
    renderShell([project()]);
    await screen.findByTitle('Ops');
    expect(screen.queryByTestId('lane-drawer-backdrop')).toBeNull();

    await userEvent.click(screen.getByLabelText('Open lanes'));
    expect(screen.getByTestId('lane-drawer-backdrop')).toBeDefined();

    await userEvent.click(screen.getByTitle('Ops'));
    expect(screen.queryByTestId('lane-drawer-backdrop')).toBeNull();
  });

  it('closes on backdrop click without changing the lane', async () => {
    renderShell([]);
    await screen.findByTestId('cli-hint');
    await userEvent.click(screen.getByLabelText('Open lanes'));

    await userEvent.click(screen.getByTestId('lane-drawer-backdrop'));
    expect(screen.queryByTestId('lane-drawer-backdrop')).toBeNull();
    // Still on the "All documents" lane — the backdrop only dismisses.
    expect(await screen.findByTestId('cli-hint')).toBeDefined();
  });

  it('closes on Escape', async () => {
    renderShell([]);
    await screen.findByTestId('cli-hint');
    await userEvent.click(screen.getByLabelText('Open lanes'));
    expect(screen.getByTestId('lane-drawer-backdrop')).toBeDefined();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('lane-drawer-backdrop')).toBeNull();
  });
});
