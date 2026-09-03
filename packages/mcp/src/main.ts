import { createServer } from 'node:http';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { API_KEY_PREFIX, UserRateLimiter, actorForApiKey, actorForOAuthToken } from '@vorlyn/app';
import type { Actor, RateLimiterPort } from '@vorlyn/app';
import {
  OtelTelemetry,
  PgAnchorResolutionRepository,
  PgApiKeyRepository,
  PgCommentRepository,
  PgDirectoryRepository,
  PgDocumentRepository,
  PgOrganizationRepository,
  PgProjectRepository,
  PgReviewRepository,
  PgSearchRepository,
  PgShareGrantRepository,
  PgUploadUnitOfWork,
  PgVersionRepository,
  RedisRateLimiter,
  assertNonSuperuserRole,
  logPoolFaults,
  pingPool,
  poolConfigFromEnv,
  setupTelemetry,
  storageFromEnv,
} from '@vorlyn/persistence';
import { mcpHttpEnvFromEnv } from './env-config.js';
import type { McpDeps } from './server.js';
import { buildMcpServer } from './server.js';
import { OidcJwtVerifier } from './auth/oidc-jwt-verifier.js';
import { bearerChallengeHeader, protectedResourceMetadata } from './well-known.js';

/**
 * MCP over streamable HTTP. Auth: `Authorization: Bearer vorlyn_...` per-user
 * API key, OR (ADR 0013) a WorkOS AuthKit-issued OAuth access token when MCP
 * OAuth is configured for this deployment — both resolve to the same Actor
 * shape and flow into the same buildMcpServer. Every request builds a server
 * bound to that Actor, so every tool runs through the same use-cases and RLS
 * as the HTTP API. Stateless (no session reuse) — fine for tool calling,
 * scales horizontally.
 */
// Validate env before any pool/telemetry/server setup — a typo'd var
// name/value fails loud here instead of limping along on a silently-wrong
// default.
const env = mcpHttpEnvFromEnv();

setupTelemetry('vorlyn-mcp');
const telemetry = new OtelTelemetry();

const pool = new Pool({ connectionString: env.DATABASE_URL, ...poolConfigFromEnv() });
logPoolFaults(pool, telemetry);
const port = env.MCP_PORT ?? 3001;

// Same RLS backstop as the HTTP API (CONSTITUTION §4): the MCP server runs
// every tool through the identical tenant-scoped query path, so a privileged
// login role would defeat isolation here too. Refuse to start.
await assertNonSuperuserRole(pool);

// Shared-store rate limiter (ADR 0010): unset REDIS_URL falls back to the
// in-process UserRateLimiter — same degrade-gracefully default as the HTTP
// API (packages/api/src/main.ts).
const redisClient = env.REDIS_URL ? new Redis(env.REDIS_URL) : undefined;
redisClient?.on('error', (err: Error) => {
  telemetry.log('process_fault', { errorCode: err.name, outcome: 'error' });
});
const redisRateLimiter = redisClient ? new RedisRateLimiter(redisClient) : undefined;
const userRateLimiter: RateLimiterPort = redisRateLimiter ?? new UserRateLimiter();

const deps: McpDeps = {
  documents: new PgDocumentRepository(pool),
  projects: new PgProjectRepository(pool),
  versions: new PgVersionRepository(pool),
  comments: new PgCommentRepository(pool),
  reviews: new PgReviewRepository(pool),
  resolutions: new PgAnchorResolutionRepository(pool),
  grants: new PgShareGrantRepository(pool),
  organizations: new PgOrganizationRepository(pool),
  uploadUow: new PgUploadUnitOfWork(pool),
  storage: storageFromEnv(),
  apiKeys: new PgApiKeyRepository(pool),
  search: new PgSearchRepository(pool),
  telemetry,
  // Process-level, not per-request: the server below is rebuilt per request,
  // so the budget state must live out here to mean anything.
  userRateLimiter,
  ...(env.WEB_APP_URL !== undefined ? { webAppUrl: env.WEB_APP_URL } : {}),
};

// OAuth (ADR 0013): only needed to resolve the `sub` claim of an
// AuthKit-issued token to a Vorlyn user — not part of McpDeps, since no MCP
// tool touches it directly.
const directory = new PgDirectoryRepository(pool);

// Built once at startup, not per-request, same as `deps` above.
// `mcpHttpEnvFromEnv`'s superRefine guarantees these three are either all
// set or all unset, and WORKOS_JWKS_URL is always populated (explicit or
// computed default) whenever WORKOS_CLIENT_ID is set — so this check alone
// is enough to know OAuth is fully configured.
const oauthVerifier =
  env.WORKOS_CLIENT_ID &&
  env.WORKOS_AUTHKIT_ISSUER &&
  env.MCP_RESOURCE_INDICATOR &&
  env.WORKOS_JWKS_URL
    ? new OidcJwtVerifier({
        jwksUrl: env.WORKOS_JWKS_URL,
        issuer: env.WORKOS_AUTHKIT_ISSUER,
        audience: env.MCP_RESOURCE_INDICATOR,
      })
    : undefined;

function errorCodeOf(e: unknown): string {
  return e instanceof Error ? e.name : 'unknown_error';
}

/** Bearer-token dispatch: `vorlyn_`-prefixed → the existing API-key path
 * (unchanged, stays primary for headless/agent use); anything else → the
 * OAuth path, only when this deployment has one configured. */
async function actorForBearerToken(token: string): Promise<Actor | undefined> {
  if (token.startsWith(API_KEY_PREFIX)) return actorForApiKey(deps.apiKeys, token);
  if (!oauthVerifier) return undefined;
  return actorForOAuthToken(directory, oauthVerifier, token);
}

const http = createServer((req, res) => {
  void (async () => {
    // Liveness/readiness (matching packages/api/src/server.ts): a
    // deployment's load balancer typically health-checks /readyz uniformly
    // across services, so mcp needs these even though its own traffic only
    // ever uses /mcp.
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/readyz') {
      const ready = await pingPool(pool);
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready' }));
      return;
    }
    // RFC 9728 protected-resource discovery (ADR 0013): 404 when this
    // deployment has no MCP OAuth configured at all — a client has nothing
    // to discover, and the shape of "not found" here matches every other
    // unrecognized route on this server.
    if (req.url === '/.well-known/oauth-protected-resource') {
      if (!oauthVerifier || !env.MCP_RESOURCE_INDICATOR || !env.WORKOS_AUTHKIT_ISSUER) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          protectedResourceMetadata(env.MCP_RESOURCE_INDICATOR, env.WORKOS_AUTHKIT_ISSUER),
        ),
      );
      return;
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const header = req.headers.authorization ?? '';
    const key = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const actor = key ? await actorForBearerToken(key) : undefined;
    if (!actor) {
      res.writeHead(401, {
        'content-type': 'application/json',
        // Tells an MCP client where to discover the OAuth path (RFC 9728
        // §5.1) — harmless to send even when this deployment has no OAuth
        // configured; the metadata route above just 404s if so followed.
        ...(env.MCP_RESOURCE_INDICATOR
          ? { 'www-authenticate': bearerChallengeHeader(env.MCP_RESOURCE_INDICATOR) }
          : {}),
      });
      res.end(JSON.stringify({ error: 'invalid_api_key' }));
      return;
    }
    const server = buildMcpServer(deps, actor);
    // Stateless mode: omitting sessionIdGenerator (rather than setting it to
    // undefined) satisfies exactOptionalPropertyTypes while producing the
    // same "no session tracking" behavior — a fresh server per request.
    const transport = new StreamableHTTPServerTransport({});
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res);
  })().catch((e: unknown) => {
    // Previously swallowed entirely — the request just silently 500'd, no
    // signal a fault happened at all.
    telemetry.log('process_fault', { errorCode: errorCodeOf(e), outcome: 'error' });
    // Sanitized envelope, mirroring the HTTP API's fault handler (Phase 24.E):
    // a static code, never the error message.
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
    }
  });
});

process.on('uncaughtException', (e: unknown) => {
  telemetry.log('process_fault', { errorCode: errorCodeOf(e), outcome: 'error' });
  process.exit(1);
});
process.on('unhandledRejection', (e: unknown) => {
  telemetry.log('process_fault', { errorCode: errorCodeOf(e), outcome: 'error' });
});

const DRAIN_TIMEOUT_MS = 10_000;

function shutdown(): void {
  const forceExit = setTimeout(() => process.exit(1), DRAIN_TIMEOUT_MS);
  forceExit.unref();
  http.close(() => {
    void Promise.all([pool.end(), redisRateLimiter?.close()]).finally(() => process.exit(0));
  });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, shutdown);
}

http.listen(port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`vorlyn mcp on :${String(port)}/mcp`);
});
