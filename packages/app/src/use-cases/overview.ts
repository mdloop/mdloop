import type { Document, Project, ReviewStatus } from '@vorlyn/domain';
import type { DocumentId, ProjectId } from '@vorlyn/shared';
import type {
  DocumentRepository,
  OverviewAccess,
  OverviewKeyset,
  OverviewPageRow,
  ProjectRepository,
  ReviewRepository,
} from '../ports/repositories.port.js';
import type { Actor } from './org-settings.js';

/** Which home lane the document page covers. */
export interface OverviewLane {
  readonly view?: 'all' | 'unfiled' | 'archived';
  readonly projectId?: ProjectId;
}

export interface OverviewPage {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface OverviewDocument {
  readonly document: Document;
  readonly open: number;
  readonly resolved: number;
  readonly lastActivityAt: Date;
  /** Derived sign-off status (Phase B); `draft` when no reviewers requested. */
  readonly reviewStatus: ReviewStatus;
}

export interface Overview {
  readonly documents: OverviewDocument[];
  readonly nextCursor: string | null;
  readonly projects: Project[];
  readonly counts: { all: number; unfiled: number; archived: number };
  readonly openByProject: { projectId: ProjectId; open: number }[];
}

export const OVERVIEW_DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Opaque keyset cursor over (lastActivityAt desc, id desc). */
function encodeCursor(row: OverviewPageRow): string {
  return Buffer.from(`${String(row.lastActivityAt.getTime())}:${row.document.id}`).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): OverviewKeyset | null {
  const raw = Buffer.from(cursor, 'base64url').toString();
  const sep = raw.indexOf(':');
  if (sep < 1) return null;
  const time = Number(raw.slice(0, sep));
  return Number.isFinite(time)
    ? { lastActivityAt: new Date(time), id: raw.slice(sep + 1) as DocumentId }
    : null;
}

/**
 * Everything the home screen needs in one call: the lane's documents
 * (activity-sorted, paged), sidebar projects, lane counts, and per-project
 * open-comment signals. Access scoping, ordering and the keyset all live in
 * SQL now (Phase 24.F) — `overviewPage` returns only the requested page (~50
 * rows) with its comment counts, `overviewCounts` returns bounded aggregates,
 * and the review status is derived for just the page's documents. The previous
 * path pulled the full org document set into JS up to four times per render.
 *
 * `OverviewDto` (packages/web) is unchanged — this is purely an internal
 * query-shape change.
 */
export async function homeOverview(
  documents: DocumentRepository,
  projects: ProjectRepository,
  reviews: ReviewRepository,
  actor: Actor,
  lane: OverviewLane = {},
  page: OverviewPage = {},
): Promise<Overview> {
  const access: OverviewAccess = { userId: actor.ctx.userId, role: actor.role };
  const limit = Math.min(Math.max(page.limit ?? OVERVIEW_DEFAULT_LIMIT, 1), MAX_LIMIT);
  const after = page.cursor ? decodeCursor(page.cursor) : null;

  // Fetch one extra row to know whether a further page exists without a count.
  const rows = await documents.overviewPage(actor.ctx, access, lane, after, limit + 1);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const pageDocIds = pageRows.map((r) => r.document.id);

  const [allProjects, counts, reviewRows] = await Promise.all([
    projects.list(actor.ctx),
    documents.overviewCounts(actor.ctx, access),
    reviews.reviewRollup(actor.ctx, pageDocIds),
  ]);
  const reviewByDoc = new Map<DocumentId, ReviewStatus>(
    reviewRows.map((r) => [r.documentId, r.status]),
  );

  const last = pageRows.at(-1);
  return {
    documents: pageRows.map((r) => ({
      document: r.document,
      open: r.open,
      resolved: r.resolved,
      lastActivityAt: r.lastActivityAt,
      reviewStatus: reviewByDoc.get(r.document.id) ?? 'draft',
    })),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
    projects: allProjects.filter((p) => p.archivedAt === null),
    counts: { all: counts.all, unfiled: counts.unfiled, archived: counts.archived },
    openByProject: counts.openByProject.map((o) => ({ projectId: o.projectId, open: o.open })),
  };
}
