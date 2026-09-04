import { loadFeature, describeFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Actor } from '@mdloop/app';
import { setUserRole, updateOrgSettings } from '@mdloop/app';
import { isPurgeDue, purgeAfter } from '@mdloop/domain';
import type { Organization, User } from '@mdloop/domain';
import type { Result } from '@mdloop/shared';
import { PgDirectoryRepository, PgOrganizationRepository } from '@mdloop/persistence';
import { createTestDb } from '@mdloop/persistence/test-support';
import type { TestDb } from '@mdloop/persistence/test-support';

const feature = await loadFeature(
  fileURLToPath(new URL('../../../features/admin-settings.feature', import.meta.url)),
);

interface World {
  db: TestDb;
  orgs: PgOrganizationRepository;
  directory: PgDirectoryRepository;
  org: Organization;
  alice: Actor;
  mia: Actor;
  miaUser: User;
  settingsResult: Result<Organization, { code: string }>;
  roleResult: Result<void, { code: string }>;
}

describeFeature(feature, ({ Background, Scenario, AfterAllScenarios }) => {
  const w = {} as World;

  AfterAllScenarios(async () => {
    await w.db.close();
  });

  Background(({ Given }) => {
    Given('an organization "Acme" with admin "alice" and member "mia"', async () => {
      w.db = await createTestDb();
      w.directory = new PgDirectoryRepository(w.db.pool);
      w.orgs = new PgOrganizationRepository(w.db.pool);
      w.org = await w.directory.createOrganization('Acme');
      const alice = await w.directory.createUser(w.org.id, {
        workosUserId: `wos_alice_${String(Math.random())}`,
        email: 'alice@acme.test',
        displayName: 'Alice',
        role: 'admin',
      });
      w.miaUser = await w.directory.createUser(w.org.id, {
        workosUserId: `wos_mia_${String(Math.random())}`,
        email: 'mia@acme.test',
        displayName: 'Mia',
        role: 'member',
      });
      w.alice = { ctx: { orgId: w.org.id, userId: alice.id }, role: 'admin' };
      w.mia = { ctx: { orgId: w.org.id, userId: w.miaUser.id }, role: 'member' };
    });
  });

  Scenario('A member cannot change retention settings', ({ When, Then, And }) => {
    When('"mia" attempts to set retention to 7 days', async () => {
      w.settingsResult = await updateOrgSettings(w.orgs, w.mia, { retentionDays: 7 });
    });
    Then('the request is forbidden', () => {
      expect(!w.settingsResult.ok && w.settingsResult.error.code).toBe('forbidden');
    });
    And('the organization retention remains 30 days', async () => {
      const org = await w.orgs.current(w.alice.ctx);
      expect(org?.retentionDays).toBe(30);
    });
  });

  Scenario('An admin can change retention settings', ({ When, Then }) => {
    When('"alice" sets retention to 7 days', async () => {
      w.settingsResult = await updateOrgSettings(w.orgs, w.alice, { retentionDays: 7 });
    });
    Then('the organization retention is 7 days', async () => {
      expect(w.settingsResult.ok).toBe(true);
      const org = await w.orgs.current(w.alice.ctx);
      expect(org?.retentionDays).toBe(7);
    });
  });

  Scenario('An admin can enable immediate purge', ({ When, Then }) => {
    When('"alice" enables immediate purge', async () => {
      w.settingsResult = await updateOrgSettings(w.orgs, w.alice, { purgeImmediately: true });
    });
    Then('deleted documents become purgeable immediately', async () => {
      const org = await w.orgs.current(w.alice.ctx);
      const deletedAt = new Date();
      const at = purgeAfter(deletedAt, {
        retentionDays: org!.retentionDays,
        purgeImmediately: org!.purgeImmediately,
      });
      expect(isPurgeDue(at, deletedAt)).toBe(true);
    });
  });

  Scenario("A member cannot change another member's role", ({ When, Then }) => {
    When('"mia" attempts to promote herself to admin', async () => {
      w.roleResult = await setUserRole(w.orgs, w.mia, w.mia.ctx.userId, 'admin');
    });
    Then('the request is forbidden', () => {
      expect(!w.roleResult.ok && w.roleResult.error.code).toBe('forbidden');
    });
  });

  Scenario('An admin can promote a member', ({ When, Then }) => {
    When('"alice" promotes "mia" to admin', async () => {
      w.roleResult = await setUserRole(w.orgs, w.alice, w.miaUser.id, 'admin');
    });
    Then('"mia" has the admin role', async () => {
      expect(w.roleResult.ok).toBe(true);
      const promoted = await w.directory.userByWorkosId(w.miaUser.workosUserId);
      expect(promoted?.role).toBe('admin');
    });
  });

  Scenario('An admin cannot demote themselves', ({ When, Then }) => {
    When('"alice" attempts to demote herself to member', async () => {
      w.roleResult = await setUserRole(w.orgs, w.alice, w.alice.ctx.userId, 'member');
    });
    Then('the request is rejected as self-demotion', () => {
      expect(!w.roleResult.ok && w.roleResult.error.code).toBe('cannot_demote_self');
    });
  });
});
