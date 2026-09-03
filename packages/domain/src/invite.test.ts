import { describe, expect, it } from 'vitest';
import { canJitJoin, canSendInvite, inviteAcceptability } from './invite.js';

const now = new Date('2026-07-14T00:00:00Z');
const future = new Date('2026-08-01T00:00:00Z');
const past = new Date('2026-06-01T00:00:00Z');

describe('canSendInvite', () => {
  it('free tier is solo (ceiling 1, Phase 33) — an org of just the owner is still under it', () => {
    const r = canSendInvite({ tier: 'free', currentMemberCount: 0, pendingInviteCount: 0 });
    expect(r.ok).toBe(true);
  });

  it('blocks at the ceiling counting members + pending invites', () => {
    const r = canSendInvite({ tier: 'free', currentMemberCount: 0, pendingInviteCount: 1 });
    expect(r).toEqual({ ok: false, error: { code: 'seat_cap_reached', limit: 1 } });
  });

  it('blocks when members alone already reach the ceiling', () => {
    const r = canSendInvite({ tier: 'free', currentMemberCount: 1, pendingInviteCount: 0 });
    expect(r.ok).toBe(false);
  });

  it('team tier has no ceiling', () => {
    const r = canSendInvite({ tier: 'team', currentMemberCount: 500, pendingInviteCount: 500 });
    expect(r.ok).toBe(true);
  });

  it('enterprise tier has no ceiling', () => {
    const r = canSendInvite({
      tier: 'enterprise',
      currentMemberCount: 10_000,
      pendingInviteCount: 0,
    });
    expect(r.ok).toBe(true);
  });
});

describe('inviteAcceptability', () => {
  const base = { acceptedAt: null, revokedAt: null, expiresAt: future };

  it('accepts a live invite', () => {
    expect(inviteAcceptability(base, now).ok).toBe(true);
  });

  it('rejects revoked, even if also expired or accepted', () => {
    const r = inviteAcceptability(
      { ...base, revokedAt: past, acceptedAt: past, expiresAt: past },
      now,
    );
    expect(r).toEqual({ ok: false, error: { code: 'invite_revoked' } });
  });

  it('rejects already-used before checking expiry', () => {
    const r = inviteAcceptability({ ...base, acceptedAt: past, expiresAt: past }, now);
    expect(r).toEqual({ ok: false, error: { code: 'invite_already_used' } });
  });

  it('rejects expired', () => {
    const r = inviteAcceptability({ ...base, expiresAt: past }, now);
    expect(r).toEqual({ ok: false, error: { code: 'invite_expired' } });
  });

  it('treats exact expiry boundary as expired', () => {
    const r = inviteAcceptability({ ...base, expiresAt: now }, now);
    expect(r).toEqual({ ok: false, error: { code: 'invite_expired' } });
  });
});

describe('canJitJoin', () => {
  it('open mode: any email joins if seats available', () => {
    const r = canJitJoin({
      mode: 'open',
      email: 'anyone@example.com',
      isAllowlisted: false,
      tier: 'enterprise',
      currentMemberCount: 10,
    });
    expect(r.ok).toBe(true);
  });

  it('refuses free tier unconditionally, even in open mode with plenty of seats (tier gate checked first, Phase 33)', () => {
    const r = canJitJoin({
      mode: 'open',
      email: 'anyone@example.com',
      isAllowlisted: false,
      tier: 'free',
      currentMemberCount: 0,
    });
    expect(r).toEqual({ ok: false, error: { code: 'sso_requires_enterprise_tier' } });
  });

  it('refuses team tier — SSO is Enterprise-only, not team-and-up (Phase 33)', () => {
    const r = canJitJoin({
      mode: 'open',
      email: 'anyone@example.com',
      isAllowlisted: false,
      tier: 'team',
      currentMemberCount: 0,
    });
    expect(r).toEqual({ ok: false, error: { code: 'sso_requires_enterprise_tier' } });
  });

  it('allowlist mode: denies non-listed email even with seats available', () => {
    const r = canJitJoin({
      mode: 'allowlist',
      email: 'stranger@example.com',
      isAllowlisted: false,
      tier: 'enterprise',
      currentMemberCount: 1,
    });
    expect(r).toEqual({ ok: false, error: { code: 'not_allowlisted' } });
  });

  it('allowlist mode: allows listed email under the ceiling', () => {
    // Enterprise, not team — SSO is Enterprise-only (Phase 33), so this must
    // clear the tier gate to reach the allowlist logic it's actually testing.
    const r = canJitJoin({
      mode: 'allowlist',
      email: 'listed@example.com',
      isAllowlisted: true,
      tier: 'enterprise',
      currentMemberCount: 50,
    });
    expect(r.ok).toBe(true);
  });

  // Phase 33: the tier gate is checked before allowlist AND before the seat
  // ceiling, so it wins even for the "hardest" combined case — an allowlisted
  // email that's also at the (old, free-tier) seat cap. This fixture used to
  // prove seat-ceiling enforcement under allowlist mode; that combination is
  // no longer constructible with any real tier (free is barred by the gate
  // before either check runs, and team/enterprise both have unlimited
  // `maxCollaborators` per tier.ts) — so it now proves gate ordering instead.
  it('allowlist mode: tier gate is still checked first, even for an allowlisted email at the old seat cap', () => {
    const r = canJitJoin({
      mode: 'allowlist',
      email: 'listed@example.com',
      isAllowlisted: true,
      tier: 'free',
      currentMemberCount: 1,
    });
    expect(r).toEqual({ ok: false, error: { code: 'sso_requires_enterprise_tier' } });
  });
});
