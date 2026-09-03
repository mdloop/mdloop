import type { Anchor, Comment, DocumentVersion } from '@vorlyn/domain';
import { REANCHOR_MAX_DIFF_BYTES, diffVersions, resolveTextAnchor } from '@vorlyn/domain';
import type { DocumentId, Result, VersionId } from '@vorlyn/shared';
import { err, ok } from '@vorlyn/shared';
import type {
  AnchorResolution,
  AnchorResolutionRepository,
  CommentRepository,
  DocumentRepository,
  VersionRepository,
} from '../ports/repositories.port.js';
import type { StoragePort } from '../ports/storage.port.js';
import type { Actor } from './org-settings.js';
import type { CommentError, CommentThread, ThreadPageInput } from './comments.js';
import { listCommentThreads } from './comments.js';

export interface ThreadWithResolution extends CommentThread {
  /** How the anchor lands on the document's current version. */
  readonly resolution: AnchorResolution;
}

const decoder = new TextDecoder();

/**
 * Non-text anchors resolve without a diff: document anchors always hold;
 * diagram anchors hold while their stable id still appears in the source
 * (mermaid ids are source-level names — presence is the honest signal).
 */
function resolveNonText(
  anchor: Exclude<Anchor, { type: 'text' }>,
  currentSource: string,
): { method: 'exact' | 'orphan'; confidence: number } {
  if (anchor.type === 'document') return { method: 'exact', confidence: 1 };
  const needle = typeof anchor.stableId === 'string' ? anchor.stableId : anchor.stableId.text;
  return currentSource.includes(needle)
    ? { method: 'exact', confidence: 1 }
    : { method: 'orphan', confidence: 0 };
}

/**
 * Threads plus lazy re-anchoring (ARCHITECTURE.md §6): comments pinned to
 * older versions are resolved against the current version through the domain
 * pipeline, cached in comment_anchor_resolutions, and never guessed —
 * confidence below the floor comes back as an honest orphan.
 *
 * Scale discipline (Phase 24.F):
 *  - `page` keyset-slices the thread list (passed straight to
 *    listCommentThreads); the resolution work is bounded to the page.
 *  - Re-anchoring is processed one pinned-version GROUP at a time. Each
 *    group's decoded source + diff structure is released before the next
 *    group, so a document whose open comments span 20 historical versions
 *    never holds all 20 decoded sources (~40 MB, UTF-16 doubled) at once.
 *  - Either leg over REANCHOR_MAX_DIFF_BYTES degrades that comment to an
 *    honest orphan WITHOUT decoding the oversized blob — the byte size is read
 *    from the version row, so the 2 MB×2 MB `diff_main` never runs and the
 *    blob is never even fetched (Core Principle 2: never guess).
 */
export async function listThreadsWithResolutions(
  documents: DocumentRepository,
  comments: CommentRepository,
  versions: VersionRepository,
  resolutions: AnchorResolutionRepository,
  storage: StoragePort,
  actor: Actor,
  documentId: DocumentId,
  status?: 'open' | 'resolved',
  page?: ThreadPageInput,
): Promise<Result<{ threads: ThreadWithResolution[]; nextCursor: string | null }, CommentError>> {
  const threads = await listCommentThreads(documents, comments, actor, documentId, status, page);
  if (!threads.ok) return threads;
  const document = await documents.byId(actor.ctx, documentId);
  if (!document?.currentVersionId) return err({ code: 'no_version' });
  const currentVersionId = document.currentVersionId;
  const currentVersion = await versions.byId(actor.ctx, currentVersionId);
  if (!currentVersion) throw new Error('version row missing for current version');

  const cached = new Map(
    (await resolutions.forVersion(actor.ctx, currentVersionId)).map((r) => [r.commentId, r]),
  );

  // The current source is one blob, shared by every group — loaded lazily and
  // only once (unavoidable, bounded to a single version).
  const currentSeq = currentVersion.seq;
  let currentSource: string | undefined;
  async function currentSourceOf(): Promise<string> {
    if (currentSource !== undefined) return currentSource;
    const text = decoder.decode(
      await storage.get({ orgId: actor.ctx.orgId, documentId, seq: currentSeq }),
    );
    currentSource = text;
    return text;
  }

  const resolutionByComment = new Map<string, AnchorResolution>();

  // Group the threads that still need resolving by their pinned version, so we
  // can decode + diff each pinned source once and release it per group.
  const toResolve = threads.value.threads.filter(
    (t) => t.comment.versionId !== currentVersionId && !cached.has(t.comment.id),
  );
  const groups = new Map<VersionId, CommentThread[]>();
  for (const thread of toResolve) {
    const bucket = groups.get(thread.comment.versionId);
    if (bucket) bucket.push(thread);
    else groups.set(thread.comment.versionId, [thread]);
  }

  for (const [pinnedVersionId, group] of groups) {
    const pinned = await versionRow(versions, actor, pinnedVersionId);
    const legTooLarge =
      pinned.byteSize > REANCHOR_MAX_DIFF_BYTES ||
      currentVersion.byteSize > REANCHOR_MAX_DIFF_BYTES;

    // Lazily materialized per group, then dropped when the group ends.
    let diffs: ReturnType<typeof diffVersions> | undefined;

    for (const thread of group) {
      const { comment } = thread;
      let resolution: AnchorResolution;
      if (comment.anchor.type !== 'text') {
        const r = resolveNonText(comment.anchor, await currentSourceOf());
        resolution = res(comment.id, currentVersionId, r.method, r.confidence, null, null);
      } else if (legTooLarge) {
        // Honest orphan: too large to diff safely, so we never guess a location.
        resolution = res(comment.id, currentVersionId, 'orphan', 0, null, null);
      } else {
        if (!diffs) {
          const current = await currentSourceOf();
          // Tombstoned pinned version (ADR 0001): the blob is gone, so no diff —
          // the anchor's own quote + context still drive exact/context/fuzzy
          // search; only diff-offset mapping is lost, and it is
          // similarity-verified anyway. Below the floor this orphans honestly.
          diffs = pinned.purgedAt
            ? diffVersions(current, current)
            : diffVersions(await pinnedSourceOf(storage, actor, documentId, pinned), current);
        }
        const r = resolveTextAnchor(comment.anchor, await currentSourceOf(), diffs);
        resolution = res(
          comment.id,
          currentVersionId,
          r.method,
          r.confidence,
          r.method === 'orphan' ? null : r.start,
          r.method === 'orphan' ? null : r.end,
        );
      }
      await resolutions.upsert(actor.ctx, resolution);
      resolutionByComment.set(comment.id, resolution);
    }
    // `diffs` (and any pinned source it closed over) is released here, before
    // the next group — the per-group memory discipline.
  }

  const out: ThreadWithResolution[] = await Promise.all(
    threads.value.threads.map(async (thread) => {
      const { comment } = thread;
      if (comment.versionId === currentVersionId) {
        const anchor = comment.anchor;
        const resolution = res(
          comment.id,
          currentVersionId,
          'exact',
          1,
          anchor.type === 'text' ? anchor.start : null,
          anchor.type === 'text' ? anchor.end : null,
        );
        const updated = await materializeIfMatched(
          comments,
          actor,
          comment,
          resolution,
          currentVersionId,
          currentSourceOf,
        );
        return { ...thread, comment: updated, resolution };
      }
      const resolution = cached.get(comment.id) ?? resolutionByComment.get(comment.id);
      if (!resolution) throw new Error('resolution missing for comment');
      const updated = await materializeIfMatched(
        comments,
        actor,
        comment,
        resolution,
        currentVersionId,
        currentSourceOf,
      );
      return { ...thread, comment: updated, resolution };
    }),
  );

  return ok({ threads: out, nextCursor: threads.value.nextCursor });
}

/**
 * Lazy suggestion-materialization check (ADR 0007): accepting a suggestion no
 * longer mints a version, so whether it was actually applied is discovered
 * here, for free, on the same re-anchor pass every comment already gets. For
 * an accepted-but-unapplied suggestion whose anchor resolved (not orphaned),
 * an exact string match between the resolved range and `proposedText` means
 * some real edit already applied it — persist that lazily. No match (fuzzy or
 * absent) leaves it `accepted` and pending; never guessed. Plain comments and
 * already-applied/rejected suggestions skip the slice+compare entirely.
 */
async function materializeIfMatched(
  comments: CommentRepository,
  actor: Actor,
  comment: Comment,
  resolution: AnchorResolution,
  currentVersionId: VersionId,
  currentSourceOf: () => Promise<string>,
): Promise<Comment> {
  if (
    comment.kind !== 'suggestion' ||
    comment.suggestionOutcome !== 'accepted' ||
    comment.appliedVersionId !== null ||
    resolution.method === 'orphan' ||
    resolution.start === null ||
    resolution.end === null
  ) {
    return comment;
  }
  const currentSource = await currentSourceOf();
  const actual = currentSource.slice(resolution.start, resolution.end);
  if (actual !== comment.proposedText) return comment;
  const applied = await comments.markSuggestionApplied(actor.ctx, comment.id, currentVersionId);
  return applied ?? comment;
}

/** Compact AnchorResolution builder — every field is required, so name them once. */
function res(
  commentId: AnchorResolution['commentId'],
  versionId: VersionId,
  method: AnchorResolution['method'],
  confidence: number,
  start: number | null,
  end: number | null,
): AnchorResolution {
  return { commentId, versionId, method, confidence, start, end };
}

async function versionRow(
  versions: VersionRepository,
  actor: Actor,
  versionId: VersionId,
): Promise<DocumentVersion> {
  const version = await versions.byId(actor.ctx, versionId);
  if (!version) throw new Error('version row missing for comment');
  return version;
}

async function pinnedSourceOf(
  storage: StoragePort,
  actor: Actor,
  documentId: DocumentId,
  pinned: DocumentVersion,
): Promise<string> {
  return decoder.decode(await storage.get({ orgId: actor.ctx.orgId, documentId, seq: pinned.seq }));
}
