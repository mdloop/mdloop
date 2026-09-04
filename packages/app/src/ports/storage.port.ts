import type { OrgId, DocumentId, PublicDocId } from '@mdloop/shared';

/**
 * Blob storage for immutable document versions (ARCHITECTURE.md §4).
 * Implementations: S3 (prod), local filesystem (dev). Objects are write-once:
 * `put` of an existing key must reject unless the content is byte-identical
 * (an upload retried after a failed DB commit re-puts the same bytes).
 */
export interface StoragePort {
  put(key: VersionKey, content: Uint8Array): Promise<void>;
  get(key: VersionKey): Promise<Uint8Array>;
  /** Remove one version blob (version auto-purge, ADR 0001). Idempotent. */
  delete(key: VersionKey): Promise<void>;
  /** Permanently remove all objects for a document (retention purge). */
  deleteDocument(orgId: OrgId, documentId: DocumentId): Promise<void>;
  /** Permanently remove every object of an org (org purge, Phase 13). */
  deleteOrg(orgId: OrgId): Promise<void>;
  /** Public Docs Hub snapshot write (ADR 0004) — separate keyspace, write-once like `put`. */
  putPublic(key: PublicDocKey, content: Uint8Array): Promise<void>;
  /** Public Docs Hub snapshot read (ADR 0004) — the only read the unauthenticated route uses. */
  getPublic(key: PublicDocKey): Promise<Uint8Array>;
}

export interface VersionKey {
  readonly orgId: OrgId;
  readonly documentId: DocumentId;
  readonly seq: number;
}

/** Canonical object key layout: orgs/{orgId}/docs/{documentId}/v{seq}. */
export function versionObjectKey(key: VersionKey): string {
  return `orgs/${key.orgId}/docs/${key.documentId}/v${String(key.seq)}`;
}

export interface PublicDocKey {
  readonly publicDocId: PublicDocId;
  readonly seq: number;
}

/** Canonical public object key layout: public/{publicDocId}/v{seq}. Deliberately outside the orgs/ tenant keyspace — there is no tenant isolation to inherit for public content (ADR 0004). */
export function publicObjectKey(key: PublicDocKey): string {
  return `public/${key.publicDocId}/v${String(key.seq)}`;
}
