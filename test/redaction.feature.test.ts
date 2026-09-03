import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFeature, describeFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Actor } from '@vorlyn/app';
import { FakeEmail, CapturingTelemetry } from '@vorlyn/app/test-support';
import { buildServer } from '@vorlyn/api';
import { testConfig, fakeAuth, loginAs, csrfTokenForSession } from '@vorlyn/api/test-support';
import { buildMcpServer } from '@vorlyn/mcp';
import type { McpDeps } from '@vorlyn/mcp';
import {
  FsStorage,
  PgAllowlistRepository,
  PgAnchorResolutionRepository,
  PgErasureLogRepository,
  PgApiKeyRepository,
  PgCommentRepository,
  PgCommentRollupReader,
  PgDirectoryRepository,
  PgGuestUserRepository,
  PgDocumentRepository,
  PgOrganizationRepository,
  PgOrgInviteRepository,
  PgProjectRepository,
  PgPublicHubRepository,
  PgSearchRepository,
  PgShareGrantRepository,
  PgUploadUnitOfWork,
  PgReviewRepository,
  PgVersionRepository,
} from '@vorlyn/persistence';
import { createTestDb } from '@vorlyn/persistence/test-support';
import type { TestDb } from '@vorlyn/persistence/test-support';

const feature = await loadFeature(
  fileURLToPath(new URL('../features/redaction.feature', import.meta.url)),
);

interface World {
  db: TestDb;
  telemetry: CapturingTelemetry;
  server: FastifyInstance;
  session: string;
  emailLocalPart: string;
  email: string;
  documentId: string;
  title: string;
  bodySecret: string;
  commentText: string;
}

describeFeature(feature, ({ Scenario }) => {
  Scenario(
    'Structured telemetry never contains document content or identity strings',
    ({ Given, Then, And }) => {
      const w = {} as World;

      Given('an organization with a user whose email is distinctive', async () => {
        w.db = await createTestDb();
        w.telemetry = new CapturingTelemetry();
        w.emailLocalPart = `redact-marker-${String(Math.random()).slice(2)}`;
        w.email = `${w.emailLocalPart}@example.test`;

        const storage = new FsStorage(await mkdtemp(path.join(tmpdir(), 'vorlyn-redact-blobs-')));
        // Single instance: OrganizationRepository + OrgLifecyclePort (see
        // main.ts's equivalent comment).
        const organizations = new PgOrganizationRepository(w.db.pool);
        w.server = await buildServer({
          config: testConfig,
          auth: fakeAuth,
          directory: new PgDirectoryRepository(w.db.pool),
          organizations,
          documents: new PgDocumentRepository(w.db.pool),
          projects: new PgProjectRepository(w.db.pool),
          versions: new PgVersionRepository(w.db.pool),
          uploadUow: new PgUploadUnitOfWork(w.db.pool),
          storage,
          commentRollup: new PgCommentRollupReader(w.db.pool),
          comments: new PgCommentRepository(w.db.pool),
          reviews: new PgReviewRepository(w.db.pool),
          resolutions: new PgAnchorResolutionRepository(w.db.pool),
          grants: new PgShareGrantRepository(w.db.pool),
          apiKeys: new PgApiKeyRepository(w.db.pool),
          search: new PgSearchRepository(w.db.pool),
          publicHub: new PgPublicHubRepository(w.db.pool),
          telemetry: w.telemetry,
          orgLifecycle: organizations,
          erasures: new PgErasureLogRepository(w.db.pool),
          invites: new PgOrgInviteRepository(w.db.pool),
          allowlist: new PgAllowlistRepository(w.db.pool),
          guests: new PgGuestUserRepository(w.db.pool),
          email: new FakeEmail(),
        });
        w.session = await loginAs(w.server, w.emailLocalPart);
      });

      And('that user uploads a document with a distinctive title and body secret', async () => {
        w.title = `TopSecretRunbook-${w.emailLocalPart}.md`;
        w.bodySecret = `do-not-log-me-${w.emailLocalPart}`;
        const csrf = csrfTokenForSession(w.session);
        const uploaded = await w.server.inject({
          method: 'POST',
          url: '/api/documents',
          cookies: { vorlyn_session: w.session, vorlyn_csrf: csrf },
          headers: { 'x-csrf-token': csrf },
          payload: { title: w.title, content: `# ${w.title}\n\n${w.bodySecret}` },
        });
        expect(uploaded.statusCode, uploaded.body).toBe(201);
        w.documentId = uploaded.json<{ document: { id: string } }>().document.id;
      });

      And('that user comments on the document with distinctive text', async () => {
        w.commentText = `please-redact-this-${w.emailLocalPart}`;
        const csrf = csrfTokenForSession(w.session);
        const commented = await w.server.inject({
          method: 'POST',
          url: `/api/documents/${w.documentId}/comments`,
          cookies: { vorlyn_session: w.session, vorlyn_csrf: csrf },
          headers: { 'x-csrf-token': csrf },
          payload: { body: w.commentText, anchor: { type: 'document' } },
        });
        expect(commented.statusCode, commented.body).toBe(201);
        await w.server.inject({
          method: 'GET',
          url: `/api/documents/search?q=${w.emailLocalPart}`,
          cookies: { vorlyn_session: w.session },
        });
        await w.server.close();
      });

      And('an MCP client searches for the document by its distinctive title', async () => {
        const directory = new PgDirectoryRepository(w.db.pool);
        const user = await directory.userByWorkosId(`wos_${w.emailLocalPart}`);
        if (!user) throw new Error('setup: user not provisioned');
        const actor: Actor = { ctx: { orgId: user.orgId, userId: user.id }, role: user.role };

        const mcpDeps: McpDeps = {
          documents: new PgDocumentRepository(w.db.pool),
          projects: new PgProjectRepository(w.db.pool),
          versions: new PgVersionRepository(w.db.pool),
          comments: new PgCommentRepository(w.db.pool),
          reviews: new PgReviewRepository(w.db.pool),
          resolutions: new PgAnchorResolutionRepository(w.db.pool),
          grants: new PgShareGrantRepository(w.db.pool),
          organizations: new PgOrganizationRepository(w.db.pool),
          uploadUow: new PgUploadUnitOfWork(w.db.pool),
          storage: new FsStorage(await mkdtemp(path.join(tmpdir(), 'vorlyn-redact-mcp-blobs-'))),
          apiKeys: new PgApiKeyRepository(w.db.pool),
          search: new PgSearchRepository(w.db.pool),
          telemetry: w.telemetry,
        };
        const mcpServer = buildMcpServer(mcpDeps, actor);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'redaction-test', version: '0.0.1' });
        await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
        await client.callTool({ name: 'search_documents', arguments: { query: w.title } });
        await client.close();
        await w.db.close();
      });

      Then("no captured telemetry field contains the user's email", () => {
        // Guards against a vacuous pass if instrumentation silently stops firing.
        expect(w.telemetry.logs.length).toBeGreaterThan(0);
        expect(w.telemetry.allStrings().some((s) => s.includes(w.email))).toBe(false);
      });

      And('no captured telemetry field contains the document title', () => {
        expect(w.telemetry.allStrings().some((s) => s.includes(w.title))).toBe(false);
      });

      And('no captured telemetry field contains the document body secret', () => {
        expect(w.telemetry.allStrings().some((s) => s.includes(w.bodySecret))).toBe(false);
      });

      And('no captured telemetry field contains the comment text', () => {
        expect(w.telemetry.allStrings().some((s) => s.includes(w.commentText))).toBe(false);
      });
    },
  );
});
