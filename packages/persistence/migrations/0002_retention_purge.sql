-- Phase 3: retention purge support (CONSTITUTION.md §6).

-- Quota history must survive a document purge: deleting a document never
-- refunds quota. The ledger row stays; only its version pointer is cleared.
-- SET NULL is column-targeted (PG15+) so org_id — part of the composite
-- tenant FK — is untouched.
alter table upload_ledger alter column version_id drop not null;
alter table upload_ledger drop constraint upload_ledger_version_id_org_id_fkey;
alter table upload_ledger
  add constraint upload_ledger_version_id_org_id_fkey
  foreign key (version_id, org_id) references document_versions (id, org_id)
  on delete set null (version_id);

-- Retention sweep scans for due documents across orgs.
create index documents_purge_due_idx on documents (purge_after)
  where deleted_at is not null;

-- The sweep job (runs as the provisioner, outside any tenant context) may see
-- which documents are due — opaque ids and timestamps only, no content.
grant select (id, org_id, deleted_at, purge_after) on documents to mdloop_provisioner;
