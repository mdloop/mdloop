import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, csrfTokenFor } from '../auth/session.js';
import type { ServerExtension } from '../server-extension.js';
import type { AuthPort, TelemetryPort } from '@vorlyn/app';
import { FakeEmail, NoopTelemetry } from '@vorlyn/app/test-support';
import {
  FsStorage,
  PgAllowlistRepository,
  PgAnchorResolutionRepository,
  PgApiKeyRepository,
  PgErasureLogRepository,
  PgCommentRepository,
  PgCommentRollupReader,
  PgDirectoryRepository,
  PgGuestUserRepository,
  PgDocumentRepository,
  PgOrganizationRepository,
  PgOrgInviteRepository,
  PgProjectRepository,
  PgPublicHubRepository,
  PgReviewRepository,
  PgSearchRepository,
  PgShareGrantRepository,
  PgUploadUnitOfWork,
  PgVersionRepository,
  pingPool,
} from '@vorlyn/persistence';
import { createTestDb } from '@vorlyn/persistence/test-support';
import type { TestDb } from '@vorlyn/persistence/test-support';
import { buildServer } from '../server.js';
import type { RateLimits } from '../server.js';
import type { ApiConfig } from '../config.js';

export const testConfig: ApiConfig = {
  baseUrl: 'http://localhost:3000',
  webAppUrl: 'http://localhost:5173',
  sessionSecret: 'a'.repeat(32),
  secureCookies: false,
  webOrigin: 'http://localhost:5173',
};

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * The CSRF token bound to a session cookie (Phase 24) — a plain string, so
 * callers building `cookies`/`headers` objects by hand don't fight
 * `noUncheckedIndexedAccess` on a `Record` lookup.
 */
export function csrfTokenForSession(
  session: string,
  secret: string = testConfig.sessionSecret,
): string {
  return csrfTokenFor(session, secret);
}

/**
 * The CSRF header a mutation needs for a given session cookie (Phase 24). Tests
 * that build requests explicitly can spread this; the wrapped `inject` below
 * attaches it automatically, mirroring what the SPA's `request` helper does.
 */
export function csrfHeadersFor(
  session: string,
  secret: string = testConfig.sessionSecret,
): Record<string, string> {
  return { [CSRF_HEADER]: csrfTokenFor(session, secret) };
}

/**
 * Wraps `server.inject` so a mutating request that carries a session cookie but
 * no explicit CSRF header gets the double-submit cookie + header attached — the
 * test-harness equivalent of the browser SPA auto-echoing `vorlyn_csrf`. Requests
 * with an explicit `x-csrf-token` (the negative CSRF tests) pass through
 * untouched, as do non-mutating and unauthenticated requests.
 */
function attachCsrfToInject(server: FastifyInstance, secret: string): FastifyInstance['inject'] {
  const rawInject = server.inject.bind(server);
  server.inject = ((opts: InjectOptions | string) => {
    if (opts && typeof opts === 'object') {
      const method = (opts.method ?? 'GET').toUpperCase();
      const session = opts.cookies?.[SESSION_COOKIE];
      const headerNames = Object.keys(opts.headers ?? {}).map((k) => k.toLowerCase());
      const hasCsrfHeader = headerNames.includes(CSRF_HEADER);
      if (MUTATING.has(method) && session !== undefined && !hasCsrfHeader) {
        const csrf = csrfTokenFor(session, secret);
        return rawInject({
          ...opts,
          cookies: { ...opts.cookies, [CSRF_COOKIE]: csrf },
          headers: { ...opts.headers, [CSRF_HEADER]: csrf },
        });
      }
    }
    return rawInject(opts);
  }) as typeof server.inject;
  return rawInject;
}

/**
 * Deterministic AuthPort double: code "code-<id>" -> profile for <id>.
 * An id containing "@" is used verbatim as the email (signup abuse tests).
 */
export const fakeAuth: AuthPort = {
  authorizationUrl: (redirectUri, state) =>
    `https://auth.example/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
  exchangeCode: (code: string) => {
    const id = code.replace('code-', '');
    return Promise.resolve({
      providerUserId: `wos_${id}`,
      email: id.includes('@') ? id : `${id}@example.test`,
      displayName: id,
    });
  },
};

export interface TestServer {
  server: FastifyInstance;
  db: TestDb;
  storage: FsStorage;
  email: FakeEmail;
  /**
   * Per-instance mutable copy of `testConfig` (never the shared const) —
   * some tests (Public Docs Hub home-org gating) only learn the real org id
   * after a login round trip, so they mutate `publicHubOrgId` on this object
   * post-construction. `buildServer` reads it fresh on every request.
   */
  config: ApiConfig;
  /**
   * The un-wrapped `inject`, before the CSRF auto-attach — for the focused
   * CSRF tests that must send a mutation with a missing/wrong token.
   */
  rawInject: FastifyInstance['inject'];
  close(): Promise<void>;
}

/**
 * Full stack against an ephemeral database + temp-dir blob store. `readiness`
 * overrides the `/readyz` DB probe — the focused readiness test passes a
 * failing probe to exercise the 503 branch without tearing down the real pool.
 */
export async function createTestServer(
  rateLimits?: RateLimits,
  telemetry: TelemetryPort = new NoopTelemetry(),
  configOverrides?: Partial<ApiConfig>,
  readiness?: () => Promise<boolean>,
  /**
   * A factory, not an array, because the database is created *here*: a
   * realistic extension is backed by repositories bound to this run's pool, so
   * it cannot be constructed before `createTestDb()` has run. Handing back an
   * already-built array would force every DB-backed extension to duplicate the
   * ephemeral-database setup instead of composing onto the core server the way
   * a deployment actually does.
   */
  extensions?: (db: TestDb) => readonly ServerExtension[],
): Promise<TestServer> {
  const db = await createTestDb();
  const blobDir = await mkdtemp(path.join(tmpdir(), 'vorlyn-api-blobs-'));
  const storage = new FsStorage(blobDir);
  const email = new FakeEmail();
  const config: ApiConfig = { ...testConfig, ...configOverrides };
  // Single instance: OrganizationRepository + OrgLifecyclePort (see main.ts's
  // equivalent comment).
  const organizations = new PgOrganizationRepository(db.pool);
  const server = await buildServer({
    config,
    auth: fakeAuth,
    directory: new PgDirectoryRepository(db.pool),
    organizations,
    documents: new PgDocumentRepository(db.pool),
    projects: new PgProjectRepository(db.pool),
    versions: new PgVersionRepository(db.pool),
    uploadUow: new PgUploadUnitOfWork(db.pool),
    storage,
    commentRollup: new PgCommentRollupReader(db.pool),
    comments: new PgCommentRepository(db.pool),
    reviews: new PgReviewRepository(db.pool),
    resolutions: new PgAnchorResolutionRepository(db.pool),
    grants: new PgShareGrantRepository(db.pool),
    apiKeys: new PgApiKeyRepository(db.pool),
    search: new PgSearchRepository(db.pool),
    telemetry,
    orgLifecycle: organizations,
    erasures: new PgErasureLogRepository(db.pool),
    invites: new PgOrgInviteRepository(db.pool),
    allowlist: new PgAllowlistRepository(db.pool),
    guests: new PgGuestUserRepository(db.pool),
    email,
    publicHub: new PgPublicHubRepository(db.pool),
    readiness: readiness ?? (() => pingPool(db.pool)),
    ...(extensions ? { extensions: extensions(db) } : {}),
    ...(rateLimits ? { rateLimits } : {}),
  });
  const rawInject = attachCsrfToInject(server, config.sessionSecret);
  return {
    server,
    db,
    storage,
    email,
    config,
    rawInject,
    async close() {
      await server.close();
      await db.close();
      await rm(blobDir, { recursive: true, force: true });
    },
  };
}

/**
 * Drives /api/auth/login + /api/auth/callback, returns the session cookie
 * value. `inviteToken` (Phase 15) rides the same round trip an invite-accept
 * link would take: /api/auth/login?invite=<token> sets a cookie the
 * callback reads.
 */
export async function loginAs(
  server: FastifyInstance,
  id: string,
  inviteToken?: string,
): Promise<string> {
  const login = await server.inject({
    method: 'GET',
    url: inviteToken
      ? `/api/auth/login?invite=${encodeURIComponent(inviteToken)}`
      : '/api/auth/login',
  });
  expect(login.statusCode).toBe(302);
  const stateCookie = login.cookies.find((c) => c.name === 'vorlyn_oauth_state');
  const inviteCookie = login.cookies.find((c) => c.name === 'vorlyn_invite_token');
  const state = new URL(String(login.headers.location)).searchParams.get('state');
  if (!stateCookie || state === null) throw new Error('login redirect missing OAuth state');
  const callback = await server.inject({
    method: 'GET',
    url: `/api/auth/callback?code=code-${id}&state=${state}`,
    cookies: {
      vorlyn_oauth_state: stateCookie.value,
      ...(inviteCookie ? { vorlyn_invite_token: inviteCookie.value } : {}),
    },
  });
  const session = callback.cookies.find((c) => c.name === 'vorlyn_session');
  if (!session) {
    throw new Error(
      `callback set no session cookie (status ${String(callback.statusCode)}: ${callback.body})`,
    );
  }
  return session.value;
}

/**
 * Like `loginAs`, but for callers expecting a denial (bad invite, JIT cap,
 * etc.) — runs the same round trip and returns the raw callback response.
 * A `signIn` failure (Phase 38.C) is a 302 back to `webAppUrl` carrying
 * `?authError=<code>`, not a JSON body — `location` is what callers assert
 * on for that case; `body` stays for the unrelated `invalid_oauth_state` 400.
 */
export async function attemptLoginAs(
  server: FastifyInstance,
  id: string,
  inviteToken?: string,
): Promise<{ statusCode: number; body: string; location: string | undefined }> {
  const login = await server.inject({
    method: 'GET',
    url: inviteToken
      ? `/api/auth/login?invite=${encodeURIComponent(inviteToken)}`
      : '/api/auth/login',
  });
  const stateCookie = login.cookies.find((c) => c.name === 'vorlyn_oauth_state');
  const inviteCookie = login.cookies.find((c) => c.name === 'vorlyn_invite_token');
  const state = new URL(String(login.headers.location)).searchParams.get('state');
  if (!stateCookie || state === null) throw new Error('login redirect missing OAuth state');
  const callback = await server.inject({
    method: 'GET',
    url: `/api/auth/callback?code=code-${id}&state=${state}`,
    cookies: {
      vorlyn_oauth_state: stateCookie.value,
      ...(inviteCookie ? { vorlyn_invite_token: inviteCookie.value } : {}),
    },
  });
  return {
    statusCode: callback.statusCode,
    body: callback.body,
    location: callback.headers.location,
  };
}

/**
 * Session-token primitives, re-exported for tests that need to *construct* a
 * session rather than obtain one through `loginAs` — expiry, rotation and
 * tamper cases, which cannot be reached through the login flow by definition.
 * They live in `auth/session.ts`; this is the seam a test (in this package or
 * in a deployment's own) is expected to reach them through, rather than a deep
 * import past the package's exports.
 */
export { encodeSession, decodeSession, SESSION_TTL_MS } from '../auth/session.js';
