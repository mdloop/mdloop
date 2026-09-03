import { Pool } from 'pg';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { actorForApiKey } from '@vorlyn/app';
import {
  FsStorage,
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
  poolConfigFromEnv,
} from '@vorlyn/persistence';
import { mcpStdioEnvFromEnv } from './env-config.js';
import type { McpDeps } from './server.js';
import { buildMcpServer } from './server.js';

/**
 * Stdio transport for local agents (Claude Code, etc.):
 *   VORLYN_API_KEY=vorlyn_... DATABASE_URL=... node packages/mcp/dist/stdio-main.js
 * The key maps to one user; the process serves exactly that identity.
 */
// Validate env before any pool setup — a typo'd var name/value fails loud
// here instead of limping along on a silently-wrong default. Subsumes the
// old bare `if (!key) throw`.
const env = mcpStdioEnvFromEnv();

// No setupTelemetry() here: its console exporters write to stdout, which
// this transport reserves for the JSON-RPC protocol. Spans/metrics fall
// back to OTel's no-op global providers (inert); structured logs still go
// to stderr via OtelTelemetry, which is safe.
const pool = new Pool({ connectionString: env.DATABASE_URL, ...poolConfigFromEnv() });
const telemetry = new OtelTelemetry();
logPoolFaults(pool, telemetry);
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
  storage: new FsStorage(env.BLOB_STORAGE_DIR ?? '.vorlyn-blobs'),
  apiKeys: new PgApiKeyRepository(pool),
  search: new PgSearchRepository(pool),
  telemetry,
  ...(env.WEB_APP_URL !== undefined ? { webAppUrl: env.WEB_APP_URL } : {}),
};

const actor = await actorForApiKey(deps.apiKeys, env.VORLYN_API_KEY);
if (!actor) throw new Error('invalid or revoked API key');

await buildMcpServer(deps, actor).connect(new StdioServerTransport());
