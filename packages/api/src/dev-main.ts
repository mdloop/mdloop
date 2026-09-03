import { Pool } from 'pg';
import type { AuthPort } from '@vorlyn/app';
import {
  FsStorage,
  OtelTelemetry,
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
  migrate,
  setupTelemetry,
} from '@vorlyn/persistence';
import { LoggingEmailAdapter } from './email/logging-email.adapter.js';
import { buildServer } from './server.js';

/**
 * Local development server (`make dev`): full stack on a persistent local
 * database with a loopback AuthPort — "hosted auth" bounces straight back to
 * the callback, so you can sign in without WorkOS keys. Every sign-in maps
 * to the same dev identity. NOT for production; main.ts is the real entry.
 */
if (process.env.NODE_ENV === 'production') {
  throw new Error('dev-main.ts (loopback auth) must never run with NODE_ENV=production');
}

const baseUrl = 'http://localhost:3000';
const webAppUrl = 'http://localhost:5173';
const dbName = process.env.DEV_DB_NAME ?? 'vorlyn_dev';
const adminUrl =
  process.env.DATABASE_URL ??
  `postgres://${process.env.USER ?? 'postgres'}@localhost:5432/postgres`;

// Create the dev database when missing, then migrate it.
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const exists = await admin.query('select 1 from pg_database where datname = $1', [dbName]);
if (exists.rowCount === 0) await admin.query(`create database ${dbName}`);
await admin.end();

const url = new URL(adminUrl);
url.pathname = `/${dbName}`;
const pool = new Pool({ connectionString: url.toString() });
const applied = await migrate(pool);
if (applied.length > 0) {
  // eslint-disable-next-line no-console
  console.log(`migrated: ${applied.join(', ')}`);
}

setupTelemetry('vorlyn-api-dev');

// Single instance: OrganizationRepository + OrgLifecyclePort (see main.ts's
// equivalent comment).
const organizations = new PgOrganizationRepository(pool);

const loopbackAuth: AuthPort = {
  authorizationUrl: (redirectUri, state) => `${redirectUri}?code=dev&state=${state}`,
  exchangeCode: () =>
    Promise.resolve({
      providerUserId: 'wos_dev_user',
      email: 'dev@vorlyn.local',
      displayName: 'Dev User',
    }),
};

const server = await buildServer({
  config: {
    baseUrl,
    webAppUrl,
    webOrigin: webAppUrl,
    sessionSecret: 'vorlyn-local-dev-secret-do-not-deploy-me',
    secureCookies: false,
  },
  auth: loopbackAuth,
  directory: new PgDirectoryRepository(pool),
  organizations,
  documents: new PgDocumentRepository(pool),
  projects: new PgProjectRepository(pool),
  versions: new PgVersionRepository(pool),
  uploadUow: new PgUploadUnitOfWork(pool),
  storage: new FsStorage(process.env.BLOB_STORAGE_DIR ?? '.vorlyn-blobs'),
  commentRollup: new PgCommentRollupReader(pool),
  comments: new PgCommentRepository(pool),
  reviews: new PgReviewRepository(pool),
  resolutions: new PgAnchorResolutionRepository(pool),
  grants: new PgShareGrantRepository(pool),
  apiKeys: new PgApiKeyRepository(pool),
  search: new PgSearchRepository(pool),
  telemetry: new OtelTelemetry(),
  orgLifecycle: organizations,
  erasures: new PgErasureLogRepository(pool),
  invites: new PgOrgInviteRepository(pool),
  allowlist: new PgAllowlistRepository(pool),
  guests: new PgGuestUserRepository(pool),
  email: new LoggingEmailAdapter(),
  publicHub: new PgPublicHubRepository(pool),
});

await server.listen({ port: 3000, host: '127.0.0.1' });
// eslint-disable-next-line no-console
console.log(`vorlyn api (dev, loopback auth) on ${baseUrl} — db ${dbName}`);
