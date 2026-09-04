import { createHash, randomBytes } from 'node:crypto';
import type {
  Document,
  GrantablePermission,
  LinkGrantablePermission,
  Permission,
  ShareGrant,
} from '@mdloop/domain';
import { canDelegate, highest, isGuestGrantable, isLinkGrantable, permits } from '@mdloop/domain';
import type { DocumentId, GrantId, Result, UserId } from '@mdloop/shared';
import { err, ok } from '@mdloop/shared';
import type {
  DocumentListFilter,
  DocumentRepository,
  ShareGrantRepository,
} from '../ports/repositories.port.js';
import { canManageDocument, canShareDocument } from '../policy.js';
import type { Actor, OrganizationRepository } from './org-settings.js';

export type SharingError =
  | { readonly code: 'document_not_found' }
  | { readonly code: 'grant_not_found' }
  | { readonly code: 'forbidden' }
  | { readonly code: 'wrong_sharing_mode' }
  | { readonly code: 'invalid_token' }
  /**
   * A `share` or `edit` grant was asked for on an external guest (ADR 0008
   * decision 3 layer b, generalized by ADR 0014 — guests stay capped at
   * read/comment regardless of which rung above that was requested).
   */
  | { readonly code: 'guest_edit_forbidden' }
  /**
   * A non-owner/admin grantor asked for a grant more powerful than their own
   * (ADR 0014): delegation is capped at the granter's held level.
   */
  | { readonly code: 'grant_exceeds_own_permission' }
  /**
   * Personal tier is solo by design (`TIER_PROFILES.free`, tier.ts, Phase 33) — it cannot
   * share a document with anyone in any form. Link sharing is the one path
   * that has no other per-tier cap to fall back on (unlike named guests/
   * collaborators, which are already blocked by their own free-tier ceiling
   * of 0/1), so it needs this explicit refusal.
   */
  | { readonly code: 'sharing_requires_paid_tier' };

/** SHA-256 hex of a share token — only the hash is ever stored. */
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The caller's highest-ranked active grant that applies to this document —
 * a grant on the document itself, or on the project it currently lives in
 * (ADR 0014). `undefined` when the document is unowned by the actor and no
 * such grant exists. Deliberately does NOT fold in owner/admin (unlike
 * `documentPermissionFor`): callers that already special-case owner/admin
 * (`requireShareable`, delegation checks) need the RAW grant level so an
 * owner/admin is treated as uncapped rather than "holds edit".
 */
async function callerGrantPermission(
  grants: ShareGrantRepository,
  actor: Actor,
  document: Pick<Document, 'id' | 'projectId'>,
): Promise<Permission | undefined> {
  const mine = await grants.listForUser(actor.ctx, actor.ctx.userId);
  const relevant = mine.filter(
    (g) =>
      (g.subject.type === 'document' && g.subject.id === document.id) ||
      (g.subject.type === 'project' &&
        document.projectId !== null &&
        g.subject.id === document.projectId),
  );
  if (relevant.length === 0) return undefined;
  // A guest's grant is structurally never share/edit (CONSTITUTION §9), but
  // this filters defensively rather than trusting that a forged row can't
  // reach here — the read-side twin of `canShareDocument`'s guest branch.
  const held = relevant
    .map((g) => g.permission)
    .filter((p) => actor.role !== 'guest' || isGuestGrantable(p));
  return highest(held);
}

/**
 * Loads the document and asserts the actor may create/list/revoke grants on
 * it (ADR 0014): the owner, an org admin, or the holder of a `share`-or-above
 * grant (an `edit` grant inherits `share` by lattice). Also returns the
 * caller's own grant permission (undefined for owner/admin, who are
 * uncapped) — callers use it to cap delegation and to decide which grants
 * a non-manager may revoke.
 */
async function requireShareable(
  documents: DocumentRepository,
  grants: ShareGrantRepository,
  actor: Actor,
  id: DocumentId,
): Promise<Result<{ document: Document; ownPermission: Permission | undefined }, SharingError>> {
  const document = await documents.byId(actor.ctx, id);
  if (!document || document.deletedAt) return err({ code: 'document_not_found' });
  if (canManageDocument(actor, document)) return ok({ document, ownPermission: undefined });
  const ownPermission = await callerGrantPermission(grants, actor, document);
  const grant = ownPermission !== undefined ? { permission: ownPermission } : undefined;
  if (!canShareDocument(actor, document, grant)) return err({ code: 'forbidden' });
  return ok({ document, ownPermission });
}

/**
 * Creates a share link. The token is returned exactly once; only its hash is
 * stored (CONSTITUTION.md §9). Requires the org to be in link sharing mode.
 *
 * Capped at read/comment: a link is forwardable and a named grant is not, so
 * `share`/`edit` are offered on user grants only (ADR 0008 decision 4, ADR
 * 0014). The cap is at the type level here and re-checked on redemption. No
 * delegation-cap check is needed beyond that: a link's ceiling (read/comment)
 * is always within what any `share`-or-above holder may grant.
 */
export async function createShareLink(
  documents: DocumentRepository,
  grants: ShareGrantRepository,
  orgs: OrganizationRepository,
  actor: Actor,
  documentId: DocumentId,
  permission: LinkGrantablePermission,
): Promise<Result<{ grant: ShareGrant; token: string }, SharingError>> {
  const shareable = await requireShareable(documents, grants, actor, documentId);
  if (!shareable.ok) return shareable;
  const org = await orgs.current(actor.ctx);
  // Checked before the sharing-mode check: a free-tier org gets the specific,
  // actionable "upgrade to share" refusal rather than a generic
  // "wrong sharing mode" (which would be true, but not why).
  if (org?.tier === 'free') return err({ code: 'sharing_requires_paid_tier' });
  if (org?.sharingMode !== 'link') return err({ code: 'wrong_sharing_mode' });
  const token = randomBytes(24).toString('base64url');
  const grant = await grants.create(actor.ctx, {
    subject: { type: 'document', id: documentId },
    grantee: { type: 'link' },
    permission,
    tokenHash: hashShareToken(token),
    createdBy: actor.ctx.userId,
  });
  return ok({ grant, token });
}

/**
 * Directory-mode grant to a specific org member. `share` and `edit` are
 * grantable here (ADR 0008, ADR 0014) — and never to an external guest, who
 * is capped at read/comment regardless of grant (CONSTITUTION §9). That
 * refusal is layer (b) of three; the DB check and `canEditDocument`/
 * `canShareDocument` each refuse independently.
 *
 * A non-owner/admin grantor (i.e. themselves holding `share` or `edit`) is
 * capped at delegating their own level or below (ADR 0014) — they can never
 * mint a grant more powerful than the one they hold. Owner and org admin are
 * uncapped.
 */
export async function createUserGrant(
  documents: DocumentRepository,
  grants: ShareGrantRepository,
  orgs: OrganizationRepository,
  actor: Actor,
  documentId: DocumentId,
  userId: UserId,
  permission: GrantablePermission,
): Promise<Result<ShareGrant, SharingError>> {
  const shareable = await requireShareable(documents, grants, actor, documentId);
  if (!shareable.ok) return shareable;
  const org = await orgs.current(actor.ctx);
  if (org?.sharingMode !== 'directory') return err({ code: 'wrong_sharing_mode' });
  if (!isGuestGrantable(permission)) {
    const grantee = await orgs.userById(actor.ctx, userId);
    if (grantee?.role === 'guest') return err({ code: 'guest_edit_forbidden' });
  }
  const { ownPermission } = shareable.value;
  // ownPermission is undefined exactly when the caller is owner/admin
  // (requireShareable), who are uncapped.
  if (ownPermission !== undefined && !canDelegate(ownPermission, permission)) {
    return err({ code: 'grant_exceeds_own_permission' });
  }
  const grant = await grants.create(actor.ctx, {
    subject: { type: 'document', id: documentId },
    grantee: { type: 'user', userId },
    permission,
    tokenHash: null,
    createdBy: actor.ctx.userId,
  });
  return ok(grant);
}

export async function listShareGrants(
  documents: DocumentRepository,
  grants: ShareGrantRepository,
  actor: Actor,
  documentId: DocumentId,
): Promise<Result<ShareGrant[], SharingError>> {
  const shareable = await requireShareable(documents, grants, actor, documentId);
  if (!shareable.ok) return shareable;
  return ok(await grants.listForDocument(actor.ctx, documentId));
}

/**
 * Revokes a grant. The owner and org admin may revoke any grant on the
 * document; a `share`/`edit` holder may revoke only a grant THEY created
 * (ADR 0014) — they can clean up what they brought in, never a peer's access
 * or the owner's own collaborators.
 */
export async function revokeShareGrant(
  documents: DocumentRepository,
  grants: ShareGrantRepository,
  actor: Actor,
  documentId: DocumentId,
  grantId: GrantId,
): Promise<Result<void, SharingError>> {
  const shareable = await requireShareable(documents, grants, actor, documentId);
  if (!shareable.ok) return shareable;
  const listed = await grants.listForDocument(actor.ctx, documentId);
  const target = listed.find((g) => g.id === grantId);
  if (!target) return err({ code: 'grant_not_found' });
  const isManager = canManageDocument(actor, shareable.value.document);
  if (!isManager && target.createdBy !== actor.ctx.userId) {
    return err({ code: 'forbidden' });
  }
  const revoked = await grants.revoke(actor.ctx, grantId);
  return revoked ? ok(undefined) : err({ code: 'grant_not_found' });
}

/**
 * Redeems a share link inside the caller's session. The hash lookup runs
 * under the caller's org RLS — a token minted in another org finds nothing,
 * so links never cross the org boundary. First open materializes a personal
 * grant (ARCHITECTURE.md §7).
 *
 * Redemption can never materialize a `share` or `edit` grant (ADR 0008
 * decision 4, ADR 0014). `createShareLink` refuses both at the type level, so
 * a link carrying either cannot exist through the app; this refuses one that
 * reached the table any other way, keeping "share/edit are named-grant-only"
 * true no matter how the row got there.
 */
export async function redeemShareLink(
  grants: ShareGrantRepository,
  actor: Actor,
  token: string,
): Promise<Result<{ documentId: DocumentId; permission: LinkGrantablePermission }, SharingError>> {
  const grant = await grants.byTokenHash(actor.ctx, hashShareToken(token));
  if (grant?.subject.type !== 'document') return err({ code: 'invalid_token' });
  if (!isLinkGrantable(grant.permission)) return err({ code: 'invalid_token' });
  const linkPermission: LinkGrantablePermission = grant.permission;
  const documentId = grant.subject.id;
  const mine = await grants.listForUser(actor.ctx, actor.ctx.userId);
  const already = mine.some(
    (g) =>
      g.subject.type === 'document' &&
      g.subject.id === documentId &&
      g.permission === grant.permission,
  );
  if (!already) {
    await grants.create(actor.ctx, {
      subject: grant.subject,
      grantee: { type: 'user', userId: actor.ctx.userId },
      permission: grant.permission,
      tokenHash: null,
      createdBy: grant.createdBy,
    });
  }
  return ok({ documentId, permission: linkPermission });
}

/**
 * Effective permission of `actor` on a document: owner and org admin hold
 * `edit`; otherwise the highest active personal grant — on the document
 * itself, or on the project it currently lives in (ADR 0014) — otherwise
 * none.
 *
 * Reports the lattice honestly since ADR 0008 — a `share`/`edit` grantee
 * reads back as that rung, because they really hold it. Note that neither
 * `share` nor `edit` here implies document management (delete/resolve/
 * suggestion accept): that is `canManageDocument`, deliberately not a
 * lattice rung.
 *
 * `share`/`edit` are filtered out for a guest actor. Unreachable given the DB
 * check and the grant-creation refusals, but this fails closed rather than
 * downgrading silently, and it is the read-side twin of
 * `canEditDocument`/`canShareDocument`'s guest branch.
 */
export async function documentPermissionFor(
  grants: ShareGrantRepository,
  actor: Actor,
  document: Document,
): Promise<Permission | undefined> {
  if (canManageDocument(actor, document)) return 'edit';
  const own = await callerGrantPermission(grants, actor, document);
  return own ?? undefined;
}

/**
 * Access gate for routes: loads the document and requires `required`
 * permission. Insufficient access reads as 404 — no existence oracle.
 */
export async function requireDocumentAccess(
  documents: DocumentRepository,
  grants: ShareGrantRepository,
  actor: Actor,
  documentId: DocumentId,
  required: Permission,
): Promise<Result<{ document: Document; permission: Permission }, SharingError>> {
  const document = await documents.byId(actor.ctx, documentId);
  if (!document || document.deletedAt) return err({ code: 'document_not_found' });
  const permission = await documentPermissionFor(grants, actor, document);
  if (!permission || !permits(permission, required)) {
    return err({ code: 'document_not_found' });
  }
  return ok({ document, permission });
}

/**
 * Homepage listing: owned + granted documents; admins see the whole org.
 * A project-subject grant (ADR 0014) surfaces every document currently in
 * that project, alongside anything granted on individual documents.
 */
export async function listAccessibleDocuments(
  documents: DocumentRepository,
  grants: ShareGrantRepository,
  actor: Actor,
  filter?: DocumentListFilter,
): Promise<Document[]> {
  const all = await documents.list(actor.ctx, filter);
  if (actor.role === 'admin') return all;
  const mine = await grants.listForUser(actor.ctx, actor.ctx.userId);
  const grantedDocIds = new Set(
    mine.filter((g) => g.subject.type === 'document').map((g) => g.subject.id as string),
  );
  const grantedProjectIds = new Set(
    mine.filter((g) => g.subject.type === 'project').map((g) => g.subject.id as string),
  );
  return all.filter(
    (d) =>
      d.ownerId === actor.ctx.userId ||
      grantedDocIds.has(d.id) ||
      (d.projectId !== null && grantedProjectIds.has(d.projectId)),
  );
}
