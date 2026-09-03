import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type {
  AllowlistRepository,
  AnchorResolutionRepository,
  ApiKeyRepository,
  AuthPort,
  CommentRepository,
  CommentRollupReader,
  DirectoryRepository,
  DocumentRepository,
  EmailPort,
  GuestUserRepository,
  OrgInviteRepository,
  OrganizationRepository,
  OrgLifecyclePort,
  ProjectRepository,
  PublicHubRepository,
  RateLimiterPort,
  ReviewRepository,
  RoleDirectory,
  SearchRepository,
  SeatSyncPort,
  ShareGrantRepository,
  StoragePort,
  TelemetryPort,
  UploadUnitOfWork,
  VersionRepository,
  ErasureLogPort,
} from '@vorlyn/app';
import {
  CachedSessionMaxResolver,
  CachedTierResolver,
  METRIC_NAMES,
  NoopSeatSync,
  UserRateLimiter,
  listAccessibleDocuments,
} from '@vorlyn/app';
import {
  blockGuestBeyondReview,
  makeRequireCsrf,
  makeRequireOrigin,
  makeRequireSession,
} from './auth/guards.js';
import { SESSION_COOKIE } from './auth/session.js';
import { actorOf } from './auth/actor.js';
import { makeFaultHandler } from './errors.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerOrgRoutes } from './routes/org-routes.js';
import { registerDocumentRoutes } from './routes/document-routes.js';
import { registerProjectRoutes } from './routes/project-routes.js';
import { registerCommentRoutes } from './routes/comment-routes.js';
import { registerReviewRoutes } from './routes/review-routes.js';
import { registerShareRoutes } from './routes/share-routes.js';
import { registerApiKeyRoutes } from './routes/api-key-routes.js';
import { registerExportRoutes } from './routes/export-routes.js';
import { registerInviteRoutes } from './routes/invite-routes.js';
import { registerGuestRedeemRoute, registerGuestShareRoutes } from './routes/guest-share-routes.js';
import { registerPublicHubAdminRoutes } from './routes/public-hub-admin-routes.js';
import { registerPublicRoutes } from './routes/public-routes.js';
import type { ExtensionContext, ServerExtension } from './server-extension.js';
import type { ApiConfig } from './config.js';

export interface RateLimits {
  /** Requests per minute per client across all routes. */
  readonly global: number;
  /** Requests per minute per client on upload routes. */
  readonly upload: number;
}

/**
 * Cheap "is the DB reachable" probe for `GET /readyz` (Phase 24.E). Resolves
 * `true` on a successful ping, `false` on any error or timeout — it never
 * throws and never surfaces the underlying error. Wired from the pool in the
 * entrypoints (`pingPool`); a load balancer target-group check hits `/readyz`
 * so a pod with a dead pool is pulled from rotation, while `/healthz` stays
 * pure liveness.
 */
export type ReadinessProbe = () => Promise<boolean>;

// Global must exceed the largest tier burst (Team tier: 600/min) — it is an
// anonymous/abuse backstop, never the effective per-user limit.
export const DEFAULT_RATE_LIMITS: RateLimits = { global: 1200, upload: 30 };

// Transport-level outer bound, deliberately NOT equal to the 500KB content
// cap (`MAX_UPLOAD_BYTES`, ADR 0011): the JSON envelope also carries `title`,
// `projectId` and a `changeNote` of up to 20k chars, and JSON string escaping
// can double a legitimate content field (every `"` or `\` becomes two bytes),
// so a lawful max-size upload can legitimately weigh ~1.1MB on the wire. 1.5MB
// keeps that request accepted — so the caller gets the typed 413/415 from the
// domain layer rather than an opaque transport error — while still being a
// coarse bound rather than a stale much larger one.
const BODY_LIMIT_BYTES = 1536 * 1024;

export interface ServerDeps {
  config: ApiConfig;
  auth: AuthPort;
  directory: DirectoryRepository;
  organizations: OrganizationRepository & RoleDirectory;
  documents: DocumentRepository;
  projects: ProjectRepository;
  versions: VersionRepository;
  uploadUow: UploadUnitOfWork;
  storage: StoragePort;
  commentRollup: CommentRollupReader;
  comments: CommentRepository;
  reviews: ReviewRepository;
  resolutions: AnchorResolutionRepository;
  grants: ShareGrantRepository;
  apiKeys: ApiKeyRepository;
  search: SearchRepository;
  telemetry: TelemetryPort;
  /** GDPR org purge/lookup (was misfiled on `BillingRepository` — relocated
   *  in the S4 billing-removal spike). Provisioner-privileged, no tenant. */
  orgLifecycle: OrgLifecyclePort;
  erasures: ErasureLogPort;
  invites: OrgInviteRepository;
  allowlist: AllowlistRepository;
  guests: GuestUserRepository;
  email: EmailPort;
  /** Public Docs Hub (ADR 0004): publishing bridge + anonymous read store. */
  publicHub: PublicHubRepository;
  rateLimits?: RateLimits;
  /** Shared with the MCP server so agents and browsers draw one budget. */
  userRateLimiter?: RateLimiterPort;
  /** DB reachability check backing `GET /readyz` (Phase 24.E); omitted ⇒ always ready. */
  readiness?: ReadinessProbe;
  /**
   * Extra route bundles this deployment mounts alongside the core ones — see
   * `ServerExtension`. Omitted ⇒ the server is exactly the core surface, which
   * is what a plain self-hosted instance runs.
   */
  extensions?: readonly ServerExtension[];
  /**
   * Notified when an org's headcount changes on a join — see `SeatSyncPort`.
   * Omitted ⇒ `NoopSeatSync`, i.e. the core reports nothing and the join path
   * behaves as if the port did not exist.
   */
  seatSync?: SeatSyncPort;
}

/**
 * Builds the Fastify instance. All routes registered under the session guard
 * except /healthz, /readyz, /public/*, and /api/auth/* (CONSTITUTION.md §4).
 * Everything except /healthz/readyz/public/* is mounted under /api — a
 * literal Fastify prefix, not an edge-side rewrite: a deployment's own
 * reverse proxy/edge cache is expected to pass /api/* straight through.
 */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const rateLimits = deps.rateLimits ?? DEFAULT_RATE_LIMITS;
  const server = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });

  // Structured request logging (ARCHITECTURE.md §9): pino stays off, this is
  // the one logging path. Runs on every route, before the session guard, so
  // even unauthenticated requests (and their outcome) are recorded.
  const requestStart = new WeakMap<object, number>();
  server.addHook('onRequest', (req, _reply, done) => {
    requestStart.set(req, Date.now());
    done();
  });
  server.addHook('onResponse', (req, reply, done) => {
    const start = requestStart.get(req);
    const actor = req.actor;
    deps.telemetry.log('http_request', {
      requestId: req.id,
      route: req.routeOptions.url ?? req.url,
      method: req.method,
      statusCode: reply.statusCode,
      ...(start !== undefined ? { latencyMs: Date.now() - start } : {}),
      outcome: reply.statusCode >= 500 ? 'error' : 'ok',
      ...(actor ? { orgId: actor.ctx.orgId, userId: actor.ctx.userId } : {}),
    });
    done();
  });

  // Unhandled-fault backstop (Phase 24.E): sanitizes the envelope and logs
  // opaquely (see makeFaultHandler). Without it, Fastify leaks thrown Error
  // messages/stacks straight to the client.
  server.setErrorHandler(makeFaultHandler(deps.telemetry));

  await server.register(fastifyCookie);
  // Coarse pre-auth backstop only — the tier-aware per-user budget below is
  // the real limit, so this ceiling must sit above the largest tier burst
  // (Team 600/min).
  await server.register(fastifyRateLimit, {
    max: rateLimits.global,
    timeWindow: '1 minute',
    // Per-user once authenticated (the guard has not run yet, so decode is
    // not available here); anonymous traffic shares the per-IP bucket.
    keyGenerator: (req) => req.cookies[SESSION_COOKIE] ?? req.ip,
  });

  const userRateLimiter = deps.userRateLimiter ?? new UserRateLimiter();
  const tierResolver = new CachedTierResolver(deps.organizations);
  const sessionPolicy = new CachedSessionMaxResolver(deps.organizations);

  // Liveness: unconditional, no dependencies — answers "is the process up".
  server.get('/healthz', () => ({ status: 'ok' }));
  // Readiness (Phase 24.E): pings the DB so a pod with an exhausted/dead pool
  // is pulled from the load balancer. Never throws, never leaks the DB error.
  server.get('/readyz', async (_req, reply) => {
    const ready = deps.readiness ? await deps.readiness() : true;
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready' });
  });
  // Public Docs Hub (ADR 0004): the named exception alongside /healthz — no
  // session, ever, by design, and architecturally its own edge-cache
  // behavior (a 60s edge TTL vs /api/*'s no-caching) rather than nested
  // under /api. Registered directly on `server`, bare, not inside the
  // `/api`-prefixed scope below.
  registerPublicRoutes(server, { publicHub: deps.publicHub, storage: deps.storage });

  // Everything else mounts under /api — a deployment's own reverse
  // proxy/edge cache is expected to pass /api/* straight through with no
  // edge-side URL rewriting, so the path a browser/agent calls
  // (`/api/auth/login`, `/api/documents`, ...) must be the literal path
  // Fastify matches here.
  const extensions = deps.extensions ?? [];
  const extensionContext: ExtensionContext = {
    config: deps.config,
    telemetry: deps.telemetry,
    organizations: deps.organizations,
    orgLifecycle: deps.orgLifecycle,
    documents: deps.documents,
    versions: deps.versions,
    comments: deps.comments,
    invites: deps.invites,
    erasures: deps.erasures,
    storage: deps.storage,
    email: deps.email,
  };

  await server.register(
    async (api) => {
      registerAuthRoutes(
        api,
        deps.config,
        deps.auth,
        deps.directory,
        deps.seatSync ?? NoopSeatSync,
      );
      // Sessionless like the auth callback: the guest token IS the identity.
      registerGuestRedeemRoute(api, {
        directory: deps.directory,
        documents: deps.documents,
        grants: deps.grants,
        config: deps.config,
      });

      // Sessionless extension routes: siblings of /api/auth/*, before the
      // session scope opens, so they are never subject to its guards.
      for (const ext of extensions) {
        await ext.registerPublic?.(api, extensionContext);
      }

      await api.register(async (authed) => {
        // CSRF Origin allowlist (Phase 24): before the session guard so a
        // cross-origin mutation is rejected regardless of auth state.
        authed.addHook('preHandler', makeRequireOrigin(deps.config.webOrigin));
        authed.addHook(
          'preHandler',
          makeRequireSession({
            sessionSecret: deps.config.sessionSecret,
            ...(deps.config.sessionSecretPrevious
              ? { sessionSecretPrevious: deps.config.sessionSecretPrevious }
              : {}),
            secureCookies: deps.config.secureCookies,
            sessionPolicy,
          }),
        );
        // CSRF token layer (Phase 24): after the session guard so a missing session
        // is already a 401; only mutating requests are checked. Verifies against
        // whichever secret (current/previous, P0.7) requireSession matched for
        // this request — see `sessionSecretUsed` in guards.ts.
        authed.addHook('preHandler', makeRequireCsrf());
        // Guests reach review routes only (Phase 18) — before any handler runs.
        authed.addHook('preHandler', blockGuestBeyondReview);

        // Tier-aware per-user budget: runs after the session guard so every
        // request has an actor; agents act as their owning user.
        authed.addHook('preHandler', async (req, reply) => {
          const actor = actorOf(req);
          const tier = (await tierResolver.resolve(actor.ctx)) ?? 'free';
          const decision = await userRateLimiter.check(actor.ctx.userId, tier);
          if (!decision.ok) {
            // Wires the previously-dormant quota_rejected metric (Phase 34's
            // cost-model discussion, rate-limiting redesign 2026-08-11) — the
            // ALARM_DEFINITIONS "quota-rejection-spike" entry already existed
            // but nothing ever emitted this. Dimensioned by tier only (a
            // closed 3-value set) — never orgId/userId, which would blow up
            // CloudWatch custom-metric cardinality (see TelemetryFields'
            // doc comment). `.log()` alongside it carries the richer,
            // opaque-ID context for CloudWatch Logs Insights / debugging,
            // matching the `http_request` logging pattern just above.
            deps.telemetry.recordMetric(METRIC_NAMES.quotaRejected, 1, { tier });
            deps.telemetry.log('quota_rejected', {
              requestId: req.id,
              route: req.routeOptions.url ?? req.url,
              method: req.method,
              orgId: actor.ctx.orgId,
              userId: actor.ctx.userId,
              errorCode: decision.error.code,
            });
            return reply
              .code(429)
              .header('retry-after', String(decision.error.retryAfterSeconds))
              .send({
                error: decision.error.code,
                retryAfterSeconds: decision.error.retryAfterSeconds,
              });
          }
        });

        authed.get('/me', (req) => {
          const actor = actorOf(req);
          return { userId: actor.ctx.userId, orgId: actor.ctx.orgId, role: actor.role };
        });

        authed.get('/comments/rollup', async (req) => {
          const actor = actorOf(req);
          // Rollup rows cover every live document in the org; narrow to what the
          // caller can actually open so counts are never an existence oracle.
          const [rollup, live, archived] = await Promise.all([
            deps.commentRollup.rollup(actor.ctx),
            listAccessibleDocuments(deps.documents, deps.grants, actor, { view: 'all' }),
            listAccessibleDocuments(deps.documents, deps.grants, actor, { view: 'archived' }),
          ]);
          const accessible = new Set([...live, ...archived].map((d) => d.id));
          return { rollup: rollup.filter((r) => accessible.has(r.documentId)) };
        });

        registerOrgRoutes(authed, {
          orgs: deps.organizations,
          documents: deps.documents,
          versions: deps.versions,
          grants: deps.grants,
        });
        registerExportRoutes(authed, {
          organizations: deps.organizations,
          documents: deps.documents,
          versions: deps.versions,
          comments: deps.comments,
          storage: deps.storage,
        });
        registerProjectRoutes(authed, {
          projects: deps.projects,
          documents: deps.documents,
          reviews: deps.reviews,
          grants: deps.grants,
          organizations: deps.organizations,
        });
        registerCommentRoutes(authed, {
          documents: deps.documents,
          comments: deps.comments,
          versions: deps.versions,
          resolutions: deps.resolutions,
          storage: deps.storage,
          grants: deps.grants,
          organizations: deps.organizations,
          reviews: deps.reviews,
          uploadUow: deps.uploadUow,
          apiKeys: deps.apiKeys,
        });
        registerReviewRoutes(authed, {
          documents: deps.documents,
          grants: deps.grants,
          comments: deps.comments,
          organizations: deps.organizations,
          reviews: deps.reviews,
          apiKeys: deps.apiKeys,
        });
        registerApiKeyRoutes(authed, deps.apiKeys);
        registerShareRoutes(authed, {
          documents: deps.documents,
          grants: deps.grants,
          organizations: deps.organizations,
        });
        registerGuestShareRoutes(authed, {
          documents: deps.documents,
          grants: deps.grants,
          organizations: deps.organizations,
          guests: deps.guests,
          email: deps.email,
          webAppUrl: deps.config.webAppUrl,
        });
        registerInviteRoutes(authed, {
          organizations: deps.organizations,
          invites: deps.invites,
          allowlist: deps.allowlist,
          email: deps.email,
          webAppUrl: deps.config.webAppUrl,
        });
        registerPublicHubAdminRoutes(authed, {
          publicHub: deps.publicHub,
          documents: deps.documents,
          versions: deps.versions,
          storage: deps.storage,
          config: deps.config,
        });
        registerDocumentRoutes(authed, {
          documents: deps.documents,
          projects: deps.projects,
          versions: deps.versions,
          organizations: deps.organizations,
          uploadUow: deps.uploadUow,
          storage: deps.storage,
          grants: deps.grants,
          search: deps.search,
          erasures: deps.erasures,
          reviews: deps.reviews,
          apiKeys: deps.apiKeys,
          uploadRateLimitMax: rateLimits.upload,
        });

        // Inside the session scope: Origin allowlist, session guard, CSRF,
        // guest allowlist and the per-user rate budget have all already run,
        // and req.actor is populated.
        for (const ext of extensions) {
          await ext.registerAuthenticated?.(authed, extensionContext);
        }
      });

      // Each isolated extension gets its own encapsulated scope, so the hooks
      // it installs to authenticate itself cannot leak onto core routes — or
      // onto another extension.
      for (const ext of extensions) {
        const register = ext.registerIsolated;
        if (!register) continue;
        await api.register(async (isolated) => {
          await register(isolated, extensionContext);
        });
      }
    },
    { prefix: '/api' },
  );

  return server;
}
