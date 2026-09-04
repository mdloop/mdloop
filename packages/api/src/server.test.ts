import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  attemptLoginAs,
  createTestServer,
  csrfTokenForSession,
  loginAs,
  testConfig,
} from './test-support/test-server.js';
import type { TestServer } from './test-support/test-server.js';

describe('api server (auth + org settings)', () => {
  let ts: TestServer;
  let server: FastifyInstance;

  beforeAll(async () => {
    ts = await createTestServer();
    server = ts.server;
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  it('health check needs no auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('readiness pings the DB and reports ready with a live pool', async () => {
    const res = await server.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });

  it('a schema-invalid body is a sanitized 400, not a leaked validation message', async () => {
    const session = await loginAs(server, 'grace');
    const res = await server.inject({
      method: 'PATCH',
      url: '/api/org/settings',
      cookies: { mdloop_session: session },
      // `sharingMode` is an enum; this value fails schema validation, which
      // routes through the fault handler.
      payload: { sharingMode: 'q3-secret-roadmap' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_request' });
    // The submitted value never echoes back in the error envelope.
    expect(res.body).not.toContain('q3-secret-roadmap');
  });

  it('protected routes 401 without a session', async () => {
    for (const url of ['/api/me', '/api/org/settings']) {
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('callback rejects a mismatched OAuth state', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/auth/callback?code=code-x&state=forged',
      cookies: { mdloop_oauth_state: 'different' },
    });
    expect(res.statusCode).toBe(400);
  });

  // Phase 38.C: a signIn() denial (bad invite, JIT cap, disposable email...)
  // used to render as a bare `{ error: '<code>' }` JSON body in the browser
  // mid-way through the WorkOS round trip. It's now a redirect back to our
  // own login card with the code in the query string, which resolves to a
  // sentence via error-copy.ts instead of a raw identifier.
  it('a signIn denial redirects to the login screen with the code, not a JSON body', async () => {
    const attempt = await attemptLoginAs(server, 'never-invited', 'not-a-real-invite-token');
    expect(attempt.statusCode).toBe(302);
    expect(attempt.location).toBe(`${testConfig.webAppUrl}/?authError=invite_not_found`);
    // No JSON error envelope on the redirect — it never reaches the SPA's
    // fetch wrapper, so the code must not be echoed in a body a browser
    // could render directly.
    expect(attempt.body).not.toContain('invite_not_found');
  });

  it('first sign-in provisions an org and an admin session', async () => {
    const session = await loginAs(server, 'alice');
    const me = await server.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { mdloop_session: session },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ role: 'admin' });
  });

  it('second sign-in reuses the same identity', async () => {
    const s1 = await loginAs(server, 'bob');
    const s2 = await loginAs(server, 'bob');
    const me1 = await server.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { mdloop_session: s1 },
    });
    const me2 = await server.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { mdloop_session: s2 },
    });
    expect(me1.json()).toEqual(me2.json());
  });

  it('admin can read and update org settings', async () => {
    const session = await loginAs(server, 'carol');
    const before = await server.inject({
      method: 'GET',
      url: '/api/org/settings',
      cookies: { mdloop_session: session },
    });
    expect(before.json()).toMatchObject({ retentionDays: 30, sharingMode: 'link' });

    const patch = await server.inject({
      method: 'PATCH',
      url: '/api/org/settings',
      cookies: { mdloop_session: session },
      payload: { retentionDays: 7, sharingMode: 'directory' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ retentionDays: 7, sharingMode: 'directory' });
  });

  // Regression: PATCH used to omit sessionMaxHours from its response while
  // GET already returned it (Phase 39 settings-redesign audit,
  // org-routes.ts). Only masked because the web client re-fetches GET after
  // every patch, so the two response shapes must match here for real.
  it('PATCH /org/settings response includes sessionMaxHours, matching GET', async () => {
    const session = await loginAs(server, 'heidi');
    const patch = await server.inject({
      method: 'PATCH',
      url: '/api/org/settings',
      cookies: { mdloop_session: session },
      payload: { sessionMaxHours: 8 },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(patch.json()).toMatchObject({ sessionMaxHours: 8 });

    const after = await server.inject({
      method: 'GET',
      url: '/api/org/settings',
      cookies: { mdloop_session: session },
    });
    expect(after.json()).toMatchObject({ sessionMaxHours: 8 });
    // Same key set on both responses — not just the same value.
    expect(Object.keys(patch.json()).sort()).toEqual(Object.keys(after.json()).sort());
  });

  it('rejects invalid retention days', async () => {
    const session = await loginAs(server, 'dave');
    const res = await server.inject({
      method: 'PATCH',
      url: '/api/org/settings',
      cookies: { mdloop_session: session },
      payload: { retentionDays: 9999 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /org/usage: any signed-in member (not admin-only) reads doc/seat/storage/guest usage', async () => {
    const session = await loginAs(server, 'ivan');
    const res = await server.inject({
      method: 'GET',
      url: '/api/org/usage',
      cookies: { mdloop_session: session },
    });
    expect(res.statusCode, res.body).toBe(200);
    // Fresh personal org: free tier, one member (the caller), no docs/guests yet.
    expect(res.json()).toMatchObject({
      tier: 'free',
      activeDocCount: 0,
      maxActiveDocs: 100,
      memberCount: 1,
      maxCollaborators: 1,
      storageBytes: 0,
      activeGuestCount: 0,
      maxExternalGuests: 0,
    });
  });

  it('GET /org/usage: 401s without a session', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/org/usage' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /org/usage: a document upload is reflected in activeDocCount and storageBytes', async () => {
    const session = await loginAs(server, 'judy');
    const csrf = csrfTokenForSession(session);
    const uploaded = await server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { mdloop_session: session, mdloop_csrf: csrf },
      headers: { 'x-csrf-token': csrf },
      payload: { title: 'Doc', content: '# Doc\n\nsome body content' },
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);

    const res = await server.inject({
      method: 'GET',
      url: '/api/org/usage',
      cookies: { mdloop_session: session },
    });
    expect(res.statusCode).toBe(200);
    const usage = res.json<{ activeDocCount: number; storageBytes: number }>();
    expect(usage.activeDocCount).toBe(1);
    expect(usage.storageBytes).toBeGreaterThan(0);
  });

  // Relocated from the deleted billing vertical (S4 spike): `listTierPlans()`
  // is pure TIER_PROFILES-derived data with no Stripe dependency, so it moved
  // to org-routes.ts under GET /org/tiers rather than being deleted outright
  // — it still feeds the retention UI's plan-ceiling display.
  it('GET /org/tiers: any signed-in member (not just admin) sees all three tiers, matching TIER_PROFILES', async () => {
    const session = await loginAs(server, 'ivan');
    const res = await server.inject({
      method: 'GET',
      url: '/api/org/tiers',
      cookies: { mdloop_session: session },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{
      tiers: {
        tier: string;
        maxCollaborators: number | null;
        maxActiveDocs: number | null;
        maxExternalGuests: number | null;
        versionRetention: { keepLastNMax: number | null; keepDaysMax: number | null };
      }[];
    }>();
    expect(body.tiers.map((t) => t.tier)).toEqual(['free', 'team', 'enterprise']);
    const free = body.tiers.find((t) => t.tier === 'free');
    expect(free).toMatchObject({ maxCollaborators: 1, maxExternalGuests: 0 });
    const enterprise = body.tiers.find((t) => t.tier === 'enterprise');
    expect(enterprise).toMatchObject({
      maxCollaborators: null,
      maxActiveDocs: null,
      maxExternalGuests: null,
    });
  });

  it('GET /org/tiers: 401s without a session', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/org/tiers' });
    expect(res.statusCode).toBe(401);
  });

  it('a tampered session cookie is rejected', async () => {
    const session = await loginAs(server, 'eve');
    const [body] = session.split('.');
    const res = await server.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { mdloop_session: `${body}.AAAA` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('logout clears the cookie', async () => {
    const session = await loginAs(server, 'frank');
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { mdloop_session: session },
    });
    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find((c) => c.name === 'mdloop_session');
    expect(cleared?.value).toBe('');
  });
});

describe('readiness under a failing DB probe', () => {
  it('reports 503 not_ready when the probe fails, without leaking why', async () => {
    // Fourth arg overrides the /readyz probe (test-server) — simulate a dead
    // pool without tearing the real one down.
    const ts = await createTestServer(undefined, undefined, undefined, () =>
      Promise.resolve(false),
    );
    try {
      const res = await ts.server.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'not_ready' });
    } finally {
      await ts.close();
    }
  });
});
