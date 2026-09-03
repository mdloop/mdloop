-- Phase 24 follow-up: upload-transaction lock reshape.
--
-- The two-phase upload path (packages/app/src/use-cases/upload.ts) reserves a
-- version's seq in one short transaction, writes the blob outside any
-- transaction, then inserts the version row in a SEPARATE transaction. A
-- recomputed max(seq)+1 is NOT enough to serialize this correctly: since
-- phase one never inserts anything, two concurrent reservations that lock
-- the documents row one after another (Postgres correctly serializes the
-- FOR UPDATE itself) can still both read the same max(seq) and compute the
-- SAME next value, because neither has persisted a row yet when the second
-- one's lock is granted — proven by upload-seq-concurrency.integration.test.ts
-- failing with a storage key collision before this column existed.
--
-- `next_seq` makes the reservation itself durable: `UPDATE documents SET
-- next_seq = next_seq + 1 ... RETURNING` is one atomic statement, so the
-- second concurrent reservation sees the FIRST reservation's increment
-- immediately on lock grant, regardless of whether a version row ever
-- follows it. A reservation whose blob write or insert never completes
-- leaves a genuine (harmless) gap — nothing enforces seq contiguity, and the
-- counter never goes backward, so that number is simply never reused.
--
-- The unique constraint on document_versions is a schema-level backstop: if
-- a future bug in the reservation logic ever let two inserts share a seq,
-- this rejects the second insert outright instead of silently corrupting
-- the version sequence.

alter table documents add column next_seq integer not null default 1;

update documents d
set next_seq = coalesce((select max(seq) + 1 from document_versions where document_id = d.id), 1);

alter table document_versions
  add constraint document_versions_doc_seq_uniq unique (document_id, seq);
