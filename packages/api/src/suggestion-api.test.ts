import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PgDirectoryRepository } from '@mdloop/persistence';
import { createTextAnchor } from '@mdloop/domain';
import type { Anchor } from '@mdloop/domain';
import type { OrgId } from '@mdloop/shared';
import { encodeSession, SESSION_TTL_MS } from './auth/session.js';
import { createTestServer, loginAs, testConfig } from './test-support/test-server.js';
import type { TestServer } from './test-support/test-server.js';

interface CommentDto {
  id: string;
  kind: 'comment' | 'suggestion';
  proposedText: string | null;
  suggestionOutcome: 'open' | 'accepted' | 'rejected' | null;
  appliedVersionId: string | null;
}

const DOC = '# Spec\n\nThis is a draft ready for review.';

/**
 * Suggested-edits permission matrix over HTTP, incl. the guest-boundary money
 * path: creating a suggestion rides the already-allowlisted POST comments
 * route (a guest may), while accept/reject are NOT allowlisted (a guest is
 * guest_forbidden before the owner/admin check is even reached) — proven in
 * both directions, plus the owner accept happy path and the honesty refusals.
 */
describe('suggested edits API', () => {
  let ts: TestServer;
  let server: FastifyInstance;
  let owner: string;

  beforeAll(async () => {
    ts = await createTestServer();
    server = ts.server;
    owner = await loginAs(server, 'owner');
    // Directory-mode grants require the org's sharing mode to be 'directory'.
    await server.inject({
      method: 'PATCH',
      url: '/api/org/settings',
      cookies: { mdloop_session: owner },
      payload: { sharingMode: 'directory' },
    });
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  function ownerOrgId(): OrgId {
    const [body] = owner.split('.');
    const payload = JSON.parse(Buffer.from(body ?? '', 'base64url').toString()) as {
      orgId: string;
    };
    return payload.orgId as OrgId;
  }

  function sessionFor(userId: string, role: 'admin' | 'member' | 'guest'): string {
    const iat = Date.now();
    return encodeSession(
      { userId, orgId: ownerOrgId(), role, iat, exp: iat + SESSION_TTL_MS },
      testConfig.sessionSecret,
    );
  }

  /** A fresh document seeded with DOC, so accept-mutating tests never collide. */
  async function freshDoc(content = DOC): Promise<string> {
    const upload = await server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { mdloop_session: owner },
      payload: { title: 'spec.md', content },
    });
    expect(upload.statusCode).toBe(201);
    return upload.json<{ document: { id: string } }>().document.id;
  }

  function anchorFor(quote: string, source = DOC): Anchor {
    const start = source.indexOf(quote);
    return createTextAnchor(source, start, start + quote.length);
  }

  async function grantComment(documentId: string, userId: string): Promise<void> {
    const res = await server.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/shares`,
      cookies: { mdloop_session: owner },
      payload: { type: 'user', userId, permission: 'comment' },
    });
    expect(res.statusCode).toBe(201);
  }

  async function makeSuggestion(
    documentId: string,
    session: string,
    quote: string,
    replacement: string,
  ): Promise<CommentDto> {
    const res = await server.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/comments`,
      cookies: { mdloop_session: session },
      payload: { body: `replace "${quote}"`, anchor: anchorFor(quote), proposedText: replacement },
    });
    expect(res.statusCode).toBe(201);
    return res.json<CommentDto>();
  }

  it('owner accepts a suggestion — the outcome flips, the document is untouched (ADR 0007)', async () => {
    const docId = await freshDoc();
    const suggestion = await makeSuggestion(docId, owner, 'draft', 'final');
    expect(suggestion.kind).toBe('suggestion');
    expect(suggestion.suggestionOutcome).toBe('open');

    const accepted = await server.inject({
      method: 'POST',
      url: `/api/comments/${suggestion.id}/accept`,
      cookies: { mdloop_session: owner },
    });
    expect(accepted.statusCode).toBe(200);
    const body = accepted.json<{ comment: CommentDto }>();
    expect(body.comment.suggestionOutcome).toBe('accepted');
    // Metadata-only: accept never mints a version, so nothing is applied yet.
    expect(body.comment.appliedVersionId).toBeNull();
    expect(Object.keys(body)).toEqual(['comment']);

    const content = await server.inject({
      method: 'GET',
      url: `/api/documents/${docId}/content`,
      cookies: { mdloop_session: owner },
    });
    expect(content.body).toContain('draft');
    expect(content.body).not.toContain('final');
  });

  it('owner rejects a suggestion', async () => {
    const docId = await freshDoc();
    const suggestion = await makeSuggestion(docId, owner, 'draft', 'final');
    const rejected = await server.inject({
      method: 'POST',
      url: `/api/comments/${suggestion.id}/reject`,
      cookies: { mdloop_session: owner },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json<CommentDto>().suggestionOutcome).toBe('rejected');
  });

  it('a guest may create a suggestion but is guest_forbidden on accept and reject', async () => {
    const docId = await freshDoc();
    const directory = new PgDirectoryRepository(ts.db.pool);
    const guest = await directory.createUser(ownerOrgId(), {
      workosUserId: 'guest:suggester',
      email: 'guest-suggest@external.test',
      displayName: 'Guest',
      role: 'guest',
    });
    await grantComment(docId, guest.id);
    const guestSession = sessionFor(guest.id, 'guest');

    // Creating a suggestion is just commenting — the allowlisted route.
    const created = await makeSuggestion(docId, guestSession, 'draft', 'final');
    expect(created.kind).toBe('suggestion');

    // Accept/reject are not in GUEST_ROUTES: 403 guest_forbidden, before the
    // owner/admin check is even reached (defense-in-depth, both layers).
    const acceptBlocked = await server.inject({
      method: 'POST',
      url: `/api/comments/${created.id}/accept`,
      cookies: { mdloop_session: guestSession },
    });
    expect(acceptBlocked.statusCode).toBe(403);
    expect(acceptBlocked.json()).toMatchObject({ error: 'guest_forbidden' });

    const rejectBlocked = await server.inject({
      method: 'POST',
      url: `/api/comments/${created.id}/reject`,
      cookies: { mdloop_session: guestSession },
    });
    expect(rejectBlocked.statusCode).toBe(403);
    expect(rejectBlocked.json()).toMatchObject({ error: 'guest_forbidden' });
  });

  it('a plain member (not owner/admin) reaches the use-case and is forbidden', async () => {
    const docId = await freshDoc();
    const directory = new PgDirectoryRepository(ts.db.pool);
    const member = await directory.createUser(ownerOrgId(), {
      workosUserId: 'wos_suggest_member',
      email: 'suggest-member@acme.test',
      displayName: 'Member',
      role: 'member',
    });
    await grantComment(docId, member.id);
    const suggestion = await makeSuggestion(docId, owner, 'draft', 'final');

    const res = await server.inject({
      method: 'POST',
      url: `/api/comments/${suggestion.id}/accept`,
      cookies: { mdloop_session: sessionFor(member.id, 'member') },
    });
    // Not guest_forbidden — the route is reachable, the use-case check refuses.
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('a second accept on a resolved suggestion is 409 suggestion_not_open', async () => {
    const docId = await freshDoc();
    const suggestion = await makeSuggestion(docId, owner, 'draft', 'final');
    const first = await server.inject({
      method: 'POST',
      url: `/api/comments/${suggestion.id}/accept`,
      cookies: { mdloop_session: owner },
    });
    expect(first.statusCode).toBe(200);
    const second = await server.inject({
      method: 'POST',
      url: `/api/comments/${suggestion.id}/accept`,
      cookies: { mdloop_session: owner },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'suggestion_not_open' });
  });

  it('accepting succeeds even when the anchored text has since changed — nothing is spliced, so nothing can be guessed', async () => {
    const docId = await freshDoc();
    const suggestion = await makeSuggestion(docId, owner, 'draft', 'final');
    // A new version erases the anchored text and its context — under the old
    // (pre-ADR-0007) behavior this would refuse with suggestion_unanchored;
    // now accept never reads document content, so an unresolvable anchor is
    // simply irrelevant to it.
    const reupload = await server.inject({
      method: 'POST',
      url: `/api/documents/${docId}/versions`,
      cookies: { mdloop_session: owner },
      payload: { content: '# Spec\n\nRewritten notes about turtles and rivers.' },
    });
    expect(reupload.statusCode).toBe(200);
    const res = await server.inject({
      method: 'POST',
      url: `/api/comments/${suggestion.id}/accept`,
      cookies: { mdloop_session: owner },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ comment: CommentDto }>();
    expect(body.comment.suggestionOutcome).toBe('accepted');
    expect(body.comment.appliedVersionId).toBeNull();
  });
});
