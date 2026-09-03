import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

export interface FakeDocument {
  id: string;
  title: string;
  versionSeq: number;
  content: string;
  /** Note recorded on the last upload, so tests can assert --note wiring. */
  changeNote?: string | null;
  /** Overrides the derived permission, for pre-flight refusal cases. */
  myPermission?: string;
  /** Repo-relative path recorded on the last upload (Phase 29 backfill, C1),
   *  so tests can assert the CLI sends it on both the new-document and
   *  new-version branches. */
  path?: string | null;
}

export interface FakeOrgUsage {
  tier: string;
  activeDocCount: number;
  maxActiveDocs: number | null;
  projectUsage?: { activeDocCount: number; maxActiveDocsPerProject: number | null };
}

export interface FakeMcpServerState {
  documents: Map<string, FakeDocument>;
  projects: { id: string; name: string; color: string }[];
  maxConcurrentUploads: number;
  currentConcurrentUploads: number;
  uploadDelayMs: number;
  callCounts: Record<string, number>;
  /**
   * `get_org_usage`'s response (Phase 33.D). Defaults to a tier with plenty
   * of headroom so existing push/status tests that never touch this field
   * see no warning. Set to `'fail'` to simulate the tool erroring — the
   * pre-flight warning must fail open, never block a push, so that's a real
   * scenario worth being able to construct.
   */
  orgUsage: FakeOrgUsage | 'fail';
}

export interface FakeMcpServer {
  url: string;
  apiKey: string;
  state: FakeMcpServerState;
  close: () => Promise<void>;
}

function jsonResult(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errorResult(
  code: string,
  extra?: { limit: number; message: string },
): { content: { type: 'text'; text: string }[]; isError: true } {
  const payload = extra ? { error: code, ...extra } : { error: code };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
}

function countCall(state: FakeMcpServerState, name: string): void {
  state.callCounts[name] = (state.callCounts[name] ?? 0) + 1;
}

function buildFakeServer(
  state: FakeMcpServerState,
  nextId: () => string,
  nextProjectId: () => string,
): McpServer {
  const server = new McpServer({ name: 'vorlyn-fake', version: '0.0.1' });

  server.registerTool('list_projects', { description: 'fake', inputSchema: {} }, () => {
    countCall(state, 'list_projects');
    return Promise.resolve(jsonResult(state.projects));
  });

  server.registerTool(
    'create_project',
    {
      description: 'fake',
      inputSchema: { name: z.string(), color: z.string().optional() },
    },
    ({ name, color }) => {
      countCall(state, 'create_project');
      const trimmed = name.trim();
      if (trimmed.length === 0 || trimmed.length > 120) {
        return Promise.resolve(errorResult('invalid_name'));
      }
      if (color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(color)) {
        return Promise.resolve(errorResult('invalid_color'));
      }
      const project = { id: nextProjectId(), name: trimmed, color: color ?? '#6366f1' };
      state.projects.push(project);
      return Promise.resolve(jsonResult(project));
    },
  );

  server.registerTool(
    'get_document',
    { description: 'fake', inputSchema: { document_id: z.string() } },
    ({ document_id }) => {
      countCall(state, 'get_document');
      if (document_id === 'doc_forbidden') return Promise.resolve(errorResult('forbidden'));
      const doc = state.documents.get(document_id);
      if (!doc) return Promise.resolve(errorResult('not_found'));
      return Promise.resolve(
        jsonResult({
          id: doc.id,
          title: doc.title,
          version_seq: doc.versionSeq,
          content: doc.content,
        }),
      );
    },
  );

  server.registerTool(
    'get_document_status',
    { description: 'fake', inputSchema: { document_id: z.string() } },
    ({ document_id }) => {
      countCall(state, 'get_document_status');
      if (document_id === 'doc_forbidden') return Promise.resolve(errorResult('forbidden'));
      const doc = state.documents.get(document_id);
      if (!doc) return Promise.resolve(errorResult('not_found'));
      return Promise.resolve(
        jsonResult({
          document_id: doc.id,
          version_seq: doc.versionSeq,
          // The real tool returns bare sha256 hex (`contentHashOf`), no
          // `sha256:` prefix — that prefix is the CLI manifest's own
          // convention. Mirror the server, not the manifest.
          content_hash: createHash('sha256').update(doc.content).digest('hex'),
          my_permission: doc.myPermission ?? 'edit',
        }),
      );
    },
  );

  server.registerTool(
    'upload_document',
    {
      description: 'fake',
      inputSchema: {
        content: z.string(),
        document_id: z.string().optional(),
        title: z.string().optional(),
        project_id: z.string().optional(),
        change_note: z.string().optional(),
        path: z.string().optional(),
      },
    },
    async ({ content, document_id, title, change_note, path }) => {
      countCall(state, 'upload_document');
      state.currentConcurrentUploads += 1;
      state.maxConcurrentUploads = Math.max(
        state.maxConcurrentUploads,
        state.currentConcurrentUploads,
      );
      try {
        if (state.uploadDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, state.uploadDelayMs));
        }
        if (document_id === 'doc_forbidden') return errorResult('forbidden');
        // Sentinel for tests exercising the tier-cap enriched-message path
        // (packages/cli/src/push.test.ts): a new document titled this way, or
        // an append to this document id, always comes back as a cap breach
        // carrying `limit`/`message` — mirroring what the real MCP server
        // produces for doc_cap_exceeded (packages/mcp/src/server.ts).
        if (title === 'cap-exceeded' || document_id === 'doc_cap_exceeded') {
          return errorResult('doc_cap_exceeded', {
            limit: 100,
            message:
              "This org already has 100 active documents, this tier's limit — the upload was rejected and nothing changed. Free up headroom (archive or delete documents) or upgrade tier, then retry.",
          });
        }
        // Sentinels for the two path-conflict codes (C1 backfill,
        // packages/cli/src/push.test.ts) — mirror what the real MCP server
        // produces once `path` is validated/uniqueness-checked server-side.
        // Neither carries a `message`: push.ts sources the friendly text
        // locally for these two.
        if (path === 'taken/path.md') return errorResult('path_taken');
        if (path === 'bad//path.md') return errorResult('invalid_path');
        if (document_id) {
          const existing = state.documents.get(document_id);
          if (!existing) return errorResult('not_found');
          existing.content = content;
          existing.versionSeq += 1;
          existing.changeNote = change_note ?? null;
          if (path !== undefined) existing.path = path;
          return jsonResult({
            document_id: existing.id,
            version_seq: existing.versionSeq,
            deduplicated: false,
          });
        }
        const id = nextId();
        const doc: FakeDocument = {
          id,
          title: title ?? id,
          versionSeq: 1,
          content,
          changeNote: change_note ?? null,
          path: path ?? null,
        };
        state.documents.set(id, doc);
        return jsonResult({ document_id: id, version_seq: 1, deduplicated: false });
      } finally {
        state.currentConcurrentUploads -= 1;
      }
    },
  );

  server.registerTool(
    'get_org_usage',
    { description: 'fake', inputSchema: { project_id: z.string().optional() } },
    ({ project_id }) => {
      countCall(state, 'get_org_usage');
      if (state.orgUsage === 'fail') return Promise.resolve(errorResult('org_not_found'));
      const usage = state.orgUsage;
      return Promise.resolve(
        jsonResult({
          tier: usage.tier,
          active_doc_count: usage.activeDocCount,
          max_active_docs: usage.maxActiveDocs,
          ...(project_id && usage.projectUsage
            ? {
                project_usage: {
                  active_doc_count: usage.projectUsage.activeDocCount,
                  max_active_docs_per_project: usage.projectUsage.maxActiveDocsPerProject,
                },
              }
            : {}),
        }),
      );
    },
  );

  return server;
}

/**
 * A throwaway MCP server for CLI integration tests — registers fake tools
 * shaped like the real `list_projects`/`create_project`/`get_document`/
 * `get_document_status`/`upload_document`
 * (packages/mcp/src/server.ts), wired over a real node:http +
 * StreamableHTTPServerTransport round trip so tests exercise the CLI's
 * actual HTTP transport code, including the Authorization header. The `cli`
 * package may not import `@vorlyn/mcp` (dependency-cruiser `cli-http-only`),
 * so this is built directly from the SDK, mirroring packages/mcp/src/main.ts's
 * per-request server pattern.
 */
export async function startFakeMcpServer(
  opts: { apiKey?: string; uploadDelayMs?: number } = {},
): Promise<FakeMcpServer> {
  const apiKey = opts.apiKey ?? 'vorlyn_test_key';
  const state: FakeMcpServerState = {
    documents: new Map(),
    projects: [
      { id: 'proj_1', name: 'Alpha', color: 'blue' },
      { id: 'proj_2', name: 'Beta', color: 'green' },
    ],
    maxConcurrentUploads: 0,
    currentConcurrentUploads: 0,
    uploadDelayMs: opts.uploadDelayMs ?? 0,
    callCounts: {},
    orgUsage: { tier: 'team', activeDocCount: 0, maxActiveDocs: 5_000 },
  };

  let nextDocSeq = 1;
  const nextId = (): string => `doc_${String(nextDocSeq++)}`;
  // Seeded past the pre-seeded proj_1/proj_2 fixtures above so a freshly
  // created project's id never collides with them.
  let nextProjectSeq = 3;
  const nextProjectId = (): string => `proj_${String(nextProjectSeq++)}`;

  const http: Server = createServer((req, res) => {
    // Matches the real MCP embedded main's `/readyz` (unauthenticated) —
    // `instance-record.ts`'s `liveInstance` probes this over a real fetch,
    // so tests exercising that path need it here too, not just against a
    // real server.
    if (req.url === '/readyz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ready' }));
      return;
    }
    void (async () => {
      const header = req.headers.authorization ?? '';
      const key = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
      if (key !== apiKey) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_api_key' }));
        return;
      }
      const mcpServer = buildFakeServer(state, nextId, nextProjectId);
      const transport = new StreamableHTTPServerTransport({});
      res.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });
      // Same exactOptionalPropertyTypes cast as packages/mcp/src/main.ts.
      await mcpServer.connect(transport as Transport);
      await transport.handleRequest(req, res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address() as AddressInfo;
  const url = `http://127.0.0.1:${String(address.port)}/mcp`;

  let closed = false;
  return {
    url,
    apiKey,
    state,
    // Idempotent: tests may close early (e.g. to simulate a dropped
    // connection) and again in afterEach. The streamable-HTTP transport
    // keeps an SSE GET connection open for server-initiated messages; a
    // plain http.close() waits (several seconds) for it to end on its own,
    // which would make every test using this server slow. closeAllConnections
    // force-ends idle sockets immediately — fine for a throwaway test server.
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolve, reject) => {
        http.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        http.closeAllConnections();
      });
    },
  };
}
