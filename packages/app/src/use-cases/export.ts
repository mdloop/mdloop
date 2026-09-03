import type { CommentReply, UploadSource } from '@vorlyn/domain';
import type { CommentId, Result } from '@vorlyn/shared';
import { err, ok } from '@vorlyn/shared';
import type {
  CommentRepository,
  DocumentExportKeyset,
  DocumentRepository,
  VersionRepository,
} from '../ports/repositories.port.js';
import type { StoragePort } from '../ports/storage.port.js';
import type { Actor, OrganizationRepository } from './org-settings.js';

/**
 * Self-serve org export (Phase 14, GDPR Art. 20): every document's current
 * markdown plus the full comment record and per-version metadata as JSON.
 * Available on every tier and — deliberately — inside the cancellation
 * read-only grace window: export is the point of that window, so there is no
 * read-only gate here.
 *
 * Keyset-paged (ADR 0003 completeness pass): a large enterprise org would be a
 * memory/timeout bomb as one synchronous blob, so the caller walks pages
 * (cursor → nextCursor until null). Memory stays flat at any org size; there is
 * deliberately no async-job infra.
 */
export interface ExportedVersion {
  readonly seq: number;
  readonly createdAt: Date;
  readonly source: UploadSource;
  /** ADR 0003 §B "what changed" note; null when unset. Metadata only — no historical blob. */
  readonly changeNote: string | null;
  /** True once the version blob was tombstoned (ADR 0001); the row survives. */
  readonly purged: boolean;
}

export interface ExportedComment {
  readonly id: string;
  readonly versionSeq: number | null;
  readonly authorId: string;
  readonly body: string;
  readonly quote: string | null;
  readonly status: 'open' | 'resolved';
  readonly createdAt: Date;
  readonly replies: {
    readonly authorId: string;
    readonly body: string;
    readonly createdAt: Date;
  }[];
}

export interface ExportedDocument {
  readonly id: string;
  readonly title: string;
  readonly projectId: string | null;
  readonly archived: boolean;
  /** Current version markdown; null when every version blob was purged. */
  readonly markdown: string | null;
  /** Every version's metadata (no historical blob content), oldest first. */
  readonly versions: ExportedVersion[];
  readonly comments: ExportedComment[];
}

export interface OrgExport {
  readonly orgId: string;
  readonly orgName: string;
  readonly exportedAt: Date;
  readonly documents: ExportedDocument[];
  /** Opaque cursor for the next page, or null when this is the last page. */
  readonly nextCursor: string | null;
}

/** Paging controls: `cursor` from a prior `nextCursor`, `limit` docs per page. */
export interface ExportPage {
  readonly cursor?: string;
  readonly limit?: number;
}

export type ExportError = { readonly code: 'forbidden' } | { readonly code: 'org_not_found' };

export const EXPORT_DEFAULT_LIMIT = 50;
const EXPORT_MAX_LIMIT = 100;

const decoder = new TextDecoder();

/** Opaque keyset cursor over (createdAt asc, id asc) — mirrors overview.ts. */
function encodeCursor(after: DocumentExportKeyset): string {
  return Buffer.from(`${String(after.createdAt.getTime())}:${after.id}`).toString('base64url');
}

function decodeCursor(cursor: string): DocumentExportKeyset | null {
  const raw = Buffer.from(cursor, 'base64url').toString();
  const sep = raw.indexOf(':');
  if (sep < 1) return null;
  const time = Number(raw.slice(0, sep));
  if (!Number.isFinite(time)) return null;
  return { createdAt: new Date(time), id: raw.slice(sep + 1) as DocumentExportKeyset['id'] };
}

/** Admin-only: one page of the org. (Per-document export is the GET content route.) */
export async function exportOrg(
  orgs: OrganizationRepository,
  documents: DocumentRepository,
  versions: VersionRepository,
  comments: CommentRepository,
  storage: StoragePort,
  actor: Actor,
  page: ExportPage = {},
  now: Date = new Date(),
): Promise<Result<OrgExport, ExportError>> {
  if (actor.role !== 'admin') return err({ code: 'forbidden' });
  const org = await orgs.current(actor.ctx);
  if (!org) return err({ code: 'org_not_found' });

  const limit = Math.min(Math.max(page.limit ?? EXPORT_DEFAULT_LIMIT, 1), EXPORT_MAX_LIMIT);
  const after = page.cursor ? decodeCursor(page.cursor) : null;
  // Fetch one extra to detect a following page without a second round-trip.
  const rows = await documents.listForExport(actor.ctx, after, limit + 1);
  const pageDocs = rows.slice(0, limit);
  const last = pageDocs.at(-1);
  const nextCursor = rows.length > limit && last ? encodeCursor(last) : null;

  const out: ExportedDocument[] = [];
  for (const document of pageDocs) {
    const documentVersions = await versions.listForDocument(actor.ctx, document.id);
    const seqById = new Map(documentVersions.map((v) => [v.id as string, v.seq]));
    const current = documentVersions.find((v) => v.id === document.currentVersionId);

    let markdown: string | null = null;
    if (current?.purgedAt === null) {
      markdown = decoder.decode(
        await storage.get({ orgId: actor.ctx.orgId, documentId: document.id, seq: current.seq }),
      );
    }

    // One batch read of every reply on the document (review-UX pass); the old
    // per-comment listReplies loop was an N+1.
    const repliesByComment = new Map<CommentId, CommentReply[]>();
    for (const reply of await comments.listRepliesForDocument(actor.ctx, document.id)) {
      const list = repliesByComment.get(reply.commentId);
      if (list) list.push(reply);
      else repliesByComment.set(reply.commentId, [reply]);
    }

    const documentComments = await comments.listForDocument(actor.ctx, document.id);
    const exported: ExportedComment[] = documentComments.map((comment) => ({
      id: comment.id,
      versionSeq: seqById.get(comment.versionId) ?? null,
      authorId: comment.authorId,
      body: comment.body,
      // The anchor-stored quote survives even version purges (ADR 0001).
      quote: comment.anchor.type === 'text' ? comment.anchor.exact : null,
      status: comment.status,
      createdAt: comment.createdAt,
      replies: (repliesByComment.get(comment.id) ?? []).map((r) => ({
        authorId: r.authorId,
        body: r.body,
        createdAt: r.createdAt,
      })),
    }));

    out.push({
      id: document.id,
      title: document.title,
      projectId: document.projectId,
      archived: document.archivedAt !== null,
      markdown,
      versions: documentVersions.map((v) => ({
        seq: v.seq,
        createdAt: v.createdAt,
        source: v.source,
        changeNote: v.changeNote,
        purged: v.purgedAt !== null,
      })),
      comments: exported,
    });
  }

  return ok({ orgId: org.id, orgName: org.name, exportedAt: now, documents: out, nextCursor });
}
