import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PgDirectoryRepository } from '@vorlyn/persistence';
import type { OrgId } from '@vorlyn/shared';
import { SESSION_TTL_MS, decodeSession, encodeSession } from './auth/session.js';
import { createTestServer, loginAs, testConfig } from './test-support/test-server.js';
import type { TestServer } from './test-support/test-server.js';

/** Session cookie for a directly-provisioned user (bypasses the login flow). */
function sessionFor(userId: string, orgId: string, role: 'admin' | 'member'): string {
  const iat = Date.now();
  return encodeSession(
    { userId, orgId, role, iat, exp: iat + SESSION_TTL_MS },
    testConfig.sessionSecret,
  );
}

describe('sharing API', () => {
  let ts: TestServer;
  let server: FastifyInstance;
  let owner: string; // org A admin (first sign-in)
  let peer: string; // org A member, provisioned directly
  let outsider: string; // org B
  let documentId: string;

  beforeAll(async () => {
    ts = await createTestServer();
    server = ts.server;
    owner = await loginAs(server, 'share-owner');
    outsider = await loginAs(server, 'share-outsider');

    const ownerSession = decodeSession(owner, [testConfig.sessionSecret])?.payload;
    if (!ownerSession) throw new Error('bad owner session');
    // Phase 33: link/directory sharing now requires a paid tier
    // (sharing_requires_paid_tier on free) — this suite is about sharing
    // mechanics (token redemption, cross-org isolation, permission levels),
    // not the free-tier gate itself, so bump off free once up front.
    await ts.db.pool.query('update organizations set tier = $1 where id = $2', [
      'team',
      ownerSession.orgId,
    ]);
    const directory = new PgDirectoryRepository(ts.db.pool);
    const peerUser = await directory.createUser(ownerSession.orgId as OrgId, {
      workosUserId: 'wos_share_peer',
      email: 'peer@share.test',
      displayName: 'Peer',
      role: 'member',
    });
    peer = sessionFor(peerUser.id, ownerSession.orgId, 'member');

    const upload = await server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { vorlyn_session: owner },
      payload: { title: 'shared.md', content: '# Shared\n\nOnly for the chosen.' },
    });
    documentId = upload.json<{ document: { id: string } }>().document.id;
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  /** `url` is the bare app-relative path — every caller here is a real /api-mounted route. */
  function inject(
    session: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) {
    return server.inject({
      method,
      url: `/api${url}`,
      cookies: { vorlyn_session: session },
      ...(payload ? { payload } : {}),
    });
  }

  it('non-granted org members cannot see or read the document', async () => {
    const list = await inject(peer, 'GET', '/documents');
    expect(list.json<{ documents: { id: string }[] }>().documents.map((d) => d.id)).not.toContain(
      documentId,
    );
    expect((await inject(peer, 'GET', `/documents/${documentId}`)).statusCode).toBe(404);
    expect((await inject(peer, 'GET', `/documents/${documentId}/content`)).statusCode).toBe(404);
    expect((await inject(peer, 'GET', `/documents/${documentId}/comments`)).statusCode).toBe(404);
  });

  it('share link: owner mints token once; peer redeems; read works, comment blocked for read grant', async () => {
    const created = await inject(owner, 'POST', `/documents/${documentId}/shares`, {
      type: 'link',
      permission: 'read',
    });
    expect(created.statusCode).toBe(201);
    const { token } = created.json<{ token: string }>();
    expect(token.length).toBeGreaterThan(20);

    // Listing grants never exposes the token.
    const listed = await inject(owner, 'GET', `/documents/${documentId}/shares`);
    expect(JSON.stringify(listed.json())).not.toContain(token);

    // Peer redeems, then reads.
    const redeemed = await inject(peer, 'POST', '/shares/redeem', { token });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json()).toMatchObject({ documentId, permission: 'read' });

    const doc = await inject(peer, 'GET', `/documents/${documentId}`);
    expect(doc.statusCode).toBe(200);
    expect(doc.json()).toMatchObject({ myPermission: 'read' });
    expect((await inject(peer, 'GET', `/documents/${documentId}/content`)).statusCode).toBe(200);

    // Read grant cannot comment or reply.
    const comment = await inject(peer, 'POST', `/documents/${documentId}/comments`, {
      body: 'sneaky',
      anchor: { type: 'document' },
    });
    expect(comment.statusCode).toBe(404);

    // And never edit: version upload stays forbidden.
    const version = await inject(peer, 'POST', `/documents/${documentId}/versions`, {
      content: 'hostile edit',
    });
    expect([403, 404]).toContain(version.statusCode);
  });

  it('a token from org A is useless in org B', async () => {
    const created = await inject(owner, 'POST', `/documents/${documentId}/shares`, {
      type: 'link',
      permission: 'comment',
    });
    const { token } = created.json<{ token: string }>();
    const res = await inject(outsider, 'POST', '/shares/redeem', { token });
    expect(res.statusCode).toBe(404);
    expect((await inject(outsider, 'GET', `/documents/${documentId}`)).statusCode).toBe(404);
  });

  it('directory mode: user grant confers comment; revocation cuts access', async () => {
    await inject(owner, 'POST', '/org/settings', undefined); // no-op sanity
    const toDirectory = await server.inject({
      method: 'PATCH',
      url: '/api/org/settings',
      cookies: { vorlyn_session: owner },
      payload: { sharingMode: 'directory' },
    });
    expect(toDirectory.statusCode).toBe(200);

    // Link creation now refused.
    const link = await inject(owner, 'POST', `/documents/${documentId}/shares`, {
      type: 'link',
      permission: 'read',
    });
    expect(link.statusCode).toBe(409);

    // Directory of org users is visible for the picker.
    const users = await inject(owner, 'GET', '/org/users');
    const peerEntry = users
      .json<{ users: { id: string; email: string }[] }>()
      .users.find((u) => u.email === 'peer@share.test');
    expect(peerEntry).toBeDefined();

    const granted = await inject(owner, 'POST', `/documents/${documentId}/shares`, {
      type: 'user',
      userId: peerEntry?.id,
      permission: 'comment',
    });
    expect(granted.statusCode).toBe(201);
    const grantId = granted.json<{ grant: { id: string } }>().grant.id;

    // Peer can now read AND comment (but resolve stays owner/admin).
    expect((await inject(peer, 'GET', `/documents/${documentId}`)).statusCode).toBe(200);
    const comment = await inject(peer, 'POST', `/documents/${documentId}/comments`, {
      body: 'granted comment',
      anchor: { type: 'document' },
    });
    expect(comment.statusCode).toBe(201);
    const commentId = comment.json<{ id: string }>().id;
    const reply = await inject(peer, 'POST', `/comments/${commentId}/replies`, {
      body: 'and reply',
    });
    expect(reply.statusCode).toBe(201);
    const resolve = await inject(peer, 'POST', `/comments/${commentId}/resolve`);
    expect(resolve.statusCode).toBe(403);

    // The granted document appears in the peer's list.
    const list = await inject(peer, 'GET', '/documents');
    expect(list.json<{ documents: { id: string }[] }>().documents.map((d) => d.id)).toContain(
      documentId,
    );

    // Revoke the comment grant: the peer drops back to the read grant
    // materialized by the earlier link redemption — commenting is gone.
    const revoked = await inject(owner, 'DELETE', `/documents/${documentId}/shares/${grantId}`);
    expect(revoked.statusCode).toBe(204);
    const afterDoc = await inject(peer, 'GET', `/documents/${documentId}`);
    expect(afterDoc.statusCode).toBe(200);
    expect(afterDoc.json()).toMatchObject({ myPermission: 'read' });
    const afterComment = await inject(peer, 'POST', `/documents/${documentId}/comments`, {
      body: 'no longer allowed',
      anchor: { type: 'document' },
    });
    expect(afterComment.statusCode).toBe(404);
  });

  it('members cannot manage shares on documents they do not own', async () => {
    const denied = await inject(peer, 'POST', `/documents/${documentId}/shares`, {
      type: 'user',
      userId: 'whoever',
      permission: 'read',
    });
    expect([403, 404]).toContain(denied.statusCode);
    const deniedList = await inject(peer, 'GET', `/documents/${documentId}/shares`);
    expect([403, 404]).toContain(deniedList.statusCode);
  });

  it('a share-permission grant, ADR 0014 delegation cap, and the renamed link refusal all round-trip over HTTP', async () => {
    // Directory mode: assumed already switched earlier in the suite, but
    // make it explicit and self-contained regardless of test order.
    const toDirectory = await inject(owner, 'PATCH', '/org/settings', {
      sharingMode: 'directory',
    });
    expect(toDirectory.statusCode).toBe(200);

    const directory = new PgDirectoryRepository(ts.db.pool);
    const ownerSession = decodeSession(owner, [testConfig.sessionSecret])?.payload;
    if (!ownerSession) throw new Error('bad owner session');
    const sharerUser = await directory.createUser(ownerSession.orgId as OrgId, {
      workosUserId: 'wos_share_sharer',
      email: 'sharer@share.test',
      displayName: 'Sharer',
      role: 'member',
    });
    const sharer = sessionFor(sharerUser.id, ownerSession.orgId, 'member');
    const thirdPartyUser = await directory.createUser(ownerSession.orgId as OrgId, {
      workosUserId: 'wos_share_third_party',
      email: 'third-party@share.test',
      displayName: 'Third Party',
      role: 'member',
    });

    // Owner grants `share` (not `edit`) to sharerUser.
    const shareGrant = await inject(owner, 'POST', `/documents/${documentId}/shares`, {
      type: 'user',
      userId: sharerUser.id,
      permission: 'share',
    });
    expect(shareGrant.statusCode, shareGrant.body).toBe(201);
    expect(shareGrant.json<{ grant: { permission: string } }>().grant.permission).toBe('share');

    // The share holder can now create a grant of their own, at or below
    // their own level...
    const bySharer = await inject(sharer, 'POST', `/documents/${documentId}/shares`, {
      type: 'user',
      userId: thirdPartyUser.id,
      permission: 'comment',
    });
    expect(bySharer.statusCode, bySharer.body).toBe(201);

    // ...and list grants.
    const listedBySharer = await inject(sharer, 'GET', `/documents/${documentId}/shares`);
    expect(listedBySharer.statusCode).toBe(200);

    // ...but is refused delegating past their own held level (ADR 0014).
    const overreach = await inject(sharer, 'POST', `/documents/${documentId}/shares`, {
      type: 'user',
      userId: thirdPartyUser.id,
      permission: 'edit',
    });
    expect(overreach.statusCode, overreach.body).toBe(403);
    expect(overreach.json<{ error: string }>().error).toBe('grant_exceeds_own_permission');

    // The renamed link refusal fires for both share and edit on a link,
    // regardless of directory/link mode — the type-level cap runs first.
    const linkShare = await inject(owner, 'POST', `/documents/${documentId}/shares`, {
      type: 'link',
      permission: 'share',
    });
    expect(linkShare.statusCode).toBe(400);
    expect(linkShare.json<{ error: string }>().error).toBe('permission_not_grantable_by_link');
    const linkEdit = await inject(owner, 'POST', `/documents/${documentId}/shares`, {
      type: 'link',
      permission: 'edit',
    });
    expect(linkEdit.statusCode).toBe(400);
    expect(linkEdit.json<{ error: string }>().error).toBe('permission_not_grantable_by_link');

    // The sharer can revoke the grant they created themselves...
    const bySharerId = bySharer.json<{ grant: { id: string } }>().grant.id;
    const revokedOwn = await inject(
      sharer,
      'DELETE',
      `/documents/${documentId}/shares/${bySharerId}`,
    );
    expect(revokedOwn.statusCode).toBe(204);

    // ...but not the owner's own grant to the sharer.
    const shareGrantId = shareGrant.json<{ grant: { id: string } }>().grant.id;
    const revokedPeer = await inject(
      sharer,
      'DELETE',
      `/documents/${documentId}/shares/${shareGrantId}`,
    );
    expect(revokedPeer.statusCode).toBe(403);
  });

  it('member-list emails follow sharing_mode; admins always see them (Phase 24)', async () => {
    // The suite left the org in directory mode above; assert, then flip.
    const asMemberDirectory = await inject(peer, 'GET', '/org/users');
    expect(asMemberDirectory.statusCode).toBe(200);
    const directoryUsers = asMemberDirectory.json<{
      users: { email: string | null; role: string }[];
    }>().users;
    expect(directoryUsers.some((u) => u.email !== null)).toBe(true);
    // Role travels regardless of sharing_mode (Phase 39.C: the Members table
    // needs it to render/change it) and a guest never appears here at all —
    // listUsersPage excludes them at the query.
    expect(directoryUsers.every((u) => u.role === 'admin' || u.role === 'member')).toBe(true);

    const toLink = await inject(owner, 'PATCH', '/org/settings', { sharingMode: 'link' });
    expect(toLink.statusCode).toBe(200);

    // Link mode: members get display names only; the admin still sees emails.
    const asMemberLink = await inject(peer, 'GET', '/org/users');
    expect(
      asMemberLink
        .json<{ users: { email: string | null }[] }>()
        .users.every((u) => u.email === null),
    ).toBe(true);
    const asAdminLink = await inject(owner, 'GET', '/org/users');
    expect(
      asAdminLink.json<{ users: { email: string | null }[] }>().users.some((u) => u.email !== null),
    ).toBe(true);
  });

  it('member list paginates keyset and filters by prefix (Phase 24)', async () => {
    const page = await inject(owner, 'GET', '/org/users?limit=1');
    const body = page.json<{ users: { id: string }[]; nextCursor: string | null }>();
    expect(body.users).toHaveLength(1);
    expect(body.nextCursor).not.toBeNull();
    const rest = await inject(
      owner,
      'GET',
      `/org/users?limit=50&cursor=${encodeURIComponent(body.nextCursor ?? '')}`,
    );
    const restBody = rest.json<{ users: { id: string }[]; nextCursor: string | null }>();
    expect(restBody.users.length).toBeGreaterThanOrEqual(1);
    expect(restBody.users.some((u) => u.id === body.users[0]?.id)).toBe(false);

    const searched = await inject(owner, 'GET', '/org/users?q=peer');
    const hits = searched.json<{ users: { email: string | null }[] }>().users;
    expect(hits).toHaveLength(1);
    expect(hits[0]?.email).toBe('peer@share.test');
  });
});

describe('guest link redeem: does not strand an already-authenticated reader in guest mode', () => {
  let ts: TestServer;
  let server: FastifyInstance;
  let owner: string; // doc owner/admin
  let peer: string; // org member, no grant on the document
  let documentId: string;
  let guestToken: string;

  beforeAll(async () => {
    ts = await createTestServer();
    server = ts.server;
    owner = await loginAs(server, 'guest-redeem-owner');

    const ownerSession = decodeSession(owner, [testConfig.sessionSecret])?.payload;
    if (!ownerSession) throw new Error('bad owner session');
    // Phase 33: free tier's external-guest ceiling dropped to 0, so creating
    // a guest share at all now requires a paid tier — bump off free before
    // this suite's guest-redeem mechanics (not the tier gate) run.
    await ts.db.pool.query('update organizations set tier = $1 where id = $2', [
      'team',
      ownerSession.orgId,
    ]);
    const directory = new PgDirectoryRepository(ts.db.pool);
    const peerUser = await directory.createUser(ownerSession.orgId as OrgId, {
      workosUserId: 'wos_guest_redeem_peer',
      email: 'peer@guest-redeem.test',
      displayName: 'Peer',
      role: 'member',
    });
    peer = sessionFor(peerUser.id, ownerSession.orgId, 'member');

    const upload = await server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { vorlyn_session: owner },
      payload: { title: 'handoff.md', content: '# Handoff\n\nFor the guest.' },
    });
    documentId = upload.json<{ document: { id: string } }>().document.id;

    const share = await server.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/guest-shares`,
      cookies: { vorlyn_session: owner },
      payload: { email: 'ext@client.test', permission: 'comment', days: 7 },
    });
    expect(share.statusCode).toBe(201);
    guestToken = share.json<{ token: string }>().token;
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  it('the owner redeeming their own link keeps their own session', async () => {
    const redeemed = await server.inject({
      method: 'POST',
      url: '/api/guest/redeem',
      cookies: { vorlyn_session: owner },
      payload: { token: guestToken },
    });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json()).toMatchObject({ documentId });
    // No Set-Cookie: the existing (non-guest) session was left alone.
    expect(redeemed.cookies).toHaveLength(0);

    // The original session cookie still works as the owner, not as a guest.
    const me = await server.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { vorlyn_session: owner },
    });
    expect(me.json()).toMatchObject({ role: 'admin' });
  });

  it('a session-less redeem still mints a capped guest session', async () => {
    const redeemed = await server.inject({
      method: 'POST',
      url: '/api/guest/redeem',
      payload: { token: guestToken },
    });
    expect(redeemed.statusCode).toBe(200);
    const sessionCookie = redeemed.cookies.find((c) => c.name === 'vorlyn_session');
    expect(sessionCookie).toBeDefined();
    const guestSession = decodeSession(sessionCookie?.value ?? '', [
      testConfig.sessionSecret,
    ])?.payload;
    expect(guestSession?.role).toBe('guest');
  });

  it('an org member without access to the document still gets downgraded to guest', async () => {
    // The peer has no grant on this document, so their own session can't
    // read it — the guest token is still the only way in for them.
    expect(
      (
        await server.inject({
          method: 'GET',
          url: `/api/documents/${documentId}`,
          cookies: { vorlyn_session: peer },
        })
      ).statusCode,
    ).toBe(404);

    const redeemed = await server.inject({
      method: 'POST',
      url: '/api/guest/redeem',
      cookies: { vorlyn_session: peer },
      payload: { token: guestToken },
    });
    expect(redeemed.statusCode).toBe(200);
    const sessionCookie = redeemed.cookies.find((c) => c.name === 'vorlyn_session');
    expect(sessionCookie).toBeDefined();
    const guestSession = decodeSession(sessionCookie?.value ?? '', [
      testConfig.sessionSecret,
    ])?.payload;
    expect(guestSession?.role).toBe('guest');
  });
});

/**
 * Phase 33: personal (free) orgs cannot share a document with anyone in any
 * form — `createShareLink` refuses with `sharing_requires_paid_tier` before
 * even reaching the sharing-mode check. HTTP-level coverage that this maps
 * to 403 via `share-routes.ts`'s `errorStatus` map, on a plain new org that
 * is on the free tier by default (no explicit setTier needed).
 */
describe('share link creation requires a paid tier (Phase 33)', () => {
  let ts: TestServer;
  let server: FastifyInstance;

  beforeAll(async () => {
    ts = await createTestServer();
    server = ts.server;
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  it('403s "sharing_requires_paid_tier" creating a share link on a free-tier org', async () => {
    const owner = await loginAs(server, 'free-tier-share-owner');
    const upload = await server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { vorlyn_session: owner },
      payload: { title: 'solo.md', content: '# Solo\n\nNobody to share with on free.' },
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const documentId = upload.json<{ document: { id: string } }>().document.id;

    const res = await server.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/shares`,
      cookies: { vorlyn_session: owner },
      payload: { type: 'link', permission: 'read' },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('sharing_requires_paid_tier');
  });
});
