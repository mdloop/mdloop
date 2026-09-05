import { describe, expect, it } from 'vitest';
import type { UserId } from '@mdloop/shared';
import {
  FakeAllowlistRepository,
  FakeEmail,
  FakeOrgInviteRepository,
  FakeOrganizationRepository,
  FakeWorld,
} from '../test-support/fakes.js';
import type { Actor } from './org-settings.js';
import {
  addAllowlistEntry,
  hashInviteToken,
  listAllowlist,
  listInvites,
  removeAllowlistEntry,
  revokeInvite,
  sendInvite,
} from './invites.js';

function setup(orgOverrides: Parameters<FakeWorld['org']>[0] = {}) {
  const world = new FakeWorld();
  const org = world.org(orgOverrides);
  const admin: Actor = { ctx: { orgId: org.id, userId: 'u-admin' as UserId }, role: 'admin' };
  const member: Actor = { ctx: { orgId: org.id, userId: 'u-member' as UserId }, role: 'member' };
  return {
    world,
    org,
    admin,
    member,
    orgs: new FakeOrganizationRepository(world),
    invites: new FakeOrgInviteRepository(world),
    allowlist: new FakeAllowlistRepository(world),
    email: new FakeEmail(),
  };
}

describe('sendInvite', () => {
  it('forbids non-admins', async () => {
    const { orgs, invites, email, member } = setup();
    const r = await sendInvite(orgs, invites, email, member, {
      email: 'x@x.test',
      role: 'member',
      acceptUrlBase: 'https://app.test/invite/accept?token=',
    });
    expect(r).toEqual({ ok: false, error: { code: 'forbidden' } });
  });

  it('sends an invite, hashes the token, and emails it once', async () => {
    const { orgs, invites, email, admin } = setup();
    const r = await sendInvite(orgs, invites, email, admin, {
      email: 'new@x.test',
      role: 'member',
      acceptUrlBase: 'https://app.test/invite/accept?token=',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.invite.tokenHash).toBe(hashInviteToken(r.value.token));
    expect(r.value.invite.email).toBe('new@x.test');
    expect(email.invitesSent).toHaveLength(1);
    expect(email.invitesSent[0]?.to).toBe('new@x.test');
    expect(email.invitesSent[0]?.acceptUrl).toContain(encodeURIComponent(r.value.token));
  });

  it('still returns the invite and token when email delivery fails (best-effort send)', async () => {
    const { orgs, invites, email, admin } = setup();
    email.failing = true;
    const r = await sendInvite(orgs, invites, email, admin, {
      email: 'new@x.test',
      role: 'member',
      acceptUrlBase: 'https://app.test/invite/accept?token=',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.token).toBeTruthy();
    expect(r.value.invite.email).toBe('new@x.test');
    // Nothing recorded — the fake only pushes onto invitesSent on success.
    expect(email.invitesSent).toHaveLength(0);
  });

  it('blocks sending at the free-tier seat ceiling counting members + pending invites', async () => {
    // Free tier's seat ceiling is 1 (Phase 33): one existing member alone
    // already occupies the org's only seat, so even the very first invite
    // is blocked — no invite needs to be sent first to prove members count.
    const { world, orgs, invites, email, admin, org } = setup({ tier: 'free' });
    world.addUser(org.id, {
      workosUserId: 'wos_a',
      email: 'a@x.test',
      displayName: 'A',
      role: 'admin',
    });
    const blocked = await sendInvite(orgs, invites, email, admin, {
      email: 'b@x.test',
      role: 'member',
      acceptUrlBase: 'https://app.test/invite/accept?token=',
    });
    expect(blocked).toEqual({ ok: false, error: { code: 'seat_cap_reached', limit: 1 } });
  });

  it('blocks a second invite when a pending invite alone already fills the free-tier seat', async () => {
    // The other half of "members + pending invites" — with zero existing
    // members, the first invite still succeeds (the seat is empty), and it
    // is the pending invite itself that then occupies the org's one seat.
    const { orgs, invites, email, admin } = setup({ tier: 'free' });
    const first = await sendInvite(orgs, invites, email, admin, {
      email: 'b@x.test',
      role: 'member',
      acceptUrlBase: 'https://app.test/invite/accept?token=',
    });
    expect(first.ok).toBe(true);

    const second = await sendInvite(orgs, invites, email, admin, {
      email: 'c@x.test',
      role: 'member',
      acceptUrlBase: 'https://app.test/invite/accept?token=',
    });
    expect(second).toEqual({ ok: false, error: { code: 'seat_cap_reached', limit: 1 } });
  });
});

describe('listInvites / revokeInvite', () => {
  it('forbids non-admins from listing or revoking', async () => {
    const { invites, member } = setup();
    expect(await listInvites(invites, member)).toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(await revokeInvite(invites, member, 'inv-1' as never)).toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
  });

  it('admin lists and revokes an invite', async () => {
    const { orgs, invites, email, admin } = setup();
    const sent = await sendInvite(orgs, invites, email, admin, {
      email: 'x@x.test',
      role: 'member',
      acceptUrlBase: 'https://app.test/invite/accept?token=',
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    const listed = await listInvites(invites, admin);
    expect(listed.ok && listed.value).toHaveLength(1);

    const revoked = await revokeInvite(invites, admin, sent.value.invite.id);
    expect(revoked.ok).toBe(true);

    const revokedAgain = await revokeInvite(invites, admin, sent.value.invite.id);
    expect(revokedAgain).toEqual({ ok: false, error: { code: 'invite_not_found' } });
  });
});

describe('allowlist admin use-cases', () => {
  it('forbids non-admins', async () => {
    const { allowlist, member } = setup();
    expect(await addAllowlistEntry(allowlist, member, 'x@x.test')).toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await listAllowlist(allowlist, member)).toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
  });

  it('admin adds, lists, and removes an entry', async () => {
    const { allowlist, admin } = setup();
    const added = await addAllowlistEntry(allowlist, admin, 'x@x.test');
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const listed = await listAllowlist(allowlist, admin);
    expect(listed.ok && listed.value).toHaveLength(1);

    const removed = await removeAllowlistEntry(allowlist, admin, added.value.id);
    expect(removed.ok).toBe(true);

    const removedAgain = await removeAllowlistEntry(allowlist, admin, added.value.id);
    expect(removedAgain).toEqual({ ok: false, error: { code: 'entry_not_found' } });
  });
});
