// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as clientModule from '../api/client.js';
import { ApiError, api } from '../api/client.js';
import type { GrantDto, Me, OrgUserDto } from '../api/client.js';
import type { SharePermission } from '../permission-copy.js';
import { SharePanel } from './share-panel.js';

vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual<typeof clientModule>('../api/client.js');
  return {
    ...actual,
    api: {
      listShares: vi.fn(),
      orgSettings: vi.fn(),
      listOrgUsers: vi.fn(),
      createShareLink: vi.fn(),
      createUserGrant: vi.fn(),
      createGuestShare: vi.fn(),
      revokeShare: vi.fn(),
      listPublicHubDocs: vi.fn(),
      publishToPublicHub: vi.fn(),
    },
  };
});

const orgUsers: OrgUserDto[] = [
  { id: 'u1', displayName: 'Ada Lovelace', email: 'ada@example.com', role: 'member' },
  { id: 'u2', displayName: '', email: 'bob@example.com', role: 'member' },
];

/** Default caller in these tests: the document owner/org-admin, matching the
 *  panel's original owner/admin-only behavior — the ADR 0014 delegation-cap
 *  behavior for a `share`/`edit` grantee gets its own describe block below. */
const me: Me = { userId: 'admin1', orgId: 'org1', role: 'admin' };

function grant(overrides: Partial<GrantDto> = {}): GrantDto {
  return {
    id: 'g1',
    grantee: { type: 'link' },
    permission: 'comment',
    granteeEmail: null,
    expiresAt: null,
    createdBy: 'admin1',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listShares).mockResolvedValue({ grants: [] });
  vi.mocked(api.listOrgUsers).mockResolvedValue({ users: orgUsers, nextCursor: null });
  vi.mocked(api.orgSettings).mockResolvedValue({ sharingMode: 'link' });
  vi.mocked(api.createShareLink).mockResolvedValue({ grant: grant(), token: 'link-token' });
  vi.mocked(api.createUserGrant).mockResolvedValue({
    grant: grant({ grantee: { type: 'user', userId: 'u1' } }),
  });
  vi.mocked(api.createGuestShare).mockResolvedValue({
    grant: {
      id: 'g2',
      granteeEmail: 'guest@example.com',
      permission: 'comment',
      expiresAt: new Date().toISOString(),
    },
    token: 'guest-token',
    expiresAt: new Date().toISOString(),
  });
  vi.mocked(api.revokeShare).mockResolvedValue(undefined);
  // Default: not the public hub's home org — most orgs, most tests.
  vi.mocked(api.listPublicHubDocs).mockRejectedValue(new ApiError(403, 'forbidden'));
});

function renderPanel(
  opts: {
    onClose?: ReturnType<typeof vi.fn>;
    myPermission?: SharePermission;
    canManage?: boolean;
    me?: Me;
  } = {},
): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = opts.onClose ?? vi.fn();
  render(
    <SharePanel
      documentId="d1"
      documentTitle="My Doc"
      myPermission={opts.myPermission ?? 'edit'}
      canManage={opts.canManage ?? true}
      me={opts.me ?? me}
      onClose={onClose}
    />,
  );
  return { onClose };
}

describe('SharePanel — per-flow permission controls', () => {
  it('shows a Link for the org section with its own permission select, defaulting to comment', async () => {
    renderPanel();
    await screen.findByText('Link for the org');
    const select = screen.getByLabelText('Permission for the org link');
    expect((select as HTMLSelectElement).value).toBe('comment');
    // Never offers share or edit: a link is forwardable, so both are
    // user-grant-only (ADR 0008 decision 4, ADR 0014).
    expect(within(select).queryByText('Can share')).toBeNull();
    expect(within(select).queryByText('Can edit')).toBeNull();
  });

  it('creates a share link with the value chosen in its own select', async () => {
    renderPanel();
    await screen.findByText('Link for the org');
    await userEvent.selectOptions(screen.getByLabelText('Permission for the org link'), 'read');
    await userEvent.click(screen.getByRole('button', { name: /create link/i }));
    await waitFor(() => {
      expect(api.createShareLink).toHaveBeenCalledWith('d1', 'read');
    });
  });

  it('shows a Grant a person section with its own permission select in directory mode', async () => {
    vi.mocked(api.orgSettings).mockResolvedValue({ sharingMode: 'directory' });
    renderPanel();
    await screen.findByText('Grant a person');
    expect(screen.queryByText('Link for the org')).toBeNull();
    const select = screen.getByLabelText('Permission for this person');
    expect((select as HTMLSelectElement).value).toBe('comment');
  });

  it('grants a person with the permission chosen in its own select, independent of other flows', async () => {
    vi.mocked(api.orgSettings).mockResolvedValue({ sharingMode: 'directory' });
    renderPanel();
    await screen.findByText('Grant a person');
    await userEvent.selectOptions(screen.getByLabelText('Grant to'), 'u1');
    await userEvent.selectOptions(screen.getByLabelText('Permission for this person'), 'read');
    await userEvent.click(screen.getByRole('button', { name: /^grant$/i }));
    await waitFor(() => {
      expect(api.createUserGrant).toHaveBeenCalledWith('d1', 'u1', 'read');
    });
  });

  it('sends a guest share with the permission chosen in the guest section', async () => {
    renderPanel();
    await screen.findByText('Share with a guest');
    await userEvent.type(screen.getByLabelText('Guest email'), 'guest@example.com');
    await userEvent.selectOptions(screen.getByLabelText('Permission for this guest'), 'read');
    await userEvent.click(screen.getByRole('button', { name: /send guest link/i }));
    await waitFor(() => {
      expect(api.createGuestShare).toHaveBeenCalledWith('d1', {
        email: 'guest@example.com',
        permission: 'read',
        days: 7,
      });
    });
  });

  it('offers Can share and Can edit on the directory-person select only, for an owner/admin caller (ADR 0008, ADR 0014)', async () => {
    vi.mocked(api.orgSettings).mockResolvedValue({ sharingMode: 'directory' });
    renderPanel({ canManage: true });
    await screen.findByText('Grant a person');
    const person = screen.getByLabelText('Permission for this person');
    expect(within(person).queryByText('Can share')).not.toBeNull();
    expect(within(person).queryByText('Can edit')).not.toBeNull();
    // External guests are capped at read/comment regardless of grant
    // (CONSTITUTION §9) — neither option must exist in this select at all.
    const guest = screen.getByLabelText('Permission for this guest');
    expect(within(guest).queryByText('Can share')).toBeNull();
    expect(within(guest).queryByText('Can edit')).toBeNull();
  });

  it('grants share through the person flow', async () => {
    vi.mocked(api.orgSettings).mockResolvedValue({ sharingMode: 'directory' });
    renderPanel({ canManage: true });
    await screen.findByText('Grant a person');
    await userEvent.selectOptions(screen.getByLabelText('Grant to'), 'u1');
    await userEvent.selectOptions(screen.getByLabelText('Permission for this person'), 'share');
    await userEvent.click(screen.getByRole('button', { name: /^grant$/i }));
    await waitFor(() => {
      expect(api.createUserGrant).toHaveBeenCalledWith('d1', 'u1', 'share');
    });
  });

  it('grants edit through the person flow', async () => {
    vi.mocked(api.orgSettings).mockResolvedValue({ sharingMode: 'directory' });
    renderPanel();
    await screen.findByText('Grant a person');
    await userEvent.selectOptions(screen.getByLabelText('Grant to'), 'u1');
    await userEvent.selectOptions(screen.getByLabelText('Permission for this person'), 'edit');
    await userEvent.click(screen.getByRole('button', { name: /^grant$/i }));
    await waitFor(() => {
      expect(api.createUserGrant).toHaveBeenCalledWith('d1', 'u1', 'edit');
    });
  });

  it('keeps each flow scoped to its own select — changing the guest permission does not touch the link permission', async () => {
    renderPanel();
    await screen.findByText('Link for the org');
    await userEvent.selectOptions(screen.getByLabelText('Permission for this guest'), 'read');
    const linkSelect = screen.getByLabelText('Permission for the org link');
    expect((linkSelect as HTMLSelectElement).value).toBe('comment');
  });
});

describe('SharePanel — ADR 0014 delegation cap (non-owner/admin caller)', () => {
  it('a share-level caller may delegate up to share, but not edit', async () => {
    vi.mocked(api.orgSettings).mockResolvedValue({ sharingMode: 'directory' });
    renderPanel({ canManage: false, myPermission: 'share' });
    await screen.findByText('Grant a person');
    const person = screen.getByLabelText('Permission for this person');
    expect(within(person).queryByText('Can comment')).not.toBeNull();
    expect(within(person).queryByText('Can read')).not.toBeNull();
    expect(within(person).queryByText('Can share')).not.toBeNull();
    expect(within(person).queryByText('Can edit')).toBeNull();
  });

  it('an edit-level caller may delegate up to and including edit', async () => {
    vi.mocked(api.orgSettings).mockResolvedValue({ sharingMode: 'directory' });
    renderPanel({ canManage: false, myPermission: 'edit' });
    await screen.findByText('Grant a person');
    const person = screen.getByLabelText('Permission for this person');
    expect(within(person).queryByText('Can share')).not.toBeNull();
    expect(within(person).queryByText('Can edit')).not.toBeNull();
  });

  it("defensively caps a comment-only caller's options at comment, though the panel is never shown to one in practice", async () => {
    vi.mocked(api.orgSettings).mockResolvedValue({ sharingMode: 'directory' });
    renderPanel({ canManage: false, myPermission: 'comment' });
    await screen.findByText('Grant a person');
    const person = screen.getByLabelText('Permission for this person');
    expect(within(person).queryByText('Can comment')).not.toBeNull();
    expect(within(person).queryByText('Can share')).toBeNull();
    expect(within(person).queryByText('Can edit')).toBeNull();
  });
});

describe('SharePanel — ADR 0014 revoke gating for a non-owner/admin caller', () => {
  it('hides Revoke on a grant created by someone else', async () => {
    vi.mocked(api.listShares).mockResolvedValue({
      grants: [grant({ grantee: { type: 'user', userId: 'u3' }, createdBy: 'someone-else' })],
    });
    renderPanel({ canManage: false, myPermission: 'share', me: { ...me, userId: 'sharer1' } });
    await screen.findByText('Org member');
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull();
  });

  it('shows Revoke on a grant the caller created themselves', async () => {
    vi.mocked(api.listShares).mockResolvedValue({
      grants: [grant({ grantee: { type: 'user', userId: 'u3' }, createdBy: 'sharer1' })],
    });
    renderPanel({ canManage: false, myPermission: 'share', me: { ...me, userId: 'sharer1' } });
    await screen.findByText('Org member');
    expect(screen.getByRole('button', { name: /revoke/i })).toBeDefined();
  });

  it('shows Revoke on every grant for an owner/admin caller regardless of who created it', async () => {
    vi.mocked(api.listShares).mockResolvedValue({
      grants: [grant({ grantee: { type: 'user', userId: 'u3' }, createdBy: 'someone-else' })],
    });
    renderPanel({ canManage: true });
    await screen.findByText('Org member');
    expect(screen.getByRole('button', { name: /revoke/i })).toBeDefined();
  });
});

describe('SharePanel — permission labels', () => {
  it('renders a human-readable label for a share grant', async () => {
    vi.mocked(api.listShares).mockResolvedValue({
      grants: [grant({ grantee: { type: 'user', userId: 'u1' }, permission: 'share' })],
    });
    renderPanel();
    expect(await screen.findByText('Can share')).toBeDefined();
  });
});

describe('SharePanel — guest days unit', () => {
  it('shows a visible "days" suffix next to the days input', async () => {
    renderPanel();
    const input = screen.getByLabelText('Days of access');
    expect(input.parentElement?.textContent).toContain('days');
    expect(input.getAttribute('min')).toBe('1');
    expect(input.getAttribute('max')).toBe('365');
  });
});

describe('SharePanel — revoke confirm flow', () => {
  it('asks for confirmation before revoking, and only revokes on confirm', async () => {
    vi.mocked(api.listShares).mockResolvedValue({
      grants: [grant({ grantee: { type: 'link' } })],
    });
    renderPanel();
    await screen.findByText('Anyone in the org with the link');
    await userEvent.click(screen.getByRole('button', { name: /revoke/i }));
    expect(screen.getByRole('alertdialog')).toBeDefined();
    expect(api.revokeShare).not.toHaveBeenCalled();
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: /revoke/i }),
    );
    await waitFor(() => {
      expect(api.revokeShare).toHaveBeenCalledWith('d1', 'g1');
    });
  });

  it('cancels without revoking', async () => {
    vi.mocked(api.listShares).mockResolvedValue({
      grants: [grant({ grantee: { type: 'link' } })],
    });
    renderPanel();
    await screen.findByText('Anyone in the org with the link');
    await userEvent.click(screen.getByRole('button', { name: /revoke/i }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: /cancel/i }),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.revokeShare).not.toHaveBeenCalled();
  });
});

describe('SharePanel — misc', () => {
  it('renders with the stable share-panel test id', async () => {
    renderPanel();
    expect(screen.getByTestId('share-panel')).toBeDefined();
  });

  it('closes on clicking the close button', async () => {
    const { onClose } = renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Close sharing' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('SharePanel — publish to public hub', () => {
  it('renders no publish UI when the org is not the hub home org (403)', async () => {
    vi.mocked(api.listPublicHubDocs).mockRejectedValue(new ApiError(403, 'forbidden'));
    renderPanel();
    await screen.findByText('Link for the org');
    expect(screen.queryByTestId('publish-hub')).toBeNull();
  });

  it('shows the publish form, defaulting the slug from the document title, when the probe succeeds', async () => {
    vi.mocked(api.listPublicHubDocs).mockResolvedValue({ docs: [], nextCursor: null });
    renderPanel();
    const panel = await screen.findByTestId('publish-hub');
    const slugInput = within(panel).getByLabelText('Public hub slug');
    expect((slugInput as HTMLInputElement).value).toBe('my-doc');
  });

  it('publishes and shows a "view at /hub/:slug" confirmation', async () => {
    vi.mocked(api.listPublicHubDocs).mockResolvedValue({ docs: [], nextCursor: null });
    vi.mocked(api.publishToPublicHub).mockResolvedValue({
      id: 'p1',
      slug: 'my-doc',
      title: 'My Doc',
      seq: 1,
      publishedAt: new Date().toISOString(),
    });
    renderPanel();
    await screen.findByTestId('publish-hub');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => {
      expect(api.publishToPublicHub).toHaveBeenCalledWith({ documentId: 'd1', slug: 'my-doc' });
    });
    const confirmation = await screen.findByTestId('publish-hub-token');
    expect(confirmation.textContent).toContain('/hub/my-doc');
  });

  it('maps invalid_slug to readable copy', async () => {
    vi.mocked(api.listPublicHubDocs).mockResolvedValue({ docs: [], nextCursor: null });
    vi.mocked(api.publishToPublicHub).mockRejectedValue(new ApiError(400, 'invalid_slug'));
    renderPanel();
    await screen.findByTestId('publish-hub');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(
      await screen.findByText(
        "That slug isn't valid — use lowercase letters, numbers, and hyphens.",
      ),
    ).toBeDefined();
  });
});
