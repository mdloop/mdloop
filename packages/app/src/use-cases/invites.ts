import { createHash, randomBytes } from 'node:crypto';
import type { AllowlistEntry, OrgInvite, SeatCapError, UserRole } from '@mdloop/domain';
import { canSendInvite, collaboratorCapLimit } from '@mdloop/domain';
import type { AllowlistEntryId, InviteId, Result } from '@mdloop/shared';
import { err, ok } from '@mdloop/shared';
import type { AllowlistRepository, OrgInviteRepository } from '../ports/repositories.port.js';
import type { EmailPort } from '../ports/email.port.js';
import type { Actor, OrganizationRepository } from './org-settings.js';

/** Invites expire 7 days after being sent. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InviteSendError =
  { readonly code: 'forbidden' } | { readonly code: 'org_not_found' } | SeatCapError;

export type InviteMutateError =
  { readonly code: 'forbidden' } | { readonly code: 'invite_not_found' };

export type AllowlistMutateError =
  { readonly code: 'forbidden' } | { readonly code: 'entry_not_found' };

/** SHA-256 hex of an invite token — only the hash is ever stored (same pattern as share tokens). */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Admin sends an invite. Seat/quota check happens here, at send time, not
 * after signup (Phase 15). The token is returned exactly once.
 */
export async function sendInvite(
  orgs: OrganizationRepository,
  invites: OrgInviteRepository,
  email: EmailPort,
  actor: Actor,
  input: { email: string; role: UserRole; acceptUrlBase: string },
  now: Date = new Date(),
): Promise<Result<{ invite: OrgInvite; token: string }, InviteSendError>> {
  if (actor.role !== 'admin') return err({ code: 'forbidden' });
  const org = await orgs.current(actor.ctx);
  if (!org) return err({ code: 'org_not_found' });

  const members = await orgs.listUsers(actor.ctx);
  const pending = await invites.countPending(actor.ctx);
  const check = canSendInvite({
    tier: org.tier,
    currentMemberCount: members.length,
    pendingInviteCount: pending,
  });
  if (!check.ok) return err(check.error);

  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  // The canSendInvite check above is the domain decision (and fast-fails with
  // the right error); the create re-checks occupied seats under a per-org
  // lock (Phase 24), so two concurrent sends at ceiling-1 cannot both land.
  const limit = collaboratorCapLimit(org.tier);
  const invite = await invites.createWithinSeatCap(
    actor.ctx,
    {
      email: input.email,
      role: input.role,
      tokenHash: hashInviteToken(token),
      expiresAt,
      invitedBy: actor.ctx.userId,
    },
    limit,
  );
  if (!invite) return err({ code: 'seat_cap_reached', limit: limit ?? 0 });
  const acceptUrl = `${input.acceptUrlBase}${encodeURIComponent(token)}`;
  // Best-effort, same idiom as upload.ts's rollback catch: the invite row
  // is already committed and its token is already in this function's
  // return value (the design this port's own doc comment describes —
  // "token also returned in the API response, same pattern as share
  // links"), so a delivery failure (unreachable SMTP relay, auth failure —
  // a real possibility once a self-hoster wires SmtpEmailAdapter, unlike
  // the always-succeeds LoggingEmailAdapter) must not turn an otherwise-
  // successful send into a hard error for the caller.
  await email.sendOrgInvite(input.email, org.name, acceptUrl, expiresAt).catch(() => undefined);
  return ok({ invite, token });
}

export async function listInvites(
  invites: OrgInviteRepository,
  actor: Actor,
): Promise<Result<OrgInvite[], InviteMutateError>> {
  if (actor.role !== 'admin') return err({ code: 'forbidden' });
  return ok(await invites.list(actor.ctx));
}

export async function revokeInvite(
  invites: OrgInviteRepository,
  actor: Actor,
  id: InviteId,
): Promise<Result<void, InviteMutateError>> {
  if (actor.role !== 'admin') return err({ code: 'forbidden' });
  const revoked = await invites.revoke(actor.ctx, id);
  return revoked ? ok(undefined) : err({ code: 'invite_not_found' });
}

export async function addAllowlistEntry(
  allowlist: AllowlistRepository,
  actor: Actor,
  email: string,
): Promise<Result<AllowlistEntry, AllowlistMutateError>> {
  if (actor.role !== 'admin') return err({ code: 'forbidden' });
  return ok(await allowlist.add(actor.ctx, { email, addedBy: actor.ctx.userId }));
}

export async function listAllowlist(
  allowlist: AllowlistRepository,
  actor: Actor,
): Promise<Result<AllowlistEntry[], AllowlistMutateError>> {
  if (actor.role !== 'admin') return err({ code: 'forbidden' });
  return ok(await allowlist.list(actor.ctx));
}

export async function removeAllowlistEntry(
  allowlist: AllowlistRepository,
  actor: Actor,
  id: AllowlistEntryId,
): Promise<Result<void, AllowlistMutateError>> {
  if (actor.role !== 'admin') return err({ code: 'forbidden' });
  const removed = await allowlist.remove(actor.ctx, id);
  return removed ? ok(undefined) : err({ code: 'entry_not_found' });
}
