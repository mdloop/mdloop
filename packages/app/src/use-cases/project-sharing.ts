import type { GrantablePermission, ShareGrant } from '@vorlyn/domain';
import { isGuestGrantable } from '@vorlyn/domain';
import type { GrantId, ProjectId, Result, UserId } from '@vorlyn/shared';
import { err, ok } from '@vorlyn/shared';
import type { ProjectRepository, ShareGrantRepository } from '../ports/repositories.port.js';
import type { Actor, OrganizationRepository } from './org-settings.js';

/**
 * Project-level share grants (ADR 0014, Phase 42). The `{type:'project'}`
 * `GrantSubject` arm and the `subject_type in ('document','project')` DB
 * check have existed since the original schema, but nothing ever wrote or
 * read one — every access predicate filtered `subject_type = 'document'`
 * only. This module is what makes the arm real: a grant on a project confers
 * its permission on every document currently in that project
 * (`documentPermissionFor` in `sharing.ts` resolves it alongside any grant on
 * the document itself, higher wins).
 *
 * Deliberately ORG-ADMIN ONLY, unlike document sharing (owner, admin, or a
 * `share`-or-above grantee). Any org member may create a project
 * (`createProject`, no authZ check) and documents owned by other people can
 * land in it later — if project sharing used `canManageProject` (creator or
 * admin), a member could create a project, wait for someone else's document
 * to be moved into it, and share the project, granting a third party access
 * to a document they could never have shared directly. Admin-only forecloses
 * that escalation. Named-user grants only: never a link (a project's
 * membership changes over time in a way a single forwardable token can't
 * track sanely), never a guest (guests are per-document, per CONSTITUTION
 * §9 — a project is an org-internal container).
 */
export type ProjectSharingError =
  | { readonly code: 'project_not_found' }
  | { readonly code: 'forbidden' }
  | { readonly code: 'grant_not_found' }
  /** A `share` or `edit` grant was asked for on a guest grantee — refused exactly as `createUserGrant`. */
  | { readonly code: 'guest_edit_forbidden' };

async function requireAdminProject(
  projects: ProjectRepository,
  actor: Actor,
  id: ProjectId,
): Promise<Result<void, ProjectSharingError>> {
  if (actor.role !== 'admin') return err({ code: 'forbidden' });
  const project = await projects.byId(actor.ctx, id);
  if (!project || project.archivedAt) return err({ code: 'project_not_found' });
  return ok(undefined);
}

/** Grants `permission` on a whole project to a named org member. Org admin only. */
export async function createProjectGrant(
  projects: ProjectRepository,
  grants: ShareGrantRepository,
  orgs: OrganizationRepository,
  actor: Actor,
  projectId: ProjectId,
  userId: UserId,
  permission: GrantablePermission,
): Promise<Result<ShareGrant, ProjectSharingError>> {
  const gate = await requireAdminProject(projects, actor, projectId);
  if (!gate.ok) return gate;
  if (!isGuestGrantable(permission)) {
    const grantee = await orgs.userById(actor.ctx, userId);
    if (grantee?.role === 'guest') return err({ code: 'guest_edit_forbidden' });
  }
  const grant = await grants.create(actor.ctx, {
    subject: { type: 'project', id: projectId },
    grantee: { type: 'user', userId },
    permission,
    tokenHash: null,
    createdBy: actor.ctx.userId,
  });
  return ok(grant);
}

/** Lists a project's own grants. Org admin only — mirrors `createProjectGrant`. */
export async function listProjectGrants(
  projects: ProjectRepository,
  grants: ShareGrantRepository,
  actor: Actor,
  projectId: ProjectId,
): Promise<Result<ShareGrant[], ProjectSharingError>> {
  const gate = await requireAdminProject(projects, actor, projectId);
  if (!gate.ok) return gate;
  return ok(await grants.listForProject(actor.ctx, projectId));
}

/** Revokes a project grant. Org admin only. */
export async function revokeProjectGrant(
  projects: ProjectRepository,
  grants: ShareGrantRepository,
  actor: Actor,
  projectId: ProjectId,
  grantId: GrantId,
): Promise<Result<void, ProjectSharingError>> {
  const gate = await requireAdminProject(projects, actor, projectId);
  if (!gate.ok) return gate;
  const listed = await grants.listForProject(actor.ctx, projectId);
  if (!listed.some((g) => g.id === grantId)) return err({ code: 'grant_not_found' });
  const revoked = await grants.revoke(actor.ctx, grantId);
  return revoked ? ok(undefined) : err({ code: 'grant_not_found' });
}
