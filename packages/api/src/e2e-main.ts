import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Actor, AuthPort } from '@vorlyn/app';
import { NoopSeatSync, signIn, uploadNewDocument } from '@vorlyn/app';
import { NoopTelemetry, UnlimitedRateLimiter } from '@vorlyn/app/test-support';
import type { DocumentId, ProjectId } from '@vorlyn/shared';
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
} from '@vorlyn/persistence';
import { createTestDb } from '@vorlyn/persistence/test-support';
import { LoggingEmailAdapter } from './email/logging-email.adapter.js';
import { buildServer } from './server.js';

/**
 * Playwright harness: real API + real Postgres (ephemeral database) with a
 * loopback AuthPort — "hosted auth" redirects straight back to the callback,
 * so the browser drives the full login flow without WorkOS.
 */
// Must track the actual ports this process and its paired vite dev server bind
// to (see playwright.config.ts) — if these drift from reality, the OAuth
// redirect lands wherever *is* listening on the stale port, which, on a dev
// machine, is easy to mistake for a totally different, real server.
const apiPort = Number(process.env.PORT ?? 3000);
const webPort = Number(process.env.WEB_PORT ?? 5173);
const baseUrl = `http://localhost:${String(apiPort)}`;
const webAppUrl = `http://localhost:${String(webPort)}`;

const loopbackAuth: AuthPort = {
  authorizationUrl: (redirectUri, state) => `${redirectUri}?code=code-e2e&state=${state}`,
  exchangeCode: (code: string) =>
    Promise.resolve({
      providerUserId: `wos_${code}`,
      email: 'e2e@vorlyn.test',
      displayName: 'E2E Runner',
    }),
};

// The e2e org signs up on the free tier by default (60 req/min budget) —
// plenty for a real user, but a Playwright spec can throw
// dozens of requests in under a second (every mutation in the admin screens
// refetches its section). Real per-user throttling is exercised by
// packages/app/src/user-rate-limit.test.ts against the real tier profiles;
// here we only need the browser flows to be deterministic, so this harness
// disables the per-user budget without touching the tier defaults anything
// else reads. `UnlimitedRateLimiter` (packages/app/src/test-support/fakes.ts)
// replaces the old UnlimitedUserRateLimiter subclass hack now that
// RateLimiterPort exists to implement directly.

const db = await createTestDb();
const blobDir = await mkdtemp(path.join(tmpdir(), 'vorlyn-e2e-blobs-'));
const storage = new FsStorage(blobDir);
const directory = new PgDirectoryRepository(db.pool);
// Single instance: OrganizationRepository + OrgLifecyclePort (see main.ts's
// equivalent comment).
const organizations = new PgOrganizationRepository(db.pool);
const documents = new PgDocumentRepository(db.pool);
const comments = new PgCommentRepository(db.pool);
const uploadUow = new PgUploadUnitOfWork(db.pool);

// k6 runs (scripts/load/) share one session cookie across every VU, so the
// global per-client backstop would cap the whole test at 1200 req/min.
// LOAD_TEST=1 lifts it for this throwaway harness only — prod limits are
// exercised by user-rate-limit.test.ts and rate-limit parity features.
const loadTest = process.env.LOAD_TEST === '1';

// Public Docs Hub e2e (Phase 24.G): publishing is gated on
// `config.publicHubOrgId` matching the actor's org (ADR 0004) — there's no
// env var to set it to ahead of time since the e2e org doesn't exist until
// first sign-in. So pre-provision the loopback identity's personal org here,
// synchronously, using the exact profile `loopbackAuth.exchangeCode` returns
// below (`wos_code-e2e` / e2e@vorlyn.test) — the later browser-driven sign-in
// (e2e/*.spec.ts clicking "Sign in") hits `signIn` again with the same
// `providerUserId` and just gets back this same user (dedup by workosUserId),
// so this doesn't create a second org or a duplicate user.
const e2eBootstrap = await signIn(directory, NoopSeatSync, {
  providerUserId: 'wos_code-e2e',
  email: 'e2e@vorlyn.test',
  displayName: 'E2E Runner',
});
if (!e2eBootstrap.ok) {
  throw new Error(`e2e org bootstrap sign-in failed: ${e2eBootstrap.error.code}`);
}
const publicHubOrgId = e2eBootstrap.value.orgId as string;

// Comment @mentions e2e (Phase 24.G, ADR 0003 §D): the composer's mention
// picker only offers candidates who are the doc owner or have already
// commented/replied on THIS document (viewer.tsx `mentionCandidates`) — and
// the loopback AuthPort can only ever authenticate as the one e2e browser
// identity (see e2e/invite-accept.spec.ts), so no Playwright spec can drive a
// second org member through the UI to become one of those candidates. This
// second real member is pre-provisioned here (never signs in) so a spec can
// seed a comment "from" them via the `/test-support/seed-member-comment`
// route registered below, then exercise the real picker/highlight UI as the
// e2e identity.
const mentionBuddy = await directory.createUser(e2eBootstrap.value.orgId, {
  workosUserId: 'e2e-mention-buddy',
  email: 'mention-buddy@vorlyn.test',
  displayName: 'Mention Buddy',
  role: 'member',
});

// mentionBuddy is a second real seat, which alone exhausts free tier's
// `maxCollaborators: 2` ceiling — every OTHER spec sharing
// this org (e.g. org-settings.spec.ts's invite test) would then spuriously
// see "out of seats". No e2e spec exercises free-tier-specific ceilings, so
// bumping to team (effectively unlimited collaborators/docs/versions) is the
// minimal-blast-radius fix; there's no admin-facing tier-upgrade path outside
// the Stripe webhook flow this harness doesn't run, hence the raw update.
await db.pool.query('update organizations set tier = $1 where id = $2', [
  'team',
  e2eBootstrap.value.orgId,
]);

const server = await buildServer({
  ...(loadTest ? { rateLimits: { global: 1_000_000, upload: 1_000_000 } } : {}),
  config: {
    baseUrl,
    webAppUrl,
    webOrigin: webAppUrl,
    sessionSecret: 'e2e-session-secret-e2e-session-secret',
    secureCookies: false,
    publicHubOrgId,
  },
  auth: loopbackAuth,
  userRateLimiter: new UnlimitedRateLimiter(),
  directory,
  organizations,
  documents,
  projects: new PgProjectRepository(db.pool),
  versions: new PgVersionRepository(db.pool),
  uploadUow,
  storage,
  commentRollup: new PgCommentRollupReader(db.pool),
  comments,
  reviews: new PgReviewRepository(db.pool),
  resolutions: new PgAnchorResolutionRepository(db.pool),
  grants: new PgShareGrantRepository(db.pool),
  apiKeys: new PgApiKeyRepository(db.pool),
  search: new PgSearchRepository(db.pool),
  telemetry: new NoopTelemetry(),
  orgLifecycle: organizations,
  erasures: new PgErasureLogRepository(db.pool),
  invites: new PgOrgInviteRepository(db.pool),
  allowlist: new PgAllowlistRepository(db.pool),
  guests: new PgGuestUserRepository(db.pool),
  email: new LoggingEmailAdapter(),
  publicHub: new PgPublicHubRepository(db.pool),
});

// Registered directly on the top-level `server`, outside the `authed`
// child scope built inside buildServer (server.ts registers session/CSRF
// preHandlers only on that scope) — so this needs no session cookie or CSRF
// token. Only ever reachable here: production boots through main.ts, which
// never calls this file.
server.post<{ Body: { documentId: string; body: string } }>(
  '/api/test-support/seed-member-comment',
  async (req, reply) => {
    const ctx = { orgId: e2eBootstrap.value.orgId, userId: mentionBuddy.id };
    const doc = await documents.byId(ctx, req.body.documentId as DocumentId);
    if (!doc?.currentVersionId) {
      return reply.code(404).send({ error: 'document_not_found' });
    }
    const comment = await comments.create(ctx, {
      documentId: doc.id,
      versionId: doc.currentVersionId,
      body: req.body.body,
      anchor: { type: 'document' },
      authorId: mentionBuddy.id,
    });
    return reply.code(201).send({ id: comment.id, authorName: mentionBuddy.displayName });
  },
);

// Breadcrumb e2e (Phase 29 web half): REST document upload never accepts
// `path` — only the MCP `upload_document` tool can set it (Document.path is
// CLI-owned, CONSTITUTION.md §3) — so a real browser-driven upload can never
// produce a path-backed document for the viewer's breadcrumb to render
// against. Same escape hatch as `/test-support/seed-member-comment` above:
// call the use case directly as the e2e bootstrap identity, outside the
// session/CSRF-guarded `authed` scope, only reachable from this harness.
server.post<{
  Body: { title: string; content: string; path: string; projectId?: string | null };
}>('/api/test-support/seed-document-path', async (req, reply) => {
  const actor: Actor = {
    ctx: { orgId: e2eBootstrap.value.orgId, userId: e2eBootstrap.value.id },
    role: e2eBootstrap.value.role,
  };
  const result = await uploadNewDocument(uploadUow, storage, actor, {
    title: req.body.title,
    // Optional (project-tree e2e, Phase 29 web half) — omitted keeps the
    // "unfiled" default the breadcrumb spec above already relies on.
    projectId: (req.body.projectId ?? null) as ProjectId | null,
    content: new TextEncoder().encode(req.body.content),
    source: 'cli',
    path: req.body.path,
  });
  if (!result.ok) {
    return reply.code(400).send({ error: result.error.code });
  }
  return reply.code(201).send({ id: result.value.document.id });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server
      .close()
      .then(() => db.close())
      .then(() => rm(blobDir, { recursive: true, force: true }))
      .finally(() => process.exit(0));
  });
}

await server.listen({ port: apiPort, host: '127.0.0.1' });
// Playwright's webServer readiness probe watches this port; nothing to log.
