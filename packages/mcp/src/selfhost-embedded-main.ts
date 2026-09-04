import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Pool } from 'pg';
import open from 'open';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { API_KEY_PREFIX, UnlimitedRateLimiter, actorForApiKey } from '@mdloop/app';
import type { Actor, RateLimiterPort } from '@mdloop/app';
import {
  OtelTelemetry,
  PgAnchorResolutionRepository,
  PgApiKeyRepository,
  PgCommentRepository,
  PgDocumentRepository,
  PgOrganizationRepository,
  PgProjectRepository,
  PgReviewRepository,
  PgSearchRepository,
  PgShareGrantRepository,
  PgUploadUnitOfWork,
  PgVersionRepository,
  logPoolFaults,
  pingPool,
  poolConfigFromEnv,
  setupTelemetryIfAvailable,
  storageFromEnv,
} from '@mdloop/persistence';
import { mcpHttpEnvFromEnv } from './env-config.js';
import type { McpDeps } from './server.js';
import { buildMcpServer } from './server.js';

/**
 * MCP-over-HTTP embedded-mode composition root — the second child process
 * `mdloop open ./folder` (packages/cli/src/open.ts) spawns, sibling to
 * `@mdloop/api`'s `selfhost-embedded-main.ts`. Deliberately near-identical
 * to `main.ts` (same telemetry/pool/fault-handling/`/healthz`+`/readyz`/
 * `/mcp` shape) with the same two categories of difference `@mdloop/api`'s
 * embedded entrypoint carries, applied here for the same reasons:
 *
 *   1. No `assertNonSuperuserRole` call — see
 *      `packages/persistence/src/embedded-postgres.ts`'s module doc comment
 *      for the full reasoning; `packages/api/src/selfhost-embedded-main.ts`
 *      restates it in full rather than duplicating it a third time. Short
 *      version: PGlite's only login identity is the `postgres` superuser,
 *      the check would (correctly) refuse to run against it, and RLS itself
 *      stays enforced regardless (`withTenant()`'s unconditional `set local
 *      role mdloop_app`). `main.ts`'s own call is untouched.
 *   2. No MCP OAuth (`WorkosJwtVerifier`) and no Redis-backed rate limiter —
 *      an embedded instance is single-user and single-process by
 *      construction: there is no second identity for OAuth to distinguish,
 *      and no fleet of instances for a shared-store rate limiter to
 *      coordinate across. Auth is the plain `mdloop_`-prefixed API-key path
 *      only, unconditionally `UnlimitedRateLimiter` (matching the choice
 *      `buildSelfHostServerDeps` makes for the sibling API process).
 *
 * Why this file exists at all rather than reusing `main.ts` unmodified: MCP
 * is a wholly separate process from the HTTP API in this codebase (`main.ts`
 * listens on its own port, e.g. 3001, independent of `@mdloop/api`'s 3000 —
 * `packages/cli/src/link.ts`'s `DEFAULT_ENDPOINT` already assumes this
 * split). `mdloop open`'s CLI-driven push/link step talks to mdloop over MCP
 * (`packages/cli/src/mcp-client.ts`, `StreamableHTTPClientTransport`), so
 * the embedded composition needs an embedded-mode MCP endpoint just as much
 * as it needs an embedded-mode HTTP API — without this file, `mdloop link`/
 * `mdloop push` would have nothing local to connect to.
 */
const env = mcpHttpEnvFromEnv();

await setupTelemetryIfAvailable('mdloop-mcp-selfhost-embedded');
const telemetry = new OtelTelemetry();

const pool = new Pool({ connectionString: env.DATABASE_URL, ...poolConfigFromEnv() });
logPoolFaults(pool, telemetry);
// `MCP_PORT` is always set by the CLI that spawns this process
// (`packages/cli/src/local-instance.ts`'s `DEFAULT_MCP_PORT`, or a caller's
// explicit override of it) — fixed rather than freshly OS-assigned per
// boot, so an MCP endpoint URL stays valid across a `mdloop serve`
// restart; not 3001, still uncommon enough to be unlikely to collide with
// something else on a dev machine. `0` (ask the OS) only when a caller
// skips the CLI entirely. The real bound port is announced to `mcp.port`
// below for `mdloop`'s CLI-side supervisor to read either way.
const port = env.MCP_PORT ?? 0;

// Difference 1 (see module doc comment above): no assertNonSuperuserRole.

// Difference 2: no OAuth verifier, no Redis — see module doc comment.
const userRateLimiter: RateLimiterPort = new UnlimitedRateLimiter();

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
  userRateLimiter,
};

function errorCodeOf(e: unknown): string {
  return e instanceof Error ? e.name : 'unknown_error';
}

/**
 * Same opt-out shape as `MDLOOP_AUTO` (`claude-plugin/hooks/mdloop-ensure.sh`):
 * unset/anything-but-"0" is on, "0" is the escape hatch. On by default
 * because a single local user IS the reviewer here — there is no one else
 * for `request_review` to have been called for, so popping their own
 * browser to the document is the seamless-by-default case this exists for,
 * not an opt-in extra.
 */
const autoOpenReview = process.env.MDLOOP_AUTO_OPEN_REVIEW !== '0';

/**
 * `upload_document`/`request_review`'s `url` field (see `McpDeps.webAppUrl`)
 * needs the sibling `@mdloop/api` embedded child's port — a process this
 * one doesn't spawn and has no other channel to. Both children write only
 * their own port file, so this reads the other one's: `<dataDir>/api.port`,
 * the same file `packages/cli/src/local-instance.ts` polls to learn it too.
 * Deliberately a single best-effort read, not that same bounded poll —
 * blocking every tool call on it would couple this process's request
 * latency to a sibling it doesn't otherwise depend on, and the two children
 * are spawned concurrently (`local-instance.ts`), so on the very first
 * request the file may genuinely not exist yet. Cached after the first
 * success (the api child's port never changes for the life of this
 * process); a miss just means this call's response omits `url` — never a
 * stale or guessed one.
 */
let cachedWebAppUrl: string | undefined;
async function resolveWebAppUrl(): Promise<string | undefined> {
  if (cachedWebAppUrl) return cachedWebAppUrl;
  const dataDir = process.env.MDLOOP_DATA_DIR;
  if (!dataDir) return undefined;
  try {
    const raw = await readFile(path.join(dataDir, 'api.port'), 'utf8');
    const apiPort = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(apiPort) || apiPort <= 0) return undefined;
    cachedWebAppUrl = `http://127.0.0.1:${String(apiPort)}`;
    return cachedWebAppUrl;
  } catch {
    return undefined;
  }
}

/** Only the `mdloop_`-prefixed API-key path — no OAuth branch (difference 2 above). */
async function actorForBearerToken(token: string): Promise<Actor | undefined> {
  if (!token.startsWith(API_KEY_PREFIX)) return undefined;
  return actorForApiKey(deps.apiKeys, token);
}

const http = createServer((req, res) => {
  void (async () => {
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
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const header = req.headers.authorization ?? '';
    const key = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const actor = key ? await actorForBearerToken(key) : undefined;
    if (!actor) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_api_key' }));
      return;
    }
    const webAppUrl = await resolveWebAppUrl();
    const server = buildMcpServer(
      {
        ...deps,
        ...(webAppUrl !== undefined ? { webAppUrl } : {}),
        ...(autoOpenReview
          ? {
              onReviewRequested: (url: string) => {
                // Fire-and-forget: a headless embedded environment (no
                // display, no default-browser handler configured) failing
                // to launch anything must never surface as an error to the
                // agent that successfully requested review.
                void open(url).catch(() => undefined);
              },
            }
          : {}),
      },
      actor,
    );
    const transport = new StreamableHTTPServerTransport({});
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res);
  })().catch((e: unknown) => {
    telemetry.log('process_fault', { errorCode: errorCodeOf(e), outcome: 'error' });
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
    void pool.end().finally(() => process.exit(0));
  });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, shutdown);
}

// A plain `http.Server` throws an uncaught exception on a bind failure with
// no listener for its own `'error'` event — the process.on('uncaughtException')
// handler above would still catch it, but only as an opaque
// telemetry-logged error, with no hint that `port` (a fixed default now,
// not always OS-assigned — see @mdloop/cli's `DEFAULT_MCP_PORT`) is the
// actual, fixable cause. Named explicitly here instead.
http.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    // eslint-disable-next-line no-console
    console.error(
      `Port ${String(port)} is already in use by something else. Set MCP_PORT to a free port and try again.`,
    );
  } else {
    console.error(err); // eslint-disable-line no-console
  }
  process.exit(1);
});

http.listen(port, '127.0.0.1', () => {
  const boundPort = (http.address() as AddressInfo).port;
  // eslint-disable-next-line no-console
  console.log(`mdloop mcp (embedded) on :${String(boundPort)}/mcp`);
  // Announced for the CLI-side supervisor (packages/cli/src/local-instance.ts)
  // to discover — see the matching comment on @mdloop/api's embedded main.
  // Same fail-fast posture as that file: MDLOOP_DATA_DIR is set by the CLI
  // on every spawn of this process, never a human-edited .env.
  const dataDir = process.env.MDLOOP_DATA_DIR;
  if (!dataDir) {
    throw new Error(
      'MDLOOP_DATA_DIR must be set — this entrypoint is only ever spawned by the CLI',
    );
  }
  void writeFile(path.join(dataDir, 'mcp.port'), `${String(boundPort)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
});
