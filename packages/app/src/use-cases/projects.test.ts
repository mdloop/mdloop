import { describe, expect, it } from 'vitest';
import type { ProjectId, UserId } from '@mdloop/shared';
import { FakeProjectRepository, FakeWorld } from '../test-support/fakes.js';
import type { Actor } from './org-settings.js';
import { createProject, deleteProject, setProjectArchived, updateProject } from './projects.js';

function setup() {
  const world = new FakeWorld();
  const org = world.org();
  const actor: Actor = { ctx: { orgId: org.id, userId: 'u1' as UserId }, role: 'member' };
  return { world, org, actor, projects: new FakeProjectRepository(world) };
}

describe('createProject', () => {
  it('creates with the default color when none given', async () => {
    const { actor, projects } = setup();
    const result = await createProject(projects, actor, { name: '  Docs  ' });
    expect(result.ok && result.value.name).toBe('Docs');
    expect(result.ok && result.value.color).toBe('#6366f1');
  });

  it('rejects invalid names and colors', async () => {
    const { actor, projects } = setup();
    const noName = await createProject(projects, actor, { name: '  ' });
    expect(!noName.ok && noName.error.code).toBe('invalid_name');
    const badColor = await createProject(projects, actor, { name: 'Docs', color: 'red' });
    expect(!badColor.ok && badColor.error.code).toBe('invalid_color');
  });
});

describe('updateProject', () => {
  it('renames and recolors', async () => {
    const { world, org, actor, projects } = setup();
    const project = world.addProject(org.id, {
      name: 'Old',
      color: '#6366f1',
      createdBy: actor.ctx.userId,
    });
    const result = await updateProject(projects, actor, project.id, {
      name: 'New',
      color: '#7c3aed',
    });
    expect(result.ok && result.value.name).toBe('New');
    expect(result.ok && result.value.color).toBe('#7c3aed');
  });

  it('validates the patch and 404s unknown projects', async () => {
    const { world, org, actor, projects } = setup();
    const project = world.addProject(org.id, {
      name: 'P',
      color: '#6366f1',
      createdBy: actor.ctx.userId,
    });
    const bad = await updateProject(projects, actor, project.id, { color: '#GGGGGG' });
    expect(!bad.ok && bad.error.code).toBe('invalid_color');
    const missing = await updateProject(projects, actor, 'nope' as ProjectId, { name: 'X' });
    expect(!missing.ok && missing.error.code).toBe('project_not_found');
  });

  it('recolors without touching the name when only color is patched', async () => {
    const { world, org, actor, projects } = setup();
    const project = world.addProject(org.id, {
      name: 'Keep Me',
      color: '#6366f1',
      createdBy: actor.ctx.userId,
    });
    const result = await updateProject(projects, actor, project.id, { color: '#7c3aed' });
    expect(result.ok && result.value.name).toBe('Keep Me');
    expect(result.ok && result.value.color).toBe('#7c3aed');
  });
});

describe('deleteProject', () => {
  it('deletes the project and unfiles its documents', async () => {
    const { world, org, actor, projects } = setup();
    const project = world.addProject(org.id, {
      name: 'P',
      color: '#6366f1',
      createdBy: actor.ctx.userId,
    });
    const doc = world.addDocument(org.id, {
      title: 'f.md',
      projectId: project.id,
      ownerId: actor.ctx.userId,
    });
    const result = await deleteProject(projects, actor, project.id);
    expect(result.ok).toBe(true);
    expect(world.projects.get(project.id)).toBeUndefined();
    expect(world.documents.get(doc.id)?.projectId).toBeNull();
  });

  it('404s unknown projects', async () => {
    const { actor, projects } = setup();
    const missing = await deleteProject(projects, actor, 'nope' as ProjectId);
    expect(!missing.ok && missing.error.code).toBe('project_not_found');
  });
});

describe('setProjectArchived', () => {
  it('archives, unarchives and 404s unknown projects', async () => {
    const { world, org, actor, projects } = setup();
    const project = world.addProject(org.id, {
      name: 'P',
      color: '#6366f1',
      createdBy: actor.ctx.userId,
    });
    expect((await setProjectArchived(projects, actor, project.id, true)).ok).toBe(true);
    expect(world.projects.get(project.id)?.archivedAt).not.toBeNull();
    expect((await setProjectArchived(projects, actor, project.id, false)).ok).toBe(true);
    expect(world.projects.get(project.id)?.archivedAt).toBeNull();
    const missing = await setProjectArchived(projects, actor, 'nope' as ProjectId, true);
    expect(!missing.ok && missing.error.code).toBe('project_not_found');
  });
});

describe('project authorization (Phase 24)', () => {
  it('stamps the creator on create', async () => {
    const { actor, projects } = setup();
    const result = await createProject(projects, actor, { name: 'Mine' });
    expect(result.ok && result.value.createdBy).toBe(actor.ctx.userId);
  });

  it('refuses another member mutating a project they did not create', async () => {
    const { world, org, actor, projects } = setup();
    const other: Actor = { ctx: { orgId: org.id, userId: 'u2' as UserId }, role: 'member' };
    const project = world.addProject(org.id, {
      name: 'P',
      color: '#6366f1',
      createdBy: actor.ctx.userId,
    });
    const rename = await updateProject(projects, other, project.id, { name: 'X' });
    expect(!rename.ok && rename.error.code).toBe('forbidden');
    const archive = await setProjectArchived(projects, other, project.id, true);
    expect(!archive.ok && archive.error.code).toBe('forbidden');
    const remove = await deleteProject(projects, other, project.id);
    expect(!remove.ok && remove.error.code).toBe('forbidden');
  });

  it('lets an admin mutate any project', async () => {
    const { world, org, actor, projects } = setup();
    const admin: Actor = { ctx: { orgId: org.id, userId: 'a1' as UserId }, role: 'admin' };
    const project = world.addProject(org.id, {
      name: 'P',
      color: '#6366f1',
      createdBy: actor.ctx.userId,
    });
    expect((await updateProject(projects, admin, project.id, { name: 'X' })).ok).toBe(true);
    expect((await deleteProject(projects, admin, project.id)).ok).toBe(true);
  });

  it('treats a null-owner (pre-migration) project as admin-only', async () => {
    const { world, org, actor, projects } = setup();
    const admin: Actor = { ctx: { orgId: org.id, userId: 'a1' as UserId }, role: 'admin' };
    const legacy = world.addProject(org.id, { name: 'Legacy', color: '#6366f1' });
    const denied = await updateProject(projects, actor, legacy.id, { name: 'Claimed' });
    expect(!denied.ok && denied.error.code).toBe('forbidden');
    expect((await updateProject(projects, admin, legacy.id, { name: 'Migrated' })).ok).toBe(true);
  });
});
