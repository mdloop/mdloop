import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { FastifyInstance } from 'fastify';
import type { Actor, AuthPort } from '@vorlyn/app';
import { FakeEmail, NoopTelemetry } from '@vorlyn/app/test-support';
import { buildServer } from '@vorlyn/api';
import { csrfTokenForSession } from '@vorlyn/api/test-support';
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

/**
 * ARCHITECTURE.md §9 — API/MCP parity: the HTTP API and the MCP server are
 * thin transports over the same use-cases and the same RLS-scoped data. This
 * drives one fixture through both transports and checks they agree.
 */
const fakeAuth: AuthPort = {
  authorizationUrl: (redirectUri, state) =>
    `https://auth.example/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
  exchangeCode: (code: string) => {
    const id = code.replace('code-', '');
    return Promise.resolve({
      providerUserId: `wos_${id}`,
      email: `${id}@example.test`,
      displayName: id,
    });
  },
};

interface JsonToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

function parse(result: JsonToolResult): unknown {
  return JSON.parse(result.content[0]?.text ?? 'null');
}

describe('API / MCP parity', () => {
  let db: TestDb;
  let server: FastifyInstance;
  let mcpDeps: McpDeps;
  let actor: Actor;
  let sessionCookie: string;

  /** CSRF cookie+header pair for the current sessionCookie (Phase 24). */
  function csrfFor(): { cookies: Record<string, string>; headers: Record<string, string> } {
    const csrf = csrfTokenForSession(sessionCookie);
    return {
      cookies: { vorlyn_session: sessionCookie, vorlyn_csrf: csrf },
      headers: { 'x-csrf-token': csrf },
    };
  }

  async function connectMcp(): Promise<Client> {
    const mcpServer = buildMcpServer(mcpDeps, actor);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'parity-test', version: '0.0.1' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  beforeAll(async () => {
    db = await createTestDb();
    const storage = new FsStorage(await mkdtemp(path.join(tmpdir(), 'vorlyn-parity-blobs-')));
    // Single instance: OrganizationRepository + OrgLifecyclePort (see
    // main.ts's equivalent comment).
    const organizations = new PgOrganizationRepository(db.pool);

    server = await buildServer({
      config: {
        baseUrl: 'http://localhost:3000',
        webAppUrl: 'http://localhost:5173',
        webOrigin: 'http://localhost:5173',
        sessionSecret: 'a'.repeat(32),
        secureCookies: false,
      },
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
      publicHub: new PgPublicHubRepository(db.pool),
      telemetry: new NoopTelemetry(),
      orgLifecycle: organizations,
      erasures: new PgErasureLogRepository(db.pool),
      invites: new PgOrgInviteRepository(db.pool),
      allowlist: new PgAllowlistRepository(db.pool),
      guests: new PgGuestUserRepository(db.pool),
      email: new FakeEmail(),
    });

    const login = await server.inject({ method: 'GET', url: '/api/auth/login' });
    const stateCookie = login.cookies.find((c) => c.name === 'vorlyn_oauth_state');
    const state = new URL(String(login.headers.location)).searchParams.get('state');
    if (!stateCookie || state === null) throw new Error('login redirect missing OAuth state');
    const callback = await server.inject({
      method: 'GET',
      url: `/api/auth/callback?code=code-owner&state=${state}`,
      cookies: { vorlyn_oauth_state: stateCookie.value },
    });
    const session = callback.cookies.find((c) => c.name === 'vorlyn_session');
    if (!session) throw new Error('callback set no session cookie');
    sessionCookie = session.value;

    const directory = new PgDirectoryRepository(db.pool);
    const user = await directory.userByWorkosId('wos_owner');
    if (!user) throw new Error('login did not provision a user');
    actor = { ctx: { orgId: user.orgId, userId: user.id }, role: user.role };

    mcpDeps = {
      documents: new PgDocumentRepository(db.pool),
      projects: new PgProjectRepository(db.pool),
      versions: new PgVersionRepository(db.pool),
      comments: new PgCommentRepository(db.pool),
      reviews: new PgReviewRepository(db.pool),
      resolutions: new PgAnchorResolutionRepository(db.pool),
      grants: new PgShareGrantRepository(db.pool),
      organizations,
      uploadUow: new PgUploadUnitOfWork(db.pool),
      storage,
      apiKeys: new PgApiKeyRepository(db.pool),
      search: new PgSearchRepository(db.pool),
      telemetry: new NoopTelemetry(),
    };
  }, 60_000);

  afterAll(async () => {
    await server.close();
    await db.close();
  });

  it('a document uploaded over HTTP is visible and byte-identical over MCP', async () => {
    const upload = await server.inject({
      method: 'POST',
      url: '/api/documents',
      ...csrfFor(),
      payload: { title: 'parity.md', content: '# Parity\n\nSame bytes, either door.' },
    });
    expect(upload.statusCode).toBe(201);
    const { document } = upload.json<{ document: { id: string } }>();

    const client = await connectMcp();
    const fetched = parse(
      (await client.callTool({
        name: 'get_document',
        arguments: { document_id: document.id },
      })) as JsonToolResult,
    ) as { id: string; title: string; content: string };
    expect(fetched).toMatchObject({
      id: document.id,
      title: 'parity.md',
      content: '# Parity\n\nSame bytes, either door.',
    });

    const listed = parse(
      (await client.callTool({ name: 'list_documents', arguments: {} })) as JsonToolResult,
    ) as { id: string }[];
    expect(listed.map((d) => d.id)).toContain(document.id);
    await client.close();
  });

  it('a comment created over MCP is visible over HTTP, and vice versa', async () => {
    const upload = await server.inject({
      method: 'POST',
      url: '/api/documents',
      ...csrfFor(),
      payload: { title: 'thread.md', content: '# Thread' },
    });
    const { document } = upload.json<{ document: { id: string } }>();

    const client = await connectMcp();
    const viaMcp = parse(
      (await client.callTool({
        name: 'create_comment',
        arguments: { document_id: document.id, body: 'from an agent' },
      })) as JsonToolResult,
    ) as { comment_id: string };

    const httpThreads = await server.inject({
      method: 'GET',
      url: `/api/documents/${document.id}/comments`,
      cookies: { vorlyn_session: sessionCookie },
    });
    expect(httpThreads.statusCode).toBe(200);
    const httpBody = httpThreads.json<{ threads: { comment: { id: string; body: string } }[] }>();
    expect(httpBody.threads.map((t) => t.comment.id)).toContain(viaMcp.comment_id);

    const httpReply = await server.inject({
      method: 'POST',
      url: `/api/comments/${viaMcp.comment_id}/replies`,
      ...csrfFor(),
      payload: { body: 'from the web' },
    });
    expect(httpReply.statusCode).toBe(201);

    const bundle = (await client.callTool({
      name: 'get_feedback_bundle',
      arguments: { document_id: document.id },
    })) as unknown as {
      structuredContent: { items: { commentId: string; replies: { body: string }[] }[] };
    };
    const item = bundle.structuredContent.items.find((i) => i.commentId === viaMcp.comment_id);
    expect(item?.replies.map((r) => r.body)).toContain('from the web');

    await client.close();
  });
});
