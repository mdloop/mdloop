import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AllowlistEntryId, InviteId, UserId } from '@vorlyn/shared';
import { FakeDirectoryRepository, FakeWorld } from '../test-support/fakes.js';
import type { SeatSyncPort } from '../ports/seat-sync.port.js';
import { NoopSeatSync } from '../ports/seat-sync.port.js';
import { signIn } from './sign-in.js';
import { hashInviteToken } from './invites.js';

function setup() {
  const world = new FakeWorld();
  return {
    world,
    directory: new FakeDirectoryRepository(world),
  };
}

describe('signIn', () => {
  it('returns the existing user without provisioning', async () => {
    const { world, directory } = setup();
    const org = world.org();
    const existing = world.addUser(org.id, {
      workosUserId: 'wos_1',
      email: 'a@x.test',
      displayName: 'A',
      role: 'member',
    });
    const result = await signIn(directory, NoopSeatSync, {
      providerUserId: 'wos_1',
      email: 'a@x.test',
      displayName: 'A',
    });
    expect(result.ok && result.value).toEqual(existing);
  });

  it('provisions a free personal org and admin user on first sign-in', async () => {
    const { directory } = setup();
    const result = await signIn(directory, NoopSeatSync, {
      providerUserId: 'wos_2',
      email: 'new@x.test',
      displayName: 'New Person',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.role).toBe('admin');
    expect(result.value.displayName).toBe('New Person');
  });

  it('falls back to a generic workspace name when display name is empty', async () => {
    const { world, directory } = setup();
    const result = await signIn(directory, NoopSeatSync, {
      providerUserId: 'wos_3',
      email: 'x@y.test',
      displayName: '',
    });
    expect(result.ok).toBe(true);
    const org = result.ok ? world.orgs.get(result.value.orgId) : undefined;
    expect(org?.name).toBe('Workspace');
  });

  it('refuses disposable-email signups but not returning users', async () => {
    const { world, directory } = setup();
    const refused = await signIn(directory, NoopSeatSync, {
      providerUserId: 'wos_4',
      email: 'burner@mailinator.com',
      displayName: 'B',
    });
    expect(!refused.ok && refused.error.code).toBe('disposable_email');

    const org = world.org();
    world.addUser(org.id, {
      workosUserId: 'wos_1',
      email: 'burner@mailinator.com',
      displayName: 'A',
      role: 'member',
    });
    const result = await signIn(directory, NoopSeatSync, {
      providerUserId: 'wos_1',
      email: 'burner@mailinator.com',
      displayName: 'A',
    });
    expect(result.ok).toBe(true);
  });

  describe('invite acceptance (Phase 15)', () => {
    it('joins the inviting org with the invite role', async () => {
      const { world, directory } = setup();
      const org = world.org({ tier: 'team' });
      const token = 'invite-token';
      const inviteId = randomUUID() as InviteId;
      world.invites.set(inviteId, {
        id: inviteId,
        orgId: org.id,
        email: 'invitee@x.test',
        role: 'admin',
        tokenHash: hashInviteToken(token),
        invitedBy: 'u-admin' as UserId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
        acceptedAt: null,
        revokedAt: null,
      });

      const result = await signIn(
        directory,
        NoopSeatSync,
        { providerUserId: 'wos_invitee', email: 'invitee@x.test', displayName: 'Invitee' },
        token,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.orgId).toBe(org.id);
      expect(result.value.role).toBe('admin');
    });

    it('rejects an unknown token', async () => {
      const { directory } = setup();
      const result = await signIn(
        directory,
        NoopSeatSync,
        { providerUserId: 'wos_x', email: 'x@x.test', displayName: 'X' },
        'no-such-token',
      );
      expect(!result.ok && result.error.code).toBe('invite_not_found');
    });

    it('rejects an expired invite', async () => {
      const { world, directory } = setup();
      const org = world.org();
      const token = 'expired-token';
      const inviteId = randomUUID() as InviteId;
      world.invites.set(inviteId, {
        id: inviteId,
        orgId: org.id,
        email: 'x@x.test',
        role: 'member',
        tokenHash: hashInviteToken(token),
        invitedBy: 'u-admin' as UserId,
        createdAt: new Date(Date.now() - 2 * 86_400_000),
        expiresAt: new Date(Date.now() - 86_400_000),
        acceptedAt: null,
        revokedAt: null,
      });
      const result = await signIn(
        directory,
        NoopSeatSync,
        { providerUserId: 'wos_x', email: 'x@x.test', displayName: 'X' },
        token,
      );
      expect(!result.ok && result.error.code).toBe('invite_expired');
    });
  });

  describe('enterprise SSO JIT (Phase 15)', () => {
    it('open mode auto-joins any verified-connection login as member', async () => {
      const { world, directory } = setup();
      const org = world.org({
        tier: 'enterprise',
        provisioningMode: 'open',
        ssoConnectionId: 'conn_1',
      });
      const result = await signIn(directory, NoopSeatSync, {
        providerUserId: 'wos_sso1',
        email: 'anyone@corp.test',
        displayName: 'Anyone',
        ssoConnectionId: 'conn_1',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.orgId).toBe(org.id);
      expect(result.value.role).toBe('member');
    });

    it('allowlist mode denies a non-listed email', async () => {
      const { world, directory } = setup();
      world.org({ tier: 'enterprise', provisioningMode: 'allowlist', ssoConnectionId: 'conn_2' });
      const result = await signIn(directory, NoopSeatSync, {
        providerUserId: 'wos_sso2',
        email: 'stranger@corp.test',
        displayName: 'Stranger',
        ssoConnectionId: 'conn_2',
      });
      expect(!result.ok && result.error.code).toBe('not_allowlisted');
    });

    it('allowlist mode admits a listed email', async () => {
      const { world, directory } = setup();
      const org = world.org({
        tier: 'enterprise',
        provisioningMode: 'allowlist',
        ssoConnectionId: 'conn_3',
      });
      const entryId = randomUUID() as AllowlistEntryId;
      world.allowlist.set(entryId, {
        id: entryId,
        orgId: org.id,
        email: 'listed@corp.test',
        addedBy: 'u-admin' as UserId,
        createdAt: new Date(),
      });
      const result = await signIn(directory, NoopSeatSync, {
        providerUserId: 'wos_sso3',
        email: 'listed@corp.test',
        displayName: 'Listed',
        ssoConnectionId: 'conn_3',
      });
      expect(result.ok).toBe(true);
    });

    it('denies with an unknown SSO connection', async () => {
      const { directory } = setup();
      const result = await signIn(directory, NoopSeatSync, {
        providerUserId: 'wos_sso4',
        email: 'x@corp.test',
        displayName: 'X',
        ssoConnectionId: 'conn_missing',
      });
      expect(!result.ok && result.error.code).toBe('sso_connection_not_found');
    });

    it('blocks JIT auto-join on a free-tier org — SSO requires Enterprise tier (Phase 33)', async () => {
      // This used to prove the free-tier seat ceiling (1) via JIT. As of
      // Phase 33, SSO is Enterprise-only and that tier gate is checked
      // before allowlist or seat-ceiling logic, so a free-tier org can no
      // longer reach the seat check via JIT at all — it refuses right here,
      // regardless of member count. Team and Enterprise both have unlimited
      // `maxCollaborators` (packages/domain/src/tier.ts), so there is no
      // real tier left where a seat-ceiling-via-JIT scenario is
      // constructible any more; see the equivalent note in
      // packages/domain/src/invite.test.ts.
      const { world, directory } = setup();
      const org = world.org({ tier: 'free', provisioningMode: 'open', ssoConnectionId: 'conn_5' });
      world.addUser(org.id, {
        workosUserId: 'wos_a',
        email: 'a@corp.test',
        displayName: 'A',
        role: 'admin',
      });
      const result = await signIn(directory, NoopSeatSync, {
        providerUserId: 'wos_c',
        email: 'c@corp.test',
        displayName: 'C',
        ssoConnectionId: 'conn_5',
      });
      expect(result).toEqual({ ok: false, error: { code: 'sso_requires_enterprise_tier' } });
    });
  });

  describe('seat-sync reporting', () => {
    function recorder(): { calls: { orgId: string; count: number }[]; port: SeatSyncPort } {
      const calls: { orgId: string; count: number }[] = [];
      return {
        calls,
        port: {
          onSeatsChanged: (org, humanMemberCount) => {
            calls.push({ orgId: org.id, count: humanMemberCount });
            return Promise.resolve();
          },
        },
      };
    }

    it('reports the post-join headcount when an invite is accepted', async () => {
      const { world, directory } = setup();
      const org = world.org();
      world.addUser(org.id, {
        workosUserId: 'wos_admin',
        email: 'admin@x.test',
        displayName: 'Admin',
        role: 'admin',
      });
      const token = 'invite-token-seat-sync';
      const inviteId = randomUUID() as InviteId;
      world.invites.set(inviteId, {
        id: inviteId,
        orgId: org.id,
        email: 'joiner@x.test',
        role: 'member',
        tokenHash: hashInviteToken(token),
        invitedBy: 'u-admin' as UserId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
        acceptedAt: null,
        revokedAt: null,
      });

      const rec = recorder();
      const result = await signIn(
        directory,
        rec.port,
        { providerUserId: 'wos_joiner', email: 'joiner@x.test', displayName: 'Joiner' },
        token,
      );

      expect(result.ok).toBe(true);
      // Counted after the join, not before: the existing admin plus the joiner.
      expect(rec.calls).toEqual([{ orgId: org.id, count: 2 }]);
    });

    it('does not report when a returning user simply signs in', async () => {
      const { world, directory } = setup();
      const org = world.org();
      world.addUser(org.id, {
        workosUserId: 'wos_1',
        email: 'a@x.test',
        displayName: 'A',
        role: 'member',
      });

      const rec = recorder();
      await signIn(directory, rec.port, {
        providerUserId: 'wos_1',
        email: 'a@x.test',
        displayName: 'A',
      });

      expect(rec.calls).toEqual([]);
    });

    it('completes the join even if the listener throws', async () => {
      // The member row is already committed by this point, and the joiner is
      // now a returning user — so failing here would break a sign-in that
      // actually succeeded, with no way to retry it.
      const { world, directory } = setup();
      const org = world.org({ tier: 'team' });
      const token = 'invite-token-throwing-listener';
      const inviteId = randomUUID() as InviteId;
      world.invites.set(inviteId, {
        id: inviteId,
        orgId: org.id,
        email: 'joiner@x.test',
        role: 'member',
        tokenHash: hashInviteToken(token),
        invitedBy: 'u-admin' as UserId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
        acceptedAt: null,
        revokedAt: null,
      });

      const exploding: SeatSyncPort = {
        onSeatsChanged: () => Promise.reject(new Error('listener is down')),
      };
      const result = await signIn(
        directory,
        exploding,
        { providerUserId: 'wos_joiner', email: 'joiner@x.test', displayName: 'Joiner' },
        token,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.orgId).toBe(org.id);
    });

    it('does not report when a personal org is bootstrapped', async () => {
      // Nobody joined an existing org — a brand-new org of one is not a
      // headcount change anyone asked to hear about.
      const { directory } = setup();
      const rec = recorder();

      await signIn(directory, rec.port, {
        providerUserId: 'wos_new',
        email: 'new@x.test',
        displayName: 'New',
      });

      expect(rec.calls).toEqual([]);
    });
  });
});
