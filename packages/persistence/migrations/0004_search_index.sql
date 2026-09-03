-- Phase 9a: permission-scoped full-text search (ARCHITECTURE.md §9,
-- CONSTITUTION.md §9). One tsvector row per document, built from title
-- (weight A) + current version body text (weight B) at upload time — the
-- body itself lives only in blob storage and is never duplicated here.

create table search_index (
  document_id uuid not null,
  org_id uuid not null,
  version_id uuid not null,
  tsv tsvector not null,
  updated_at timestamptz not null default now(),
  primary key (document_id, org_id),
  foreign key (document_id, org_id) references documents (id, org_id) on delete cascade,
  foreign key (version_id, org_id) references document_versions (id, org_id)
);

create index search_index_tsv_idx on search_index using gin (tsv);

alter table search_index enable row level security;
alter table search_index force row level security;
create policy tenant_isolation on search_index
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

grant select, insert, update, delete on search_index to vorlyn_app;
