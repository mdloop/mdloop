import { fileURLToPath } from 'node:url';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { Actor, SignInError } from '@mdloop/app';
import {
  NoopSeatSync,
  addAllowlistEntry,
  hashInviteToken,
  revokeInvite,
  sendInvite,
  signIn,
} from '@mdloop/app';
import { FakeEmail } from '@mdloop/app/test-support';
import type { Organization, OrgInvite, User } from '@mdloop/domain';
import type { Result } from '@mdloop/shared';
import {
  PgAllowlistRepository,
  PgOrgInviteRepository,
} from './repositories/pg-invite-repository.js';
import { PgOrganizationRepository } from './repositories/pg-organization-repository.js';
import { PgDirectoryRepository } from './repositories/pg-repositories.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

const feature = await loadFeature(
  fileURLToPath(new URL('../../../features/org-invites.feature', import.meta.url)),
);

interface World {
  db: TestDb;
  directory: PgDirectoryRepository;
  orgRepo: PgOrganizationRepository;
  inviteRepo: PgOrgInviteRepository;
  allowlistRepo: PgAllowlistRepository;
  email: FakeEmail;
  orgs: Map<string, Organization>;
  admins: Map<string, Actor>;
  invites: Map<string, { invite: OrgInvite; token: string }>;
  lastSignIn?: Result<User, SignInError>;
  lastSendError?: string;
}

describeFeature(feature, ({ Background, Scenario, AfterAllScenarios }) => {
  const w = {} as World;

  AfterAllScenarios(async () => {
    await w.db.close();
  });

  async function makeAdmin(orgId: Organization['id'], name: string): Promise<Actor> {
    const user = await w.directory.createUser(orgId, {
      workosUserId: `wos_${name}_${String(Math.random())}`,
      email: `${name}_${String(Math.random())}@test.test`,
      displayName: name,
      role: 'admin',
    });
    return { ctx: { orgId, userId: user.id }, role: 'admin' };
  }

  async function addPlainMember(orgId: Organization['id'], name: string): Promise<void> {
    await w.directory.createUser(orgId, {
      workosUserId: `wos_${name}_${String(Math.random())}`,
      email: `${name}_${String(Math.random())}@test.test`,
      displayName: name,
      role: 'member',
    });
  }

  async function setSso(
    orgId: Organization['id'],
    tier: string,
    mode: 'open' | 'allowlist',
    connectionId: string,
  ): Promise<void> {
    await w.db.pool.query(
      'update organizations set tier = $1, provisioning_mode = $2, sso_connection_id = $3 where id = $4',
      [tier, mode, connectionId, orgId],
    );
  }

  Background(({ Given }) => {
    // Team tier (unlimited collaborators) so scenarios about invite
    // lifecycle (send, accept, expire, revoke, redeem-once) aren't tripped
    // up by the free-tier seat ceiling, which is now 1 (Phase 33) — a single
    // admin already fills it. The seat-cap scenarios prove the ceiling on
    // their own dedicated free-tier orgs below.
    Given('a team-tier organization "Acme" with admin "alice"', async () => {
      if (!(w as Partial<World>).db) {
        w.db = await createTestDb();
        w.orgRepo = new PgOrganizationRepository(w.db.pool);
        w.inviteRepo = new PgOrgInviteRepository(w.db.pool);
        w.allowlistRepo = new PgAllowlistRepository(w.db.pool);
      }
      w.directory = new PgDirectoryRepository(w.db.pool);
      w.email = new FakeEmail();
      w.orgs = new Map();
      w.admins = new Map();
      w.invites = new Map();

      const acme = await w.directory.createOrganization('Acme', 'team');
      w.orgs.set('Acme', acme);
      w.admins.set('Acme', await makeAdmin(acme.id, 'alice'));
    });
  });

  function okUser(): User {
    if (!w.lastSignIn?.ok) throw new Error('expected signIn to succeed');
    return w.lastSignIn.value;
  }

  function errCode(): string {
    if (!w.lastSignIn || w.lastSignIn.ok) throw new Error('expected signIn to fail');
    return w.lastSignIn.error.code;
  }

  async function invite(orgName: string, email: string, role: 'admin' | 'member'): Promise<void> {
    const admin = w.admins.get(orgName);
    if (!admin) throw new Error(`no admin actor for ${orgName}`);
    const result = await sendInvite(w.orgRepo, w.inviteRepo, w.email, admin, {
      email,
      role,
      acceptUrlBase: 'https://app.test/auth/login?invite=',
    });
    if (!result.ok) {
      w.lastSendError = result.error.code;
      return;
    }
    w.invites.set(email, result.value);
  }

  Scenario('Sending an invite returns a token shown exactly once', ({ When, Then, And }) => {
    When('"alice" invites "new@acme.test" as "member"', async () => {
      await invite('Acme', 'new@acme.test', 'member');
    });
    Then('the invite is pending for "new@acme.test"', () => {
      const entry = w.invites.get('new@acme.test');
      expect(entry?.invite.acceptedAt).toBeNull();
      expect(entry?.invite.revokedAt).toBeNull();
    });
    And('the invite token hashes to the stored invite', () => {
      const entry = w.invites.get('new@acme.test');
      expect(entry).toBeDefined();
      expect(hashInviteToken(entry?.token ?? '')).toBe(entry?.invite.tokenHash);
    });
  });

  Scenario(
    'Accepting a live invite joins the inviting org with its pre-set role',
    ({ Given, When, Then, And }) => {
      Given('"alice" invited "new@acme.test" as "admin"', async () => {
        await invite('Acme', 'new@acme.test', 'admin');
      });
      When('the invitee signs in with that invite token', async () => {
        const entry = w.invites.get('new@acme.test');
        if (!entry) throw new Error('missing invite');
        w.lastSignIn = await signIn(
          w.directory,
          NoopSeatSync,
          { providerUserId: 'wos_invitee_1', email: 'new@acme.test', displayName: 'New' },
          entry.token,
        );
      });
      Then('they join "Acme" with role "admin"', () => {
        expect(okUser().role).toBe('admin');
        expect(okUser().orgId).toBe(w.orgs.get('Acme')?.id);
      });
      And('the invite is marked accepted', async () => {
        const entry = w.invites.get('new@acme.test');
        const fresh = await w.inviteRepo.list(w.admins.get('Acme')!.ctx);
        const found = fresh.find((i) => i.id === entry?.invite.id);
        expect(found?.acceptedAt).not.toBeNull();
      });
    },
  );

  Scenario('An expired invite is rejected honestly', ({ Given, When, Then }) => {
    Given('"alice" invited "new@acme.test" as "member" that already expired', async () => {
      await invite('Acme', 'new@acme.test', 'member');
      const entry = w.invites.get('new@acme.test');
      await w.db.pool.query(
        "update org_invites set expires_at = now() - interval '1 day' where id = $1",
        [entry?.invite.id],
      );
    });
    When('the invitee signs in with that invite token', async () => {
      const entry = w.invites.get('new@acme.test');
      if (!entry) throw new Error('missing invite');
      w.lastSignIn = await signIn(
        w.directory,
        NoopSeatSync,
        { providerUserId: 'wos_invitee_2', email: 'new@acme.test', displayName: 'New' },
        entry.token,
      );
    });
    Then('sign-in is refused with "invite_expired"', () => {
      expect(errCode()).toBe('invite_expired');
    });
  });

  Scenario('A revoked invite is rejected honestly', ({ Given, And, When, Then }) => {
    Given('"alice" invited "new@acme.test" as "member"', async () => {
      await invite('Acme', 'new@acme.test', 'member');
    });
    And('"alice" revokes that invite', async () => {
      const entry = w.invites.get('new@acme.test');
      if (!entry) throw new Error('missing invite');
      const r = await revokeInvite(w.inviteRepo, w.admins.get('Acme')!, entry.invite.id);
      expect(r.ok).toBe(true);
    });
    When('the invitee signs in with that invite token', async () => {
      const entry = w.invites.get('new@acme.test');
      if (!entry) throw new Error('missing invite');
      w.lastSignIn = await signIn(
        w.directory,
        NoopSeatSync,
        { providerUserId: 'wos_invitee_3', email: 'new@acme.test', displayName: 'New' },
        entry.token,
      );
    });
    Then('sign-in is refused with "invite_revoked"', () => {
      expect(errCode()).toBe('invite_revoked');
    });
  });

  Scenario('An already-accepted invite cannot be redeemed twice', ({ Given, And, When, Then }) => {
    Given('"alice" invited "new@acme.test" as "member"', async () => {
      await invite('Acme', 'new@acme.test', 'member');
    });
    And('the invitee already accepted that invite', async () => {
      const entry = w.invites.get('new@acme.test');
      if (!entry) throw new Error('missing invite');
      const first = await signIn(
        w.directory,
        NoopSeatSync,
        { providerUserId: 'wos_invitee_4', email: 'new@acme.test', displayName: 'New' },
        entry.token,
      );
      expect(first.ok).toBe(true);
    });
    When('a second sign-in attempts the same invite token', async () => {
      const entry = w.invites.get('new@acme.test');
      if (!entry) throw new Error('missing invite');
      w.lastSignIn = await signIn(
        w.directory,
        NoopSeatSync,
        { providerUserId: 'wos_invitee_4b', email: 'other@acme.test', displayName: 'Other' },
        entry.token,
      );
    });
    Then('sign-in is refused with "invite_already_used"', () => {
      expect(errCode()).toBe('invite_already_used');
    });
  });

  Scenario('The free-tier seat ceiling blocks sending a new invite', ({ Given, When, Then }) => {
    // Free tier's seat ceiling is 1 (Phase 33) — the admin alone already
    // occupies it, so no extra member needs seeding to hit the cap. Uses a
    // dedicated org rather than the Background's now team-tier "Acme".
    Given('a free-tier organization "Frugal" with admin "owner"', async () => {
      const frugal = await w.directory.createOrganization('Frugal', 'free');
      w.orgs.set('Frugal', frugal);
      w.admins.set('Frugal', await makeAdmin(frugal.id, 'owner'));
    });
    When('"owner" invites "another@frugal.test" as "member"', async () => {
      await invite('Frugal', 'another@frugal.test', 'member');
    });
    Then('the invite send is refused with "seat_cap_reached"', () => {
      expect(w.lastSendError).toBe('seat_cap_reached');
    });
  });

  Scenario('Enterprise open mode auto-joins any verified SSO login', ({ Given, When, Then }) => {
    Given(
      'an enterprise organization "Globex" in open provisioning mode with an SSO connection',
      async () => {
        const globex = await w.directory.createOrganization('Globex', 'team');
        await setSso(globex.id, 'enterprise', 'open', 'conn_globex');
        w.orgs.set('Globex', globex);
      },
    );
    When('"anyone@globex.test" signs in through that SSO connection', async () => {
      w.lastSignIn = await signIn(w.directory, NoopSeatSync, {
        providerUserId: 'wos_globex_1',
        email: 'anyone@globex.test',
        displayName: 'Anyone',
        ssoConnectionId: 'conn_globex',
      });
    });
    Then('they join "Globex" with role "member"', () => {
      expect(okUser().role).toBe('member');
    });
  });

  Scenario('Enterprise allowlist mode rejects a non-listed email', ({ Given, When, Then }) => {
    Given(
      'an enterprise organization "Initech" in allowlist provisioning mode with an SSO connection',
      async () => {
        const initech = await w.directory.createOrganization('Initech', 'team');
        await setSso(initech.id, 'enterprise', 'allowlist', 'conn_initech');
        w.orgs.set('Initech', initech);
      },
    );
    When('"stranger@initech.test" signs in through that SSO connection', async () => {
      w.lastSignIn = await signIn(w.directory, NoopSeatSync, {
        providerUserId: 'wos_initech_1',
        email: 'stranger@initech.test',
        displayName: 'Stranger',
        ssoConnectionId: 'conn_initech',
      });
    });
    Then('sign-in is refused with "not_allowlisted"', () => {
      expect(errCode()).toBe('not_allowlisted');
    });
  });

  Scenario('Enterprise allowlist mode admits a listed email', ({ Given, And, When, Then }) => {
    Given(
      'an enterprise organization "Initech" in allowlist provisioning mode with an SSO connection',
      async () => {
        if (!w.orgs.has('Initech')) {
          const initech = await w.directory.createOrganization('Initech', 'team');
          await setSso(initech.id, 'enterprise', 'allowlist', 'conn_initech_2');
          w.orgs.set('Initech', initech);
          w.admins.set('Initech', await makeAdmin(initech.id, 'ivan'));
        }
      },
    );
    And('"listed@initech.test" is on the allowlist', async () => {
      const admin = w.admins.get('Initech');
      if (!admin) throw new Error('missing admin');
      const r = await addAllowlistEntry(w.allowlistRepo, admin, 'listed@initech.test');
      expect(r.ok).toBe(true);
    });
    When('"listed@initech.test" signs in through that SSO connection', async () => {
      w.lastSignIn = await signIn(w.directory, NoopSeatSync, {
        providerUserId: 'wos_initech_2',
        email: 'listed@initech.test',
        displayName: 'Listed',
        ssoConnectionId: 'conn_initech_2',
      });
    });
    Then('they join "Initech" with role "member"', () => {
      expect(okUser().role).toBe('member');
    });
  });

  Scenario(
    'JIT auto-join on a free-tier org is blocked by the SSO tier gate, not the seat ceiling',
    ({ Given, And, When, Then }) => {
      Given(
        'a free-tier organization "Bootstrap" in open provisioning mode with an SSO connection',
        async () => {
          const bootstrap = await w.directory.createOrganization('Bootstrap', 'free');
          await setSso(bootstrap.id, 'free', 'open', 'conn_bootstrap');
          w.orgs.set('Bootstrap', bootstrap);
        },
      );
      And('"Bootstrap" already has 1 seat occupied by a member', async () => {
        const bootstrap = w.orgs.get('Bootstrap');
        if (!bootstrap) throw new Error('missing org');
        await addPlainMember(bootstrap.id, 'first');
      });
      When('"second@bootstrap.test" signs in through that SSO connection', async () => {
        w.lastSignIn = await signIn(w.directory, NoopSeatSync, {
          providerUserId: 'wos_bootstrap_2',
          email: 'second@bootstrap.test',
          displayName: 'Second',
          ssoConnectionId: 'conn_bootstrap',
        });
      });
      Then('sign-in is refused with "sso_requires_enterprise_tier"', () => {
        expect(errCode()).toBe('sso_requires_enterprise_tier');
      });
    },
  );
});
