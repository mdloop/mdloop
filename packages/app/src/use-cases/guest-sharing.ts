import { randomBytes } from 'node:crypto';
import type { GuestCapError, Permission, ShareGrant } from '@vorlyn/domain';
import {
  checkGuestShareAllowed,
  clampGuestShareDays,
  guestCapLimit,
  isGuestGrantable,
  isValidEmail,
} from '@vorlyn/domain';
import type { DocumentId, OrgId, Result, UserId } from '@vorlyn/shared';
import { err, ok } from '@vorlyn/shared';
import type {
  DirectoryRepository,
  DocumentRepository,
  GuestUserRepository,
  ShareGrantRepository,
} from '../ports/repositories.port.js';
import type { EmailPort } from '../ports/email.port.js';
import type { GuestGrantablePermission } from '@vorlyn/domain';
import { canManageDocument } from '../policy.js';
import type { Actor, OrganizationRepository } from './org-settings.js';
import { hashShareToken, requireDocumentAccess } from './sharing.js';

export type GuestShareError =
  | { readonly code: 'document_not_found' }
  | { readonly code: 'external_sharing_disabled' }
  | { readonly code: 'invalid_email' }
  /** `edit` was asked for on a guest share (ADR 0008 decision 3, layer b). */
  | { readonly code: 'guest_edit_forbidden' }
  | GuestCapError;

export type GuestRedeemError =
  | { readonly code: 'invalid_token' }
  | { readonly code: 'expired' }
  | { readonly code: 'external_sharing_disabled' };

export interface CreateGuestShareDeps {
  readonly documents: DocumentRepository;
  readonly grants: ShareGrantRepository;
  readonly orgs: OrganizationRepository;
  readonly guests: GuestUserRepository;
  readonly email: EmailPort;
}

export interface CreateGuestShareInput {
  readonly documentId: DocumentId;
  readonly email: string;
  /** Never `edit` — external guests are capped at read/comment (CONSTITUTION §9). */
  readonly permission: GuestGrantablePermission;
  readonly days: number;
  /** Base the emailed redeem link is built on: `${base}<token>`. */
  readonly redeemUrlBase: string;
}

export interface GuestShareResult {
  readonly grant: ShareGrant;
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * A doc owner/admin shares a document to an external email (Phase 18). The
 * recipient has no Vorlyn account, so a synthetic `guest` user row backs the
 * grant. Requires management rights on the document (owner/admin) behind a
 * read-level `requireDocumentAccess`, so insufficient access still reads as a
 * 404 — no existence oracle — and the org's `external_sharing` flag on.
 * Re-sharing to the same email EXTENDS the existing grant (bumps expiry,
 * regenerates token) rather than erroring. The token is returned exactly once;
 * only its hash is stored.
 *
 * The gate used to be `requireDocumentAccess(…, 'edit')`, which meant
 * owner-or-admin only because `edit` was ungrantable. ADR 0008 made `edit`
 * grantable, so the check is now spelled out as `canManageDocument` — an
 * editor may push versions, never re-share the document.
 */
export async function createGuestShare(
  deps: CreateGuestShareDeps,
  actor: Actor,
  input: CreateGuestShareInput,
  now: Date = new Date(),
): Promise<Result<GuestShareResult, GuestShareError>> {
  const access = await requireDocumentAccess(
    deps.documents,
    deps.grants,
    actor,
    input.documentId,
    'read',
  );
  if (!access.ok) return err({ code: 'document_not_found' });
  const document = access.value.document;
  if (!canManageDocument(actor, document)) return err({ code: 'document_not_found' });

  // Runtime half of the type-level cap on `permission` — a wire value that
  // slipped past the schema still cannot buy a guest an `edit` grant.
  const requested: Permission = input.permission;
  if (!isGuestGrantable(requested)) return err({ code: 'guest_edit_forbidden' });

  const org = await deps.orgs.current(actor.ctx);
  if (!org?.externalSharing) return err({ code: 'external_sharing_disabled' });

  const email = input.email.trim();
  if (!isValidEmail(email)) return err({ code: 'invalid_email' });
  const normalized = email.toLowerCase();

  // The cap counts distinct active guest emails; re-sharing to an email that
  // is already an active guest never consumes a new seat.
  const activeEmails = await deps.grants.activeGuestEmails(actor.ctx);
  if (!activeEmails.includes(normalized)) {
    const capped = checkGuestShareAllowed(activeEmails.length, org.tier);
    if (!capped.ok) return err(capped.error);
  }

  const days = clampGuestShareDays(input.days, org.tier);
  const expiresAt = new Date(now.getTime() + days * 86_400_000);

  const guestUser =
    (await deps.guests.guestByEmail(actor.ctx, normalized)) ??
    (await deps.guests.createGuest(actor.ctx, normalized));

  const token = randomBytes(24).toString('base64url');
  const tokenHash = hashShareToken(token);

  // An active (non-revoked) guest grant for this (document, guest) pair is a
  // re-share: extend it in place. Otherwise mint a fresh grant.
  const onDoc = await deps.grants.listForDocument(actor.ctx, input.documentId);
  const existing = onDoc.find(
    (g) =>
      g.grantee.type === 'user' && g.grantee.userId === guestUser.id && g.granteeEmail !== null,
  );

  let grant: ShareGrant;
  if (existing) {
    grant = await deps.grants.extendGuestGrant(actor.ctx, existing.id, {
      permission: input.permission,
      tokenHash,
      expiresAt,
    });
  } else {
    // The early cap check above is a courtesy fast-fail; this create re-checks
    // the ceiling under a per-org lock (Phase 24), so concurrent shares to two
    // new guest emails at ceiling-1 cannot both land.
    const limit = guestCapLimit(org.tier);
    const created = await deps.grants.createWithinGuestCap(
      actor.ctx,
      {
        subject: { type: 'document', id: input.documentId },
        grantee: { type: 'user', userId: guestUser.id },
        permission: input.permission,
        tokenHash,
        expiresAt,
        granteeEmail: normalized,
        createdBy: actor.ctx.userId,
      },
      normalized,
      limit,
    );
    if (!created) return err({ code: 'guest_cap_exceeded', limit: limit ?? 0 });
    grant = created;
  }

  // Best-effort, same idiom as upload.ts's rollback catch and sendInvite's
  // matching fix: the grant is already committed and its token is already
  // in this function's return value, so a delivery failure must not turn
  // an otherwise-successful share into a hard error for the caller.
  await deps.email
    .sendGuestShare({
      to: normalized,
      documentTitle: document.title,
      url: `${input.redeemUrlBase}${encodeURIComponent(token)}`,
      expiresAt,
    })
    .catch(() => undefined);

  return ok({ grant, token, expiresAt });
}

export interface GuestRedeemResult {
  readonly orgId: OrgId;
  readonly userId: UserId;
  readonly documentId: DocumentId;
  readonly expiresAt: Date | null;
}

/**
 * Redeems a guest-share token (Phase 18). Runs WITHOUT tenant context — the
 * token is the identity, so the lookup is a privileged cross-org read by hash
 * (same trust boundary as invite acceptance). Denies a revoked/expired grant
 * and a grant whose org has since turned `external_sharing` off. Returns the
 * identity the caller mints a guest session for.
 */
export async function redeemGuestShare(
  directory: DirectoryRepository,
  token: string,
  now: Date = new Date(),
): Promise<Result<GuestRedeemResult, GuestRedeemError>> {
  const grant = await directory.guestGrantByTokenHash(hashShareToken(token));
  if (!grant) return err({ code: 'invalid_token' });
  if (
    grant.revokedAt !== null ||
    grant.grantee.type !== 'user' ||
    grant.subject.type !== 'document' ||
    grant.granteeEmail === null
  ) {
    return err({ code: 'invalid_token' });
  }
  if (grant.expiresAt !== null && grant.expiresAt.getTime() <= now.getTime()) {
    return err({ code: 'expired' });
  }
  const org = await directory.organizationById(grant.orgId);
  if (!org?.externalSharing) return err({ code: 'external_sharing_disabled' });

  return ok({
    orgId: grant.orgId,
    userId: grant.grantee.userId,
    documentId: grant.subject.id,
    expiresAt: grant.expiresAt,
  });
}
