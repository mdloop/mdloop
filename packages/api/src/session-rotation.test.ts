import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { csrfTokenFor, decodeSession, encodeSession } from './auth/session.js';
import { createTestServer, loginAs, testConfig } from './test-support/test-server.js';
import type { TestServer } from './test-support/test-server.js';

/**
 * P0.7: the exit criterion for SESSION_SECRET rotation is "a session signed
 * with the previous secret still verifies;
 * rotation no longer mass-logs-out". These are the route-level proof — the
 * server is configured with a `sessionSecretPrevious` distinct from the
 * `sessionSecret` every other test in this suite logs in under, and requests
 * carry cookies signed entirely with that previous secret, exercising the
 * real `requireSession`/`requireCsrf` preHandlers end to end rather than the
 * primitives directly (see auth/session.test.ts for those).
 */
describe('SESSION_SECRET rotation — dual-verify against current + previous', () => {
  const PREVIOUS_SECRET = 'previous-secret-during-rotation-pppppppp';
  let ts: TestServer;
  let server: FastifyInstance;

  beforeAll(async () => {
    ts = await createTestServer(undefined, undefined, { sessionSecretPrevious: PREVIOUS_SECRET });
    server = ts.server;
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  it('a customer session + CSRF pair signed entirely with the previous secret still authenticates and passes CSRF', async () => {
    // Establish a real actor via the normal (current-secret) login flow, then
    // simulate "this session predates the rotation" by re-signing the exact
    // same payload under the previous secret — what a not-yet-expired,
    // not-yet-refreshed pre-rotation cookie looks like.
    const currentToken = await loginAs(server, 'rotation-alice');
    const decoded = decodeSession(currentToken, [testConfig.sessionSecret]);
    expect(decoded).toBeDefined();
    const oldToken = encodeSession(decoded!.payload, PREVIOUS_SECRET);

    const me = await server.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { mdloop_session: oldToken },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ userId: decoded!.payload.userId });

    const oldCsrf = csrfTokenFor(oldToken, PREVIOUS_SECRET);
    const created = await ts.rawInject({
      method: 'POST',
      url: '/api/api-keys',
      cookies: { mdloop_session: oldToken, mdloop_csrf: oldCsrf },
      headers: { 'x-csrf-token': oldCsrf },
      payload: { name: 'rotation-smoke-key' },
    });
    expect(created.statusCode).toBe(201);
  });

  it('rejects a previous-secret session paired with a CSRF token only valid under the current secret, and vice versa', async () => {
    const currentToken = await loginAs(server, 'rotation-bob');
    const decoded = decodeSession(currentToken, [testConfig.sessionSecret]);
    const oldToken = encodeSession(decoded!.payload, PREVIOUS_SECRET);

    // Session verified via `previous`, CSRF only checks out under `current` —
    // not a pair any real client ever minted together.
    const wrongCsrfForOldSession = csrfTokenFor(oldToken, testConfig.sessionSecret);
    const mismatch1 = await ts.rawInject({
      method: 'POST',
      url: '/api/api-keys',
      cookies: { mdloop_session: oldToken, mdloop_csrf: wrongCsrfForOldSession },
      headers: { 'x-csrf-token': wrongCsrfForOldSession },
      payload: { name: 'should-not-be-created' },
    });
    expect(mismatch1.statusCode).toBe(403);

    // Session verified via `current`, CSRF only checks out under `previous`.
    const wrongCsrfForCurrentSession = csrfTokenFor(currentToken, PREVIOUS_SECRET);
    const mismatch2 = await ts.rawInject({
      method: 'POST',
      url: '/api/api-keys',
      cookies: { mdloop_session: currentToken, mdloop_csrf: wrongCsrfForCurrentSession },
      headers: { 'x-csrf-token': wrongCsrfForCurrentSession },
      payload: { name: 'should-not-be-created' },
    });
    expect(mismatch2.statusCode).toBe(403);
  });
});

describe('SESSION_SECRET rotation — steady state (SESSION_SECRET_PREVIOUS unset)', () => {
  let ts: TestServer;
  let server: FastifyInstance;

  beforeAll(async () => {
    ts = await createTestServer();
    server = ts.server;
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  it('a token signed with a secret other than current is rejected exactly as before — no regression', async () => {
    const currentToken = await loginAs(server, 'rotation-charlie');
    const decoded = decodeSession(currentToken, [testConfig.sessionSecret]);
    const foreignToken = encodeSession(decoded!.payload, 'some-secret-that-is-not-configured');

    const res = await server.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { mdloop_session: foreignToken },
    });
    expect(res.statusCode).toBe(401);
  });
});
