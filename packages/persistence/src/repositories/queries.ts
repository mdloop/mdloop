import type { PoolClient } from 'pg';
import type { IndexVersionInput, NewDocument, NewVersion } from '@vorlyn/app';
import type { Comment, Document, DocumentVersion, Organization, Project } from '@vorlyn/domain';
import type { CommentId, DocumentId, OrgId, ProjectId, UserId, VersionId } from '@vorlyn/shared';
import { toComment, toDocument, toOrganization, toProject, toVersion } from './row-mappers.js';
import type {
  CommentRow,
  DocumentRow,
  OrganizationRow,
  ProjectRow,
  VersionRow,
} from './row-mappers.js';

/**
 * Client-bound query cores, shared between the per-call repositories and the
 * upload unit of work so both paths run the exact same SQL. Every caller is
 * already inside a withTenant transaction — nothing here opens one.
 */

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error('expected a row, got none');
  return row;
}

export async function currentOrg(c: PoolClient): Promise<Organization | undefined> {
  const { rows } = await c.query<OrganizationRow>('select * from organizations');
  return rows[0] ? toOrganization(rows[0]) : undefined;
}

/**
 * Non-deleted documents in the org — the tier doc cap counts these. Takes the
 * per-org advisory lock first (Phase 24): the count and the insert that
 * follows it in the upload transaction are serialized against every other
 * cap-checked create in the org, so two concurrent creates at ceiling-1 can
 * never both slip past the cap.
 */
export async function activeDocCount(c: PoolClient): Promise<number> {
  await c.query("select pg_advisory_xact_lock(hashtextextended(current_setting('app.org_id'), 0))");
  const { rows } = await c.query<{ n: string }>(
    'select count(*) as n from documents where deleted_at is null',
  );
  return Number(one(rows).n);
}

/**
 * Non-deleted documents in one project — the tier per-project doc cap counts
 * these (Phase 33). Reuses the same per-org advisory lock as `activeDocCount`
 * rather than a second lock key: a project always belongs to exactly one
 * org, so the org-level lock is already the correct serialization boundary
 * for this count too.
 */
export async function activeDocCountInProject(
  c: PoolClient,
  projectId: ProjectId,
): Promise<number> {
  await c.query("select pg_advisory_xact_lock(hashtextextended(current_setting('app.org_id'), 0))");
  const { rows } = await c.query<{ n: string }>(
    'select count(*) as n from documents where project_id = $1 and deleted_at is null',
    [projectId],
  );
  return Number(one(rows).n);
}

/**
 * Live (non-tombstoned) versions — the tier version cap never counts
 * tombstones (ADR 0001). Locks the document row first (Phase 24): the same
 * lock `appendVersion` takes, so count-then-append inside one upload
 * transaction is serialized per document and the version cap cannot be raced.
 */
export async function liveVersionCount(c: PoolClient, documentId: DocumentId): Promise<number> {
  await c.query('select id from documents where id = $1 for update', [documentId]);
  const { rows } = await c.query<{ n: string }>(
    'select count(*) as n from document_versions where document_id = $1 and purged_at is null',
    [documentId],
  );
  return Number(one(rows).n);
}

/**
 * Non-deleted documents in the org (Phase 33.D) — read-only sibling of
 * `activeDocCount`, WITHOUT the advisory lock: this is never followed by an
 * insert in the same transaction (it backs a status-check read path, e.g. the
 * sync CLI's pre-flight headroom warning), so taking the lock here would only
 * contend against real uploads for no benefit. Do not add the lock back.
 */
export async function countActiveDocs(c: PoolClient): Promise<number> {
  const { rows } = await c.query<{ n: string }>(
    'select count(*) as n from documents where deleted_at is null',
  );
  return Number(one(rows).n);
}

/**
 * Non-deleted documents in one project (Phase 33.D) — read-only sibling of
 * `activeDocCountInProject`, same no-lock reasoning as `countActiveDocs`.
 */
export async function countActiveDocsInProject(
  c: PoolClient,
  projectId: ProjectId,
): Promise<number> {
  const { rows } = await c.query<{ n: string }>(
    'select count(*) as n from documents where project_id = $1 and deleted_at is null',
    [projectId],
  );
  return Number(one(rows).n);
}

/**
 * Sum of `byte_size` over every LIVE (non-tombstoned) version blob in the org
 * (Phase 39.B) — the storage lane of `orgUsage()`. RLS (the caller's
 * `withTenant` transaction) is what scopes this to one org; there is no
 * `org_id` filter in the SQL itself, same as `countActiveDocs` above.
 */
export async function sumLiveStorageBytes(c: PoolClient): Promise<number> {
  const { rows } = await c.query<{ n: string | null }>(
    'select sum(byte_size) as n from document_versions where purged_at is null',
  );
  return Number(one(rows).n ?? 0);
}

export async function documentById(c: PoolClient, id: DocumentId): Promise<Document | undefined> {
  const { rows } = await c.query<DocumentRow>('select * from documents where id = $1', [id]);
  return rows[0] ? toDocument(rows[0]) : undefined;
}

export async function projectById(c: PoolClient, id: ProjectId): Promise<Project | undefined> {
  const { rows } = await c.query<ProjectRow>('select * from projects where id = $1', [id]);
  return rows[0] ? toProject(rows[0]) : undefined;
}

export async function insertDocument(
  c: PoolClient,
  orgId: OrgId,
  input: NewDocument,
): Promise<Document> {
  const { rows } = await c.query<DocumentRow>(
    `insert into documents (org_id, project_id, owner_id, title, path)
     values ($1, $2, $3, $4, $5) returning *`,
    [orgId, input.projectId, input.ownerId, input.title, input.path ?? null],
  );
  return toDocument(one(rows));
}

/**
 * The live document occupying `path` in `projectId`, if any (Phase 29) — the
 * pre-check behind the `path_taken` error, so a sync collision surfaces as a
 * typed refusal instead of `documents_project_path_uniq`'s raw constraint
 * violation. Mirrors that index exactly: live rows only (`deleted_at is
 * null`), archived rows included, and a NULL `projectId` matched as a value
 * rather than skipped (the index is NULLS NOT DISTINCT).
 *
 * The index remains the real guarantee — this is a check-then-act, so two
 * concurrent pushes can still both pass it and one will lose at INSERT time.
 */
export async function documentIdAtPath(
  c: PoolClient,
  projectId: ProjectId | null,
  path: string,
): Promise<DocumentId | undefined> {
  const { rows } = await c.query<{ id: string }>(
    `select id from documents
     where path = $1 and project_id is not distinct from $2::uuid and deleted_at is null
     limit 1`,
    [path, projectId],
  );
  return rows[0]?.id as DocumentId | undefined;
}

/**
 * Repoints a document at a new repo path (Phase 29). Only the sync CLI's
 * rename/move detection reaches this — a `git mv` re-sends the SAME
 * document_id with the new path, so the document moves in the tree instead of
 * forking a duplicate. Deliberately touches nothing else: `project_id` is a
 * human decision and stays where it is.
 */
export async function setDocumentPath(
  c: PoolClient,
  id: DocumentId,
  path: string,
): Promise<Document | undefined> {
  const { rows } = await c.query<DocumentRow>(
    'update documents set path = $2 where id = $1 and deleted_at is null returning *',
    [id, path],
  );
  return rows[0] ? toDocument(rows[0]) : undefined;
}

export async function currentVersion(
  c: PoolClient,
  documentId: DocumentId,
): Promise<DocumentVersion | undefined> {
  const { rows } = await c.query<VersionRow>(
    'select * from document_versions where document_id = $1 order by seq desc limit 1',
    [documentId],
  );
  return rows[0] ? toVersion(rows[0]) : undefined;
}

export async function appendVersion(
  c: PoolClient,
  orgId: OrgId,
  input: NewVersion,
): Promise<DocumentVersion> {
  // Serialize concurrent appends per document.
  await c.query('select id from documents where id = $1 for update', [input.documentId]);
  const { rows } = await c.query<VersionRow>(
    `insert into document_versions (org_id, document_id, seq, content_hash, byte_size, created_by, source, via_api_key_id, change_note)
     values ($1, $2,
       (select coalesce(max(seq), 0) + 1 from document_versions where document_id = $2),
       $3, $4, $5, $6, $7, $8)
     returning *`,
    [
      orgId,
      input.documentId,
      input.contentHash,
      input.byteSize,
      input.createdBy,
      input.source,
      input.viaApiKeyId ?? null,
      input.changeNote ?? null,
    ],
  );
  const version = toVersion(one(rows));
  await c.query('update documents set current_version_id = $2 where id = $1', [
    input.documentId,
    version.id,
  ]);
  return version;
}

/**
 * Reserves the next seq for a document via `documents.next_seq` (migration
 * 0026) — no insert. Split out of `appendVersion` (Phase 24 follow-up,
 * upload-transaction lock reshape): the upload path commits this in its own
 * short transaction, writes the blob, then inserts the version row in a
 * SEPARATE transaction via `insertVersionAtSeq` — so the row lock's lifetime
 * no longer spans the blob write.
 *
 * A RECOMPUTED max(seq)+1 is not safe here: since phase one never inserts a
 * row, two reservations that acquire the document lock one after another
 * would both read the same max(seq) and compute the same next value —
 * proven wrong in practice by a real-Postgres concurrency test before this
 * counter existed. `UPDATE ... SET next_seq = next_seq + 1 RETURNING` is one
 * atomic statement, so the counter itself is the durable, monotonic
 * reservation: the second concurrent caller sees the first's increment the
 * moment its own lock is granted, independent of whether any version row
 * ever follows. A reservation whose blob write or insert never completes
 * leaves a genuine, harmless gap — the counter never goes backward, so that
 * number is simply never reused (nothing enforces seq contiguity).
 */
export async function reserveVersionSeq(c: PoolClient, documentId: DocumentId): Promise<number> {
  const { rows } = await c.query<{ seq: number }>(
    'update documents set next_seq = next_seq + 1 where id = $1 returning next_seq - 1 as seq',
    [documentId],
  );
  return one(rows).seq;
}

/**
 * Inserts the version row at an already-reserved seq (see
 * `reserveVersionSeq`) — no lock, no subselect: the seq is exclusively ours
 * (protected by the `document_versions_doc_seq_uniq` constraint, migration
 * 0026, as a schema-level backstop against a reservation-logic bug). Runs in
 * the upload path's second transaction, after the blob is already written.
 */
export async function insertVersionAtSeq(
  c: PoolClient,
  orgId: OrgId,
  seq: number,
  input: NewVersion,
): Promise<DocumentVersion> {
  const { rows } = await c.query<VersionRow>(
    `insert into document_versions (org_id, document_id, seq, content_hash, byte_size, created_by, source, via_api_key_id, change_note)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning *`,
    [
      orgId,
      input.documentId,
      seq,
      input.contentHash,
      input.byteSize,
      input.createdBy,
      input.source,
      input.viaApiKeyId ?? null,
      input.changeNote ?? null,
    ],
  );
  const version = toVersion(one(rows));
  await c.query('update documents set current_version_id = $2 where id = $1', [
    input.documentId,
    version.id,
  ]);
  return version;
}

/**
 * Upserts the search_index row for a document from the version just
 * appended. Only the tsvector is stored — title (weight A) and body
 * (weight B) are never persisted verbatim here (the body lives in blob
 * storage; this is a client-bound query, always inside a withTenant tx).
 */
export async function indexVersion(
  c: PoolClient,
  orgId: OrgId,
  input: IndexVersionInput,
): Promise<void> {
  await c.query(
    `insert into search_index (document_id, org_id, version_id, tsv)
     values ($1, $2, $3,
       setweight(to_tsvector('english', $4), 'A') ||
       setweight(to_tsvector('english', $5), 'B'))
     on conflict (document_id, org_id)
     do update set version_id = excluded.version_id, tsv = excluded.tsv, updated_at = now()`,
    [input.documentId, orgId, input.versionId, input.title, input.body],
  );
}

export async function recordUpload(
  c: PoolClient,
  orgId: OrgId,
  userId: UserId,
  versionId: VersionId,
  byteSize: number,
): Promise<void> {
  await c.query(
    'insert into upload_ledger (org_id, user_id, version_id, byte_size) values ($1, $2, $3, $4)',
    [orgId, userId, versionId, byteSize],
  );
  // Idle free-org lifecycle (Phase 13): writes count as activity, reads don't.
  await c.query('update organizations set last_activity_at = now() where id = $1', [orgId]);
}

/**
 * Permanent purge of one document and everything hanging off it. The upload
 * ledger survives (its version_id FK is ON DELETE SET NULL): purging a
 * document never refunds quota. Order respects FKs; current_version_id is
 * cleared first so versions can go.
 */
export async function purgeDocument(c: PoolClient, id: DocumentId): Promise<void> {
  await c.query(
    `delete from comment_anchor_resolutions
     where comment_id in (select id from comments where document_id = $1)`,
    [id],
  );
  await c.query(
    `delete from comment_replies
     where comment_id in (select id from comments where document_id = $1)`,
    [id],
  );
  await c.query('delete from comments where document_id = $1', [id]);
  // Sign-off rows (Phase B) are append-only at the grant level (no delete) —
  // they disappear only via the `on delete cascade` FKs to document_versions
  // and documents, which fire below (versions, then the document itself).
  await c.query(`delete from share_grants where subject_type = 'document' and subject_id = $1`, [
    id,
  ]);
  // search_index.version_id FKs to document_versions without cascade (only
  // its document_id FK cascades on the documents delete below, which is too
  // late — versions go first), so it must be cleared explicitly here.
  await c.query('delete from search_index where document_id = $1', [id]);
  await c.query('update documents set current_version_id = null where id = $1', [id]);
  await c.query('delete from document_versions where document_id = $1', [id]);
  await c.query('delete from documents where id = $1', [id]);
}

/**
 * Flip an OPEN suggestion to `accepted` inside the caller's open transaction —
 * the version-mint half of `acceptSuggestion` (Phase 24.D). Identical guard to
 * `PgCommentRepository.setSuggestionOutcome` (only an open suggestion flips, so
 * a concurrent accept is a lost update returning undefined), but bound to the
 * same client as the upload so the version and the outcome commit atomically.
 */
export async function markSuggestionAccepted(
  c: PoolClient,
  id: CommentId,
  appliedVersionId: VersionId,
): Promise<Comment | undefined> {
  const { rows } = await c.query<CommentRow>(
    `update comments
       set suggestion_outcome = 'accepted', applied_version_id = $2
     where id = $1 and kind = 'suggestion' and suggestion_outcome = 'open'
       and deleted_at is null
     returning *`,
    [id, appliedVersionId],
  );
  return rows[0] ? toComment(rows[0]) : undefined;
}
