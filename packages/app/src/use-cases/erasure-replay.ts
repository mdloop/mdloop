import type { ErasureLogPort } from '../ports/erasure-log.port.js';
import type { OrgLifecyclePort } from '../ports/organization-lifecycle.port.js';
import type { StoragePort } from '../ports/storage.port.js';
import type { DocumentRepository, VersionRepository } from '../ports/repositories.port.js';
import type { TenantContext } from '../tenant-context.js';

export interface ErasureReplayDeps {
  readonly erasures: ErasureLogPort;
  readonly orgs: OrgLifecyclePort;
  readonly documents: DocumentRepository;
  readonly versions: VersionRepository;
  readonly storage: StoragePort;
}

export interface ErasureReplayReport {
  readonly eventsReplayed: number;
  readonly orgsPurged: number;
  readonly documentsPurged: number;
  readonly versionsPurged: number;
}

/**
 * Post-restore erasure replay (Phase 14; wired into the Phase 10 restore
 * runbook): a PITR restore resurrects rows and blobs that were purged after
 * the backup was taken — replaying the erasure log re-applies every purge so
 * "purged" stays purged (the GDPR-clean promise).
 * Idempotent by construction: each step is a delete/tombstone that no-ops
 * when the target is already gone, so replaying twice — or replaying events
 * whose org was later fully purged — changes nothing.
 */
export async function replayErasures(deps: ErasureReplayDeps): Promise<ErasureReplayReport> {
  const log = await deps.erasures.list();
  const report = { eventsReplayed: 0, orgsPurged: 0, documentsPurged: 0, versionsPurged: 0 };

  for (const event of log) {
    const ctx: TenantContext = { orgId: event.orgId, userId: 'system-erasure-replay' as never };
    switch (event.kind) {
      case 'org_purge': {
        await deps.storage.deleteOrg(event.orgId);
        if (await deps.orgs.orgById(event.orgId)) {
          await deps.orgs.purgeOrganization(event.orgId);
          report.orgsPurged += 1;
        }
        break;
      }
      case 'document_purge': {
        await deps.storage.deleteDocument(event.orgId, event.documentId);
        if (await deps.documents.byId(ctx, event.documentId)) {
          await deps.documents.purge(ctx, event.documentId);
          report.documentsPurged += 1;
        }
        break;
      }
      case 'version_purge': {
        await deps.storage.delete({
          orgId: event.orgId,
          documentId: event.documentId,
          seq: event.versionSeq,
        });
        // The restore may have brought the row back live: find it by seq and
        // re-tombstone. A row already tombstoned (or gone) is left alone.
        const versions = await deps.versions.listForDocument(ctx, event.documentId);
        const resurrected = versions.find((v) => v.seq === event.versionSeq && v.purgedAt === null);
        if (resurrected) {
          await deps.versions.tombstone(ctx, resurrected.id);
          report.versionsPurged += 1;
        }
        break;
      }
    }
    report.eventsReplayed += 1;
  }
  return report;
}
