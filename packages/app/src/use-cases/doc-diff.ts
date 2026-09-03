import type { DocDiff } from '@vorlyn/domain';
import { DIFF_MAX_BYTES, computeDocDiff } from '@vorlyn/domain';
import type { DocumentId, OrgId, Result } from '@vorlyn/shared';
import { err, ok } from '@vorlyn/shared';
import type { DocumentRepository, VersionRepository } from '../ports/repositories.port.js';
import type { ShareGrantRepository } from '../ports/repositories.port.js';
import type { StoragePort } from '../ports/storage.port.js';
import type { Actor } from './org-settings.js';
import { requireDocumentAccess } from './sharing.js';

/**
 * Rendered leg diff (ADR 0003 §A). Resolves the document at `read` level,
 * loads both pinned version rows, and computes the tier-1 structural diff over
 * their blobs — read strictly through the typed VersionKey storage port. Never
 * logs content (Core Principle 3). Honest degradation:
 * - a purged (tombstoned) leg returns `version_purged` (ADR §A.5), mirroring
 *   how suggestion-accept degrades against a purged pin (ADR 0001);
 * - a leg over the byte cap returns `diff_too_large` WITHOUT reading its blob —
 *   the caller falls back to the client-side source `<pre>` view (ADR §A.4).
 *
 * Both legs' immutable `contentHash` and each leg's `changeNote` come back so
 * the transport can build the strong pair-ETag and surface the version notes.
 */
export type DocDiffError =
  | { readonly code: 'document_not_found' }
  | { readonly code: 'version_not_found' }
  | { readonly code: 'version_purged' }
  | { readonly code: 'diff_too_large' };

export interface DocDiffDeps {
  readonly documents: DocumentRepository;
  readonly grants: ShareGrantRepository;
  readonly versions: VersionRepository;
  readonly storage: StoragePort;
}

export interface DocDiffLeg {
  readonly seq: number;
  readonly contentHash: string;
  readonly changeNote: string | null;
}

export interface DocDiffResult {
  readonly from: DocDiffLeg;
  readonly to: DocDiffLeg;
  readonly diff: DocDiff;
}

export interface DocDiffInput {
  readonly documentId: DocumentId;
  readonly fromSeq: number;
  readonly toSeq: number;
}

/**
 * The metadata half of a diff: access check + both version rows, resolved
 * without touching a blob. The route builds its strong pair-ETag off this
 * alone and can 304 before `documentDiff` ever reads storage or computes
 * anything (ADR §A.4 — the byte-cap 413 already lived here; conditional-GET
 * shares the same cheap path).
 */
export interface DocDiffMeta {
  readonly documentId: DocumentId;
  readonly from: DocDiffLeg & { readonly byteSize: number };
  readonly to: DocDiffLeg & { readonly byteSize: number };
}

const decoder = new TextDecoder();

export async function resolveDocDiffMeta(
  deps: Pick<DocDiffDeps, 'documents' | 'grants' | 'versions'>,
  actor: Actor,
  input: DocDiffInput,
): Promise<Result<DocDiffMeta, DocDiffError>> {
  const access = await requireDocumentAccess(
    deps.documents,
    deps.grants,
    actor,
    input.documentId,
    'read',
  );
  // Insufficient access reads as not-found — no existence oracle (sharing.ts).
  if (!access.ok) return err({ code: 'document_not_found' });
  const document = access.value.document;

  const all = await deps.versions.listForDocument(actor.ctx, document.id);
  const from = all.find((v) => v.seq === input.fromSeq);
  const to = all.find((v) => v.seq === input.toSeq);
  if (!from || !to) return err({ code: 'version_not_found' });

  // A tombstoned leg has no blob to diff — degrade honestly (ADR §A.5).
  if (from.purgedAt || to.purgedAt) return err({ code: 'version_purged' });

  // Byte cap, from metadata, before any blob read (ADR §A.4). The domain diff
  // re-checks bytes and the block cap; this only avoids two wasted blob reads.
  if (from.byteSize > DIFF_MAX_BYTES || to.byteSize > DIFF_MAX_BYTES) {
    return err({ code: 'diff_too_large' });
  }

  return ok({
    documentId: document.id,
    from: {
      seq: from.seq,
      contentHash: from.contentHash,
      changeNote: from.changeNote,
      byteSize: from.byteSize,
    },
    to: {
      seq: to.seq,
      contentHash: to.contentHash,
      changeNote: to.changeNote,
      byteSize: to.byteSize,
    },
  });
}

/** Blob read + diff compute, given an already-resolved `DocDiffMeta` (the route's post-304 path). */
export async function computeDocDiffFromMeta(
  deps: Pick<DocDiffDeps, 'storage'>,
  orgId: OrgId,
  meta: DocDiffMeta,
): Promise<Result<DocDiffResult, DocDiffError>> {
  const [beforeBytes, afterBytes] = await Promise.all([
    deps.storage.get({ orgId, documentId: meta.documentId, seq: meta.from.seq }),
    deps.storage.get({ orgId, documentId: meta.documentId, seq: meta.to.seq }),
  ]);
  const diff = computeDocDiff(decoder.decode(beforeBytes), decoder.decode(afterBytes));
  if (!diff.ok) return err({ code: 'diff_too_large' });

  return ok({ from: meta.from, to: meta.to, diff: diff.value });
}

export async function documentDiff(
  deps: DocDiffDeps,
  actor: Actor,
  input: DocDiffInput,
): Promise<Result<DocDiffResult, DocDiffError>> {
  const meta = await resolveDocDiffMeta(deps, actor, input);
  if (!meta.ok) return meta;
  return computeDocDiffFromMeta(deps, actor.ctx.orgId, meta.value);
}
