import { effectiveVersionRetention, selectVersionsToPurge } from '@vorlyn/domain';
import type { OrgId, UserId, VersionId } from '@vorlyn/shared';
import type {
  CommentRepository,
  DocumentRepository,
  VersionPurgeSweepRepository,
  VersionRepository,
} from '../ports/repositories.port.js';
import type { ErasureLogPort } from '../ports/erasure-log.port.js';
import type { StoragePort } from '../ports/storage.port.js';
import type { TenantContext } from '../tenant-context.js';
import type { OrganizationRepository } from './org-settings.js';

export interface VersionPurgeDeps {
  readonly sweep: VersionPurgeSweepRepository;
  readonly orgs: OrganizationRepository;
  readonly documents: DocumentRepository;
  readonly versions: VersionRepository;
  readonly comments: CommentRepository;
  readonly storage: StoragePort;
  readonly erasures: ErasureLogPort;
}

export interface VersionPurgeReport {
  readonly orgsSwept: number;
  readonly versionsPurged: number;
}

/**
 * Version auto-purge worker (ADR 0001). Sweeps every org: resolves the org's
 * effective N/T rule (org config clamped to tier ceiling), selects purgeable
 * versions per live document — never the current version, never a version
 * pinned by an open comment, never an existing tombstone — then tombstones
 * the row and deletes the blob. Row first, blob second: a failed blob delete
 * leaves an orphaned object to retry, never a live row pointing at nothing.
 */
export async function sweepVersionPurge(
  deps: VersionPurgeDeps,
  now: Date = new Date(),
): Promise<VersionPurgeReport> {
  const orgIds = await deps.sweep.listOrgIds();
  let versionsPurged = 0;
  for (const orgId of orgIds) {
    versionsPurged += await purgeOrgVersions(deps, orgId, now);
  }
  return { orgsSwept: orgIds.length, versionsPurged };
}

async function purgeOrgVersions(deps: VersionPurgeDeps, orgId: OrgId, now: Date): Promise<number> {
  const ctx: TenantContext = { orgId, userId: 'system-version-purge' as UserId };
  const org = await deps.orgs.current(ctx);
  if (!org) return 0;
  const rule = effectiveVersionRetention(org.tier, org.versionRetention);

  let purged = 0;
  // Both live views: archived documents keep their content and purge on the
  // same schedule; soft-deleted ones are the document-retention sweep's job.
  const documents = [
    ...(await deps.documents.list(ctx, { view: 'all' })),
    ...(await deps.documents.list(ctx, { view: 'archived' })),
  ];
  for (const document of documents) {
    const versions = await deps.versions.listForDocument(ctx, document.id);
    const pinned = await deps.comments.openCommentVersionIds(ctx, document.id);
    const toPurge = selectVersionsToPurge(
      {
        versions,
        keepLastN: rule.keepLastN,
        keepDays: rule.keepDays,
        currentVersionId: document.currentVersionId,
        openCommentVersionIds: new Set<string>(pinned),
      },
      now,
    );
    for (const id of toPurge) {
      const tombstoned = await deps.versions.tombstone(ctx, id as VersionId);
      if (!tombstoned) continue;
      await deps.storage.delete({ orgId, documentId: document.id, seq: tombstoned.seq });
      await deps.erasures.record({
        kind: 'version_purge',
        orgId,
        documentId: document.id,
        versionSeq: tombstoned.seq,
      });
      purged += 1;
    }
  }
  return purged;
}
