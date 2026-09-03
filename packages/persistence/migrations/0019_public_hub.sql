-- Phase 22.A (ADR 0004): Public Docs Hub backend foundation.
--
-- public_documents lives entirely OUTSIDE the tenant model: no org_id column,
-- RLS never enabled — there is no tenant to scope it to (see the ADR for why
-- a non-RLS table beats an RLS carve-out on `documents`). Rows are snapshot
-- copies written only through the publish use-case; source_* / published_by
-- are audit-only provenance, never read by the public path. Content itself
-- lives in blob storage under a separate keyspace (public/{id}/v{seq}), never
-- referenced live from `documents`/`document_versions`.
create table public_documents (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  title text not null,
  content_hash text not null,
  byte_size int not null check (byte_size > 0),
  seq int not null default 1,
  -- Provenance only (audit trail for what was published from where) — never
  -- joined against tenant tables from the public read path.
  source_org_id uuid,
  source_document_id uuid,
  source_version_id uuid,
  published_by uuid,
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  tsv tsvector
);

create unique index public_documents_slug_idx on public_documents (slug);
create index public_documents_tsv_idx on public_documents using gin (tsv);

-- vorlyn_public_reader: the ONLY role the unauthenticated public-hub read
-- routes ever run as. Granted SELECT on this one table and nothing else —
-- it is structurally incapable of reading `documents`/`document_versions`,
-- not merely policy-restricted from them (ADR 0004).
do $$
begin
  if not exists (select from pg_roles where rolname = 'vorlyn_public_reader') then
    create role vorlyn_public_reader nologin nobypassrls;
  end if;
end
$$;
grant usage on schema public to vorlyn_public_reader;
grant select on public_documents to vorlyn_public_reader;

-- Publishing is the one bridge between the tenant model and the public store
-- (ADR 0004): a home-org admin's publish/unpublish use-case writes the
-- snapshot via the existing vorlyn_provisioner role.
grant select, insert, update, delete on public_documents to vorlyn_provisioner;
