import type { Project } from '@mdloop/domain';
import { isValidProjectColor, isValidProjectName } from '@mdloop/domain';
import type { ProjectId, Result } from '@mdloop/shared';
import { err, ok } from '@mdloop/shared';
import type { ProjectPatch, ProjectRepository } from '../ports/repositories.port.js';
import { canManageProject } from '../policy.js';
import type { Actor } from './org-settings.js';

export type ProjectError =
  | { readonly code: 'invalid_name' }
  | { readonly code: 'invalid_color' }
  | { readonly code: 'forbidden' }
  | { readonly code: 'project_not_found' };

const DEFAULT_PROJECT_COLOR = '#6366f1';

function validatePatch(patch: ProjectPatch): Result<void, ProjectError> {
  if (patch.name !== undefined && !isValidProjectName(patch.name)) {
    return err({ code: 'invalid_name' });
  }
  if (patch.color !== undefined && !isValidProjectColor(patch.color)) {
    return err({ code: 'invalid_color' });
  }
  return ok(undefined);
}

/**
 * Any member may create a project (guests are blocked at the route allowlist).
 * The creator is stamped as `created_by` (Phase 24, migration 0021) — that
 * record is what the owner-or-admin mutation gate below keys off.
 */
export async function createProject(
  projects: ProjectRepository,
  actor: Actor,
  input: { name: string; color?: string },
): Promise<Result<Project, ProjectError>> {
  const color = input.color ?? DEFAULT_PROJECT_COLOR;
  const valid = validatePatch({ name: input.name, color });
  if (!valid.ok) return valid;
  return ok(
    await projects.create(actor.ctx, {
      name: input.name.trim(),
      color,
      createdBy: actor.ctx.userId,
    }),
  );
}

/**
 * Loads the project and asserts the actor may manage it (Phase 24): its
 * creator or an org admin. A null-owner project (pre-migration row) is
 * admin-only. A missing project reads as `project_not_found`.
 */
async function requireManageable(
  projects: ProjectRepository,
  actor: Actor,
  id: ProjectId,
): Promise<Result<Project, ProjectError>> {
  const project = await projects.byId(actor.ctx, id);
  if (!project) return err({ code: 'project_not_found' });
  if (!canManageProject(actor, project)) return err({ code: 'forbidden' });
  return ok(project);
}

export async function updateProject(
  projects: ProjectRepository,
  actor: Actor,
  id: ProjectId,
  patch: ProjectPatch,
): Promise<Result<Project, ProjectError>> {
  const valid = validatePatch(patch);
  if (!valid.ok) return valid;
  const manageable = await requireManageable(projects, actor, id);
  if (!manageable.ok) return manageable;
  const updated = await projects.update(actor.ctx, id, {
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
  });
  return updated ? ok(updated) : err({ code: 'project_not_found' });
}

export async function setProjectArchived(
  projects: ProjectRepository,
  actor: Actor,
  id: ProjectId,
  archived: boolean,
): Promise<Result<void, ProjectError>> {
  const manageable = await requireManageable(projects, actor, id);
  if (!manageable.ok) return manageable;
  const changed = await projects.setArchived(actor.ctx, id, archived);
  return changed ? ok(undefined) : err({ code: 'project_not_found' });
}

export async function deleteProject(
  projects: ProjectRepository,
  actor: Actor,
  id: ProjectId,
): Promise<Result<void, ProjectError>> {
  const manageable = await requireManageable(projects, actor, id);
  if (!manageable.ok) return manageable;
  const removed = await projects.remove(actor.ctx, id);
  return removed ? ok(undefined) : err({ code: 'project_not_found' });
}
