import type { ReviewStatus } from '@mdloop/domain';
import type { DocumentId, ProjectId, Result } from '@mdloop/shared';
import { err, ok } from '@mdloop/shared';
import type {
  DocumentRepository,
  ProjectRepository,
  ReviewRepository,
} from '../ports/repositories.port.js';
import type { Actor } from './org-settings.js';

/**
 * Above this many live documents the tree is not worth building or shipping,
 * and the lane falls back to the paged flat list. ~2000 rows of this payload
 * is a few hundred KB — large but survivable; an order of magnitude more is
 * not, and no reader scans a 20,000-node tree anyway.
 */
export const PROJECT_TREE_MAX_DOCUMENTS = 2000;

export interface ProjectTreeError {
  readonly code: 'project_not_found';
}

/**
 * One document in the workspace tree. Deliberately the smallest payload a
 * folder-aware, review-attention-shaped index needs — no content, no version
 * ids, no owner: `path` positions the row, `openCommentCount` is what the
 * folder rows aggregate upward, `reviewStatus` is the per-file chip.
 */
export interface ProjectTreeDocument {
  readonly id: DocumentId;
  readonly title: string;
  /** Repo-relative path, or null for a manual upload with no repo origin. */
  readonly path: string | null;
  readonly openCommentCount: number;
  readonly reviewStatus: ReviewStatus;
}

/**
 * The whole project index, flat. The client splits `path` on `/` and builds
 * the hierarchy — nesting is a rendering decision, so the server never shapes
 * it (and never has to agree with the client about collapse state or ordering).
 *
 * `tooLarge` is the honest fallback signal: `documents` is empty and the lane
 * should render today's paged flat list instead. `documentCount` is populated
 * either way so the UI can say how many rows it declined to draw.
 */
export interface ProjectTree {
  readonly projectId: ProjectId;
  readonly tooLarge: boolean;
  readonly documentCount: number;
  readonly documents: ProjectTreeDocument[];
}

/**
 * The workspace file tree for one project (Phase 29).
 *
 * Unpaged on purpose. `/overview` is keyset-paged at 50/page, so aggregating a
 * folder's open-comment total over just the loaded page would under-report
 * every folder past the first page — and "where are people stuck" is the whole
 * reason this tree exists. The size bound is a COUNT first, so an oversized
 * project costs one cheap query rather than thousands of rows and their
 * aggregates.
 *
 * Access-scoped exactly like the home overview (owner/grant/admin, with RLS
 * underneath): a member sees their slice of the project, an admin sees all of
 * it, and an actor in another org cannot resolve the project at all.
 */
export async function projectTree(
  documents: DocumentRepository,
  projects: ProjectRepository,
  reviews: ReviewRepository,
  actor: Actor,
  projectId: ProjectId,
  maxDocuments: number = PROJECT_TREE_MAX_DOCUMENTS,
): Promise<Result<ProjectTree, ProjectTreeError>> {
  // RLS scopes `byId` to the caller's org, so a cross-org id is simply absent
  // — the tenant boundary and the 404 are the same answer.
  const project = await projects.byId(actor.ctx, projectId);
  if (!project) return err({ code: 'project_not_found' });

  const access = { userId: actor.ctx.userId, role: actor.role };
  const documentCount = await documents.countLiveInProject(actor.ctx, access, projectId);
  if (documentCount > maxDocuments) {
    return ok({ projectId, tooLarge: true, documentCount, documents: [] });
  }

  const rows = await documents.listProjectIndex(actor.ctx, access, projectId);
  const reviewRows = await reviews.reviewRollup(
    actor.ctx,
    rows.map((r) => r.document.id),
  );
  const reviewByDoc = new Map<DocumentId, ReviewStatus>(
    reviewRows.map((r) => [r.documentId, r.status]),
  );

  return ok({
    projectId,
    tooLarge: false,
    documentCount: rows.length,
    documents: rows.map((r) => ({
      id: r.document.id,
      title: r.document.title,
      path: r.document.path,
      openCommentCount: r.open,
      // `draft` = nobody has been asked to review, same default as /overview.
      reviewStatus: reviewByDoc.get(r.document.id) ?? 'draft',
    })),
  });
}
