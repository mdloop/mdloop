import { createHash } from 'node:crypto';
import type {
  ContentError,
  Document,
  DocumentVersion,
  Organization,
  QuotaError,
  TierCapError,
  UploadSource,
} from '@vorlyn/domain';
import {
  checkDocCreateAllowed,
  checkProjectDocCreateAllowed,
  checkUploadAllowed,
  checkVersionAppendAllowed,
  isValidDocumentPath,
  isValidDocumentTitle,
  orgIsWriteLocked,
  validateMarkdownContent,
} from '@vorlyn/domain';
import type { DocumentId, ProjectId, Result } from '@vorlyn/shared';
import { err, ok } from '@vorlyn/shared';
import type { StoragePort } from '../ports/storage.port.js';
import type { UploadTx, UploadUnitOfWork } from '../ports/upload-uow.port.js';
import { canEditDocument, canManageDocument } from '../policy.js';
import type { Actor } from './org-settings.js';

export type UploadError =
  | QuotaError
  /**
   * Ingest content policy (ADR 0011) — binary signature, control bytes,
   * replacement-character density, malformed UTF-8. Widening this union is
   * what forces `uploadErrorStatus` (packages/api) to map every new code
   * before it can compile: an exhaustive `Record<UploadError['code'], number>`
   * means no content-policy code can ever reach a client unmapped.
   */
  | ContentError
  | TierCapError
  | { readonly code: 'invalid_title' }
  /** `path` failed `isValidDocumentPath` — absolute, traversal, malformed (Phase 29). */
  | { readonly code: 'invalid_path' }
  /** Another live document already sits at this repo path in this project (Phase 29). */
  | { readonly code: 'path_taken' }
  | { readonly code: 'project_not_found' }
  | { readonly code: 'document_not_found' }
  | { readonly code: 'org_not_found' }
  | { readonly code: 'org_read_only' }
  | { readonly code: 'forbidden' };

export interface UploadResult {
  readonly document: Document;
  readonly version: DocumentVersion;
  /** True when the content matched the current version and nothing was written. */
  readonly deduplicated: boolean;
}

export interface UploadNewDocumentInput {
  readonly title: string;
  readonly projectId: ProjectId | null;
  readonly content: Uint8Array;
  readonly source: UploadSource;
  /** Optional "what changed" note stored on the version (ADR 0003 §B). */
  readonly changeNote?: string | null;
  /**
   * Repo-relative path this document was mirrored from (Phase 29), e.g.
   * `docs/specs/auth.md`. Omitted for every manual upload — the sync CLI is
   * its only writer, and the REST routes deliberately don't accept one.
   * Display metadata, never a storage key (CONSTITUTION.md §3).
   */
  readonly path?: string;
}

export interface UploadNewVersionInput {
  readonly documentId: DocumentId;
  readonly content: Uint8Array;
  readonly source: UploadSource;
  /** Optional "what changed" note stored on the version (ADR 0003 §B). */
  readonly changeNote?: string | null;
  /**
   * New repo-relative path for this document (Phase 29). Present means the
   * sync CLI saw this file at `path` — if that differs from the stored one,
   * the document MOVES there (`git mv` re-sends the same document_id with a
   * new path). Omitted leaves the stored path exactly as it is, which is what
   * every non-CLI upload does; there is deliberately no way to clear a path,
   * since un-mirroring a file is not a sync operation.
   */
  readonly path?: string;
}

export function contentHashOf(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Everything phase two needs, carried across the blob write. */
interface VersionReservation {
  readonly document: Document;
  readonly seq: number;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly source: UploadSource;
  readonly changeNote: string | null;
}

/**
 * Every check that can still fail before a version is minted — file size/
 * content policy and the live-version cap. Deliberately no writes. Split out
 * so both `uploadNewDocument` and `uploadNewVersion` can run it BEFORE their
 * own transaction's write (`createDocument` / `setDocumentPath` respectively):
 * `withTenant` (packages/persistence/src/db.ts) commits whenever its callback
 * resolves without throwing, regardless of whether the resolved value is
 * `ok` or `err` — a check that runs after a write, and then fails, leaves
 * that write committed anyway even though the caller is told the whole
 * operation failed. Every use-case that can still fail must finish failing
 * before it writes anything, in the same transaction.
 *
 * Upload *velocity* (how many uploads per week/month) used to be checked
 * here too, against `tx.usageFor(...)`'s rolling-window ledger read.
 * Retired in the rate-limiting redesign (2026-08-11): the
 * general per-user request budget (minute/day/month, enforced at the
 * transport layer before a request ever reaches a use-case) plus the
 * live-version cap below now cover that job — see `quota.ts`'s doc comment.
 *
 * `documentId: null` is the brand-new-document case: there is no row yet, so
 * there are no live versions to count and the version cap can never trip —
 * skip the query rather than pretend to check something structurally always
 * true.
 */
async function checkVersionUploadAllowed(
  tx: UploadTx,
  org: Organization,
  documentId: DocumentId | null,
  contentByteLength: number,
): Promise<Result<void, UploadError>> {
  const allowed = checkUploadAllowed(contentByteLength);
  if (!allowed.ok) return err(allowed.error);
  // Cap counts live blobs, not tombstones — auto-purge frees headroom, and
  // the cap only ever blocks this upload, it never prunes (ADR 0001).
  const liveVersions = documentId === null ? 0 : await tx.liveVersionCount(documentId);
  const underCap = checkVersionAppendAllowed(liveVersions, org.tier);
  if (!underCap.ok) return err(underCap.error);
  return ok(undefined);
}

/**
 * The one write left once every check above has passed: reserves the next
 * seq — no blob I/O, no row insert. Kept as its own function (not inlined)
 * for the same lock-lifetime reason the two-phase reservation/finalize split
 * exists at all. Upload-transaction lock reshape (Phase 24 follow-up): this
 * used to run in the SAME transaction as the blob write, holding a pooled
 * connection + row lock for however long storage.put took (S3 latency in
 * prod) — under concurrent uploads to one document that serialized on blob
 * I/O, not DB work. Splitting the reservation from the insert (see
 * `finalizeVersion`) means the lock's lifetime is now just this fast check.
 * Reading the live-version count fresh (not from a counter) in
 * `checkVersionUploadAllowed` is what keeps the cap honest across the
 * two-phase split: a seq reserved here but never inserted in phase two never
 * shows up there, so it can never falsely block a later upload.
 */
async function reserveVersion(
  tx: UploadTx,
  document: Document,
  content: Uint8Array,
  source: UploadSource,
  changeNote: string | null,
): Promise<VersionReservation> {
  const seq = await tx.reserveVersionSeq(document.id);
  return {
    document,
    seq,
    contentHash: contentHashOf(content),
    byteSize: content.byteLength,
    source,
    changeNote,
  };
}

/**
 * Phase two: inserts the version row at the already-reserved seq, records
 * the upload, indexes it — all in one new transaction, after the blob is
 * already on disk/S3. `onAppended` (suggestion-accept's outcome flip) runs
 * inside this same transaction, so it still commits atomically with the
 * version row (the invariant that matters — comments pin to committed rows,
 * never to blobs directly).
 */
async function finalizeVersion(
  tx: UploadTx,
  actor: Actor,
  reservation: VersionReservation,
  content: Uint8Array,
  onAppended: ((tx: UploadTx, result: UploadResult) => Promise<void>) | undefined,
): Promise<UploadResult> {
  const version = await tx.insertVersionAtSeq(reservation.seq, {
    documentId: reservation.document.id,
    contentHash: reservation.contentHash,
    byteSize: reservation.byteSize,
    source: reservation.source,
    createdBy: actor.ctx.userId,
    viaApiKeyId: actor.apiKeyId ?? null,
    changeNote: reservation.changeNote,
  });
  await tx.recordUpload(version.id, reservation.byteSize);
  await tx.indexVersion({
    documentId: reservation.document.id,
    versionId: version.id,
    title: reservation.document.title,
    body: new TextDecoder().decode(content),
  });
  const result: UploadResult = {
    document: { ...reservation.document, currentVersionId: version.id },
    version,
    deduplicated: false,
  };
  if (onAppended) await onAppended(tx, result);
  return result;
}

/**
 * Applies a CLI-supplied path to an existing document (Phase 29's rename/move
 * detection), returning the document unchanged when there is nothing to do.
 *
 * Runs inside the caller's gate transaction and BEFORE the dedup branch on
 * purpose: a `git mv` usually re-sends byte-identical content, so if the
 * repath rode the mint-a-version path it would be a silent no-op for the
 * commonest move and the tree would keep showing the old location.
 *
 * `path` is display metadata — it never reaches storage, whose keys stay
 * `VersionKey{orgId, documentId, seq}` (CONSTITUTION.md §3).
 */
async function applyPathChange(
  tx: UploadTx,
  document: Document,
  path: string | undefined,
): Promise<Result<Document, UploadError>> {
  if (path === undefined || path === document.path) return ok(document);
  const occupant = await tx.documentIdAtPath(document.projectId, path);
  if (occupant !== undefined && occupant !== document.id) return err({ code: 'path_taken' });
  return ok((await tx.setDocumentPath(document.id, path)) ?? document);
}

/** Upload a brand-new document (first version). */
export async function uploadNewDocument(
  uow: UploadUnitOfWork,
  storage: StoragePort,
  actor: Actor,
  input: UploadNewDocumentInput,
): Promise<Result<UploadResult, UploadError>> {
  // First check in the function, before any transactional state (ADR 0011):
  // it is pure, needs nothing from the database, and is the cheapest possible
  // rejection for the case it exists to catch — a renamed binary.
  const content = validateMarkdownContent(input.content);
  if (!content.ok) return err(content.error);
  if (!isValidDocumentTitle(input.title)) return err({ code: 'invalid_title' });
  if (input.path !== undefined && !isValidDocumentPath(input.path)) {
    return err({ code: 'invalid_path' });
  }
  const reserved = await uow.run(
    actor.ctx,
    async (tx): Promise<Result<VersionReservation, UploadError>> => {
      if (input.projectId !== null && !(await tx.projectById(input.projectId))) {
        return err({ code: 'project_not_found' });
      }
      const org = await tx.org();
      if (!org) return err({ code: 'org_not_found' });
      if (orgIsWriteLocked(org)) return err({ code: 'org_read_only' });
      const underCap = checkDocCreateAllowed(await tx.activeDocCount(), org.tier);
      if (!underCap.ok) return err(underCap.error);
      // A separate, tighter-scoped sibling of the org-wide cap (Phase 33) —
      // unfiled documents (projectId null) have no project to scope against,
      // so only a real project is subject to it.
      if (input.projectId !== null) {
        const underProjectCap = checkProjectDocCreateAllowed(
          await tx.activeDocCountInProject(input.projectId),
          org.tier,
        );
        if (!underProjectCap.ok) return err(underProjectCap.error);
      }
      // Checked in the same transaction as the INSERT, so the common collision
      // is a typed refusal; `documents_project_path_uniq` is still the
      // guarantee if two pushes race past this.
      if (
        input.path !== undefined &&
        (await tx.documentIdAtPath(input.projectId, input.path)) !== undefined
      ) {
        return err({ code: 'path_taken' });
      }
      // Every check that can still fail runs above this line — `createDocument`
      // below is the transaction's first write, and withTenant commits
      // regardless of whether this callback goes on to return ok or err, so
      // nothing may write before every possible rejection has already happened.
      const allowed = await checkVersionUploadAllowed(tx, org, null, input.content.byteLength);
      if (!allowed.ok) return err(allowed.error);
      const document = await tx.createDocument({
        title: input.title.trim(),
        projectId: input.projectId,
        ownerId: actor.ctx.userId,
        ...(input.path !== undefined ? { path: input.path } : {}),
      });
      return ok(
        await reserveVersion(tx, document, input.content, input.source, input.changeNote ?? null),
      );
    },
  );
  if (!reserved.ok) return reserved;
  const documentId = reserved.value.document.id;
  try {
    await storage.put(
      { orgId: actor.ctx.orgId, documentId, seq: reserved.value.seq },
      input.content,
    );
    const result = await uow.run(actor.ctx, (tx) =>
      finalizeVersion(tx, actor, reserved.value, input.content, undefined),
    );
    return ok(result);
  } catch (e) {
    // `createDocument` above already committed in its own transaction — a
    // failure here (storage.put, or the finalize transaction) leaves a row
    // with no version, ever (see this function's other comments on why the
    // create and the blob write can't share one transaction). That row would
    // otherwise sit visible in the document list while 404ing on open — the
    // exact "document not found" ghost this closes. Brand new, no version, so
    // nothing else references it: a hard delete is safe here in a way it
    // normally wouldn't be. Best-effort: the caller (this function) surfaces
    // the ORIGINAL error regardless of whether the rollback itself succeeds —
    // that's the one that explains what actually went wrong.
    await uow.run(actor.ctx, (tx) => tx.purgeDocumentRow(documentId)).catch(() => undefined);
    throw e;
  }
}

/**
 * Upload the next version of an existing document. Idempotent for agent
 * re-pushes: content identical to the current version is a no-op that
 * consumes no quota (ARCHITECTURE.md §6) and never reserves a seq or touches
 * storage.
 *
 * `onAppended` runs inside the finalize transaction once the result is known
 * (whether freshly minted or deduplicated), so a caller can fold an extra
 * write into the same commit — used by `acceptSuggestion` to flip the
 * suggestion outcome atomically with the version it mints. A throw from the
 * hook rolls the finalize transaction back (the blob stays written — see
 * `finalizeVersion`'s doc comment); it runs only on the success path.
 */
export async function uploadNewVersion(
  uow: UploadUnitOfWork,
  storage: StoragePort,
  actor: Actor,
  input: UploadNewVersionInput,
  onAppended?: (tx: UploadTx, result: UploadResult) => Promise<void>,
): Promise<Result<UploadResult, UploadError>> {
  type Gate =
    | { readonly dedup: true; readonly document: Document; readonly version: DocumentVersion }
    | { readonly dedup: false; readonly reservation: VersionReservation };

  // Same first-check placement as `uploadNewDocument` — see there.
  const content = validateMarkdownContent(input.content);
  if (!content.ok) return err(content.error);
  if (input.path !== undefined && !isValidDocumentPath(input.path)) {
    return err({ code: 'invalid_path' });
  }

  const gate = await uow.run(actor.ctx, async (tx): Promise<Result<Gate, UploadError>> => {
    const found = await tx.documentById(input.documentId);
    if (!found || found.deletedAt) return err({ code: 'document_not_found' });
    // Edit right = upload new versions (ADR 0008): the document's owner, an
    // org admin, or the holder of an explicit `edit` grant — on the document
    // itself or on the project it lives in (ADR 0014). Never a guest,
    // whatever any grant says. The grant is only loaded when it could change
    // the answer, so owner/admin pushes cost no extra query.
    const grant =
      actor.role === 'guest' || canManageDocument(actor, found)
        ? undefined
        : await tx.highestGrantFor(found.id, actor.ctx.userId, found.projectId);
    if (!canEditDocument(actor, found, grant)) return err({ code: 'forbidden' });

    const org = await tx.org();
    if (!org) return err({ code: 'org_not_found' });
    // Checked before the repath (a write) unconditionally — not just on the
    // non-dedup branch below — because repathing is itself a write a
    // write-locked org must refuse the same as any other. A content-identical
    // `git mv` would otherwise silently repath a document during a freeze.
    if (orgIsWriteLocked(org)) return err({ code: 'org_read_only' });

    // Dedup-ness depends only on content, not path, so it can — and must — be
    // decided before the repath below: identical content consumes no quota at
    // all (ARCHITECTURE.md §6), and `found.id` is stable across a repath (only
    // `.path` changes), so checking here vs. after applyPathChange is
    // equivalent.
    const current = await tx.currentVersion(found.id);
    const isDedup = current?.contentHash === contentHashOf(input.content);

    // Every check that can still fail runs above this line, in the branch
    // where it applies — `applyPathChange` below is this transaction's first
    // write, and withTenant commits regardless of whether this callback goes
    // on to return ok or err, so nothing may write before every possible
    // rejection (in the branch that's actually being taken) has already
    // happened. Skipped entirely on the dedup path: a no-op re-push or a pure
    // rename must never be blocked by, or count against, the quota ceiling.
    if (!isDedup) {
      const allowed = await checkVersionUploadAllowed(tx, org, found.id, input.content.byteLength);
      if (!allowed.ok) return err(allowed.error);
    }

    // After the permission and read-only gates, and after every check the
    // taken branch needs — a `git mv` usually carries identical bytes, so this
    // runs unconditionally (dedup or not) on purpose: the commonest rename
    // must still move the document even when nothing else changed.
    const repathed = await applyPathChange(tx, found, input.path);
    if (!repathed.ok) return repathed;
    const document = repathed.value;

    // `current` is `DocumentVersion | undefined`, but TS's control-flow
    // analysis narrows it to defined here: `isDedup` is an aliased condition
    // for `current?.contentHash === contentHashOf(input.content)`, and that
    // equality can only be true when `current` itself is defined (the LHS is
    // `undefined` otherwise, which never strictly-equals a content hash
    // string) — so no separate `current` check is needed, or accepted by
    // `no-unnecessary-condition`.
    if (isDedup) {
      return ok({ dedup: true, document, version: current });
    }

    const reservation = await reserveVersion(
      tx,
      document,
      input.content,
      input.source,
      input.changeNote ?? null,
    );
    return ok({ dedup: false, reservation });
  });
  if (!gate.ok) return gate;

  if (gate.value.dedup) {
    const result: UploadResult = {
      document: gate.value.document,
      version: gate.value.version,
      deduplicated: true,
    };
    // No blob write on dedup, so no transaction is open here — but
    // `onAppended` still runs "once the result is known" per this
    // function's contract (a caller like acceptSuggestion must flip its
    // outcome even when the spliced content matches the current version
    // exactly). A fresh transaction is fine: nothing else needs to commit
    // alongside it, since no version was minted.
    if (onAppended) await uow.run(actor.ctx, (tx) => onAppended(tx, result));
    return ok(result);
  }

  const reservation = gate.value.reservation;
  await storage.put(
    { orgId: actor.ctx.orgId, documentId: reservation.document.id, seq: reservation.seq },
    input.content,
  );
  const result = await uow.run(actor.ctx, (tx) =>
    finalizeVersion(tx, actor, reservation, input.content, onAppended),
  );
  return ok(result);
}
