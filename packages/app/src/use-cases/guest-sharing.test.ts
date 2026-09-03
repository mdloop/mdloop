import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserId } from '@vorlyn/shared';
import {
  FakeDirectoryRepository,
  FakeDocumentRepository,
  FakeEmail,
  FakeGuestUserRepository,
  FakeOrganizationRepository,
  FakeShareGrantRepository,
  FakeWorld,
} from '../test-support/fakes.js';
import type { Actor } from './org-settings.js';
import { createGuestShare, redeemGuestShare } from './guest-sharing.js';
import { listAccessibleDocuments } from './sharing.js';

const NOW = new Date('2026-07-15T00:00:00Z');

// Grant expiry is filtered against the real wall clock (mirrors Postgres
// `now()` — see FakeShareGrantRepository.unexpired), so it must be pinned to
// NOW here or these tests rot as real time passes NOW + days.
beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(orgOverrides: Parameters<FakeWorld['org']>[0] = {}) {
  const world = new FakeWorld();
  const org = world.org({ externalSharing: true, ...orgOverrides });
  const owner: Actor = { ctx: { orgId: org.id, userId: 'owner' as UserId }, role: 'member' };
  const member: Actor = { ctx: { orgId: org.id, userId: 'member' as UserId }, role: 'member' };
  const document = world.addDocument(org.id, {
    title: 'design.md',
    projectId: null,
    ownerId: owner.ctx.userId,
  });
  const documents = new FakeDocumentRepository(world);
  const grants = new FakeShareGrantRepository(world);
  const email = new FakeEmail();
  const deps = {
    documents,
    grants,
    orgs: new FakeOrganizationRepository(world),
    guests: new FakeGuestUserRepository(world),
    email,
  };
  const directory = new FakeDirectoryRepository(world, grants);
  return { world, org, owner, member, documentId: document.id, deps, directory, email, grants };
}

function share(
  s: ReturnType<typeof setup>,
  overrides: Partial<Parameters<typeof createGuestShare>[2]> = {},
) {
  return createGuestShare(
    s.deps,
    s.owner,
    {
      documentId: s.documentId,
      email: 'ext@client.test',
      permission: 'comment',
      days: 7,
      redeemUrlBase: 'https://app.test/g/',
      ...overrides,
    },
    NOW,
  );
}

describe('createGuestShare', () => {
  it('creates a guest user + expiring grant and emails the link', async () => {
    const s = setup();
    const result = await share(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.grant.granteeEmail).toBe('ext@client.test');
    expect(result.value.expiresAt.getTime()).toBe(NOW.getTime() + 7 * 86_400_000);
    const guest = [...s.world.users.values()].find((u) => u.role === 'guest');
    expect(guest?.email).toBe('ext@client.test');
    expect(guest?.workosUserId.startsWith('guest:')).toBe(true);
    expect(s.email.guestSharesSent).toHaveLength(1);
    expect(s.email.guestSharesSent[0]?.url).toContain(result.value.token);
  });

  it('still returns the grant and token when email delivery fails (best-effort send)', async () => {
    const s = setup();
    s.email.failing = true;
    const result = await share(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.token).toBeTruthy();
    expect(result.value.grant.granteeEmail).toBe('ext@client.test');
    // Nothing recorded — the fake only pushes onto guestSharesSent on success.
    expect(s.email.guestSharesSent).toHaveLength(0);
  });

  it('refuses an edit permission outright (ADR 0008, layer b)', async () => {
    const s = setup();
    // The type-level cap keeps honest callers out; this proves the runtime
    // twin refuses a value that arrived past the types (a wire body, say).
    const result = await share(s, { permission: 'edit' as 'read' | 'comment' });
    expect(!result.ok && result.error.code).toBe('guest_edit_forbidden');
    expect(s.email.guestSharesSent).toHaveLength(0);
  });

  it('is management-gated, not edit-gated — an edit grantee cannot re-share (ADR 0008)', async () => {
    const s = setup();
    await s.grants.create(s.owner.ctx, {
      subject: { type: 'document', id: s.documentId },
      grantee: { type: 'user', userId: s.member.ctx.userId },
      permission: 'edit',
      tokenHash: null,
      createdBy: s.owner.ctx.userId,
    });
    const denied = await createGuestShare(
      s.deps,
      s.member,
      {
        documentId: s.documentId,
        email: 'ext@client.test',
        permission: 'read',
        days: 7,
        redeemUrlBase: 'https://app.test/g/',
      },
      NOW,
    );
    expect(!denied.ok && denied.error.code).toBe('document_not_found');
  });

  it('requires management rights — a non-owner member reads as 404', async () => {
    const s = setup();
    const denied = await createGuestShare(
      s.deps,
      s.member,
      {
        documentId: s.documentId,
        email: 'ext@client.test',
        permission: 'read',
        days: 7,
        redeemUrlBase: 'https://app.test/g/',
      },
      NOW,
    );
    expect(!denied.ok && denied.error.code).toBe('document_not_found');
  });

  it('blocks creation when the org flag is off', async () => {
    const s = setup({ externalSharing: false });
    const result = await share(s);
    expect(!result.ok && result.error.code).toBe('external_sharing_disabled');
  });

  it('rejects a malformed email', async () => {
    const s = setup();
    const result = await share(s, { email: 'not-an-email' });
    expect(!result.ok && result.error.code).toBe('invalid_email');
  });

  it('clamps requested days to the tier ceiling', async () => {
    // Free tier's guest cap is now zero (Phase 33), so it can't create a
    // guest share at all — this test is about day-clamping, not the guest
    // count cap, so it runs on team tier (25 guests of headroom) instead.
    const s = setup({ tier: 'team' });
    const result = await share(s, { days: 90 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.expiresAt.getTime()).toBe(NOW.getTime() + 30 * 86_400_000);
  });

  it('enforces the distinct-guest cap per tier', async () => {
    // Free tier's guest ceiling is now zero (Phase 33) — it blocks the very
    // first guest, so it can't demonstrate "create up to the cap, then get
    // blocked" the way it used to. That shape now runs on team tier (cap
    // 25); the free-tier zero-guest case gets its own direct assertion.
    const free = setup({ tier: 'free' });
    const blockedFirst = await share(free, { email: 'g1@x.test' });
    expect(!blockedFirst.ok && blockedFirst.error.code).toBe('guest_cap_exceeded');

    const s = setup({ tier: 'team' }); // cap 25
    for (let n = 1; n <= 25; n++) {
      const r = await share(s, { email: `g${String(n)}@x.test` });
      expect(r.ok).toBe(true);
    }
    const overCap = await share(s, { email: 'g26@x.test' });
    expect(!overCap.ok && overCap.error.code).toBe('guest_cap_exceeded');
  });

  it('re-share to the same email extends expiry instead of erroring at the cap', async () => {
    // Not a guest-count test either (see above) — team tier gives headroom
    // so the re-share behavior itself is what's under test.
    const s = setup({ tier: 'team' });
    for (const n of [1, 2, 3]) await share(s, { email: `g${String(n)}@x.test` });
    const again = await share(s, { email: 'G1@X.TEST', days: 7 });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    // Same guest user, same grant row, bumped expiry — not a new seat.
    const guests = [...s.world.users.values()].filter((u) => u.role === 'guest');
    expect(guests).toHaveLength(3);
    const emails = await s.grants.activeGuestEmails(s.owner.ctx);
    expect(emails).toHaveLength(3);
  });
});

describe('redeemGuestShare', () => {
  it('returns the guest identity for a live token', async () => {
    const s = setup();
    const created = await share(s);
    if (!created.ok) throw new Error('setup');
    const redeemed = await redeemGuestShare(s.directory, created.value.token, NOW);
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;
    expect(redeemed.value.orgId).toBe(s.org.id);
    expect(redeemed.value.documentId).toBe(s.documentId);
    expect(redeemed.value.expiresAt?.getTime()).toBe(created.value.expiresAt.getTime());
  });

  it('denies an expired grant', async () => {
    const s = setup();
    const created = await share(s, { days: 7 });
    if (!created.ok) throw new Error('setup');
    const after = new Date(created.value.expiresAt.getTime() + 1);
    const redeemed = await redeemGuestShare(s.directory, created.value.token, after);
    expect(!redeemed.ok && redeemed.error.code).toBe('expired');
  });

  it('denies when the org has since turned external sharing off', async () => {
    const s = setup();
    const created = await share(s);
    if (!created.ok) throw new Error('setup');
    s.world.orgs.set(s.org.id, { ...s.org, externalSharing: false });
    const redeemed = await redeemGuestShare(s.directory, created.value.token, NOW);
    expect(!redeemed.ok && redeemed.error.code).toBe('external_sharing_disabled');
  });

  it('denies an unknown or revoked token', async () => {
    const s = setup();
    const created = await share(s);
    if (!created.ok) throw new Error('setup');
    expect((await redeemGuestShare(s.directory, 'nope', NOW)).ok).toBe(false);
    await s.grants.revoke(s.owner.ctx, created.value.grant.id);
    const revoked = await redeemGuestShare(s.directory, created.value.token, NOW);
    expect(!revoked.ok && revoked.error.code).toBe('invalid_token');
  });
});

describe('guests are never seats', () => {
  it('a guest user never appears in the member list (seat count, billing, grant picker)', async () => {
    const s = setup();
    const created = await share(s);
    if (!created.ok) throw new Error('setup');
    const members = await s.deps.orgs.listUsers(s.owner.ctx);
    expect(members.every((u) => u.role !== 'guest')).toBe(true);
    // The guest user row itself exists — it is just not a member.
    expect([...s.world.users.values()].some((u) => u.role === 'guest')).toBe(true);
  });
});

describe('guest access scope', () => {
  it('a guest sees only the granted document, and expiry removes it', async () => {
    const s = setup();
    s.world.addDocument(s.org.id, {
      title: 'other.md',
      projectId: null,
      ownerId: s.owner.ctx.userId,
    });
    const created = await share(s);
    if (!created.ok) throw new Error('setup');
    const guest = [...s.world.users.values()].find((u) => u.role === 'guest');
    if (!guest) throw new Error('setup');
    const guestActor: Actor = { ctx: { orgId: s.org.id, userId: guest.id }, role: 'guest' };

    const visible = await listAccessibleDocuments(s.deps.documents, s.grants, guestActor);
    expect(visible.map((d) => d.id)).toEqual([s.documentId]);

    // Force-expire the grant: the document disappears at read time, no sweep.
    const grant = [...s.grants.grants.values()].find((g) => g.granteeEmail !== null);
    if (!grant) throw new Error('setup');
    s.grants.grants.set(grant.id, { ...grant, expiresAt: new Date(NOW.getTime() - 1) });
    const gone = await listAccessibleDocuments(s.deps.documents, s.grants, guestActor);
    expect(gone).toHaveLength(0);
  });
});
