import { describe, expect, it } from 'vitest';
import type { UserId } from '@vorlyn/shared';
import { FakeApiKeyRepository, FakeWorld } from '../test-support/fakes.js';
import type { Actor } from './org-settings.js';
import {
  API_KEY_PREFIX,
  actorForApiKey,
  createApiKey,
  hashApiKey,
  listApiKeys,
  revokeApiKey,
} from './api-keys.js';

function setup() {
  const world = new FakeWorld();
  const org = world.org();
  const owner: Actor = { ctx: { orgId: org.id, userId: 'owner' as UserId }, role: 'member' };
  const other: Actor = { ctx: { orgId: org.id, userId: 'other' as UserId }, role: 'member' };
  const admin: Actor = { ctx: { orgId: org.id, userId: 'admin' as UserId }, role: 'admin' };
  const keys = new FakeApiKeyRepository(world);
  return { world, org, owner, other, admin, keys };
}

describe('createApiKey', () => {
  it('returns the key once, prefixed, and stores only its hash', async () => {
    const s = setup();
    const result = await createApiKey(s.keys, s.owner, 'ci bot');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.key.startsWith(API_KEY_PREFIX)).toBe(true);
    const stored = s.keys.keys.get(result.value.record.id);
    expect(stored?.keyHash).toBe(hashApiKey(result.value.key));
  });

  it('rejects an empty name', async () => {
    const s = setup();
    const result = await createApiKey(s.keys, s.owner, '   ');
    expect(!result.ok && result.error.code).toBe('invalid_name');
  });
});

describe('listApiKeys', () => {
  it('members see only their own keys; admins see the whole org', async () => {
    const s = setup();
    await createApiKey(s.keys, s.owner, 'owner key');
    await createApiKey(s.keys, s.other, 'other key');

    const ownerView = await listApiKeys(s.keys, s.owner);
    expect(ownerView.map((k) => k.name)).toEqual(['owner key']);

    const adminView = await listApiKeys(s.keys, s.admin);
    expect(adminView.map((k) => k.name).sort()).toEqual(['other key', 'owner key']);
  });
});

describe('revokeApiKey', () => {
  it('owners revoke their own key', async () => {
    const s = setup();
    const created = await createApiKey(s.keys, s.owner, 'owner key');
    if (!created.ok) throw new Error('setup');
    const revoked = await revokeApiKey(s.keys, s.owner, created.value.record.id);
    expect(revoked.ok).toBe(true);
    const [key] = await listApiKeys(s.keys, s.owner);
    expect(key?.revokedAt).not.toBeNull();
  });

  it("members cannot revoke someone else's key; admins can", async () => {
    const s = setup();
    const created = await createApiKey(s.keys, s.other, 'other key');
    if (!created.ok) throw new Error('setup');

    const denied = await revokeApiKey(s.keys, s.owner, created.value.record.id);
    expect(!denied.ok && denied.error.code).toBe('key_not_found');

    const revoked = await revokeApiKey(s.keys, s.admin, created.value.record.id);
    expect(revoked.ok).toBe(true);
  });

  it('unknown or already-revoked keys are not-found', async () => {
    const s = setup();
    const missing = await revokeApiKey(s.keys, s.owner, 'nope');
    expect(!missing.ok && missing.error.code).toBe('key_not_found');
  });

  it('reports not-found when the repository loses the race and revoke() fails', async () => {
    // Visible-and-not-yet-revoked at the read, but the write itself reports
    // failure (e.g. concurrently revoked between the check and the write).
    const s = setup();
    const created = await createApiKey(s.keys, s.owner, 'owner key');
    if (!created.ok) throw new Error('setup');
    const realRevoke = s.keys.revoke.bind(s.keys);
    s.keys.revoke = () => Promise.resolve(false);
    const result = await revokeApiKey(s.keys, s.owner, created.value.record.id);
    expect(!result.ok && result.error.code).toBe('key_not_found');
    s.keys.revoke = realRevoke;
  });
});

describe('namesByIds', () => {
  it('resolves ids to names, including revoked keys, within one org only', async () => {
    const s = setup();
    const otherOrg = s.world.org({ name: 'Other Co' });
    const stranger: Actor = { ctx: { orgId: otherOrg.id, userId: 'x' as UserId }, role: 'member' };

    const mine = await createApiKey(s.keys, s.owner, 'ci bot');
    const theirs = await createApiKey(s.keys, stranger, 'their bot');
    if (!mine.ok || !theirs.ok) throw new Error('setup');
    await revokeApiKey(s.keys, s.owner, mine.value.record.id);

    const names = await s.keys.namesByIds(s.owner.ctx, [
      mine.value.record.id,
      theirs.value.record.id,
      'unknown-id',
    ]);
    // Revoked key still resolves (honest attribution); another org's key and
    // an unknown id are simply absent.
    expect(names.get(mine.value.record.id)).toBe('ci bot');
    expect(names.has(theirs.value.record.id)).toBe(false);
    expect(names.has('unknown-id')).toBe(false);
  });

  it('returns an empty map for an empty id list', async () => {
    const s = setup();
    expect(await s.keys.namesByIds(s.owner.ctx, [])).toEqual(new Map());
  });
});

describe('actorForApiKey', () => {
  it('resolves a valid key to the identity it was created for', async () => {
    const s = setup();
    const created = await createApiKey(s.keys, s.owner, 'ci bot');
    if (!created.ok) throw new Error('setup');
    const actor = await actorForApiKey(s.keys, created.value.key);
    // The actor carries the key that authenticated it, for write attribution.
    expect(actor).toEqual({ ...s.owner, apiKeyId: created.value.record.id });
  });

  it('picks up the role the identity lookup reports', async () => {
    const s = setup();
    s.world.userRoles.set(s.admin.ctx.userId, 'admin');
    const created = await createApiKey(s.keys, s.admin, 'admin key');
    if (!created.ok) throw new Error('setup');
    const actor = await actorForApiKey(s.keys, created.value.key);
    expect(actor?.role).toBe('admin');
  });

  it('rejects malformed, unknown and revoked keys', async () => {
    const s = setup();
    expect(await actorForApiKey(s.keys, 'not-a-vorlyn-key')).toBeUndefined();
    expect(await actorForApiKey(s.keys, `${API_KEY_PREFIX}bogus`)).toBeUndefined();

    const created = await createApiKey(s.keys, s.owner, 'ci bot');
    if (!created.ok) throw new Error('setup');
    await revokeApiKey(s.keys, s.owner, created.value.record.id);
    expect(await actorForApiKey(s.keys, created.value.key)).toBeUndefined();
  });
});

describe('guest containment (Phase 24)', () => {
  it('refuses to mint a key for a guest actor', async () => {
    const s = setup();
    const guest: Actor = { ctx: { orgId: s.org.id, userId: 'g1' as UserId }, role: 'guest' };
    const result = await createApiKey(s.keys, guest, 'sneaky');
    expect(!result.ok && result.error.code).toBe('forbidden');
  });

  it('refuses to resolve an actor for a key whose owner became a guest', async () => {
    const s = setup();
    const created = await createApiKey(s.keys, s.owner, 'ci bot');
    if (!created.ok) throw new Error('setup');
    // Owner demoted to guest after the key was minted: the key dies at the
    // MCP chokepoint even though the row itself is not revoked.
    s.world.userRoles.set(s.owner.ctx.userId, 'guest');
    expect(await actorForApiKey(s.keys, created.value.key)).toBeUndefined();
  });
});
