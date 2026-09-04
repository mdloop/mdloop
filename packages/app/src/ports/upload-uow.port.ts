import type {
  Comment,
  Document,
  DocumentVersion,
  Organization,
  Project,
  ShareGrant,
} from '@mdloop/domain';
import type { CommentId, DocumentId, ProjectId, UserId, VersionId } from '@mdloop/shared';
import type { TenantContext } from '../tenant-context.js';
import type { NewDocument, NewVersion } from './repositories.port.js';

/**
 * Repositories bound to one open tenant transaction — `uow.run` opens and
 * commits/rolls back exactly one. The upload use-cases (upload.ts) call it
 * TWICE per upload (Phase 24 follow-up, upload-transaction lock reshape):
 * once to check quota/caps and reserve the next version seq (fast, no blob
 * I/O — this is the transaction that holds the per-document lock), and once,
 * after the blob is written, to insert the version row and everything that
 * must commit atomically with it (ledger, search index, a suggestion-accept
 * outcome flip). Splitting this way means the row lock's lifetime no longer
 * spans potentially-slow storage I/O (S3 latency in prod), while every cap
 * check still reads live committed rows (`activeDocCount`/`liveVersionCount`
 * never overcounts a reservation that didn't pan out — a seq reserved in
 * phase one but never inserted in phase two is a harmless gap in the
 * document's seq numbering, not a phantom row anything counts).
 */
export interface IndexVersionInput {
  readonly documentId: DocumentId;
  readonly versionId: VersionId;
  readonly title: string;
  readonly body: string;
}

export interface UploadTx {
  /** The caller's org row — tier + settings for cap checks (`TIER_PROFILES`, tier.ts). */
  org(): Promise<Organization | undefined>;
  documentById(id: DocumentId): Promise<Document | undefined>;
  projectById(id: ProjectId): Promise<Project | undefined>;
  createDocument(input: NewDocument): Promise<Document>;
  /**
   * The live document occupying `path` in `projectId`, if any (Phase 29) — the
   * transactional sibling of `DocumentRepository.documentIdAtPath`, so the
   * collision pre-check reads inside the SAME transaction as the create/repath
   * that follows it. Turns the common sync collision into a typed `path_taken`
   * instead of `documents_project_path_uniq`'s raw constraint violation; the
   * index is still the actual guarantee.
   */
  documentIdAtPath(projectId: ProjectId | null, path: string): Promise<DocumentId | undefined>;
  /**
   * Repoints a document at a new repo path (Phase 29). Only the sync CLI's
   * rename/move detection reaches this: a `git mv` re-sends the SAME
   * document_id with the new path, so the document moves in the tree rather
   * than forking a duplicate. Touches nothing else — `project_id` is a human
   * decision and stays put. Returns undefined if the row is gone/deleted.
   */
  setDocumentPath(id: DocumentId, path: string): Promise<Document | undefined>;
  /** Non-deleted documents in the org — the tier doc cap counts these. */
  activeDocCount(): Promise<number>;
  /** Non-deleted documents in one project — the tier per-project doc cap counts these (Phase 33). */
  activeDocCountInProject(projectId: ProjectId): Promise<number>;
  /** Live (non-tombstoned) versions of the document — the tier version cap counts these, never tombstones (ADR 0001). */
  liveVersionCount(documentId: DocumentId): Promise<number>;
  /** Highest-seq version of the document, if any. */
  currentVersion(documentId: DocumentId): Promise<DocumentVersion | undefined>;
  /**
   * Phase one: locks the document row and reserves the next seq — no insert.
   * The lock is released when this transaction commits, before the blob is
   * ever written.
   */
  reserveVersionSeq(documentId: DocumentId): Promise<number>;
  /**
   * Phase two: inserts the version row at an already-reserved seq, after the
   * blob is written and in a new transaction — no lock needed, the seq is
   * exclusively ours (schema-backed by `document_versions_doc_seq_uniq`).
   */
  insertVersionAtSeq(seq: number, input: NewVersion): Promise<DocumentVersion>;
  recordUpload(versionId: VersionId, byteSize: number): Promise<void>;
  /**
   * Upserts the search_index row for this document from the version just
   * appended, in the same transaction — a document is never searchable
   * without its version committed, or vice versa.
   */
  indexVersion(input: IndexVersionInput): Promise<void>;
  /**
   * Flip an OPEN suggestion to `accepted` (with `appliedVersionId` = the
   * version just minted) in THIS transaction. Accepting a suggestion is an
   * upload plus an outcome flip; folding both here closes the crash window
   * where the version committed but the suggestion stayed `open` (Phase 24.D).
   * Returns undefined if the suggestion was already resolved (lost the accept
   * race) — the caller surfaces that as a conflict, the minted version stays.
   */
  markSuggestionAccepted(id: CommentId, appliedVersionId: VersionId): Promise<Comment | undefined>;
  /**
   * The caller's highest-ranked active (non-revoked, unexpired) share grant on
   * this document OR on the project it currently lives in (ADR 0008, ADR
   * 0014) — the input `canEditDocument` needs. Reading it inside the SAME
   * transaction as the rest of the upload gate is what stops a concurrent
   * revoke from racing a push through. `projectId` is optional so callers on
   * an unfiled document can omit it.
   */
  highestGrantFor(
    documentId: DocumentId,
    userId: UserId,
    projectId?: ProjectId | null,
  ): Promise<ShareGrant | undefined>;
  /**
   * Compensating rollback for `uploadNewDocument` (upload.ts): if `storage.put`
   * (or the phase-two finalize transaction) fails after `createDocument`
   * already committed, the row is pure garbage — brand new, never had a
   * version, nothing hangs off it — so a hard delete is safe where it
   * normally wouldn't be. Runs in its OWN transaction (the phase-one
   * transaction that created the row has already committed by the time a
   * caller learns `storage.put` failed), reusing the same purge SQL a real
   * document delete uses, which already handles FK order and clearing
   * `current_version_id` first. A best-effort call: the caller propagates the
   * original storage error regardless of whether this succeeds.
   */
  purgeDocumentRow(id: DocumentId): Promise<void>;
}

export interface UploadUnitOfWork {
  run<T>(ctx: TenantContext, fn: (tx: UploadTx) => Promise<T>): Promise<T>;
}
