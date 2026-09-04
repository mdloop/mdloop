import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type {
  Actor,
  AnchorResolutionRepository,
  ApiKeyRepository,
  CommentRepository,
  DocumentRepository,
  OrganizationRepository,
  ProjectRepository,
  RateLimiterPort,
  ReviewRepository,
  SearchRepository,
  ShareGrantRepository,
  StoragePort,
  TelemetryPort,
  UploadUnitOfWork,
  VersionRepository,
} from '@mdloop/app';
import {
  CachedTierResolver,
  METRIC_NAMES,
  UserRateLimiter,
  acceptSuggestion,
  addReply,
  createComment,
  createProject,
  documentDiff,
  exportOrg,
  getFeedbackBundle,
  getReviewStatus,
  listAccessibleDocuments,
  orgUsage,
  rejectSuggestion,
  requestReview,
  requireDocumentAccess,
  resolveComment,
  searchComments,
  searchDocuments,
  submitReview,
  uploadNewDocument,
  uploadNewVersion,
} from '@mdloop/app';
import type { CommentId, DocumentId, ProjectId, ReplyId, UserId } from '@mdloop/shared';

export interface McpDeps {
  documents: DocumentRepository;
  projects: ProjectRepository;
  versions: VersionRepository;
  comments: CommentRepository;
  reviews: ReviewRepository;
  resolutions: AnchorResolutionRepository;
  grants: ShareGrantRepository;
  organizations: OrganizationRepository;
  uploadUow: UploadUnitOfWork;
  storage: StoragePort;
  apiKeys: ApiKeyRepository;
  search: SearchRepository;
  telemetry: TelemetryPort;
  /** Shared with the HTTP API so agents and browsers draw one budget. */
  userRateLimiter?: RateLimiterPort;
  /**
   * Base URL of the web app a human reviews documents in, e.g.
   * `http://127.0.0.1:60356` or `https://mdloop.example.com` — no trailing
   * slash. When set, `upload_document` and `request_review` include a `url`
   * pointing straight at the document (`${webAppUrl}/d/${documentId}`,
   * matching `packages/web/src/app.route.ts`'s route) so an agent can hand
   * the reviewer a live link instead of the human having to go find it.
   * Omitted (both here and from tool responses) when a deployment hasn't
   * configured one — never a broken or guessed link.
   */
  webAppUrl?: string;
  /**
   * Fired after `request_review` succeeds, with the same document `url` the
   * response carries — the seam a local, single-user deployment uses to pop
   * the reviewer's own browser straight to it (`mdloop open`/`mdloop
   * serve`'s embedded MCP entrypoint is the only caller that sets this).
   * Deliberately narrower than a general-purpose notification port: firing
   * on every `upload_document` too would pop a tab per revision during
   * ordinary editing, and firing in a real multi-tenant deployment would
   * try to open a browser on a server with no display — so this stays
   * `request_review`-only, and undefined (no-op) is the correct default
   * everywhere else. Synchronous and fire-and-forget: never awaited, and a
   * throw here must never fail the tool call that triggered it — callers
   * are expected to swallow their own errors, but `request_review` also
   * wraps the call in `try`/`catch` as a backstop.
   */
  onReviewRequested?: (url: string) => void;
}

function documentUrl(webAppUrl: string | undefined, documentId: string): string | undefined {
  return webAppUrl ? `${webAppUrl}/d/${documentId}` : undefined;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function jsonResult(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/**
 * Tier-cap codes (packages/domain/src/tier.ts) that carry a
 * numeric `limit` the domain already computed. Phase 33.A.1: enrich just
 * these three with a human-readable `message` so an agent can't misreport a
 * rejected push as successful to the human it's working for — the raw code
 * alone doesn't say "nothing changed" clearly enough. Every other error code
 * is untouched; this is additive, not a rewrite of `errorResult`.
 */
type TierCapCode = 'doc_cap_exceeded' | 'project_doc_cap_exceeded' | 'version_cap_exceeded';

const tierCapMessage: Record<TierCapCode, (limit: number) => string> = {
  doc_cap_exceeded: (limit) =>
    `This org already has ${String(limit)} active documents, this tier's limit — the upload was rejected and nothing changed. Free up headroom (archive or delete documents) or upgrade tier, then retry.`,
  project_doc_cap_exceeded: (limit) =>
    `This project already has ${String(limit)} active documents, this tier's limit — the upload was rejected and nothing changed. Free up headroom (move or delete documents out of this project) or upgrade tier, then retry.`,
  // Version auto-purge: the hourly sweep frees
  // headroom on its own schedule, and an open comment is the one thing that
  // keeps an old version un-purgeable — so "wait" and "resolve what's
  // pinning old versions" are both real options here, not just "upgrade".
  version_cap_exceeded: (limit) =>
    `This document already has ${String(limit)} live versions, this tier's limit — the upload was rejected and nothing changed. Auto-purge already frees headroom automatically over time on its own schedule, so you can wait, or free up headroom sooner by resolving any open comments pinning old versions (an open comment is what keeps a version from being purged); upgrading tier also raises the ceiling.`,
};

function isTierCapCode(code: string): code is TierCapCode {
  return (
    code === 'doc_cap_exceeded' ||
    code === 'project_doc_cap_exceeded' ||
    code === 'version_cap_exceeded'
  );
}

function errorResult(
  code: string,
  limit?: number,
): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  const message =
    limit === undefined || !isTierCapCode(code) ? undefined : tierCapMessage[code](limit);
  const payload = message === undefined ? { error: code } : { error: code, limit, message };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
}

const textAnchorSchema = z
  .object({
    type: z.literal('text').describe('Discriminator: pins the comment to a span of text.'),
    exact: z
      .string()
      .describe(
        'The exact substring being commented on, copied verbatim from the version markdown. Must be non-empty.',
      ),
    prefix: z
      .string()
      .describe(
        'Up to 32 characters of source immediately BEFORE `exact`; used to re-anchor the comment onto later versions. Send fewer only at the start of the document.',
      ),
    suffix: z
      .string()
      .describe('Up to 32 characters of source immediately AFTER `exact`, same re-anchoring role.'),
    start: z
      .number()
      .int()
      .describe(
        "Character offset of `exact` into the raw markdown of the document's CURRENT version — the exact string get_document returns in `content`. Not a line number, not a byte offset.",
      ),
    end: z
      .number()
      .int()
      .describe('Exclusive end offset; must equal start + exact.length, and be > start.'),
  })
  .describe(
    "Anchor to a span of the current version's markdown. The comment pins to whichever version is current when it is created, so read the document first and take the offsets from that same fetch.",
  );

const anchorSchema = z.union([
  textAnchorSchema,
  z
    .object({
      type: z
        .literal('document')
        .describe('Discriminator: attaches the comment to the document as a whole.'),
    })
    .describe('Whole-document anchor — no offsets, never orphans. Not valid for a suggested edit.'),
]);

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}

/**
 * Wraps a tool handler with a telemetry span (tool name, latency, outcome —
 * opaque ids only, never arguments or results). `isError` on the tool result
 * counts as a domain-level error outcome, same as a thrown exception.
 */
function instrumented<A extends unknown[], R extends ToolResult>(
  telemetry: TelemetryPort,
  tool: string,
  handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const span = telemetry.startSpan('mcp_tool_call', { tool });
    try {
      const result = await handler(...args);
      span.end({ outcome: result.isError ? 'error' : 'ok' });
      return result;
    } catch (error) {
      span.end({ outcome: 'error' });
      throw error;
    }
  };
}

/**
 * The MCP surface (ARCHITECTURE.md §9): tools over the exact use-cases the
 * HTTP API calls, executing as the API key's user — same permission checks,
 * same RLS, same quota.
 */
export function buildMcpServer(deps: McpDeps, actor: Actor): McpServer {
  const server = new McpServer({ name: 'mdloop', version: '0.1.0' });
  const userRateLimiter = deps.userRateLimiter ?? new UserRateLimiter();
  const tierResolver = new CachedTierResolver(deps.organizations);
  const reviewDeps = {
    documents: deps.documents,
    grants: deps.grants,
    comments: deps.comments,
    orgs: deps.organizations,
    reviews: deps.reviews,
  };
  // Tier-aware per-user budget: the identical typed error the HTTP API
  // sends as 429 + Retry-After — API/MCP parity.
  const rateLimited = async (
    toolName: string,
  ): Promise<{ error: 'rate_limited'; retryAfterSeconds: number } | undefined> => {
    const tier = (await tierResolver.resolve(actor.ctx)) ?? 'free';
    const decision = await userRateLimiter.check(actor.ctx.userId, tier);
    if (decision.ok) return undefined;
    // Wires the previously-dormant quota_rejected metric (rate-limiting
    // redesign, 2026-08-11) — API/MCP parity for observability too, matching
    // packages/api/src/server.ts's identical rejection-site wiring.
    // Dimensioned by tier only in the metric (never orgId/userId — see
    // TelemetryFields' doc comment); `.log()` carries the richer opaque-ID
    // context for CloudWatch Logs Insights.
    deps.telemetry.recordMetric(METRIC_NAMES.quotaRejected, 1, { tier });
    deps.telemetry.log('quota_rejected', {
      tool: toolName,
      orgId: actor.ctx.orgId,
      userId: actor.ctx.userId,
      errorCode: decision.error.code,
    });
    return { error: decision.error.code, retryAfterSeconds: decision.error.retryAfterSeconds };
  };
  const tool = <A extends unknown[], R extends ToolResult>(
    name: string,
    handler: (...args: A) => Promise<R>,
  ) =>
    instrumented(
      deps.telemetry,
      name,
      async (
        ...args: A
      ): Promise<R | { content: { type: 'text'; text: string }[]; isError: true }> => {
        const limited = await rateLimited(name);
        if (limited) {
          return { content: [{ type: 'text', text: JSON.stringify(limited) }], isError: true };
        }
        try {
          return await handler(...args);
        } catch {
          // Every expected failure is a typed Result the handler already
          // turned into `errorResult(code)` above — reaching here means an
          // unhandled throw (e.g. a raw pg error), which can quote row or
          // constraint values (CONSTITUTION §3). Never let the SDK serialize
          // `error.message` verbatim back to the calling agent.
          return errorResult('internal');
        }
      },
    );

  server.registerTool(
    'list_projects',
    {
      description:
        'List the live (non-archived) projects in your organization — id, name, colour. Projects are the folders documents are filed under; pass one of these ids to list_documents to see its contents. Errors: none beyond `rate_limited`, which any tool can return.',
      inputSchema: {},
    },
    tool('list_projects', async () => {
      const projects = await deps.projects.list(actor.ctx);
      return jsonResult(
        projects
          .filter((p) => p.archivedAt === null)
          .map((p) => ({ id: p.id, name: p.name, color: p.color })),
      );
    }),
  );

  server.registerTool(
    'create_project',
    {
      description:
        'Create a new project in your organization. Project names are NOT unique — there is no (org_id, name) constraint at any layer, so creating one named the same as an existing project produces two distinct projects rather than reusing or erroring. Call list_projects first and reuse a matching id if you want to file documents alongside an existing project instead of creating a duplicate. Any member may create one; guests are blocked at the route allowlist. Errors: `invalid_name` (empty after trimming, or over 120 characters), `invalid_color` (not a `#rrggbb` hex string); plus `rate_limited`, which any tool can return.',
      inputSchema: {
        name: z
          .string()
          .describe('Project display name. Non-empty after trimming, max 120 characters.'),
        color: z
          .string()
          .optional()
          .describe('Display color as `#rrggbb` hex. Omit to use the default indigo (#6366f1).'),
      },
    },
    tool('create_project', async ({ name, color }) => {
      const result = await createProject(deps.projects, actor, {
        name,
        ...(color !== undefined ? { color } : {}),
      });
      if (!result.ok) return errorResult(result.error.code);
      return jsonResult({
        id: result.value.id,
        name: result.value.name,
        color: result.value.color,
      });
    }),
  );

  server.registerTool(
    'get_org_usage',
    {
      description:
        "Current document-count usage against this org's tier ceilings — call before a large batch upload to see headroom, so a doc_cap_exceeded/project_doc_cap_exceeded mid-batch isn't a surprise. Pass project_id to also get that project's own headroom against the tighter per-project ceiling. `max_active_docs`/`max_active_docs_per_project` are null on tiers with no ceiling. Errors: `org_not_found`; plus `rate_limited`, which any tool can return.",
      inputSchema: {
        project_id: z
          .string()
          .optional()
          .describe(
            "Project uuid (from list_projects) to also report that project's own doc-count headroom for. Omit for org-wide usage only.",
          ),
      },
    },
    tool('get_org_usage', async ({ project_id }) => {
      const result = await orgUsage(
        deps.organizations,
        deps.documents,
        deps.versions,
        deps.grants,
        actor,
        project_id as ProjectId | undefined,
      );
      if (!result.ok) return errorResult(result.error.code);
      return jsonResult({
        tier: result.value.tier,
        active_doc_count: result.value.activeDocCount,
        max_active_docs: result.value.maxActiveDocs,
        ...(result.value.projectUsage
          ? {
              project_usage: {
                active_doc_count: result.value.projectUsage.activeDocCount,
                max_active_docs_per_project: result.value.projectUsage.maxActiveDocsPerProject,
              },
            }
          : {}),
      });
    }),
  );

  server.registerTool(
    'list_documents',
    {
      description:
        'Browse the documents you can access — ones you own, ones shared with you, or the whole org if you are an admin — optionally narrowed by project or view. This is the enumerate path: no query string, no relevance ranking, every match returned. Use search_documents instead when you have words to look for. Returns id, title, project_id and created_at only; fetch markdown with get_document. Errors: none beyond `rate_limited`, which any tool can return.',
      inputSchema: {
        project_id: z
          .string()
          .optional()
          .describe(
            'Project uuid (from list_projects) to restrict the listing to. Omit to list across every project.',
          ),
        view: z
          .enum(['all', 'unfiled', 'archived'])
          .optional()
          .describe(
            "Which slice to list. 'all' (the default) = no filter: every live document, filed or not. 'unfiled' = live documents in no project. 'archived' = archived documents only. 'all' and 'unfiled' both EXCLUDE archived documents; deleted documents never appear in any view.",
          ),
      },
    },
    tool('list_documents', async ({ project_id, view }) => {
      const docs = await listAccessibleDocuments(deps.documents, deps.grants, actor, {
        ...(view && view !== 'all' ? { view } : {}),
        ...(project_id ? { projectId: project_id as ProjectId } : {}),
      });
      return jsonResult(
        docs.map((d) => ({
          id: d.id,
          title: d.title,
          project_id: d.projectId,
          created_at: d.createdAt,
        })),
      );
    }),
  );

  server.registerTool(
    'get_document',
    {
      description:
        'Fetch a document: id, title, current version seq, your permission on it, and the full markdown of that current version. Use get_document_status instead when all you want is "did this change?" — it returns the same seq plus a content hash without downloading the body. Needs read access. Errors: `document_not_found` (also what you get when you simply lack access — no existence oracle), `no_version` (the document exists but nothing has been uploaded to it yet); plus `rate_limited`, which any tool can return.',
      inputSchema: {
        document_id: z
          .string()
          .describe(
            'Document uuid, as returned by list_documents, search_documents or upload_document.',
          ),
      },
    },
    tool('get_document', async ({ document_id }) => {
      const access = await requireDocumentAccess(
        deps.documents,
        deps.grants,
        actor,
        document_id as DocumentId,
        'read',
      );
      if (!access.ok) return errorResult(access.error.code);
      const doc = access.value.document;
      if (!doc.currentVersionId) return errorResult('no_version');
      const version = await deps.versions.byId(actor.ctx, doc.currentVersionId);
      if (!version) return errorResult('no_version');
      const content = decoder.decode(
        await deps.storage.get({ orgId: actor.ctx.orgId, documentId: doc.id, seq: version.seq }),
      );
      return jsonResult({
        id: doc.id,
        title: doc.title,
        version_seq: version.seq,
        my_permission: access.value.permission,
        content,
      });
    }),
  );

  server.registerTool(
    'get_document_status',
    {
      description:
        'A document\'s sync state without its content: the current version\'s seq and content hash (sha256 hex of the raw markdown bytes), plus your permission on it. Use this instead of get_document when all you need is "has this moved since I last saw it?" — get_document downloads the entire markdown to answer the same question. Fetch the body with get_document only once the seq or hash has actually moved. Needs read access. Errors: `document_not_found` (also covers no access), `no_version`; plus `rate_limited`, which any tool can return.',
      inputSchema: {
        document_id: z.string().describe('Document uuid to check.'),
      },
    },
    tool('get_document_status', async ({ document_id }) => {
      const access = await requireDocumentAccess(
        deps.documents,
        deps.grants,
        actor,
        document_id as DocumentId,
        'read',
      );
      if (!access.ok) return errorResult(access.error.code);
      const doc = access.value.document;
      if (!doc.currentVersionId) return errorResult('no_version');
      // Same two reads get_document makes, minus the blob fetch — the version
      // row already carries the hash the uploader computed, so a sync client
      // never pays for the body just to compare.
      const version = await deps.versions.byId(actor.ctx, doc.currentVersionId);
      if (!version) return errorResult('no_version');
      return jsonResult({
        document_id: doc.id,
        version_seq: version.seq,
        content_hash: version.contentHash,
        my_permission: access.value.permission,
      });
    }),
  );

  server.registerTool(
    'list_versions',
    {
      description:
        "A document's version history, newest first: seq, version id, created_at, upload source, the change note, and whether retention has purged the blob (a purged version can only be diffed against as an honest `version_purged`). Use it to pick from_seq and to_seq for get_diff; use get_document_status if you only want the current seq. Needs read access. Errors: `document_not_found` (also covers no access); plus `rate_limited`, which any tool can return.",
      inputSchema: {
        document_id: z.string().describe('Document uuid whose history to list.'),
      },
    },
    tool('list_versions', async ({ document_id }) => {
      const access = await requireDocumentAccess(
        deps.documents,
        deps.grants,
        actor,
        document_id as DocumentId,
        'read',
      );
      if (!access.ok) return errorResult(access.error.code);
      const versions = await deps.versions.listForDocument(actor.ctx, access.value.document.id);
      return jsonResult(
        versions
          .slice()
          .sort((a, b) => b.seq - a.seq)
          .map((v) => ({
            seq: v.seq,
            id: v.id,
            created_at: v.createdAt,
            source: v.source,
            change_note: v.changeNote,
            purged: v.purgedAt !== null,
          })),
      );
    }),
  );

  server.registerTool(
    'get_diff',
    {
      description:
        "What changed between two versions of one document — a structured block diff (unchanged/added/removed/modified blocks, with inline word or code-line runs on modified blocks). Start here when resuming a document that moved since you last saw it; call list_versions first to pick from_seq and to_seq. Needs read access. Errors: `document_not_found` (also covers no access), `version_not_found` (a seq this document does not have), `version_purged` (a leg's blob was removed by retention), `diff_too_large` (a leg over the 200 KB pre-parse cap, or a diff over 1000 blocks); plus `rate_limited`, which any tool can return.",
      inputSchema: {
        document_id: z.string().describe('Document uuid both versions belong to.'),
        from_seq: z
          .number()
          .int()
          .positive()
          .describe(
            'Seq of the "before" version — the version number from list_versions, 1-based and increasing by one per upload (not a version uuid).',
          ),
        to_seq: z
          .number()
          .int()
          .positive()
          .describe(
            'Seq of the "after" version, same numbering. Usually the current seq from get_document_status.',
          ),
      },
    },
    tool('get_diff', async ({ document_id, from_seq, to_seq }) => {
      const result = await documentDiff(
        {
          documents: deps.documents,
          grants: deps.grants,
          versions: deps.versions,
          storage: deps.storage,
        },
        actor,
        { documentId: document_id as DocumentId, fromSeq: from_seq, toSeq: to_seq },
      );
      if (!result.ok) return errorResult(result.error.code);
      return jsonResult({
        from: result.value.from,
        to: result.value.to,
        blocks: result.value.diff.blocks,
      });
    }),
  );

  server.registerTool(
    'upload_document',
    {
      description:
        'Upload markdown — the only way to change what a document says. With document_id: appends a new version (byte-identical content is a free no-op, reported back as `deduplicated`). Without document_id: creates a new document, and title becomes required. This is also the completion step for a suggested edit: accept_suggestion only records the decision, so you must apply the proposed text to the source yourself and upload the result here before the change exists. The response carries a `url` straight to the document — share it with whoever should look, rather than leaving them to find it themselves. Needs ownership, org admin, or an `edit` share grant on an existing document. Errors: `title_required` (new document with no title), `document_not_found`, `forbidden`, `invalid_title`, `invalid_path`, `path_taken` (another live document already occupies that path in the project), `project_not_found`, `org_read_only`, quota codes `empty_file` / `file_too_large`, tier caps `doc_cap_exceeded` / `project_doc_cap_exceeded` / `version_cap_exceeded` (each of these three also carries a numeric `limit` and a human-readable `message` explaining what to do — nothing changed, retry after freeing headroom or upgrading tier), and content-policy codes `binary_signature_detected` / `control_byte_detected` / `invalid_utf8` / `replacement_char_density_exceeded`; plus `rate_limited`, which any tool can return.',
      inputSchema: {
        content: z
          .string()
          .describe(
            'The complete markdown source of the new version — whole-file replacement text, never a patch or a diff. Max 500 KB encoded as UTF-8; must be non-empty.',
          ),
        document_id: z
          .string()
          .optional()
          .describe(
            'Uuid of an existing document to append a version to. Omit to create a brand-new document.',
          ),
        title: z
          .string()
          .optional()
          .describe(
            'Document title. Optional in this schema but REQUIRED at runtime whenever document_id is omitted — creating a document without one returns `title_required`. Ignored when document_id is given; this call never renames an existing document.',
          ),
        project_id: z
          .string()
          .optional()
          .describe(
            'Project uuid to file a NEW document under (omit to leave it unfiled). Ignored when document_id is given — this call never moves an existing document between projects.',
          ),
        change_note: z
          .string()
          .max(20_000)
          .optional()
          .describe(
            'One line of prose for this version: what changed and why. Reviewers read it before the diff. Max 20000 characters, immutable once written, and never applied retroactively to earlier versions.',
          ),
        path: z
          .string()
          .max(1024)
          .optional()
          .describe(
            'Repo-relative POSIX path including the filename, e.g. "docs/specs/auth.md", when mirroring a real file so mdloop can show the folder structure. Sending an existing document_id with a DIFFERENT path moves the document there rather than forking a duplicate; omitting it leaves any stored path untouched (there is no way to clear one). Max 1024 characters, no absolute paths or ".." traversal. Omit unless you are mirroring a repo.',
          ),
      },
    },
    tool(
      'upload_document',
      async ({ content, document_id, title, project_id, change_note, path }) => {
        const bytes = encoder.encode(content);
        if (document_id) {
          const result = await uploadNewVersion(deps.uploadUow, deps.storage, actor, {
            documentId: document_id as DocumentId,
            content: bytes,
            source: 'mcp',
            changeNote: change_note ?? null,
            // Omitted, not nulled: an upload that carries no path leaves the
            // stored one exactly as it is (Phase 29).
            ...(path !== undefined ? { path } : {}),
          });
          if (!result.ok) {
            return errorResult(
              result.error.code,
              'limit' in result.error ? result.error.limit : undefined,
            );
          }
          return jsonResult({
            document_id: result.value.document.id,
            version_seq: result.value.version.seq,
            deduplicated: result.value.deduplicated,
            path: result.value.document.path,
            url: documentUrl(deps.webAppUrl, result.value.document.id),
          });
        }
        if (!title) return errorResult('title_required');
        const result = await uploadNewDocument(deps.uploadUow, deps.storage, actor, {
          title,
          projectId: (project_id ?? null) as ProjectId | null,
          content: bytes,
          source: 'mcp',
          changeNote: change_note ?? null,
          ...(path !== undefined ? { path } : {}),
        });
        if (!result.ok) {
          return errorResult(
            result.error.code,
            'limit' in result.error ? result.error.limit : undefined,
          );
        }
        return jsonResult({
          document_id: result.value.document.id,
          version_seq: result.value.version.seq,
          deduplicated: result.value.deduplicated,
          path: result.value.document.path,
          url: documentUrl(deps.webAppUrl, result.value.document.id),
        });
      },
    ),
  );

  server.registerTool(
    'get_feedback_bundle',
    {
      description:
        'Everything a human said that you still have to act on: every UNRESOLVED comment on a document with its quoted text, anchor state against the current version, upvote count, reply thread and any suggested replacement text — plus the whole set rendered as one prompt-ready text block. Start here after a human reviews your document. This is the comment-level view; get_review_status is the sign-off-level view (who was asked to review, what verdicts landed). The bundle embeds a summary of that sign-off status too, so you rarely need both. Needs read access. Errors: `document_not_found` (also covers no access), `no_version`; plus `rate_limited`, which any tool can return.',
      inputSchema: {
        document_id: z.string().describe('Document uuid whose open feedback to fetch.'),
      },
    },
    tool('get_feedback_bundle', async ({ document_id }) => {
      const result = await getFeedbackBundle(
        deps.documents,
        deps.comments,
        deps.versions,
        deps.resolutions,
        deps.storage,
        deps.grants,
        deps.reviews,
        deps.organizations,
        actor,
        document_id as DocumentId,
      );
      if (!result.ok) return errorResult(result.error.code);
      return {
        content: [{ type: 'text' as const, text: result.value.prompt }],
        structuredContent: {
          document: result.value.document,
          open_count: result.value.openCount,
          items: result.value.items,
          review: {
            status: result.value.review.status,
            pending_reviewers: result.value.review.pendingReviewers,
            gate: result.value.review.gate,
          },
        },
      };
    }),
  );

  server.registerTool(
    'create_comment',
    {
      description:
        'Comment on a document, as the user the API key belongs to. Anchor to exact text (with up to 32 characters of prefix/suffix context and source offsets) or to the whole document. Pass proposed_text to make it a suggested edit instead of a plain comment — the replacement text for the anchored range, which then requires a text anchor; an owner or org admin can later accept it (a metadata-only decision — the edit still has to be applied and uploaded separately) or reject it. Needs comment permission. Errors: `document_not_found` (also covers no access), `empty_body`, `body_too_long` (over 2000 characters), `invalid_anchor`, `suggestion_requires_text_anchor`, `proposed_text_too_long` (over 20000 characters), `no_version`, `org_read_only`, `comment_cap_exceeded` (free tier only); plus `rate_limited`, which any tool can return.',
      inputSchema: {
        document_id: z.string().describe('Document uuid to comment on.'),
        body: z
          .string()
          .describe(
            'The comment text (markdown). Non-empty after trimming, max 2000 characters. `@Display Name` mentions resolve against people already on the document.',
          ),
        anchor: anchorSchema
          .optional()
          .describe(
            'Where the comment attaches. Omit for a whole-document comment (the default). A suggested edit must use the text form.',
          ),
        proposed_text: z
          .string()
          .optional()
          .describe(
            'Turns this into a suggested edit: the replacement for exactly the anchored range. An empty string is a real "delete this" suggestion, distinct from omitting the field. Max 20000 characters; requires a text anchor.',
          ),
      },
    },
    tool('create_comment', async ({ document_id, body, anchor, proposed_text }) => {
      const access = await requireDocumentAccess(
        deps.documents,
        deps.grants,
        actor,
        document_id as DocumentId,
        'comment',
      );
      if (!access.ok) return errorResult(access.error.code);
      const result = await createComment(
        deps.documents,
        deps.comments,
        deps.organizations,
        deps.grants,
        actor,
        {
          documentId: document_id as DocumentId,
          body,
          anchor: anchor ?? { type: 'document' },
          proposedText: proposed_text ?? null,
        },
      );
      if (!result.ok) return errorResult(result.error.code);
      return jsonResult({
        comment_id: result.value.id,
        status: result.value.status,
        kind: result.value.kind,
        suggestion_outcome: result.value.suggestionOutcome,
      });
    }),
  );

  server.registerTool(
    'accept_suggestion',
    {
      description:
        'Accept a suggested edit: marks it accepted. This does NOT change the document — accepting is a decision, not a mutation, and it mints no version. Whoever owns the actual source (this agent, another tool, or a human) must apply the proposed text and call upload_document separately; get_feedback_bundle keeps surfacing the suggestion as accepted-but-not-yet-applied until an upload whose content matches lands. Only for suggestions (a comment carrying proposed_text) — close an ordinary comment with resolve_comment instead. Document owner or org admin only; guests never. Errors: `comment_not_found`, `not_a_suggestion` (it is a plain comment), `suggestion_not_open` (already accepted or rejected, including losing a race to a concurrent decision), `document_not_found`, `forbidden`; plus `rate_limited`, which any tool can return.',
      inputSchema: {
        comment_id: z
          .string()
          .describe(
            "Uuid of an OPEN suggestion comment — from get_feedback_bundle's items[].commentId (the ones with a non-null proposedText) or create_comment's returned comment_id. Not a reply id.",
          ),
      },
    },
    tool('accept_suggestion', async ({ comment_id }) => {
      const result = await acceptSuggestion(
        { documents: deps.documents, comments: deps.comments },
        actor,
        comment_id as CommentId,
        'mcp',
      );
      if (!result.ok) return errorResult(result.error.code);
      return jsonResult({
        comment_id: result.value.comment.id,
        suggestion_outcome: result.value.comment.suggestionOutcome,
        applied_version_id: result.value.comment.appliedVersionId,
      });
    }),
  );

  server.registerTool(
    'reject_suggestion',
    {
      description:
        'Reject a suggested edit, marking its outcome terminal. Does not change the document and mints no version — the mirror image of accept_suggestion, and like it, only valid on a suggestion (use resolve_comment to close an ordinary comment). Say why in reply_to_comment first; rejecting alone leaves the reviewer no explanation. Document owner or org admin only; guests never. Errors: `comment_not_found`, `not_a_suggestion`, `suggestion_not_open` (already decided), `document_not_found`, `forbidden`; plus `rate_limited`, which any tool can return.',
      inputSchema: {
        comment_id: z.string().describe('Uuid of an OPEN suggestion comment to reject.'),
      },
    },
    tool('reject_suggestion', async ({ comment_id }) => {
      const result = await rejectSuggestion(
        { documents: deps.documents, comments: deps.comments },
        actor,
        comment_id as CommentId,
      );
      if (!result.ok) return errorResult(result.error.code);
      return jsonResult({
        comment_id: result.value.id,
        suggestion_outcome: result.value.suggestionOutcome,
      });
    }),
  );

  server.registerTool(
    'reply_to_comment',
    {
      description:
        "Reply inside a comment thread — the way to tell a reviewer how you addressed their feedback, or why you did not. Replying never changes a thread's state: it stays open until resolve_comment, and it is not how a suggested edit is answered (accept_suggestion / reject_suggestion decide those). Pass parent_reply_id to nest under another reply. Needs comment permission. Errors: `comment_not_found`, `document_not_found` (also covers no access), `empty_body`, `body_too_long` (over 2000 characters), `parent_reply_not_found` (missing, or belonging to a different thread — deliberately indistinguishable), `reply_depth_exceeded` (nesting caps at depth 5); plus `rate_limited`, which any tool can return.",
      inputSchema: {
        comment_id: z
          .string()
          .describe(
            'Uuid of the top-level comment whose thread you are replying to — never a reply id.',
          ),
        body: z
          .string()
          .describe('The reply text (markdown). Non-empty after trimming, max 2000 characters.'),
        parent_reply_id: z
          .string()
          .optional()
          .describe(
            'Uuid of an existing reply IN THIS SAME THREAD to nest under. Omit to reply at the top level of the thread. Nesting caps at depth 5.',
          ),
      },
    },
    tool('reply_to_comment', async ({ comment_id, body, parent_reply_id }) => {
      const comment = await deps.comments.byId(actor.ctx, comment_id as CommentId);
      if (!comment) return errorResult('comment_not_found');
      const access = await requireDocumentAccess(
        deps.documents,
        deps.grants,
        actor,
        comment.documentId,
        'comment',
      );
      if (!access.ok) return errorResult(access.error.code);
      const result = await addReply(
        deps.documents,
        deps.comments,
        deps.grants,
        actor,
        comment.id,
        body,
        (parent_reply_id ?? null) as ReplyId | null,
      );
      if (!result.ok) return errorResult(result.error.code);
      return jsonResult({ reply_id: result.value.id });
    }),
  );

  server.registerTool(
    'resolve_comment',
    {
      description:
        'Mark an ordinary comment thread resolved — the closing move once its feedback has actually been addressed and uploaded. Document owner or org admin only: an `edit` share grant buys uploads, not resolution. Not for suggested edits; those close through accept_suggestion or reject_suggestion. Errors: `comment_not_found`, `document_not_found`, `forbidden` (not the owner or an org admin), `already_resolved`; plus `rate_limited`, which any tool can return.',
      inputSchema: {
        comment_id: z
          .string()
          .describe('Uuid of the top-level comment to resolve — never a reply id.'),
      },
    },
    tool('resolve_comment', async ({ comment_id }) => {
      const result = await resolveComment(
        deps.documents,
        deps.comments,
        actor,
        comment_id as CommentId,
      );
      if (!result.ok) return errorResult(result.error.code);
      return jsonResult({ resolved: true });
    }),
  );

  server.registerTool(
    'export_org',
    {
      description:
        'Export the whole organization as JSON: each document (current markdown only), its version history as metadata (seq, source, change_note — no historical bodies), and all comments with replies. Org admin only; works during the cancellation read-only grace (GDPR Art. 20 data portability). Paged: one page carries up to `limit` documents plus `next_cursor`. Keep calling with `cursor` = the previous `next_cursor` until `next_cursor` is null. Errors: `forbidden` (not an org admin), `org_not_found`; plus `rate_limited`, which any tool can return.',
      inputSchema: {
        cursor: z
          .string()
          .optional()
          .describe(
            'Opaque paging cursor: the `next_cursor` from the previous page. Omit for the first page; stop when a page returns a null `next_cursor`.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Documents per page, 1-100. Defaults to 50.'),
      },
    },
    tool('export_org', async ({ cursor, limit }) => {
      const result = await exportOrg(
        deps.organizations,
        deps.documents,
        deps.versions,
        deps.comments,
        deps.storage,
        actor,
        {
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
      );
      if (!result.ok) return errorResult(result.error.code);
      return jsonResult({ ...result.value, next_cursor: result.value.nextCursor });
    }),
  );

  server.registerTool(
    'request_review',
    {
      description:
        'Ask one named person to sign off on a document ("pass the mdloop"), opening an active review request they answer with submit_review. You must own the document or be an org admin, and the reviewer must ALREADY have access — this grants none. The response carries a `url` straight to the document — this is the moment to hand it to whoever should look, and on a local single-user instance (mdloop open/mdloop serve) it also opens their browser there automatically. Track the outcome with get_review_status. Errors: `document_not_found`, `forbidden` (not the owner or an org admin, or the caller is a guest), `reviewer_not_found`, `reviewer_has_no_access` (share the document with them first), `already_requested` (they already hold an open request on it), `org_read_only`, `org_not_found`; plus `rate_limited`, which any tool can return.',
      inputSchema: {
        document_id: z.string().describe('Document uuid to have reviewed.'),
        reviewer_user_id: z
          .string()
          .describe(
            "Uuid of the mdloop user being asked — a users.id, not an email or display name. Reviewer ids appear in get_review_status's `requests` and `approvals`. They must already have access to the document.",
          ),
      },
    },
    tool('request_review', async ({ document_id, reviewer_user_id }) => {
      const result = await requestReview(reviewDeps, actor, {
        documentId: document_id as DocumentId,
        reviewerUserId: reviewer_user_id as UserId,
      });
      if (!result.ok) return errorResult(result.error.code);
      const url = documentUrl(deps.webAppUrl, document_id);
      if (url && deps.onReviewRequested) {
        try {
          deps.onReviewRequested(url);
        } catch {
          // Never let a launch-the-browser side effect fail the request
          // that already succeeded — see McpDeps.onReviewRequested's doc
          // comment.
        }
      }
      return jsonResult({
        request_id: result.value.id,
        reviewer_user_id: result.value.reviewerUserId,
        reviewer_name: result.value.reviewerName,
        url,
      });
    }),
  );

  server.registerTool(
    'get_review_status',
    {
      description:
        "The sign-off picture for a document: derived status (draft / in_review / changes_requested / approved), active review requests, every verdict recorded so far with its note and the version it pinned to, the org's approval gate (soft or hard), and the open-comment count. This is the who-signed-off view; use get_feedback_bundle when you need the actual comment text to act on. Any level of access can read it. Errors: `document_not_found` (also covers no access), `org_not_found`; plus `rate_limited`, which any tool can return.",
      inputSchema: {
        document_id: z.string().describe('Document uuid whose sign-off state to read.'),
      },
    },
    tool('get_review_status', async ({ document_id }) => {
      const result = await getReviewStatus(reviewDeps, actor, document_id as DocumentId);
      if (!result.ok) return errorResult(result.error.code);
      return jsonResult({
        status: result.value.status,
        gate: result.value.gate,
        open_comment_count: result.value.openCommentCount,
        requests: result.value.requests.map((r) => ({
          request_id: r.id,
          reviewer_user_id: r.reviewerUserId,
          reviewer_name: r.reviewerName,
        })),
        approvals: result.value.approvals.map((a) => ({
          version_id: a.versionId,
          reviewer_user_id: a.reviewerUserId,
          reviewer_name: a.reviewerName,
          verdict: a.verdict,
          note: a.note,
          created_at: a.createdAt,
        })),
      });
    }),
  );

  server.registerTool(
    'submit_review',
    {
      description:
        "Record YOUR OWN verdict on a document you were personally asked to review. It only works when the API key's user holds an active review request on that document (request_review opens one) — there is no way to sign off on someone else's behalf, so this is normally a human's move and an agent calls it only when it is itself the requested reviewer. The verdict pins to whichever version is current, so a later upload reopens the question. Errors: `not_a_reviewer` (no active request for you — the usual reason this fails), `document_not_found`, `no_version`, `note_too_long` (over 2000 characters), `open_comments_block_approval` (approving under a hard gate with comments still open — resolve them first), `org_not_found`; plus `rate_limited`, which any tool can return.",
      inputSchema: {
        document_id: z.string().describe('Document uuid you were asked to review.'),
        verdict: z
          .enum(['approved', 'changes_requested'])
          .describe(
            "'approved' signs off on the document's current version; 'changes_requested' hands it back with work outstanding. Both are recorded append-only — a later verdict supersedes but never erases an earlier one.",
          ),
        note: z
          .string()
          .optional()
          .describe(
            'Optional prose explaining the verdict, shown beside it. Trimmed; max 2000 characters. Strongly worth sending with `changes_requested`.',
          ),
      },
    },
    tool('submit_review', async ({ document_id, verdict, note }) => {
      const result = await submitReview(reviewDeps, actor, {
        documentId: document_id as DocumentId,
        verdict,
        note: note ?? null,
      });
      if (!result.ok) return errorResult(result.error.code);
      return jsonResult({
        status: result.value.status,
        verdict: result.value.approval.verdict,
        version_id: result.value.approval.versionId,
      });
    }),
  );

  server.registerTool(
    'search_documents',
    {
      description:
        'Full-text search, relevance-ranked, over everything you can reach: documents (title + current version body) and comments (body + suggested-edit text). Use this when you have words to look for; use list_documents to enumerate or filter by project/view with no query. Returns { documents, comments } — comment hits carry a snippet and the anchor, so you can jump straight to the thread; if comment search fails independently, `comments` comes back empty rather than failing the call. Errors: `empty_query` (blank or whitespace-only); plus `rate_limited`, which any tool can return.',
      inputSchema: {
        query: z
          .string()
          .describe(
            'Free-text search terms, matched against document titles and bodies and against comment text. Non-empty after trimming.',
          ),
      },
    },
    tool('search_documents', async ({ query }) => {
      // Parity with the HTTP /documents/search route: one call, both result
      // kinds (ADR 0003 §C). Comment search is separately permission-scoped in
      // the query; either can fail empty independently.
      const [docs, comments] = await Promise.all([
        searchDocuments(deps.search, actor, query),
        searchComments(deps.search, actor, query),
      ]);
      if (!docs.ok) return errorResult(docs.error.code);
      return jsonResult({
        documents: docs.value.map((h) => ({
          id: h.documentId,
          title: h.title,
          project_id: h.projectId,
        })),
        comments: comments.ok
          ? comments.value.map((h) => ({
              comment_id: h.commentId,
              document_id: h.documentId,
              document_title: h.documentTitle,
              snippet: h.snippet,
              status: h.status,
              anchor: h.anchor,
            }))
          : [],
      });
    }),
  );

  return server;
}
