import { describe, expect, it } from 'vitest';
import { TIER_PROFILES } from '@vorlyn/domain';
import type { Tier } from '@vorlyn/domain';
import type { DocumentId, OrgId, ProjectId, UserId } from '@vorlyn/shared';
import {
  FakeDocumentRepository,
  FakeOrganizationRepository,
  FakeShareGrantRepository,
  FakeVersionRepository,
  FakeWorld,
} from '../test-support/fakes.js';
import type { Actor } from './org-settings.js';
import { orgUsage } from './org-usage.js';

function setup(tier: Tier = 'team') {
  const world = new FakeWorld();
  const org = world.org({ tier });
  // A real `users` row for the admin, not just an Actor context — mirrors
  // production (the caller of orgUsage is always a real org member), so
  // memberCount baselines at 1 rather than 0.
  const adminUser = world.addUser(org.id, {
    workosUserId: 'wos-admin',
    email: 'admin@acme.test',
    displayName: 'Admin',
    role: 'admin',
  });
  const admin: Actor = { ctx: { orgId: org.id, userId: adminUser.id }, role: 'admin' };
  return {
    world,
    org,
    admin,
    orgs: new FakeOrganizationRepository(world),
    documents: new FakeDocumentRepository(world),
    versions: new FakeVersionRepository(world),
    grants: new FakeShareGrantRepository(world),
  };
}

describe('orgUsage', () => {
  it.each<Tier>(['free', 'team', 'enterprise'])(
    'reports tier, ceilings, doc/seat/storage/guest usage for %s',
    async (tier) => {
      const s = setup(tier);
      s.world.addDocument(s.org.id, {
        title: 'a.md',
        projectId: null,
        ownerId: s.admin.ctx.userId,
      });
      s.world.addDocument(s.org.id, {
        title: 'b.md',
        projectId: null,
        ownerId: s.admin.ctx.userId,
      });

      const result = await orgUsage(s.orgs, s.documents, s.versions, s.grants, s.admin);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const ceilings = TIER_PROFILES[tier].ceilings;
      expect(result.value).toEqual({
        tier,
        activeDocCount: 2,
        maxActiveDocs: ceilings.maxActiveDocs,
        memberCount: 1, // just the admin seeded by setup()
        maxCollaborators: ceilings.maxCollaborators,
        storageBytes: 0,
        activeGuestCount: 0,
        maxExternalGuests: ceilings.maxExternalGuests,
      });
      expect(result.value.projectUsage).toBeUndefined();
    },
  );

  it('does not count soft-deleted documents', async () => {
    const s = setup('team');
    const doc = s.world.addDocument(s.org.id, {
      title: 'a.md',
      projectId: null,
      ownerId: s.admin.ctx.userId,
    });
    await s.documents.softDelete(s.admin.ctx, doc.id, new Date());

    const result = await orgUsage(s.orgs, s.documents, s.versions, s.grants, s.admin);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.activeDocCount).toBe(0);
  });

  it('sums live version bytes as storage usage, excluding tombstoned versions', async () => {
    const s = setup('team');
    const doc = s.world.addDocument(s.org.id, {
      title: 'a.md',
      projectId: null,
      ownerId: s.admin.ctx.userId,
    });
    const v1 = s.world.addVersion(s.org.id, {
      documentId: doc.id,
      contentHash: 'h1',
      byteSize: 100,
      createdBy: s.admin.ctx.userId,
      source: 'web',
    });
    s.world.addVersion(s.org.id, {
      documentId: doc.id,
      contentHash: 'h2',
      byteSize: 250,
      createdBy: s.admin.ctx.userId,
      source: 'web',
    });
    await s.versions.tombstone(s.admin.ctx, v1.id);

    const result = await orgUsage(s.orgs, s.documents, s.versions, s.grants, s.admin);
    expect(result.ok).toBe(true);
    // Only the live (non-tombstoned) 250-byte version counts.
    if (result.ok) expect(result.value.storageBytes).toBe(250);
  });

  it('counts members against an unlimited (null) seat ceiling on team', async () => {
    const s = setup('team');
    s.world.addUser(s.org.id, {
      workosUserId: 'wos-bob',
      email: 'bob@acme.test',
      displayName: 'Bob',
      role: 'member',
    });
    s.world.addUser(s.org.id, {
      workosUserId: 'wos-carol',
      email: 'carol@acme.test',
      displayName: 'Carol',
      role: 'member',
    });

    const result = await orgUsage(s.orgs, s.documents, s.versions, s.grants, s.admin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.memberCount).toBe(3); // admin + bob + carol
    expect(result.value.maxCollaborators).toBeNull(); // unlimited on team
  });

  it('reports finite free-tier ceilings', async () => {
    const s = setup('free');
    const result = await orgUsage(s.orgs, s.documents, s.versions, s.grants, s.admin);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxCollaborators).toBe(1);
      expect(result.value.maxExternalGuests).toBe(0);
    }
  });

  it('counts active external guests against the tier guest ceiling', async () => {
    const s = setup('team');
    const doc = s.world.addDocument(s.org.id, {
      title: 'shared.md',
      projectId: null,
      ownerId: s.admin.ctx.userId,
    });
    await s.grants.create(s.admin.ctx, {
      subject: { type: 'document', id: doc.id },
      grantee: { type: 'user', userId: 'guest-user' as UserId },
      permission: 'comment',
      tokenHash: 'hash-1',
      expiresAt: new Date(Date.now() + 86_400_000),
      granteeEmail: 'external@guest.test',
      createdBy: s.admin.ctx.userId,
    });

    const result = await orgUsage(s.orgs, s.documents, s.versions, s.grants, s.admin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.activeGuestCount).toBe(1);
    expect(result.value.maxExternalGuests).toBe(TIER_PROFILES.team.ceilings.maxExternalGuests);
  });

  it('does not count an expired guest grant', async () => {
    const s = setup('team');
    const doc = s.world.addDocument(s.org.id, {
      title: 'shared.md',
      projectId: null,
      ownerId: s.admin.ctx.userId,
    });
    await s.grants.create(s.admin.ctx, {
      subject: { type: 'document', id: doc.id },
      grantee: { type: 'user', userId: 'guest-user' as UserId },
      permission: 'comment',
      tokenHash: 'hash-1',
      expiresAt: new Date(Date.now() - 1000), // already expired
      granteeEmail: 'expired@guest.test',
      createdBy: s.admin.ctx.userId,
    });

    const result = await orgUsage(s.orgs, s.documents, s.versions, s.grants, s.admin);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.activeGuestCount).toBe(0);
  });

  it('includes projectUsage only when a projectId is passed', async () => {
    const s = setup('team');
    const project = s.world.addProject(s.org.id, { name: 'Docs', color: '#000' });
    s.world.addDocument(s.org.id, {
      title: 'in-project.md',
      projectId: project.id,
      ownerId: s.admin.ctx.userId,
    });
    s.world.addDocument(s.org.id, {
      title: 'unfiled.md',
      projectId: null,
      ownerId: s.admin.ctx.userId,
    });

    const withoutProject = await orgUsage(s.orgs, s.documents, s.versions, s.grants, s.admin);
    expect(withoutProject.ok).toBe(true);
    if (withoutProject.ok) {
      expect(withoutProject.value.activeDocCount).toBe(2);
      expect(withoutProject.value.projectUsage).toBeUndefined();
    }

    const withProject = await orgUsage(
      s.orgs,
      s.documents,
      s.versions,
      s.grants,
      s.admin,
      project.id,
    );
    expect(withProject.ok).toBe(true);
    if (withProject.ok) {
      expect(withProject.value.activeDocCount).toBe(2);
      expect(withProject.value.projectUsage).toEqual({
        activeDocCount: 1,
        maxActiveDocsPerProject: TIER_PROFILES.team.ceilings.maxActiveDocsPerProject,
      });
    }
  });

  it('returns org_not_found for a bogus org', async () => {
    const s = setup('team');
    const ghost: Actor = {
      ctx: { orgId: 'does-not-exist' as OrgId, userId: 'x' as UserId },
      role: 'admin',
    };
    const result = await orgUsage(s.orgs, s.documents, s.versions, s.grants, ghost);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('org_not_found');
  });

  it('returns org_not_found even with a projectId when the org is bogus', async () => {
    const s = setup('team');
    const ghost: Actor = {
      ctx: { orgId: 'does-not-exist' as OrgId, userId: 'x' as UserId },
      role: 'admin',
    };
    const result = await orgUsage(
      s.orgs,
      s.documents,
      s.versions,
      s.grants,
      ghost,
      'proj' as ProjectId,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('org_not_found');
  });

  it('does not leak one org usage read into another org (docs, storage, seats, guests)', async () => {
    const world = new FakeWorld();
    const orgA = world.org({ tier: 'team' });
    const orgB = world.org({ tier: 'team' });
    const adminAUser = world.addUser(orgA.id, {
      workosUserId: 'wos-admin-a',
      email: 'admin-a@acme.test',
      displayName: 'Admin A',
      role: 'admin',
    });
    const adminBUser = world.addUser(orgB.id, {
      workosUserId: 'wos-admin-b',
      email: 'admin-b@globex.test',
      displayName: 'Admin B',
      role: 'admin',
    });
    const adminA: Actor = { ctx: { orgId: orgA.id, userId: adminAUser.id }, role: 'admin' };
    const adminB: Actor = { ctx: { orgId: orgB.id, userId: adminBUser.id }, role: 'admin' };
    const orgs = new FakeOrganizationRepository(world);
    const documents = new FakeDocumentRepository(world);
    const versions = new FakeVersionRepository(world);
    const grants = new FakeShareGrantRepository(world);

    // Org A gets 3 documents with storage, org B gets 1.
    const docsA: DocumentId[] = [];
    for (let i = 0; i < 3; i++) {
      const doc = world.addDocument(orgA.id, {
        title: `a-${String(i)}.md`,
        projectId: null,
        ownerId: adminA.ctx.userId,
      });
      docsA.push(doc.id);
      world.addVersion(orgA.id, {
        documentId: doc.id,
        contentHash: `hash-a-${String(i)}`,
        byteSize: 100,
        createdBy: adminA.ctx.userId,
        source: 'web',
      });
    }
    const docB = world.addDocument(orgB.id, {
      title: 'b.md',
      projectId: null,
      ownerId: adminB.ctx.userId,
    });
    world.addVersion(orgB.id, {
      documentId: docB.id,
      contentHash: 'hash-b',
      byteSize: 9999,
      createdBy: adminB.ctx.userId,
      source: 'web',
    });
    world.addUser(orgA.id, {
      workosUserId: 'wos-extra',
      email: 'extra@acme.test',
      displayName: 'Extra',
      role: 'member',
    });
    await grants.create(adminA.ctx, {
      subject: { type: 'document', id: docsA[0]! },
      grantee: { type: 'user', userId: 'guest-a' as UserId },
      permission: 'comment',
      tokenHash: 'hash-guest-a',
      expiresAt: new Date(Date.now() + 86_400_000),
      granteeEmail: 'guest-a@ext.test',
      createdBy: adminA.ctx.userId,
    });

    const resultA = await orgUsage(orgs, documents, versions, grants, adminA);
    const resultB = await orgUsage(orgs, documents, versions, grants, adminB);
    expect(resultA.ok && resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;

    expect(resultA.value.activeDocCount).toBe(3);
    expect(resultA.value.storageBytes).toBe(300);
    expect(resultA.value.memberCount).toBe(2); // admin-a + Extra
    expect(resultA.value.activeGuestCount).toBe(1);

    expect(resultB.value.activeDocCount).toBe(1);
    expect(resultB.value.storageBytes).toBe(9999);
    expect(resultB.value.memberCount).toBe(1); // admin-b only
    expect(resultB.value.activeGuestCount).toBe(0); // org A's guest grant never leaks in
  });
});
