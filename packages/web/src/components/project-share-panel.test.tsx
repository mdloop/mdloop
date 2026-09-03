// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as clientModule from '../api/client.js';
import { ApiError, api } from '../api/client.js';
import type { OrgUserDto, ProjectGrantDto } from '../api/client.js';
import { ProjectSharePanel } from './project-share-panel.js';

vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual<typeof clientModule>('../api/client.js');
  return {
    ...actual,
    api: {
      listProjectGrants: vi.fn(),
      listOrgUsers: vi.fn(),
      createProjectGrant: vi.fn(),
      revokeProjectGrant: vi.fn(),
    },
  };
});

const orgUsers: OrgUserDto[] = [
  { id: 'u1', displayName: 'Ada Lovelace', email: 'ada@example.com', role: 'member' },
  { id: 'u2', displayName: '', email: 'bob@example.com', role: 'member' },
];

/** Grantee `u3` is deliberately not in `orgUsers` below, so the rendered
 *  grant-list label falls back to "Org member" — that name never collides
 *  with the "Grant to"/"Permission for this person" `<select>` options the
 *  same panel also renders (e.g. "Ada Lovelace", "Can edit"), which a real
 *  org member's display name or permission label would. */
function grant(overrides: Partial<ProjectGrantDto> = {}): ProjectGrantDto {
  return {
    id: 'g1',
    grantee: { type: 'user', userId: 'u3' },
    permission: 'comment',
    createdBy: 'admin1',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listProjectGrants).mockResolvedValue({ grants: [] });
  vi.mocked(api.listOrgUsers).mockResolvedValue({ users: orgUsers, nextCursor: null });
  vi.mocked(api.createProjectGrant).mockResolvedValue({ grant: grant() });
  vi.mocked(api.revokeProjectGrant).mockResolvedValue(undefined);
});

function renderPanel(onClose = vi.fn()): { onClose: ReturnType<typeof vi.fn> } {
  render(<ProjectSharePanel projectId="p1" projectName="Ops" onClose={onClose} />);
  return { onClose };
}

describe('ProjectSharePanel — grant a person', () => {
  it('renders the person select offering all four permissions, defaulting to comment (org-admin only, no delegation cap)', async () => {
    renderPanel();
    await screen.findByText('Grant a person');
    const select = screen.getByLabelText('Permission for this person');
    expect((select as HTMLSelectElement).value).toBe('comment');
    expect(within(select).queryByText('Can read')).not.toBeNull();
    expect(within(select).queryByText('Can comment')).not.toBeNull();
    expect(within(select).queryByText('Can share')).not.toBeNull();
    expect(within(select).queryByText('Can edit')).not.toBeNull();
  });

  it('grants a person the chosen permission', async () => {
    renderPanel();
    await screen.findByText('Grant a person');
    await userEvent.selectOptions(screen.getByLabelText('Grant to'), 'u1');
    await userEvent.selectOptions(screen.getByLabelText('Permission for this person'), 'share');
    await userEvent.click(screen.getByRole('button', { name: /^grant$/i }));
    await waitFor(() => {
      expect(api.createProjectGrant).toHaveBeenCalledWith('p1', 'u1', 'share');
    });
  });

  it('disables Grant until a person is picked', async () => {
    renderPanel();
    await screen.findByText('Grant a person');
    const grantButton = screen.getByRole<HTMLButtonElement>('button', { name: /^grant$/i });
    expect(grantButton.disabled).toBe(true);
    await userEvent.selectOptions(screen.getByLabelText('Grant to'), 'u1');
    expect(grantButton.disabled).toBe(false);
  });
});

describe('ProjectSharePanel — grant list', () => {
  it('renders existing grants with human-readable permission labels', async () => {
    vi.mocked(api.listProjectGrants).mockResolvedValue({
      grants: [grant({ permission: 'edit' })],
    });
    renderPanel();
    // Scoped to the grant-list `<ul>` — "Can edit" also appears as an option
    // in the "Permission for this person" select rendered by the same panel.
    const list = await screen.findByRole('list');
    expect(await within(list).findByText('Org member')).toBeDefined();
    expect(within(list).getByText('Can edit')).toBeDefined();
  });

  it('shows an empty-state message when there are no grants yet', async () => {
    renderPanel();
    expect(await screen.findByText('No grants yet on this project — add one above.')).toBeDefined();
  });
});

describe('ProjectSharePanel — revoke confirm flow', () => {
  it('asks for confirmation before revoking, and only revokes on confirm', async () => {
    vi.mocked(api.listProjectGrants).mockResolvedValue({ grants: [grant()] });
    renderPanel();
    await screen.findByText('Org member');
    await userEvent.click(screen.getByRole('button', { name: /revoke/i }));
    expect(screen.getByRole('alertdialog')).toBeDefined();
    expect(api.revokeProjectGrant).not.toHaveBeenCalled();
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: /revoke/i }),
    );
    await waitFor(() => {
      expect(api.revokeProjectGrant).toHaveBeenCalledWith('p1', 'g1');
    });
  });

  it('cancels without revoking', async () => {
    vi.mocked(api.listProjectGrants).mockResolvedValue({ grants: [grant()] });
    renderPanel();
    await screen.findByText('Org member');
    await userEvent.click(screen.getByRole('button', { name: /revoke/i }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: /cancel/i }),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.revokeProjectGrant).not.toHaveBeenCalled();
  });
});

describe('ProjectSharePanel — misc', () => {
  it('renders with the stable project-share-panel test id', async () => {
    renderPanel();
    expect(screen.getByTestId('project-share-panel')).toBeDefined();
  });

  it('closes on clicking the close button', async () => {
    const { onClose } = renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Close sharing' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('surfaces a mapped error banner when a grant is refused for exceeding a permission (defensive; org admins are uncapped in practice)', async () => {
    vi.mocked(api.createProjectGrant).mockRejectedValue(
      new ApiError(403, 'grant_exceeds_own_permission'),
    );
    renderPanel();
    await screen.findByText('Grant a person');
    await userEvent.selectOptions(screen.getByLabelText('Grant to'), 'u1');
    await userEvent.click(screen.getByRole('button', { name: /^grant$/i }));
    expect(
      await screen.findByText("You can't grant a permission higher than your own."),
    ).toBeDefined();
  });
});
