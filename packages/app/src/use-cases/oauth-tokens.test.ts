import { describe, expect, it } from 'vitest';
import { FakeDirectoryRepository, FakeWorld } from '../test-support/fakes.js';
import type { OAuthTokenVerifierPort } from '../ports/oauth-verifier.port.js';
import { actorForOAuthToken } from './oauth-tokens.js';

/** Maps presented tokens to the `sub` claim they'd carry — a minimal fake of
 * the port, same style as this file's Fake* repositories. */
class FakeOAuthTokenVerifier implements OAuthTokenVerifierPort {
  constructor(private readonly subjectByToken: Map<string, string>) {}

  verify(token: string): Promise<{ readonly sub: string } | undefined> {
    const sub = this.subjectByToken.get(token);
    return Promise.resolve(sub ? { sub } : undefined);
  }
}

function setup() {
  const world = new FakeWorld();
  const org = world.org();
  const directory = new FakeDirectoryRepository(world);
  const user = world.addUser(org.id, {
    workosUserId: 'wos_alice',
    email: 'alice@acme.test',
    displayName: 'Alice',
    role: 'member',
  });
  const verifier = new FakeOAuthTokenVerifier(new Map([['valid-token', user.workosUserId]]));
  return { world, org, directory, user, verifier };
}

describe('actorForOAuthToken', () => {
  it('resolves a valid token to the identity WorkOS attests', async () => {
    const s = setup();
    const actor = await actorForOAuthToken(s.directory, s.verifier, 'valid-token');
    expect(actor).toEqual({ ctx: { orgId: s.org.id, userId: s.user.id }, role: 'member' });
  });

  it('picks up whatever role the directory reports, and sets no apiKeyId', async () => {
    const s = setup();
    const admin = s.world.addUser(s.org.id, {
      workosUserId: 'wos_admin',
      email: 'admin@acme.test',
      displayName: 'Admin',
      role: 'admin',
    });
    const verifier = new FakeOAuthTokenVerifier(new Map([['admin-token', admin.workosUserId]]));
    const actor = await actorForOAuthToken(s.directory, verifier, 'admin-token');
    expect(actor?.role).toBe('admin');
    expect(actor?.apiKeyId).toBeUndefined();
  });

  it('rejects a token the verifier does not recognize', async () => {
    const s = setup();
    expect(await actorForOAuthToken(s.directory, s.verifier, 'unknown-token')).toBeUndefined();
  });

  it('rejects a verified token whose subject has no mdloop user', async () => {
    const s = setup();
    const verifier = new FakeOAuthTokenVerifier(new Map([['orphan-token', 'wos_nobody']]));
    expect(await actorForOAuthToken(s.directory, verifier, 'orphan-token')).toBeUndefined();
  });
});

describe('guest containment (Phase 24)', () => {
  it('refuses to resolve an actor for a guest subject', async () => {
    const s = setup();
    const guest = s.world.addUser(s.org.id, {
      workosUserId: 'wos_guest',
      email: 'guest@client.test',
      displayName: 'Guest',
      role: 'guest',
    });
    const verifier = new FakeOAuthTokenVerifier(new Map([['guest-token', guest.workosUserId]]));
    expect(await actorForOAuthToken(s.directory, verifier, 'guest-token')).toBeUndefined();
  });

  it('refuses to resolve an actor for a user demoted to guest after the token was issued', async () => {
    const s = setup();
    // Same shape as the API-key sibling test: the WorkOS subject is still
    // valid and still maps to a mdloop user, but that user's role now reads
    // guest — the MCP chokepoint refuses even though nothing about the token
    // itself changed.
    s.world.userRoles.set(s.user.id, 'guest');
    s.world.users.set(s.user.id, { ...s.user, role: 'guest' });
    expect(await actorForOAuthToken(s.directory, s.verifier, 'valid-token')).toBeUndefined();
  });
});
