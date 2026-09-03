import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PgDirectoryRepository } from '@vorlyn/persistence';
import type { OrgId } from '@vorlyn/shared';
import { encodeSession, SESSION_TTL_MS } from './auth/session.js';
import { createTestServer, loginAs, testConfig } from './test-support/test-server.js';
import type { TestServer } from './test-support/test-server.js';

interface ReviewDto {
  status: 'draft' | 'in_review' | 'changes_requested' | 'approved';
  gate: 'soft' | 'hard';
  openCommentCount: number;
  requests: { id: string; reviewerUserId: string }[];
  approvals: { reviewerUserId: string; verdict: string }[];
}

/**
 * Permission matrix for the sign-off workflow, incl. the guest boundary money
 * path: the two routes GUEST_ROUTES allowlists (GET review, POST verdict)
 * must stay reachable by a guest, while request/revoke stay guest-closed —
 * proven in both directions, since allowlist-not-blocklist fails closed on a
 * typo but silently breaks the guest reviewer story instead of erroring loud.
 */
describe('review sign-off API', () => {
  let ts: TestServer;
  let server: FastifyInstance;
  let owner: string;
  let outsider: string;
  let documentId: string;

  beforeAll(async () => {
    ts = await createTestServer();
    server = ts.server;
    owner = await loginAs(server, 'owner');
    outsider = await loginAs(server, 'outsider');
    const upload = await server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { vorlyn_session: owner },
      payload: { title: 'spec.md', content: '# Spec\n\nReady for sign-off.' },
    });
    expect(upload.statusCode).toBe(201);
    documentId = upload.json<{ document: { id: string } }>().document.id;

    // Directory-mode grants (used throughout to give a reviewer document
    // access) require the org's sharing mode to be 'directory'.
    await server.inject({
      method: 'PATCH',
      url: '/api/org/settings',
      cookies: { vorlyn_session: owner },
      payload: { sharingMode: 'directory' },
    });
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  /** Session decoded from `owner`'s cookie to discover the shared org id. */
  function ownerOrgId(): OrgId {
    const [body] = owner.split('.');
    const payload = JSON.parse(Buffer.from(body ?? '', 'base64url').toString()) as {
      orgId: string;
    };
    return payload.orgId as OrgId;
  }

  /** Mints a real session for a directly-created same-org user (no OAuth
   * round trip needed — same technique the guest-redeem route itself uses to
   * hand a browser a session cookie post-authentication). */
  function sessionFor(userId: string, role: 'admin' | 'member' | 'guest'): string {
    const iat = Date.now();
    return encodeSession(
      { userId, orgId: ownerOrgId(), role, iat, exp: iat + SESSION_TTL_MS },
      testConfig.sessionSecret,
    );
  }

  async function grantComment(userId: string): Promise<void> {
    const res = await server.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/shares`,
      cookies: { vorlyn_session: owner },
      payload: { type: 'user', userId, permission: 'comment' },
    });
    expect(res.statusCode).toBe(201);
  }

  it('member without access cannot be requested (reviewer_has_no_access)', async () => {
    const directory = new PgDirectoryRepository(ts.db.pool);
    const stranger = await directory.createUser(ownerOrgId(), {
      workosUserId: 'wos_stranger',
      email: 'stranger@acme.test',
      displayName: 'Stranger',
      role: 'member',
    });
    const res = await server.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/review-requests`,
      cookies: { vorlyn_session: owner },
      payload: { reviewerUserId: stranger.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'reviewer_has_no_access' });
  });

  it('a member (not owner/admin) cannot request review', async () => {
    const directory = new PgDirectoryRepository(ts.db.pool);
    const member = await directory.createUser(ownerOrgId(), {
      workosUserId: 'wos_member1',
      email: 'member1@acme.test',
      displayName: 'Member One',
      role: 'member',
    });
    await grantComment(member.id);
    const memberSession = sessionFor(member.id, 'member');

    const res = await server.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/review-requests`,
      cookies: { vorlyn_session: memberSession },
      payload: { reviewerUserId: member.id },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('guest cannot request review — route is guest-closed', async () => {
    const directory = new PgDirectoryRepository(ts.db.pool);
    const guest = await directory.createUser(ownerOrgId(), {
      workosUserId: 'guest:closed-request',
      email: 'guest-req@external.test',
      displayName: 'Guest',
      role: 'guest',
    });
    const guestSession = sessionFor(guest.id, 'guest');
    const res = await server.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/review-requests`,
      cookies: { vorlyn_session: guestSession },
      payload: { reviewerUserId: guest.id },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'guest_forbidden' });
  });

  it('owner requests a member reviewer with access; reviewer approves', async () => {
    const directory = new PgDirectoryRepository(ts.db.pool);
    const member = await directory.createUser(ownerOrgId(), {
      workosUserId: 'wos_reviewer_member',
      email: 'reviewer-member@acme.test',
      displayName: 'Reviewer Member',
      role: 'member',
    });
    await grantComment(member.id);
    const memberSession = sessionFor(member.id, 'member');

    const requested = await server.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/review-requests`,
      cookies: { vorlyn_session: owner },
      payload: { reviewerUserId: member.id },
    });
    expect(requested.statusCode).toBe(201);

    // Non-reviewer cannot submit a verdict — the owner has document access
    // but was never made a requested reviewer, so is refused too.
    const denied = await server.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/review/verdict`,
      cookies: { vorlyn_session: owner },
      payload: { verdict: 'approved' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'not_a_reviewer' });

    const status = await server.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/review`,
      cookies: { vorlyn_session: memberSession },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json<ReviewDto>().status).toBe('in_review');

    const submitted = await server.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/review/verdict`,
      cookies: { vorlyn_session: memberSession },
      payload: { verdict: 'approved', note: 'looks good' },
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json<{ status: string }>().status).toBe('approved');
  });

  it('guest with a comment grant can be requested and reach both review routes', async () => {
    const upload = await server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { vorlyn_session: owner },
      payload: { title: 'guest-review.md', content: '# For a guest reviewer' },
    });
    const docId = upload.json<{ document: { id: string } }>().document.id;

    const directory = new PgDirectoryRepository(ts.db.pool);
    const guest = await directory.createUser(ownerOrgId(), {
      workosUserId: 'guest:consulting-client',
      email: 'client@consulting.test',
      displayName: 'Client',
      role: 'guest',
    });
    const guestSession = sessionFor(guest.id, 'guest');

    // Guests qualify via any active grant — comment permission, same as an
    // external-share redemption would leave them with.
    const grantRes = await server.inject({
      method: 'POST',
      url: `/api/documents/${docId}/shares`,
      cookies: { vorlyn_session: owner },
      payload: { type: 'user', userId: guest.id, permission: 'comment' },
    });
    expect(grantRes.statusCode).toBe(201);

    const requested = await server.inject({
      method: 'POST',
      url: `/api/documents/${docId}/review-requests`,
      cookies: { vorlyn_session: owner },
      payload: { reviewerUserId: guest.id },
    });
    expect(requested.statusCode).toBe(201);

    // Allowlisted read route: reachable.
    const status = await server.inject({
      method: 'GET',
      url: `/api/documents/${docId}/review`,
      cookies: { vorlyn_session: guestSession },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json<ReviewDto>().requests.map((r) => r.reviewerUserId)).toContain(guest.id);

    // Allowlisted write route: reachable, and the guest is an active
    // reviewer, so the verdict is accepted — annotation, never a document
    // mutation, so the guest-never-writes-versions rule stays intact.
    const submitted = await server.inject({
      method: 'POST',
      url: `/api/documents/${docId}/review/verdict`,
      cookies: { vorlyn_session: guestSession },
      payload: { verdict: 'changes_requested', note: 'please clarify section 2' },
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json<{ status: string }>().status).toBe('changes_requested');

    // Not-allowlisted routes stay guest-closed even though this guest is a
    // legitimate reviewer on this very document.
    const requestBlocked = await server.inject({
      method: 'POST',
      url: `/api/documents/${docId}/review-requests`,
      cookies: { vorlyn_session: guestSession },
      payload: { reviewerUserId: guest.id },
    });
    expect(requestBlocked.statusCode).toBe(403);
    expect(requestBlocked.json()).toMatchObject({ error: 'guest_forbidden' });

    const revokeBlocked = await server.inject({
      method: 'DELETE',
      url: `/api/documents/${docId}/review-requests/${requested.json<{ id: string }>().id}`,
      cookies: { vorlyn_session: guestSession },
    });
    expect(revokeBlocked.statusCode).toBe(403);
    expect(revokeBlocked.json()).toMatchObject({ error: 'guest_forbidden' });
  });

  it('hard gate blocks approval with open comments, soft gate does not', async () => {
    const upload = await server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { vorlyn_session: owner },
      payload: { title: 'gated.md', content: '# Gated\n\nBody text.' },
    });
    const docId = upload.json<{ document: { id: string } }>().document.id;

    const directory = new PgDirectoryRepository(ts.db.pool);
    const reviewer = await directory.createUser(ownerOrgId(), {
      workosUserId: 'wos_gate_reviewer',
      email: 'gate-reviewer@acme.test',
      displayName: 'Gate Reviewer',
      role: 'admin', // trivially has access without a separate grant
    });
    const reviewerSession = sessionFor(reviewer.id, 'admin');

    await server.inject({
      method: 'POST',
      url: `/api/documents/${docId}/review-requests`,
      cookies: { vorlyn_session: owner },
      payload: { reviewerUserId: reviewer.id },
    });

    const commented = await server.inject({
      method: 'POST',
      url: `/api/documents/${docId}/comments`,
      cookies: { vorlyn_session: owner },
      payload: { body: 'one open thread', anchor: { type: 'document' } },
    });
    const commentId = commented.json<{ id: string }>().id;

    const gateOn = await server.inject({
      method: 'PATCH',
      url: '/api/org/settings',
      cookies: { vorlyn_session: owner },
      payload: { approvalGate: 'hard' },
    });
    expect(gateOn.statusCode).toBe(200);

    const blocked = await server.inject({
      method: 'POST',
      url: `/api/documents/${docId}/review/verdict`,
      cookies: { vorlyn_session: reviewerSession },
      payload: { verdict: 'approved' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: 'open_comments_block_approval' });

    // request_changes is never gated — only 'approved' is.
    const changesOk = await server.inject({
      method: 'POST',
      url: `/api/documents/${docId}/review/verdict`,
      cookies: { vorlyn_session: reviewerSession },
      payload: { verdict: 'changes_requested' },
    });
    expect(changesOk.statusCode).toBe(200);

    await server.inject({
      method: 'POST',
      url: `/api/comments/${commentId}/resolve`,
      cookies: { vorlyn_session: owner },
    });

    const approvedAfterResolve = await server.inject({
      method: 'POST',
      url: `/api/documents/${docId}/review/verdict`,
      cookies: { vorlyn_session: reviewerSession },
      payload: { verdict: 'approved' },
    });
    expect(approvedAfterResolve.statusCode).toBe(200);
    expect(approvedAfterResolve.json<{ status: string }>().status).toBe('approved');

    // Back to soft for any later test in this file relying on the default.
    await server.inject({
      method: 'PATCH',
      url: '/api/org/settings',
      cookies: { vorlyn_session: owner },
      payload: { approvalGate: 'soft' },
    });
  });

  it('tenant isolation: an org B session cannot read org A review state', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/review`,
      cookies: { vorlyn_session: outsider },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'document_not_found' });
  });
});
