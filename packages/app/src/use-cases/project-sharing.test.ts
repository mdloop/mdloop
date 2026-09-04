import { describe, expect, it } from 'vitest';
import type { UserId } from '@mdloop/shared';
import {
  FakeOrganizationRepository,
  FakeProjectRepository,
  FakeShareGrantRepository,
  FakeWorld,
} from '../test-support/fakes.js';
import type { Actor } from './org-settings.js';
import { createProjectGrant, listProjectGrants, revokeProjectGrant } from './project-sharing.js';

function setup() {
  const world = new FakeWorld();
  const org = world.org({ sharingMode: 'directory' });
  const admin: Actor = { ctx: { orgId: org.id, userId: 'admin' as UserId }, role: 'admin' };
  const member: Actor = { ctx: { orgId: org.id, userId: 'member' as UserId }, role: 'member' };
  const creator: Actor = { ctx: { orgId: org.id, userId: 'creator' as UserId }, role: 'member' };
  const project = world.addProject(org.id, {
    name: 'Runbooks',
    color: '#123456',
    createdBy: creator.ctx.userId,
  });
  return {
    world,
    org,
    admin,
    member,
    creator,
    project,
    projects: new FakeProjectRepository(world),
    grants: new FakeShareGrantRepository(world),
    orgs: new FakeOrganizationRepository(world),
  };
}

describe('createProjectGrant (ADR 0014, admin-only)', () => {
  it('an org admin can create a project grant', async () => {
    const s = setup();
    const result = await createProjectGrant(
      s.projects,
      s.grants,
      s.orgs,
      s.admin,
      s.project.id,
      s.member.ctx.userId,
      'comment',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.subject).toEqual({ type: 'project', id: s.project.id });
    expect(result.value.permission).toBe('comment');
  });

  it("is refused for a non-admin, even the project's own creator — deliberate escalation-prevention (see project-sharing.ts doc comment)", async () => {
    const s = setup();
    const byCreator = await createProjectGrant(
      s.projects,
      s.grants,
      s.orgs,
      s.creator,
      s.project.id,
      s.member.ctx.userId,
      'read',
    );
    expect(!byCreator.ok && byCreator.error.code).toBe('forbidden');

    const byMember = await createProjectGrant(
      s.projects,
      s.grants,
      s.orgs,
      s.member,
      s.project.id,
      s.creator.ctx.userId,
      'read',
    );
    expect(!byMember.ok && byMember.error.code).toBe('forbidden');
  });

  it('404s on an unknown project', async () => {
    const s = setup();
    const result = await createProjectGrant(
      s.projects,
      s.grants,
      s.orgs,
      s.admin,
      'nope' as never,
      s.member.ctx.userId,
      'read',
    );
    expect(!result.ok && result.error.code).toBe('project_not_found');
  });

  it('404s on an archived project — archived reads as not-found here too', async () => {
    const s = setup();
    await s.projects.setArchived(s.admin.ctx, s.project.id, true);
    const result = await createProjectGrant(
      s.projects,
      s.grants,
      s.orgs,
      s.admin,
      s.project.id,
      s.member.ctx.userId,
      'read',
    );
    expect(!result.ok && result.error.code).toBe('project_not_found');
  });

  it('refuses share/edit for a guest grantee, same guest cap as document grants', async () => {
    const s = setup();
    const guestUser = s.world.addUser(s.org.id, {
      workosUserId: 'guest:project',
      email: 'ext@partner.test',
      displayName: 'ext@partner.test',
      role: 'guest',
    });
    const edit = await createProjectGrant(
      s.projects,
      s.grants,
      s.orgs,
      s.admin,
      s.project.id,
      guestUser.id,
      'edit',
    );
    expect(!edit.ok && edit.error.code).toBe('guest_edit_forbidden');
    const share = await createProjectGrant(
      s.projects,
      s.grants,
      s.orgs,
      s.admin,
      s.project.id,
      guestUser.id,
      'share',
    );
    expect(!share.ok && share.error.code).toBe('guest_edit_forbidden');
    // read/comment still fine for a guest.
    const read = await createProjectGrant(
      s.projects,
      s.grants,
      s.orgs,
      s.admin,
      s.project.id,
      guestUser.id,
      'read',
    );
    expect(read.ok).toBe(true);
  });

  it('a project grant never carries a link — always a named user grantee', async () => {
    const s = setup();
    const result = await createProjectGrant(
      s.projects,
      s.grants,
      s.orgs,
      s.admin,
      s.project.id,
      s.member.ctx.userId,
      'edit',
    );
    expect(result.ok && result.value.grantee.type).toBe('user');
    expect(result.ok && result.value.tokenHash).toBeNull();
  });
});

describe('listProjectGrants (admin-only)', () => {
  it('lists grants on the project, refuses non-admins', async () => {
    const s = setup();
    const created = await createProjectGrant(
      s.projects,
      s.grants,
      s.orgs,
      s.admin,
      s.project.id,
      s.member.ctx.userId,
      'read',
    );
    if (!created.ok) throw new Error('setup');

    const listed = await listProjectGrants(s.projects, s.grants, s.admin, s.project.id);
    expect(listed.ok && listed.value.map((g) => g.id)).toEqual([created.value.id]);

    const denied = await listProjectGrants(s.projects, s.grants, s.member, s.project.id);
    expect(!denied.ok && denied.error.code).toBe('forbidden');
  });

  it('never returns a document-subject grant, even one on a document filed in the project', async () => {
    const s = setup();
    const doc = s.world.addDocument(s.org.id, {
      title: 'a.md',
      projectId: s.project.id,
      ownerId: s.member.ctx.userId,
    });
    await s.grants.create(s.admin.ctx, {
      subject: { type: 'document', id: doc.id },
      grantee: { type: 'user', userId: s.member.ctx.userId },
      permission: 'read',
      tokenHash: null,
      createdBy: s.admin.ctx.userId,
    });
    const listed = await listProjectGrants(s.projects, s.grants, s.admin, s.project.id);
    expect(listed.ok && listed.value).toHaveLength(0);
  });
});

describe('revokeProjectGrant (admin-only)', () => {
  it('an admin can revoke a project grant', async () => {
    const s = setup();
    const created = await createProjectGrant(
      s.projects,
      s.grants,
      s.orgs,
      s.admin,
      s.project.id,
      s.member.ctx.userId,
      'read',
    );
    if (!created.ok) throw new Error('setup');
    const revoked = await revokeProjectGrant(
      s.projects,
      s.grants,
      s.admin,
      s.project.id,
      created.value.id,
    );
    expect(revoked.ok).toBe(true);
    const listed = await listProjectGrants(s.projects, s.grants, s.admin, s.project.id);
    expect(listed.ok && listed.value).toHaveLength(0);
  });

  it('a non-admin (including the creator) cannot revoke, even a grant they can otherwise see', async () => {
    const s = setup();
    const created = await createProjectGrant(
      s.projects,
      s.grants,
      s.orgs,
      s.admin,
      s.project.id,
      s.member.ctx.userId,
      'read',
    );
    if (!created.ok) throw new Error('setup');
    const denied = await revokeProjectGrant(
      s.projects,
      s.grants,
      s.creator,
      s.project.id,
      created.value.id,
    );
    expect(!denied.ok && denied.error.code).toBe('forbidden');
  });

  it('404s (grant_not_found) for an unknown grant id', async () => {
    const s = setup();
    const result = await revokeProjectGrant(
      s.projects,
      s.grants,
      s.admin,
      s.project.id,
      'nope' as never,
    );
    expect(!result.ok && result.error.code).toBe('grant_not_found');
  });
});
