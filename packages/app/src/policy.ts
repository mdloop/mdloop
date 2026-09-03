import type { Document, Project, ShareGrant } from '@vorlyn/domain';
import { permits } from '@vorlyn/domain';
import type { Actor } from './use-cases/org-settings.js';

/**
 * Central authorization predicates (Phase 24, ADR 0002 §9 / CONSTITUTION.md
 * §4). Before this module the "owner OR org-admin" rule was hand-inlined in
 * five use-cases; drift between copies is exactly the kind of authZ hole this
 * consolidation closes. Every mutation gate now routes through one of these
 * functions, so the rule has a single definition and a single test surface.
 */

/**
 * May the actor manage this document — resolve/edit its review, share it,
 * upload a new version, accept a suggestion, resolve a comment? True for the
 * document's owner and for any org admin. Takes only `ownerId` so callers can
 * pass a full `Document` or a lighter projection.
 */
export function canManageDocument(actor: Actor, document: Pick<Document, 'ownerId'>): boolean {
  return document.ownerId === actor.ctx.userId || actor.role === 'admin';
}

/**
 * May the actor upload a new version of this document (Phase 28, ADR 0008)?
 *
 * Deliberately NARROWER than `canManageDocument` and deliberately a separate
 * function: `edit` buys new versions and nothing else. Delete, archive, move,
 * resolve, re-share, review requests and suggestion accept/reject all stay on
 * `canManageDocument`. Keeping the two apart is what stops the grant quietly
 * growing into ownership over time.
 *
 * True for the document's owner, for any org admin, and for the holder of an
 * explicit `edit` grant — on this document, or on the project it currently
 * lives in (ADR 0014; the caller resolves which grant is highest and passes
 * it in, this function doesn't care which subject it came from).
 *
 * Never true for an external guest, checked before the grant is even read —
 * layer (c) of the three-layer guest carve-out (CONSTITUTION §9). The other
 * two are the `share_grants_guest_read_comment_only` DB check (migration
 * 0033) and the refusals in `createUserGrant`/`createGuestShare`. Each layer
 * is independently sufficient; a forged row written straight into the table
 * still stops here.
 */
export function canEditDocument(
  actor: Actor,
  document: Pick<Document, 'ownerId'>,
  grant?: Pick<ShareGrant, 'permission'>,
): boolean {
  if (actor.role === 'guest') return false;
  if (canManageDocument(actor, document)) return true;
  return grant?.permission === 'edit';
}

/**
 * May the actor create or revoke grants on this document (ADR 0014)? True
 * for the document's owner, any org admin, or the holder of a
 * `share`-or-above grant — `edit` inherits `share` by lattice, so an editor
 * may also re-share. Deliberately a separate function from
 * `canManageDocument`: `share` buys creating/revoking grants and nothing
 * else, same narrowing discipline as `canEditDocument`.
 *
 * Never true for an external guest, checked before the grant is even read —
 * the guest cap is absolute regardless of which rung above read/comment was
 * requested (CONSTITUTION §9, DB check + grant-creation refusal are the other
 * two layers).
 */
export function canShareDocument(
  actor: Actor,
  document: Pick<Document, 'ownerId'>,
  grant?: Pick<ShareGrant, 'permission'>,
): boolean {
  if (actor.role === 'guest') return false;
  if (canManageDocument(actor, document)) return true;
  return grant !== undefined && permits(grant.permission, 'share');
}

/**
 * May the actor rename, archive or delete this project (Phase 24)? True for an
 * org admin, or for the member who created it. A project with a `null`
 * `createdBy` (rows predating migration 0021) is deliberately admin-only — with
 * no recorded owner there is no member to trust, so the safe default is to
 * require admin.
 */
export function canManageProject(actor: Actor, project: Pick<Project, 'createdBy'>): boolean {
  if (actor.role === 'admin') return true;
  return project.createdBy !== null && project.createdBy === actor.ctx.userId;
}
