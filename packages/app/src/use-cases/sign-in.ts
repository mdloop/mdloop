import type { InviteAcceptabilityError, JitJoinError, Organization, User } from '@mdloop/domain';
import {
  canJitJoin,
  collaboratorCapLimit,
  inviteAcceptability,
  isDisposableEmail,
} from '@mdloop/domain';
import type { Result } from '@mdloop/shared';
import { err, ok } from '@mdloop/shared';
import type { AuthProfile } from '../ports/auth.port.js';
import type { DirectoryRepository } from '../ports/repositories.port.js';
import type { SeatSyncPort } from '../ports/seat-sync.port.js';
import { hashInviteToken } from './invites.js';

export type SignInError =
  | { readonly code: 'disposable_email' }
  | { readonly code: 'invite_not_found' }
  | { readonly code: 'sso_connection_not_found' }
  | InviteAcceptabilityError
  | JitJoinError;

/**
 * Reports the org's new headcount after a join. Read fresh rather than derived
 * from a pre-join count, so a concurrent join cannot make the reported number
 * wrong.
 *
 * Deliberately swallows its own failure. By the time this runs the member row
 * is already committed and the person is already in the org, so throwing here
 * would fail a sign-in that actually succeeded — the user sees an error, cannot
 * retry (they are now a returning user, which short-circuits before this
 * point), and is left in a worse state than if nobody had been notified at all.
 * A notification is not worth a broken join. Same reasoning and same idiom as
 * the email sends in `invites.ts` and `guest-sharing.ts`.
 */
async function reportSeatsChanged(
  directory: DirectoryRepository,
  seatSync: SeatSyncPort,
  org: Organization,
): Promise<void> {
  await directory
    .memberCount(org.id)
    .then((members) => seatSync.onSeatsChanged(org, members))
    .catch(() => undefined);
}

async function acceptInvite(
  directory: DirectoryRepository,
  seatSync: SeatSyncPort,
  profile: AuthProfile,
  inviteToken: string,
): Promise<Result<User, SignInError>> {
  const invite = await directory.inviteByTokenHash(hashInviteToken(inviteToken));
  if (!invite) return err({ code: 'invite_not_found' });
  const acceptable = inviteAcceptability(invite, new Date());
  if (!acceptable.ok) return err(acceptable.error);
  const org = await directory.organizationById(invite.orgId);
  if (!org) return err({ code: 'invite_not_found' });

  const user = await directory.createUser(invite.orgId, {
    workosUserId: profile.providerUserId,
    email: profile.email,
    displayName: profile.displayName,
    role: invite.role,
  });
  await directory.markInviteAccepted(invite.id);
  await reportSeatsChanged(directory, seatSync, org);
  return ok(user);
}

async function jitJoin(
  directory: DirectoryRepository,
  seatSync: SeatSyncPort,
  profile: AuthProfile,
  ssoConnectionId: string,
): Promise<Result<User, SignInError>> {
  const org = await directory.organizationBySsoConnection(ssoConnectionId);
  if (!org) return err({ code: 'sso_connection_not_found' });

  const isAllowlisted =
    org.provisioningMode === 'allowlist'
      ? await directory.isAllowlisted(org.id, profile.email)
      : false;
  const currentMemberCount = await directory.memberCount(org.id);
  const check = canJitJoin({
    mode: org.provisioningMode,
    email: profile.email,
    isAllowlisted,
    tier: org.tier,
    currentMemberCount,
  });
  if (!check.ok) return err(check.error);

  // canJitJoin above is the domain decision; the create re-checks the seat
  // count under a per-org lock (Phase 24), so two concurrent JIT joins at
  // ceiling-1 cannot both land.
  const limit = collaboratorCapLimit(org.tier);
  const user = await directory.createUserWithinSeatCap(
    org.id,
    {
      workosUserId: profile.providerUserId,
      email: profile.email,
      displayName: profile.displayName,
      role: 'member',
    },
    limit,
  );
  if (!user) return err({ code: 'seat_cap_reached', limit: limit ?? 0 });
  await reportSeatsChanged(directory, seatSync, org);
  return ok(user);
}

/**
 * Provision-on-first-sign-in: a returning user signs in; an unknown user is
 * routed to one of three paths, in priority order:
 *
 * 1. **Invite token present** (Phase 15 manual invite): join the inviting org
 *    with the invite's pre-set role.
 * 2. **SSO connection on the profile** (Phase 15 enterprise JIT): join the org
 *    that owns the connection, per its `open`/`allowlist` provisioning mode.
 * 3. **Neither**: fresh **free personal** organization of their own (org of
 *    one, `TIER_PROFILES.free` in tier.ts), admin. Email-domain matching is deliberately NOT
 *    used (domain collisions would breach tenant boundaries).
 *
 * Abuse controls (Phase 13): email verification is WorkOS's job (OTP/magic
 * link — an unverified address never reaches this point); disposable-domain
 * signups are refused on the personal-org path; the per-IP signup rate limit
 * lives on the route.
 */
export async function signIn(
  directory: DirectoryRepository,
  seatSync: SeatSyncPort,
  profile: AuthProfile,
  inviteToken?: string,
): Promise<Result<User, SignInError>> {
  const existing = await directory.userByWorkosId(profile.providerUserId);
  if (existing) return ok(existing);

  if (inviteToken) return acceptInvite(directory, seatSync, profile, inviteToken);
  if (profile.ssoConnectionId)
    return jitJoin(directory, seatSync, profile, profile.ssoConnectionId);

  if (isDisposableEmail(profile.email)) return err({ code: 'disposable_email' });
  const orgName = profile.displayName !== '' ? `${profile.displayName}'s workspace` : 'Workspace';
  const org = await directory.createOrganization(orgName, 'free');
  return ok(
    await directory.createUser(org.id, {
      workosUserId: profile.providerUserId,
      email: profile.email,
      displayName: profile.displayName,
      role: 'admin',
    }),
  );
}
