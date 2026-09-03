import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ExtensionContext, ServerExtension } from './server-extension.js';
import { createTestServer, loginAs } from './test-support/test-server.js';
import type { TestServer } from './test-support/test-server.js';

/**
 * The extension seam is public API (a deployment composes its own routes onto
 * the core server through it), so the guarantee that actually matters is
 * *placement*: which of the core's guards have already run by the time each
 * position's handler is reached. A seam that merely mounts routes somewhere is
 * worse than no seam, because it invites registering a privileged route
 * outside the session guard by accident.
 */
const seenContext: { value: ExtensionContext | null } = { value: null };

const probe: ServerExtension = {
  name: 'probe',
  registerPublic: (scope, ctx) => {
    seenContext.value = ctx;
    scope.get('/probe/public', () => ({ where: 'public' }));
  },
  registerAuthenticated: (scope) => {
    scope.get('/probe/authed', (req) => ({
      where: 'authed',
      // Populated by the core's session guard — proves the guard ran, not just
      // that the route mounted somewhere inside the scope.
      orgId: req.actor?.ctx.orgId ?? null,
    }));
  },
  registerIsolated: (scope) => {
    scope.addHook('preHandler', (req, reply, done) => {
      if (req.headers['x-probe-key'] !== 'let-me-in') {
        void reply.code(418).send({ error: 'probe_auth_failed' });
        return;
      }
      done();
    });
    scope.get('/probe/isolated', () => ({ where: 'isolated' }));
  },
};

describe('server extensions', () => {
  let ts: TestServer;
  let server: FastifyInstance;

  beforeAll(async () => {
    ts = await createTestServer(undefined, undefined, undefined, undefined, () => [probe]);
    server = ts.server;
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  it('mounts a public route under /api with no session required', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/probe/public' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ where: 'public' });
  });

  it('hands the extension a context built from the host deps', () => {
    expect(seenContext.value).not.toBeNull();
    expect(seenContext.value?.config.webOrigin).toBeTruthy();
    expect(typeof seenContext.value?.telemetry.log).toBe('function');
  });

  it('refuses an authenticated route without a session', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/probe/authed' });
    expect(res.statusCode).toBe(401);
  });

  it('runs the core session guard before an authenticated route, populating the actor', async () => {
    const session = await loginAs(server, 'grace');
    const res = await server.inject({
      method: 'GET',
      url: '/api/probe/authed',
      cookies: { vorlyn_session: session },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ where: string; orgId: string | null }>();
    expect(body.where).toBe('authed');
    expect(body.orgId).not.toBeNull();
  });

  it('does not apply the core session guard to an isolated route', async () => {
    // No session cookie, but the extension's own hook admits it — proving the
    // isolated scope authenticates itself rather than inheriting the customer
    // session guard.
    const res = await server.inject({
      method: 'GET',
      url: '/api/probe/isolated',
      headers: { 'x-probe-key': 'let-me-in' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ where: 'isolated' });
  });

  it("enforces the isolated scope's own auth", async () => {
    const res = await server.inject({ method: 'GET', url: '/api/probe/isolated' });
    expect(res.statusCode).toBe(418);
  });

  it("does not leak an isolated extension's hooks onto core routes", async () => {
    // /healthz is a core route and must stay reachable without the probe's
    // header — Fastify encapsulation is what guarantees this, and it is the
    // reason each isolated extension gets its own scope.
    const res = await server.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});

describe('server without extensions', () => {
  it('is exactly the core surface — what a plain self-hosted instance runs', async () => {
    const ts = await createTestServer();
    try {
      const res = await ts.server.inject({ method: 'GET', url: '/api/probe/public' });
      expect(res.statusCode).toBe(404);
      expect((await ts.server.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    } finally {
      await ts.close();
    }
  }, 60_000);
});
