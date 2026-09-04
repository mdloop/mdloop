import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Result } from '@mdloop/shared';
import { err, ok } from '@mdloop/shared';
import {
  assertEndpointTrusted,
  assertTransportSafe,
  endpointOrigin,
  pinTrustedOrigin,
} from './endpoint-trust.js';

export interface McpProject {
  id: string;
  name: string;
  color: string;
}

export interface McpDocument {
  id: string;
  title: string;
  versionSeq: number;
  content: string;
}

/**
 * The cheap half of `McpDocument` — everything the conflict guard needs and
 * no markdown. Served by the `get_document_status` tool.
 */
export interface McpDocumentStatus {
  documentId: string;
  versionSeq: number;
  /** Server-side sha256 hex of the current version's raw bytes — no `sha256:` prefix. */
  contentHash: string;
  myPermission: string;
}

export interface McpUploadResult {
  documentId: string;
  versionSeq: number;
  deduplicated: boolean;
}

/** Served by the `get_org_usage` tool — the pre-flight signal a batch push warns from (Phase 33.D). */
export interface McpOrgUsage {
  tier: string;
  activeDocCount: number;
  maxActiveDocs: number | null;
  projectUsage?: {
    activeDocCount: number;
    maxActiveDocsPerProject: number | null;
  };
}

export interface McpToolError {
  code: string;
  /**
   * Human-readable explanation, present only for the three tier-cap codes
   * (`doc_cap_exceeded` / `project_doc_cap_exceeded` / `version_cap_exceeded`
   * — packages/mcp/src/server.ts) that carry one. Every other code leaves
   * this unset, same as before this field existed.
   */
  message?: string;
  /** Numeric ceiling that was hit, present alongside `message` on the same codes. */
  limit?: number;
}

export interface UploadDocumentInput {
  content: string;
  documentId?: string;
  title?: string;
  projectId?: string;
  changeNote?: string;
  /** Repo-relative POSIX path (Phase 29) — where the sync CLI found this file. */
  path?: string;
}

export interface MdloopMcpClient {
  listProjects: () => Promise<Result<McpProject[], McpToolError>>;
  createProject: (name: string, color?: string) => Promise<Result<McpProject, McpToolError>>;
  getDocument: (documentId: string) => Promise<Result<McpDocument, McpToolError>>;
  getDocumentStatus: (documentId: string) => Promise<Result<McpDocumentStatus, McpToolError>>;
  uploadDocument: (input: UploadDocumentInput) => Promise<Result<McpUploadResult, McpToolError>>;
  getOrgUsage: (projectId?: string) => Promise<Result<McpOrgUsage, McpToolError>>;
  close: () => Promise<void>;
}

// The SDK's callTool() return type is a union (normal result vs. task-based
// result) with an index signature on one arm, which defeats `in`-narrowing
// on `content`/`isError`. Treat the raw result as unknown and narrow by hand
// instead of fighting that union.
function firstText(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) return '{}';
  const content = (raw as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const first = content[0] as { type?: unknown; text?: unknown } | undefined;
    if (first?.type === 'text' && typeof first.text === 'string') return first.text;
  }
  return '{}';
}

function isErrorResult(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  return (raw as { isError?: unknown }).isError === true;
}

function parseToolResult<T>(raw: unknown): Result<T, McpToolError> {
  const text = firstText(raw);
  if (isErrorResult(raw)) {
    const parsed = JSON.parse(text) as { error: string; message?: string; limit?: number };
    return err({
      code: parsed.error,
      ...(parsed.message !== undefined ? { message: parsed.message } : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
    });
  }
  return ok(JSON.parse(text) as T);
}

/**
 * MCP client wrapper over mdloop's streamable-HTTP transport (ARCHITECTURE.md
 * §9 — the CLI is just another MCP agent, authenticating the same way any
 * other client would: `Authorization: Bearer mdloop_...`, stateless, a fresh
 * server per request on mdloop's side, so no session id is needed here
 * either).
 *
 * The scheme guard lives here, at the one place a socket is ever opened, so
 * no caller can route around it; the folder-scoped trust pin is layered on
 * top by `connectTrustedMcpClient`, which every command uses.
 */
export async function connectMcpClient(endpoint: string, apiKey: string): Promise<MdloopMcpClient> {
  assertTransportSafe(endpoint);
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
  const client = new Client({ name: 'mdloop-cli', version: '0.0.1' });
  // Same exactOptionalPropertyTypes cast as packages/mcp/src/main.ts: the
  // SDK's own transport types don't satisfy their own Transport interface
  // under this compiler option.
  await client.connect(transport as Transport);

  async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return client.callTool({ name, arguments: args });
  }

  return {
    async listProjects() {
      const result = await callTool('list_projects', {});
      return parseToolResult<McpProject[]>(result);
    },
    async createProject(name: string, color?: string) {
      const args: Record<string, unknown> = { name };
      if (color) args.color = color;
      const result = await callTool('create_project', args);
      return parseToolResult<McpProject>(result);
    },
    async getDocument(documentId: string) {
      const result = await callTool('get_document', { document_id: documentId });
      const parsed = parseToolResult<{
        id: string;
        title: string;
        version_seq: number;
        content: string;
      }>(result);
      if (!parsed.ok) return parsed;
      return ok({
        id: parsed.value.id,
        title: parsed.value.title,
        versionSeq: parsed.value.version_seq,
        content: parsed.value.content,
      });
    },
    async getDocumentStatus(documentId: string) {
      const result = await callTool('get_document_status', { document_id: documentId });
      const parsed = parseToolResult<{
        document_id: string;
        version_seq: number;
        content_hash: string;
        my_permission: string;
      }>(result);
      if (!parsed.ok) return parsed;
      return ok({
        documentId: parsed.value.document_id,
        versionSeq: parsed.value.version_seq,
        contentHash: parsed.value.content_hash,
        myPermission: parsed.value.my_permission,
      });
    },
    async uploadDocument(input: UploadDocumentInput) {
      const args: Record<string, unknown> = { content: input.content };
      if (input.documentId) args.document_id = input.documentId;
      if (input.title) args.title = input.title;
      if (input.projectId) args.project_id = input.projectId;
      if (input.changeNote) args.change_note = input.changeNote;
      if (input.path) args.path = input.path;
      const result = await callTool('upload_document', args);
      const parsed = parseToolResult<{
        document_id: string;
        version_seq: number;
        deduplicated: boolean;
      }>(result);
      if (!parsed.ok) return parsed;
      return ok({
        documentId: parsed.value.document_id,
        versionSeq: parsed.value.version_seq,
        deduplicated: parsed.value.deduplicated,
      });
    },
    async getOrgUsage(projectId?: string) {
      const args: Record<string, unknown> = {};
      if (projectId) args.project_id = projectId;
      const result = await callTool('get_org_usage', args);
      const parsed = parseToolResult<{
        tier: string;
        active_doc_count: number;
        max_active_docs: number | null;
        project_usage?: {
          active_doc_count: number;
          max_active_docs_per_project: number | null;
        };
      }>(result);
      if (!parsed.ok) return parsed;
      return ok({
        tier: parsed.value.tier,
        activeDocCount: parsed.value.active_doc_count,
        maxActiveDocs: parsed.value.max_active_docs,
        ...(parsed.value.project_usage
          ? {
              projectUsage: {
                activeDocCount: parsed.value.project_usage.active_doc_count,
                maxActiveDocsPerProject: parsed.value.project_usage.max_active_docs_per_project,
              },
            }
          : {}),
      });
    },
    async close() {
      await client.close();
    },
  };
}

/**
 * `connectMcpClient` plus the trust-on-first-use endpoint pin — the entry
 * point every command (`link`, `push`, `status`) actually calls.
 *
 * `.mdloop/manifest.json` is committed and shared, so its `endpoint` is
 * attacker-controllable through any poisoned commit; sending a bearer API key
 * to whatever it names is exactly the exfiltration path this closes. The pin
 * is written only after the connect succeeds, so a typo'd endpoint doesn't
 * become the trusted one.
 */
export async function connectTrustedMcpClient(
  folder: string,
  endpoint: string,
  apiKey: string,
): Promise<MdloopMcpClient> {
  await assertEndpointTrusted(folder, endpoint);
  const client = await connectMcpClient(endpoint, apiKey);
  await pinTrustedOrigin(folder, endpointOrigin(endpoint));
  return client;
}
