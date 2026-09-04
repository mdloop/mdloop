// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ApiKeyDto,
  Me,
  OrgUsageDto,
  OrgUserDto,
  PublicHubDocDto,
  TierPlanDto,
} from '../api/client.js';
import type * as clientModule from '../api/client.js';
import { ApiError, api } from '../api/client.js';
import { fmtDateWithYear } from '../format.js';
import { OrgSettings } from './org-settings.js';

vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual<typeof clientModule>('../api/client.js');
  return {
    ...actual,
    api: {
      getOrgSettings: vi.fn(),
      getTierPlans: vi.fn(),
      getOrgUsage: vi.fn(),
      listOrgUsers: vi.fn(),
      setUserRole: vi.fn(),
      listInvites: vi.fn(),
      listAllowlist: vi.fn(),
      sendInvite: vi.fn(),
      revokeInvite: vi.fn(),
      addAllowlistEntry: vi.fn(),
      removeAllowlistEntry: vi.fn(),
      updateOrgSettings: vi.fn(),
      listApiKeys: vi.fn(),
      createApiKey: vi.fn(),
      revokeApiKey: vi.fn(),
      listPublicHubDocs: vi.fn(),
      unpublishFromPublicHub: vi.fn(),
    },
  };
});

const admin: Me = { userId: 'u1', orgId: 'o1', role: 'admin' };
const member: Me = { userId: 'u2', orgId: 'o1', role: 'member' };

function apiKey(overrides: Partial<ApiKeyDto> = {}): ApiKeyDto {
  return {
    id: 'k1',
    userId: admin.userId,
    name: 'Laptop',
    createdAt: '2026-08-01T00:00:00Z',
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

const baseSettings = {
  name: 'Acme',
  sharingMode: 'link' as const,
  retentionDays: 30,
  purgeImmediately: false,
  tier: 'team' as const,
  versionRetention: null,
  provisioningMode: 'open' as const,
  externalSharing: true,
  approvalGate: 'soft' as const,
  sessionMaxHours: null,
  createdAt: '2026-03-03T00:00:00Z',
};

// Mirrors packages/domain/src/tier.ts's TIER_PROFILES (2026-08-13 numbers) —
// the retention form derives its seed values and ceiling hints from exactly
// this shape, so the fixture needs to be real, not arbitrary.
const baseTierPlans: TierPlanDto[] = [
  {
    tier: 'free',
    maxCollaborators: 1,
    maxActiveDocs: 100,
    maxActiveDocsPerProject: 100,
    maxExternalGuests: 0,
    maxGuestShareDays: 7,
    versionRetention: {
      keepLastNMax: 20,
      keepDaysMax: 90,
      defaultKeepLastN: 20,
      defaultKeepDays: 90,
    },
  },
  {
    tier: 'team',
    maxCollaborators: null,
    maxActiveDocs: 5000,
    maxActiveDocsPerProject: 500,
    maxExternalGuests: 25,
    maxGuestShareDays: 30,
    versionRetention: {
      keepLastNMax: 250,
      keepDaysMax: 365,
      defaultKeepLastN: 50,
      defaultKeepDays: 90,
    },
  },
  {
    tier: 'enterprise',
    maxCollaborators: null,
    maxActiveDocs: null,
    maxActiveDocsPerProject: null,
    maxExternalGuests: null,
    maxGuestShareDays: null,
    versionRetention: {
      keepLastNMax: 250,
      keepDaysMax: 365,
      defaultKeepLastN: 100,
      defaultKeepDays: 180,
    },
  },
];

const baseUsage: OrgUsageDto = {
  tier: 'team',
  activeDocCount: 12,
  maxActiveDocs: 5000,
  memberCount: 3,
  maxCollaborators: 25,
  storageBytes: 1024,
  activeGuestCount: 0,
  maxExternalGuests: 25,
};

/** Clicks a settings-rail item by its accessible name (its label text). */
async function goTo(label: string): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: label }));
}

function renderScreen(me: Me = admin): void {
  render(
    <OrgSettings
      me={me}
      mode="light"
      setMode={vi.fn()}
      onBack={vi.fn()}
      onOpenDocument={vi.fn()}
      onLogout={vi.fn()}
    />,
  );
}

function orgUser(overrides: Partial<OrgUserDto> = {}): OrgUserDto {
  return {
    id: 'm1',
    displayName: 'Priya Raman',
    email: 'priya@co.com',
    role: 'member',
    ...overrides,
  };
}

afterEach(cleanup);

beforeEach(() => {
  // jsdom has no matchMedia — SettingsLayout (Phase 39.A) reads it for the
  // below-720px rail drill-down; default to "not narrow" here, same stub
  // convention as shell.test.tsx/viewer.test.tsx.
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
  // Call history is per-test here: several assertions below are "this was
  // never called", which a previous test's calls would silently break.
  vi.clearAllMocks();
  vi.mocked(api.getOrgSettings).mockResolvedValue(baseSettings);
  vi.mocked(api.getTierPlans).mockResolvedValue({ tiers: baseTierPlans });
  vi.mocked(api.getOrgUsage).mockResolvedValue(baseUsage);
  vi.mocked(api.listOrgUsers).mockResolvedValue({ users: [], nextCursor: null });
  vi.mocked(api.listInvites).mockResolvedValue({ invites: [] });
  vi.mocked(api.listAllowlist).mockResolvedValue({ entries: [] });
  vi.mocked(api.listApiKeys).mockResolvedValue({ keys: [] });
  // Default: not the public hub's home org — most orgs, most tests.
  vi.mocked(api.listPublicHubDocs).mockRejectedValue(new ApiError(403, 'forbidden'));
});

describe('OrgSettings', () => {
  it('hides the screen from non-admins', () => {
    render(
      <OrgSettings
        me={member}
        mode="light"
        setMode={vi.fn()}
        onBack={vi.fn()}
        onOpenDocument={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    expect(screen.getByText('Admins only')).toBeDefined();
    expect(api.getOrgSettings).not.toHaveBeenCalled();
  });

  it('loads and lists pending invites', async () => {
    vi.mocked(api.listInvites).mockResolvedValue({
      invites: [
        {
          id: 'i1',
          email: 'new@co.com',
          role: 'member',
          invitedBy: 'u1',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          acceptedAt: null,
          revokedAt: null,
        },
      ],
    });
    render(
      <OrgSettings
        me={admin}
        mode="light"
        setMode={vi.fn()}
        onBack={vi.fn()}
        onOpenDocument={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    await goTo('Members');
    expect(await screen.findByText('new@co.com')).toBeDefined();
    expect(screen.getByText('Pending')).toBeDefined();
  });

  it('sends an invite and shows the one-time accept link', async () => {
    vi.mocked(api.sendInvite).mockResolvedValue({
      invite: {
        id: 'i2',
        email: 'friend@co.com',
        role: 'member',
        invitedBy: 'u1',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        acceptedAt: null,
        revokedAt: null,
      },
      token: 'tok123',
    });
    render(
      <OrgSettings
        me={admin}
        mode="light"
        setMode={vi.fn()}
        onBack={vi.fn()}
        onOpenDocument={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(api.getOrgSettings).toHaveBeenCalled();
    });
    await goTo('Members');
    await userEvent.type(screen.getByLabelText('Email to invite'), 'friend@co.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    expect(api.sendInvite).toHaveBeenCalledWith({ email: 'friend@co.com', role: 'member' });
    const token = await screen.findByTestId('invite-token');
    expect(token.textContent).toContain('/invite/accept?token=tok123');
  });

  it('revokes an invite', async () => {
    vi.mocked(api.listInvites).mockResolvedValue({
      invites: [
        {
          id: 'i3',
          email: 'gone@co.com',
          role: 'member',
          invitedBy: 'u1',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          acceptedAt: null,
          revokedAt: null,
        },
      ],
    });
    vi.mocked(api.revokeInvite).mockResolvedValue(undefined);
    render(
      <OrgSettings
        me={admin}
        mode="light"
        setMode={vi.fn()}
        onBack={vi.fn()}
        onOpenDocument={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    await goTo('Members');
    await screen.findByText('gone@co.com');
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByTestId('confirm-dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    expect(api.revokeInvite).toHaveBeenCalledWith('i3');
  });

  it('adds an allowlist entry', async () => {
    vi.mocked(api.addAllowlistEntry).mockResolvedValue({
      entry: { id: 'a1', email: 'ok@co.com', addedBy: 'u1', createdAt: new Date().toISOString() },
    });
    render(
      <OrgSettings
        me={admin}
        mode="light"
        setMode={vi.fn()}
        onBack={vi.fn()}
        onOpenDocument={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(api.getOrgSettings).toHaveBeenCalled();
    });
    await goTo('Access');
    await userEvent.type(screen.getByLabelText('Email to allow'), 'ok@co.com');
    await userEvent.click(screen.getByRole('button', { name: 'Add to allowlist' }));
    expect(api.addAllowlistEntry).toHaveBeenCalledWith('ok@co.com');
  });

  it('toggles provisioning mode', async () => {
    vi.mocked(api.updateOrgSettings).mockResolvedValue({
      ...baseSettings,
      provisioningMode: 'allowlist',
    });
    render(
      <OrgSettings
        me={admin}
        mode="light"
        setMode={vi.fn()}
        onBack={vi.fn()}
        onOpenDocument={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(api.getOrgSettings).toHaveBeenCalled();
    });
    await goTo('Access');
    await userEvent.click(screen.getByRole('button', { name: 'Allowlist' }));
    expect(api.updateOrgSettings).toHaveBeenCalledWith({ provisioningMode: 'allowlist' });
  });

  it('shows readable copy for a failed invite, never the raw error code', async () => {
    vi.mocked(api.sendInvite).mockRejectedValue(new ApiError(409, 'seat_cap_reached'));
    render(
      <OrgSettings
        me={admin}
        mode="light"
        setMode={vi.fn()}
        onBack={vi.fn()}
        onOpenDocument={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(api.getOrgSettings).toHaveBeenCalled();
    });
    await goTo('Members');
    await userEvent.type(screen.getByLabelText('Email to invite'), 'friend@co.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send invite' }));

    const banner = await screen.findByText('Your plan is out of seats — upgrade to invite more.');
    expect(banner).toBeDefined();
    expect(screen.queryByText(/Request failed/)).toBeNull();
    expect(screen.queryByText(/seat_cap_reached/)).toBeNull();
  });

  it("keeps this screen's own wording for a forbidden action", async () => {
    vi.mocked(api.updateOrgSettings).mockRejectedValue(new ApiError(403, 'forbidden'));
    render(
      <OrgSettings
        me={admin}
        mode="light"
        setMode={vi.fn()}
        onBack={vi.fn()}
        onOpenDocument={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(api.getOrgSettings).toHaveBeenCalled();
    });
    await goTo('Access');
    await userEvent.click(screen.getByRole('button', { name: 'Allowlist' }));
    // The surface override, not the shared map's generic phrasing.
    expect(await screen.findByText('You need admin access to do that.')).toBeDefined();
  });
});

describe('OrgSettings API keys', () => {
  function renderFor(me: Me): void {
    render(
      <OrgSettings
        me={me}
        mode="light"
        setMode={vi.fn()}
        onBack={vi.fn()}
        onOpenDocument={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
  }

  function stubClipboard(): ReturnType<typeof vi.fn> {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    return writeText;
  }

  it('is reachable by a member, unlike every org-wide section', async () => {
    renderFor(member);
    // The org-wide half still says no...
    expect(screen.getByText('Admins only')).toBeDefined();
    // ...but keys are personal, so the section renders and loads.
    expect(await screen.findByRole('heading', { name: 'API keys' })).toBeDefined();
    await waitFor(() => {
      expect(api.listApiKeys).toHaveBeenCalled();
    });
    expect(screen.getByLabelText('Name for the new API key')).toBeDefined();
  });

  it('lists a key with its created date and a never-used marker', async () => {
    vi.mocked(api.listApiKeys).mockResolvedValue({ keys: [apiKey({ userId: member.userId })] });
    renderFor(member);

    const list = await screen.findByTestId('api-key-list');
    expect(within(list).getByText('Laptop')).toBeDefined();
    expect(within(list).getByText('never used')).toBeDefined();
    expect(within(list).getByText(/^created /)).toBeDefined();
  });

  it('shows a revoked key as revoked, with no way to revoke it again', async () => {
    vi.mocked(api.listApiKeys).mockResolvedValue({
      keys: [
        apiKey({
          id: 'k-dead',
          userId: member.userId,
          name: 'Old laptop',
          lastUsedAt: '2026-08-02T00:00:00Z',
          revokedAt: '2026-08-03T00:00:00Z',
        }),
      ],
    });
    renderFor(member);

    const list = await screen.findByTestId('api-key-list');
    expect(within(list).getByText('Revoked')).toBeDefined();
    expect(within(list).getByText(/^last used /)).toBeDefined();
    expect(within(list).queryByRole('button', { name: /Revoke/ })).toBeNull();
  });

  it("labels an admin's own keys apart from other members', yours first", async () => {
    vi.mocked(api.listApiKeys).mockResolvedValue({
      keys: [
        apiKey({ id: 'k-them', userId: 'someone-else', name: 'Their CI' }),
        apiKey({ id: 'k-mine', userId: admin.userId, name: 'My laptop' }),
      ],
    });
    renderFor(admin);
    await goTo('API keys');

    const list = await screen.findByTestId('api-key-list');
    expect(within(list).getByText('Yours')).toBeDefined();
    expect(within(list).getByText('Another member')).toBeDefined();
    // Ownership is shown by label, never by leaking a raw user id on screen.
    expect(within(list).queryByText(/someone-else/)).toBeNull();
    const names = within(list)
      .getAllByText(/laptop|CI/i)
      .map((el) => el.textContent);
    expect(names).toEqual(['My laptop', 'Their CI']);
  });

  it('mints a key, reveals it once, and copies it', async () => {
    const writeText = stubClipboard();
    const record = apiKey({ id: 'k-new', userId: member.userId, name: 'CI' });
    vi.mocked(api.createApiKey).mockResolvedValue({ key: 'mdloop_supersecret', record });
    renderFor(member);
    await screen.findByRole('heading', { name: 'API keys' });

    await userEvent.type(screen.getByLabelText('Name for the new API key'), 'CI');
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }));

    expect(api.createApiKey).toHaveBeenCalledWith('CI');
    const reveal = await screen.findByTestId('api-key-token');
    expect(reveal.textContent).toContain('mdloop_supersecret');
    expect(reveal.textContent).toContain('only time it can be shown');

    await userEvent.click(within(reveal).getByRole('button', { name: 'Copy key' }));
    expect(writeText).toHaveBeenCalledWith('mdloop_supersecret');
    expect(await within(reveal).findByRole('button', { name: 'Copied' })).toBeDefined();
  });

  it('never sends a blank name to the server', async () => {
    renderFor(member);
    await screen.findByRole('heading', { name: 'API keys' });

    await userEvent.type(screen.getByLabelText('Name for the new API key'), '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }));

    expect(api.createApiKey).not.toHaveBeenCalled();
  });

  it('revokes a key after confirmation and drops it from the list', async () => {
    vi.mocked(api.listApiKeys).mockResolvedValue({
      keys: [apiKey({ id: 'k-doomed', userId: member.userId, name: 'Doomed' })],
    });
    vi.mocked(api.revokeApiKey).mockResolvedValue(undefined);
    renderFor(member);
    await screen.findByText('Doomed');

    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog.textContent).toContain('Doomed');
    vi.mocked(api.listApiKeys).mockResolvedValue({ keys: [] });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(api.revokeApiKey).toHaveBeenCalledWith('k-doomed');
    });
    await waitFor(() => {
      expect(screen.queryByText('Doomed')).toBeNull();
    });
    expect(await screen.findByText(/No API keys yet/)).toBeDefined();
  });

  it('shows readable copy for a rejected mint, never the raw code', async () => {
    vi.mocked(api.createApiKey).mockRejectedValue(new ApiError(400, 'invalid_name'));
    renderFor(member);
    await screen.findByRole('heading', { name: 'API keys' });

    await userEvent.type(screen.getByLabelText('Name for the new API key'), '///');
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }));

    // This section's own override, not the shared map's "That name is not valid."
    expect(await screen.findByText('Give the key a name first.')).toBeDefined();
    expect(screen.queryByText(/invalid_name/)).toBeNull();
    expect(screen.queryByTestId('api-key-token')).toBeNull();
  });

  it('reports a failed revoke without leaking the code', async () => {
    vi.mocked(api.listApiKeys).mockResolvedValue({
      keys: [apiKey({ id: 'k-gone', userId: member.userId, name: 'Stale' })],
    });
    vi.mocked(api.revokeApiKey).mockRejectedValue(new ApiError(404, 'key_not_found'));
    renderFor(member);
    await screen.findByText('Stale');

    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByTestId('confirm-dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    expect(
      await screen.findByText('That API key is already gone — refresh to see the current list.'),
    ).toBeDefined();
    expect(screen.queryByText(/key_not_found/)).toBeNull();
  });

  it('says so when the list cannot be loaded', async () => {
    vi.mocked(api.listApiKeys).mockRejectedValue(new Error('offline'));
    renderFor(member);
    expect(await screen.findByText('Could not load API keys.')).toBeDefined();
  });
});

function publicHubDoc(overrides: Partial<PublicHubDocDto> = {}): PublicHubDocDto {
  return {
    id: 'ph1',
    slug: 'onboarding',
    title: 'Onboarding Guide',
    seq: 3,
    publishedAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-02T00:00:00Z',
    ...overrides,
  };
}

describe('OrgSettings — public docs hub section', () => {
  function renderAsAdmin(): void {
    render(
      <OrgSettings
        me={admin}
        mode="light"
        setMode={vi.fn()}
        onBack={vi.fn()}
        onOpenDocument={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
  }

  it('renders nothing when the org is not the hub home org (403), no error banner', async () => {
    vi.mocked(api.listPublicHubDocs).mockRejectedValue(new ApiError(403, 'forbidden'));
    renderAsAdmin();
    await goTo('Public hub');
    await waitFor(() => {
      expect(api.listPublicHubDocs).toHaveBeenCalled();
    });
    expect(screen.queryByText('Public docs hub')).toBeNull();
    expect(screen.queryByText(/could not/i)).toBeNull();
  });

  it('does not probe the hub for a non-admin', async () => {
    render(
      <OrgSettings
        me={member}
        mode="light"
        setMode={vi.fn()}
        onBack={vi.fn()}
        onOpenDocument={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    await screen.findByText('Admins only');
    expect(api.getOrgSettings).not.toHaveBeenCalled();
    expect(api.listPublicHubDocs).not.toHaveBeenCalled();
  });

  it('shows the published list and a Load more button when there is a nextCursor', async () => {
    vi.mocked(api.listPublicHubDocs).mockResolvedValue({
      docs: [publicHubDoc()],
      nextCursor: 'cursor-2',
    });
    renderAsAdmin();
    await goTo('Public hub');

    const list = await screen.findByTestId('public-hub-list');
    expect(within(list).getByText('Onboarding Guide')).toBeDefined();
    expect(within(list).getByText('/onboarding')).toBeDefined();
    expect(within(list).getByText('v3')).toBeDefined();

    const loadMoreBtn = screen.getByRole('button', { name: 'Load more' });
    vi.mocked(api.listPublicHubDocs).mockResolvedValue({
      docs: [publicHubDoc({ id: 'ph2', slug: 'runbook', title: 'Runbook' })],
      nextCursor: null,
    });
    await userEvent.click(loadMoreBtn);

    await screen.findByText('Runbook');
    expect(api.listPublicHubDocs).toHaveBeenLastCalledWith({ cursor: 'cursor-2' });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('unpublishes a doc after confirmation', async () => {
    vi.mocked(api.listPublicHubDocs).mockResolvedValue({
      docs: [publicHubDoc()],
      nextCursor: null,
    });
    vi.mocked(api.unpublishFromPublicHub).mockResolvedValue(undefined);
    renderAsAdmin();
    await goTo('Public hub');

    await screen.findByText('Onboarding Guide');
    await userEvent.click(screen.getByRole('button', { name: /unpublish/i }));
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(api.unpublishFromPublicHub).not.toHaveBeenCalled();

    vi.mocked(api.listPublicHubDocs).mockResolvedValue({ docs: [], nextCursor: null });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Unpublish' }));

    await waitFor(() => {
      expect(api.unpublishFromPublicHub).toHaveBeenCalledWith('onboarding');
    });
    expect(await screen.findByText(/Nothing published yet/)).toBeDefined();
  });

  it('reports a failed unpublish without leaking the raw code', async () => {
    vi.mocked(api.listPublicHubDocs).mockResolvedValue({
      docs: [publicHubDoc()],
      nextCursor: null,
    });
    vi.mocked(api.unpublishFromPublicHub).mockRejectedValue(new ApiError(403, 'forbidden'));
    renderAsAdmin();
    await goTo('Public hub');

    await screen.findByText('Onboarding Guide');
    await userEvent.click(screen.getByRole('button', { name: /unpublish/i }));
    const dialog = await screen.findByTestId('confirm-dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Unpublish' }));

    expect(await screen.findByText('You need admin access to do that.')).toBeDefined();
    expect(screen.queryByText(/^forbidden$/)).toBeNull();
  });
});

describe('OrgSettings — Members', () => {
  it("changes another member's role", async () => {
    vi.mocked(api.listOrgUsers).mockResolvedValue({
      users: [orgUser({ id: 'm1', displayName: 'Priya Raman', role: 'member' })],
      nextCursor: null,
    });
    vi.mocked(api.setUserRole).mockResolvedValue(undefined);
    renderScreen();
    await goTo('Members');

    const select = await screen.findByLabelText('Role for Priya Raman');
    expect((select as HTMLSelectElement).disabled).toBe(false);
    await userEvent.selectOptions(select, 'admin');

    expect(api.setUserRole).toHaveBeenCalledWith('m1', 'admin');
    await waitFor(() => {
      expect(api.listOrgUsers).toHaveBeenCalledTimes(2);
    });
  });

  it("disables the signed-in admin's own role control", async () => {
    vi.mocked(api.listOrgUsers).mockResolvedValue({
      users: [orgUser({ id: admin.userId, displayName: 'You', role: 'admin' })],
      nextCursor: null,
    });
    renderScreen();
    await goTo('Members');

    const select = await screen.findByLabelText('Role for You');
    expect((select as HTMLSelectElement).disabled).toBe(true);
  });

  it('loads more members via the Load more button', async () => {
    vi.mocked(api.listOrgUsers).mockResolvedValueOnce({
      users: [orgUser({ id: 'm1', displayName: 'Priya Raman' })],
      nextCursor: 'cursor-2',
    });
    renderScreen();
    await goTo('Members');
    await screen.findByLabelText('Role for Priya Raman');

    vi.mocked(api.listOrgUsers).mockResolvedValueOnce({
      users: [orgUser({ id: 'm2', displayName: 'Sam Okafor' })],
      nextCursor: null,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await screen.findByLabelText('Role for Sam Okafor');
    expect(api.listOrgUsers).toHaveBeenLastCalledWith({ cursor: 'cursor-2', limit: 50 });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows readable copy for a failed role change, never the raw code', async () => {
    vi.mocked(api.listOrgUsers).mockResolvedValue({
      users: [orgUser({ id: 'm1', displayName: 'Priya Raman', role: 'member' })],
      nextCursor: null,
    });
    vi.mocked(api.setUserRole).mockRejectedValue(new ApiError(404, 'user_not_found'));
    renderScreen();
    await goTo('Members');

    const select = await screen.findByLabelText('Role for Priya Raman');
    await userEvent.selectOptions(select, 'admin');

    expect(
      await screen.findByText('That member could not be found — refresh and try again.'),
    ).toBeDefined();
    expect(screen.queryByText(/user_not_found/)).toBeNull();
  });

  it('shows the seat headroom meter above the invite form', async () => {
    vi.mocked(api.getOrgUsage).mockResolvedValue({ ...baseUsage, memberCount: 7 });
    renderScreen();
    await goTo('Members');

    const meter = await screen.findByTestId('meter');
    expect(within(meter).getByText('Seats')).toBeDefined();
    expect(within(meter).getByText('7 / 25')).toBeDefined();
  });
});

describe('OrgSettings — Retention', () => {
  it('pre-populates from the current org settings when the org has an explicit override', async () => {
    vi.mocked(api.getOrgSettings).mockResolvedValue({
      ...baseSettings,
      retentionDays: 45,
      versionRetention: { keepLastN: 10, keepDays: 60 },
    });
    renderScreen();
    await goTo('Retention');

    const days = await screen.findByLabelText('Retention days for deleted documents');
    expect((days as HTMLInputElement).value).toBe('45');
    const keepLastN = screen.getByLabelText('Versions to always keep');
    expect((keepLastN as HTMLInputElement).value).toBe('10');
    const keepDays = screen.getByLabelText('Days to keep versions');
    expect((keepDays as HTMLInputElement).value).toBe('60');
    // Not anchored with `$`: the paragraph's full textContent also includes
    // the trailing "Reset to plan default" button's own text.
    expect(
      screen.getByText(/^Custom — your Team plan allows up to 250 versions \/ 365 days\./),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reset to plan default' })).toBeDefined();
  });

  it("pre-fills from the plan's default, and says so, when the org has never set an override", async () => {
    // baseSettings.versionRetention is null — never configured.
    renderScreen();
    await goTo('Retention');

    const keepLastN = await screen.findByLabelText('Versions to always keep');
    expect((keepLastN as HTMLInputElement).value).toBe('50');
    const keepDays = screen.getByLabelText('Days to keep versions');
    expect((keepDays as HTMLInputElement).value).toBe('90');
    expect(
      screen.getByText(/^Following your Team plan's default — 50 versions \/ 90 days\.$/),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Reset to plan default' })).toBeNull();
  });

  it('resets to the plan default, clearing the stored override', async () => {
    vi.mocked(api.getOrgSettings).mockResolvedValue({
      ...baseSettings,
      versionRetention: { keepLastN: 10, keepDays: 60 },
    });
    vi.mocked(api.updateOrgSettings).mockResolvedValue({
      ...baseSettings,
      versionRetention: null,
    });
    renderScreen();
    await goTo('Retention');

    await userEvent.click(await screen.findByRole('button', { name: 'Reset to plan default' }));

    expect(api.updateOrgSettings).toHaveBeenCalledWith({ versionRetention: null });
  });

  it('submits a valid retention-days change', async () => {
    vi.mocked(api.updateOrgSettings).mockResolvedValue({ ...baseSettings, retentionDays: 14 });
    renderScreen();
    await goTo('Retention');

    const input = await screen.findByLabelText('Retention days for deleted documents');
    await userEvent.clear(input);
    await userEvent.type(input, '14');
    await userEvent.click(screen.getByRole('button', { name: 'Save retention days' }));

    expect(api.updateOrgSettings).toHaveBeenCalledWith({ retentionDays: 14 });
  });

  it('rejects an out-of-range retention-days value without calling the API', async () => {
    renderScreen();
    await goTo('Retention');

    const input = await screen.findByLabelText('Retention days for deleted documents');
    await userEvent.clear(input);
    await userEvent.type(input, '9999');
    await userEvent.click(screen.getByRole('button', { name: 'Save retention days' }));

    // Surfaced twice now — the page-top banner (unchanged) and an inline
    // message right next to the field — so this asserts on both rather than
    // a single findByText, which would throw on an ambiguous match.
    const messages = await screen.findAllByText(
      'Retention must be a whole number of days, 0 to 365.',
    );
    expect(messages.length).toBe(2);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(api.updateOrgSettings).not.toHaveBeenCalled();
  });

  it('disables the retention-days input once purge-immediately is on', async () => {
    vi.mocked(api.updateOrgSettings).mockResolvedValue({
      ...baseSettings,
      purgeImmediately: true,
    });
    renderScreen();
    await goTo('Retention');

    // The click's own response isn't what the screen re-renders from — it
    // calls refresh(), which re-fetches GET /org/settings, so that mock has
    // to reflect the change too, same as the real server would.
    vi.mocked(api.getOrgSettings).mockResolvedValue({ ...baseSettings, purgeImmediately: true });
    await userEvent.click(screen.getByRole('button', { name: 'Purge immediately' }));

    expect(api.updateOrgSettings).toHaveBeenCalledWith({ purgeImmediately: true });
    await waitFor(() => {
      const days = screen.getByLabelText('Retention days for deleted documents');
      expect((days as HTMLInputElement).disabled).toBe(true);
    });
    const saveBtn = screen.getByRole('button', { name: 'Save retention days' });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('submits version retention with both fields set', async () => {
    vi.mocked(api.updateOrgSettings).mockResolvedValue({
      ...baseSettings,
      versionRetention: { keepLastN: 5, keepDays: 30 },
    });
    renderScreen();
    await goTo('Retention');

    // Fields are pre-filled from the plan default (50 / 90), not blank — so
    // each has to be cleared before typing the new value, or the result
    // would be appended onto the default instead of replacing it.
    const keepLastN = await screen.findByLabelText('Versions to always keep');
    await userEvent.clear(keepLastN);
    await userEvent.type(keepLastN, '5');
    const keepDays = screen.getByLabelText('Days to keep versions');
    await userEvent.clear(keepDays);
    await userEvent.type(keepDays, '30');
    await userEvent.click(screen.getByRole('button', { name: 'Save version retention' }));

    expect(api.updateOrgSettings).toHaveBeenCalledWith({
      versionRetention: { keepLastN: 5, keepDays: 30 },
    });
  });

  it('rejects a blank days field without calling the API — every plan has a finite ceiling now', async () => {
    renderScreen();
    await goTo('Retention');

    const keepDays = await screen.findByLabelText('Days to keep versions');
    await userEvent.clear(keepDays);
    await userEvent.click(screen.getByRole('button', { name: 'Save version retention' }));

    // Surfaced twice, same as the retention-days test above: the page-top
    // banner and the inline field message.
    const messages = await screen.findAllByText(
      'Days to keep must be a whole number of 1 or more.',
    );
    expect(messages.length).toBe(2);
    expect(api.updateOrgSettings).not.toHaveBeenCalled();
  });

  it("rejects a versions value over the plan's ceiling client-side, without calling the API", async () => {
    renderScreen();
    await goTo('Retention');

    const keepLastN = await screen.findByLabelText('Versions to always keep');
    await userEvent.clear(keepLastN);
    await userEvent.type(keepLastN, '500');
    await userEvent.click(screen.getByRole('button', { name: 'Save version retention' }));

    const messages = await screen.findAllByText(
      'Your plan keeps at most 250 versions — lower the number, or upgrade.',
    );
    expect(messages.length).toBe(2);
    expect(api.updateOrgSettings).not.toHaveBeenCalled();
  });

  it("shows readable copy when the server rejects a change the client's own (stale) ceiling missed", async () => {
    // A value the cached plan ceiling (250) allows, so the client-side check
    // passes and the request goes out — but the server rejects it anyway,
    // simulating a tier downgrade landing between page load and submit.
    vi.mocked(api.updateOrgSettings).mockRejectedValue(
      new ApiError(400, 'version_retention_exceeds_tier_ceiling'),
    );
    renderScreen();
    await goTo('Retention');

    const keepLastN = await screen.findByLabelText('Versions to always keep');
    await userEvent.clear(keepLastN);
    await userEvent.type(keepLastN, '200');
    await userEvent.click(screen.getByRole('button', { name: 'Save version retention' }));

    expect(api.updateOrgSettings).toHaveBeenCalled();
    expect(
      await screen.findByText(
        "That's more history than your plan keeps — lower the number, or upgrade.",
      ),
    ).toBeDefined();
    expect(screen.queryByText(/version_retention_exceeds_tier_ceiling/)).toBeNull();
  });
});

describe('OrgSettings — Overview', () => {
  it('shows the ledger and usage lanes', async () => {
    renderScreen();

    expect(await screen.findByRole('heading', { name: 'Acme' })).toBeDefined();
    expect(screen.getByText('Team')).toBeDefined();
    expect(screen.getByText(fmtDateWithYear(baseSettings.createdAt))).toBeDefined();

    expect(await screen.findByText('Seats')).toBeDefined();
    // Unique among the four lanes given baseUsage's fixture numbers.
    expect(screen.getByText('3 / 25')).toBeDefined();
  });

  it('disables Save until the org name is actually changed', async () => {
    renderScreen();

    const saveBtn = await screen.findByRole('button', { name: 'Save organization name' });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);

    const input = screen.getByLabelText('Organization name');
    await userEvent.type(input, ' Inc');
    expect((saveBtn as HTMLButtonElement).disabled).toBe(false);

    await userEvent.clear(input);
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('renames the org', async () => {
    vi.mocked(api.updateOrgSettings).mockResolvedValue({ ...baseSettings, name: 'Acme Inc' });
    renderScreen();

    const input = await screen.findByLabelText('Organization name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Acme Inc');
    await userEvent.click(screen.getByRole('button', { name: 'Save organization name' }));

    expect(api.updateOrgSettings).toHaveBeenCalledWith({ name: 'Acme Inc' });
  });
});
