import { describe, expect, it, vi } from 'vitest';
import type { Actor, OrganizationRepository, RoleDirectory } from './org-settings.js';
import { setUserRole, updateOrgSettings } from './org-settings.js';
import type { Organization } from '@vorlyn/domain';
import type { OrgId, UserId } from '@vorlyn/shared';

const org: Organization = {
  id: 'o1' as OrgId,
  name: 'Acme',
  sharingMode: 'link',
  externalSharing: true,
  tier: 'team',
  versionRetention: null,
  subscriptionStatus: 'none',
  billingCustomerId: null,
  trialEndsAt: null,
  readOnlyAt: null,
  purgeScheduledAt: null,
  idleWarningSentAt: null,
  provisioningMode: 'allowlist',
  ssoConnectionId: null,
  approvalGate: 'soft',
  sessionMaxHours: null,
  retentionDays: 30,
  purgeImmediately: false,
  createdAt: new Date(),
};

const admin: Actor = { ctx: { orgId: org.id, userId: 'u-admin' as UserId }, role: 'admin' };
const member: Actor = { ctx: { orgId: org.id, userId: 'u-member' as UserId }, role: 'member' };

function fakeOrgs(...updated: [Organization | undefined] | []): OrganizationRepository {
  const result = updated.length > 0 ? updated[0] : org;
  return {
    current: vi.fn(async () => org),
    updateSettings: vi.fn(async () => result),
    listUsers: vi.fn(async () => []),
    listUsersPage: vi.fn(async () => ({ users: [], nextCursor: null })),
    userById: vi.fn(async () => undefined),
  };
}

describe('updateOrgSettings', () => {
  it('lets an admin update settings', async () => {
    const orgs = fakeOrgs({ ...org, retentionDays: 7 });
    const res = await updateOrgSettings(orgs, admin, { retentionDays: 7 });
    expect(res.ok && res.value.retentionDays).toBe(7);
  });

  it('refuses a member', async () => {
    const orgs = fakeOrgs();
    const res = await updateOrgSettings(orgs, member, { retentionDays: 7 });
    expect(!res.ok && res.error.code).toBe('forbidden');
    expect(orgs.updateSettings).not.toHaveBeenCalled();
  });

  it('renames the org (personal→org upgrade path), rejecting blank names', async () => {
    const orgs = fakeOrgs({ ...org, name: 'Acme Inc' });
    const renamed = await updateOrgSettings(orgs, admin, { name: 'Acme Inc' });
    expect(renamed.ok && renamed.value.name).toBe('Acme Inc');
    for (const bad of ['   ', 'x'.repeat(201)]) {
      const res = await updateOrgSettings(fakeOrgs(), admin, { name: bad });
      expect(!res.ok && res.error.code).toBe('invalid_name');
    }
  });

  it('rejects invalid retention days', async () => {
    const res = await updateOrgSettings(fakeOrgs(), admin, { retentionDays: 9999 });
    expect(!res.ok && res.error.code).toBe('invalid_retention_days');
  });

  it('propagates org_not_found', async () => {
    const res = await updateOrgSettings(fakeOrgs(undefined), admin, { purgeImmediately: true });
    expect(!res.ok && res.error.code).toBe('org_not_found');
  });

  it('sets a shorter session max (Phase 24) and round-trips it', async () => {
    const orgs = fakeOrgs({ ...org, sessionMaxHours: 8 });
    const res = await updateOrgSettings(orgs, admin, { sessionMaxHours: 8 });
    expect(res.ok && res.value.sessionMaxHours).toBe(8);
  });

  it('accepts null to reset the session max to the global default', async () => {
    const orgs = fakeOrgs({ ...org, sessionMaxHours: null });
    const res = await updateOrgSettings(orgs, admin, { sessionMaxHours: null });
    expect(res.ok && res.value.sessionMaxHours).toBeNull();
    expect(orgs.updateSettings).toHaveBeenCalled();
  });

  it('rejects a session max outside 1..24 (may only shorten below 24h)', async () => {
    for (const bad of [0, 25, -3, 1.5]) {
      const orgs = fakeOrgs();
      const res = await updateOrgSettings(orgs, admin, { sessionMaxHours: bad });
      expect(!res.ok && res.error.code).toBe('invalid_session_max_hours');
      expect(orgs.updateSettings).not.toHaveBeenCalled();
    }
  });

  it('accepts version retention within the tier ceiling (ADR 0001)', async () => {
    const config = { keepLastN: 100, keepDays: 90 };
    const orgs = fakeOrgs({ ...org, versionRetention: config });
    const res = await updateOrgSettings(orgs, admin, { versionRetention: config });
    expect(res.ok && res.value.versionRetention).toEqual(config);
  });

  it('accepts null to reset version retention to the tier default', async () => {
    const res = await updateOrgSettings(fakeOrgs(), admin, { versionRetention: null });
    expect(res.ok).toBe(true);
  });

  it('rejects malformed version retention', async () => {
    for (const bad of [
      { keepLastN: 0, keepDays: 30 },
      { keepLastN: 1.5, keepDays: 30 },
      { keepLastN: 5, keepDays: 0 },
    ]) {
      const res = await updateOrgSettings(fakeOrgs(), admin, { versionRetention: bad });
      expect(!res.ok && res.error.code).toBe('invalid_version_retention');
    }
  });

  it('rejects version retention looser than the tier ceiling instead of clamping', async () => {
    // Team ceiling is N≤250; asking for more is an explicit error the admin sees.
    const res = await updateOrgSettings(fakeOrgs(), admin, {
      versionRetention: { keepLastN: 5000, keepDays: null },
    });
    expect(!res.ok && res.error.code).toBe('version_retention_exceeds_tier_ceiling');
  });

  it('propagates org_not_found when the org disappears before the tier-ceiling check', async () => {
    const orgs: OrganizationRepository = {
      current: vi.fn(async () => undefined),
      updateSettings: vi.fn(async () => org),
      listUsers: vi.fn(async () => []),
      listUsersPage: vi.fn(async () => ({ users: [], nextCursor: null })),
      userById: vi.fn(async () => undefined),
    };
    const res = await updateOrgSettings(orgs, admin, {
      versionRetention: { keepLastN: 5, keepDays: 30 },
    });
    expect(!res.ok && res.error.code).toBe('org_not_found');
  });
});

describe('setUserRole', () => {
  function fakeRoles(changed = true): RoleDirectory {
    return { setUserRole: vi.fn(async () => changed) };
  }

  it('lets an admin change a role', async () => {
    const res = await setUserRole(fakeRoles(), admin, 'u2' as UserId, 'admin');
    expect(res.ok).toBe(true);
  });

  it('refuses a member', async () => {
    const roles = fakeRoles();
    const res = await setUserRole(roles, member, 'u2' as UserId, 'admin');
    expect(!res.ok && res.error.code).toBe('forbidden');
    expect(roles.setUserRole).not.toHaveBeenCalled();
  });

  it('blocks self-demotion', async () => {
    const res = await setUserRole(fakeRoles(), admin, admin.ctx.userId, 'member');
    expect(!res.ok && res.error.code).toBe('cannot_demote_self');
  });

  it('allows self re-affirmation as admin', async () => {
    const res = await setUserRole(fakeRoles(), admin, admin.ctx.userId, 'admin');
    expect(res.ok).toBe(true);
  });

  it('propagates user_not_found', async () => {
    const res = await setUserRole(fakeRoles(false), admin, 'ghost' as UserId, 'member');
    expect(!res.ok && res.error.code).toBe('user_not_found');
  });
});
