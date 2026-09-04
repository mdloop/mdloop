// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '../api/client.js';
import type * as clientModule from '../api/client.js';
import { api } from '../api/client.js';
import { AppHeader } from './app-header.js';
import type { AppHeaderProps } from './app-header.js';

vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual<typeof clientModule>('../api/client.js');
  return {
    ...actual,
    api: {
      searchDocuments: vi.fn(),
    },
  };
});

const admin: Me = { userId: 'u1', orgId: 'o1', role: 'admin' };
const member: Me = { userId: 'u2', orgId: 'o1', role: 'member' };

afterEach(cleanup);

function renderHeader(overrides: Partial<AppHeaderProps> = {}): {
  onLogout: ReturnType<typeof vi.fn>;
  onNavigateHome: ReturnType<typeof vi.fn>;
  onOpenDocument: ReturnType<typeof vi.fn>;
  onOpenSettings: ReturnType<typeof vi.fn>;
} {
  const onLogout = vi.fn();
  const onNavigateHome = vi.fn();
  const onOpenDocument = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <AppHeader
      me={admin}
      mode="light"
      setMode={vi.fn()}
      onLogout={onLogout}
      onNavigateHome={onNavigateHome}
      onOpenDocument={onOpenDocument}
      onOpenSettings={onOpenSettings}
      {...overrides}
    />,
  );
  return { onLogout, onNavigateHome, onOpenDocument, onOpenSettings };
}

beforeEach(() => {
  vi.mocked(api.searchDocuments).mockResolvedValue({ hits: [], commentHits: [] });
});

describe('AppHeader identity menu', () => {
  it('opens the menu from the avatar trigger', async () => {
    renderHeader();
    const trigger = screen.getByRole('button', { name: 'Account menu' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu')).toBeDefined();
  });

  it('fires onLogout when Sign out is clicked', async () => {
    const { onLogout } = renderHeader();
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(onLogout).toHaveBeenCalled();
  });

  it('shows Settings for admins when onOpenSettings is passed', async () => {
    const { onOpenSettings } = renderHeader({ me: admin });
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('hides Settings for non-admins', async () => {
    renderHeader({ me: member });
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.queryByRole('menuitem', { name: 'Settings' })).toBeNull();
  });

  it('hides Settings when the callback is not passed (the settings shell itself)', async () => {
    renderHeader({ me: admin, onOpenSettings: undefined });
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.queryByRole('menuitem', { name: 'Settings' })).toBeNull();
  });

  it('closes on outside click', async () => {
    renderHeader();
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.getByRole('menu')).toBeDefined();
    await userEvent.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Escape', async () => {
    renderHeader();
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.getByRole('menu')).toBeDefined();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('AppHeader search', () => {
  it('moves the active hit with arrow keys and opens it on Enter', async () => {
    vi.mocked(api.searchDocuments).mockResolvedValue({
      hits: [
        { documentId: 'd1', title: 'Alpha', projectId: null, path: null, rank: 1 },
        { documentId: 'd2', title: 'Beta', projectId: null, path: null, rank: 2 },
      ],
      commentHits: [],
    });
    const { onOpenDocument } = renderHeader();
    const input = screen.getByLabelText('Search documents');
    await userEvent.type(input, 'a');
    await waitFor(() => {
      expect(api.searchDocuments).toHaveBeenCalledWith('a');
    });
    expect(await screen.findByText('Alpha')).toBeDefined();

    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByText('Alpha').closest('button')?.className).toContain(
      'app-header-search-hit--active',
    );

    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByText('Beta').closest('button')?.className).toContain(
      'app-header-search-hit--active',
    );

    await userEvent.keyboard('{Enter}');
    expect(onOpenDocument).toHaveBeenCalledWith('d2');
  });

  it('falls back to the first hit on Enter with nothing highlighted', async () => {
    vi.mocked(api.searchDocuments).mockResolvedValue({
      hits: [
        { documentId: 'd1', title: 'Alpha', projectId: null, path: null, rank: 1 },
        { documentId: 'd2', title: 'Beta', projectId: null, path: null, rank: 2 },
      ],
      commentHits: [],
    });
    const { onOpenDocument } = renderHeader();
    const input = screen.getByLabelText('Search documents');
    await userEvent.type(input, 'a');
    await waitFor(() => {
      expect(api.searchDocuments).toHaveBeenCalledWith('a');
    });
    expect(await screen.findByText('Alpha')).toBeDefined();
    await userEvent.keyboard('{Enter}');
    expect(onOpenDocument).toHaveBeenCalledWith('d1');
  });

  it('wraps from the last hit back to the first on ArrowDown', async () => {
    vi.mocked(api.searchDocuments).mockResolvedValue({
      hits: [
        { documentId: 'd1', title: 'Alpha', projectId: null, path: null, rank: 1 },
        { documentId: 'd2', title: 'Beta', projectId: null, path: null, rank: 2 },
      ],
      commentHits: [],
    });
    renderHeader();
    const input = screen.getByLabelText('Search documents');
    await userEvent.type(input, 'a');
    await waitFor(() => {
      expect(api.searchDocuments).toHaveBeenCalledWith('a');
    });
    await screen.findByText('Alpha');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(screen.getByText('Alpha').closest('button')?.className).toContain(
      'app-header-search-hit--active',
    );
  });

  it('focuses search on Cmd+K from anywhere on the page', async () => {
    renderHeader();
    const input = screen.getByLabelText('Search documents');
    document.body.focus();
    expect(document.activeElement).not.toBe(input);
    await userEvent.keyboard('{Meta>}k{/Meta}');
    expect(document.activeElement).toBe(input);
  });

  it('shows the repo path as a secondary line only for hits that have one', async () => {
    vi.mocked(api.searchDocuments).mockResolvedValue({
      hits: [
        { documentId: 'd1', title: 'Alpha', projectId: null, path: 'docs/specs/alpha.md', rank: 1 },
        { documentId: 'd2', title: 'Beta', projectId: null, path: null, rank: 2 },
      ],
      commentHits: [],
    });
    renderHeader();
    const input = screen.getByLabelText('Search documents');
    await userEvent.type(input, 'a');
    await waitFor(() => {
      expect(api.searchDocuments).toHaveBeenCalledWith('a');
    });
    expect(await screen.findByText('docs/specs/alpha.md')).toBeDefined();

    const betaRow = screen.getByText('Beta').closest('button');
    expect(betaRow?.querySelector('.app-header-search-hit-path')).toBeNull();
  });
});

describe('AppHeader mobile lane trigger (Phase 39.F)', () => {
  it('renders the trigger only when the caller passes onOpenLaneMenu (Shell only, in practice)', () => {
    renderHeader();
    expect(screen.queryByLabelText('Open lanes')).toBeNull();
  });

  it('calls onOpenLaneMenu when clicked', async () => {
    const onOpenLaneMenu = vi.fn();
    renderHeader({ onOpenLaneMenu });
    await userEvent.click(screen.getByLabelText('Open lanes'));
    expect(onOpenLaneMenu).toHaveBeenCalled();
  });
});
