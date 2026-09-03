import { afterAll, describe, expect, it } from 'vitest';
import type { AuthPort } from '@vorlyn/app';
import { UnlimitedRateLimiter } from '@vorlyn/app';
import { NoopTelemetry } from '@vorlyn/app/test-support';
import { PgDirectoryRepository } from '@vorlyn/persistence';
import { createTestDb } from '@vorlyn/persistence/test-support';
import type { TestDb } from '@vorlyn/persistence/test-support';
import { LoggingEmailAdapter } from './email/logging-email.adapter.js';
import { buildServer } from './server.js';
import type { ApiConfig } from './config.js';
import { buildSelfHostServerDeps } from './selfhost-server-deps.js';

const testConfig: ApiConfig = {
  baseUrl: 'http://localhost:3000',
  webAppUrl: 'http://localhost:5173',
  sessionSecret: 'a'.repeat(32),
  secureCookies: false,
  webOrigin: 'http://localhost:5173',
};

const fakeAuth: AuthPort = {
  authorizationUrl: (redirectUri, state) =>
    `https://auth.example/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
  exchangeCode: (code: string) =>
    Promise.resolve({
      providerUserId: `wos_${code}`,
      email: `${code}@example.test`,
      displayName: code,
    }),
};

/**
 * Real, non-`*main.ts` unit under test (unlike `selfhost-main.ts`/
 * `selfhost-embedded-main.ts`, which are wiring-only and excluded from the
 * coverage floor by `vitest.config.ts`'s `**\/*main.ts` glob). Exercises the
 * helper against a real ephemeral Postgres (`createTestDb`), proving the
 * `ServerDeps` it builds actually work end to end — not just that the object
 * shape typechecks.
 */
describe('buildSelfHostServerDeps', () => {
  let db: TestDb;

  afterAll(async () => {
    await db.close();
  });

  it('wires every ServerDeps field off one pool into a working server', async () => {
    db = await createTestDb();
    const directory = new PgDirectoryRepository(db.pool);
    const deps = buildSelfHostServerDeps(
      db.pool,
      testConfig,
      fakeAuth,
      directory,
      new NoopTelemetry(),
      new LoggingEmailAdapter(),
    );

    // organizations and orgLifecycle are the same PgOrganizationRepository
    // instance — matching selfhost-main.ts's original "single instance:
    // OrganizationRepository + OrgLifecyclePort" comment, now enforced by
    // the helper rather than by two call sites agreeing to pass the same
    // variable.
    expect(deps.organizations).toBe(deps.orgLifecycle);

    // The caller-supplied fields pass through untouched, not rebuilt.
    expect(deps.config).toBe(testConfig);
    expect(deps.auth).toBe(fakeAuth);
    expect(deps.directory).toBe(directory);

    // Self-host is always UnlimitedRateLimiter — never Redis, regardless of
    // env (no shared-store rate limiter to point at in a single-instance
    // deployment).
    expect(deps.userRateLimiter).toBeInstanceOf(UnlimitedRateLimiter);

    expect(await deps.readiness?.()).toBe(true);

    const server = await buildServer(deps);
    try {
      const health = await server.inject({ method: 'GET', url: '/healthz' });
      expect(health.statusCode).toBe(200);
      const ready = await server.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ status: 'ready' });

      // A real end-to-end login round trip proves directory/organizations/
      // apiKeys/comments/etc. are all wired against the same real pool, not
      // just individually constructable.
      const login = await server.inject({ method: 'GET', url: '/api/auth/login' });
      expect(login.statusCode).toBe(302);
      const stateCookie = login.cookies.find((c) => c.name === 'vorlyn_oauth_state');
      const state = new URL(String(login.headers.location)).searchParams.get('state');
      expect(stateCookie).toBeDefined();
      expect(state).not.toBeNull();
      const callback = await server.inject({
        method: 'GET',
        url: `/api/auth/callback?code=alice&state=${String(state)}`,
        cookies: { vorlyn_oauth_state: String(stateCookie?.value) },
      });
      const session = callback.cookies.find((c) => c.name === 'vorlyn_session');
      expect(session).toBeDefined();

      const me = await server.inject({
        method: 'GET',
        url: '/api/me',
        cookies: { vorlyn_session: String(session?.value) },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ role: 'admin' });
    } finally {
      await server.close();
    }
  }, 30_000);
});
