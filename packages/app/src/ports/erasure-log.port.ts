import type { DocumentId, OrgId } from '@vorlyn/shared';

/**
 * Erasure log (Phase 14, GDPR Art. 17 pattern): every purge appends an
 * event of opaque ids + a timestamp — enough to re-apply erasures after a
 * backup restore, never enough to reconstruct content (Core Principle 3).
 * Version events carry the seq (the blob key component), not the row id:
 * replay needs to delete the object and tombstone whatever row a restore
 * brought back.
 */
export type ErasureEvent =
  | { readonly kind: 'org_purge'; readonly orgId: OrgId }
  | { readonly kind: 'document_purge'; readonly orgId: OrgId; readonly documentId: DocumentId }
  | {
      readonly kind: 'version_purge';
      readonly orgId: OrgId;
      readonly documentId: DocumentId;
      readonly versionSeq: number;
    };

export type LoggedErasure = ErasureEvent & { readonly occurredAt: Date };

export interface ErasureLogPort {
  record(event: ErasureEvent): Promise<void>;
  /** Full log, oldest first — the post-restore replay input. */
  list(): Promise<LoggedErasure[]>;
}
