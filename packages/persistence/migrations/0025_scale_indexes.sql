-- Phase 24.F (scale core).
--
-- 1. comments thread-page index — the thread list paginates keyset over
--    (org_id, document_id, created_at, id) filtered to live comments (Phase
--    24.F item 3). 0001's comments_doc_idx is (org_id, document_id, status),
--    which serves the status split and cap counts but not the created_at
--    keyset walk a document with thousands of comments now pages through.
--    Partial on `deleted_at is null` — soft-deleted comments never list, so
--    the index only carries rows the page can actually return.
--
-- 2. public_documents published_at index — the anonymous hub list keyset-pages
--    over (published_at desc, id desc) (Phase 24.F item 5). 0019 indexed only
--    the slug unique + tsv GIN, so the newest-first list seq-scanned + sorted.
--    A plain (published_at, id) btree is scanned backward for the desc order.
--    No org_id: public_documents lives outside the tenant model (ADR 0004).

create index comments_doc_created_idx
  on comments (org_id, document_id, created_at, id)
  where deleted_at is null;

create index public_documents_published_idx
  on public_documents (published_at, id);
