-- Core schema + RLS (CONSTITUTION.md §1, ARCHITECTURE.md §3-4).
-- Every tenant-scoped table: org_id + FORCE ROW LEVEL SECURITY + org policy.
-- The application connects as (or SET ROLEs to) mdloop_app: non-superuser,
-- NOBYPASSRLS, no ability to skip policies.

create extension if not exists pgcrypto;

-- Application role. NOINHERIT so nothing sneaks in via membership.
do $$
begin
  if not exists (select from pg_roles where rolname = 'mdloop_app') then
    create role mdloop_app nologin nobypassrls noinherit;
  end if;
end
$$;

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sharing_mode text not null default 'link' check (sharing_mode in ('link', 'directory')),
  retention_days integer not null default 30 check (retention_days between 0 and 365),
  purge_immediately boolean not null default false,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  workos_user_id text not null unique,
  email text not null,
  display_name text not null default '',
  role text not null default 'member' check (role in ('admin', 'member')),
  created_at timestamptz not null default now(),
  unique (org_id, email)
);

-- NOTE on foreign keys: Postgres FK checks bypass RLS, so a plain FK to a
-- parent's primary key would let a tenant probe/reference another org's rows
-- (existence oracle). Every FK between tenant-scoped tables is therefore
-- composite on (id, org_id): a cross-org reference cannot exist at all.

alter table users add constraint users_id_org_unique unique (id, org_id);

create table projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  name text not null,
  color text not null default '#6366f1' check (color ~ '^#[0-9a-f]{6}$'),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (id, org_id)
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  project_id uuid,
  owner_id uuid not null,
  title text not null,
  current_version_id uuid,
  archived_at timestamptz,
  deleted_at timestamptz,
  purge_after timestamptz,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (project_id, org_id) references projects (id, org_id),
  foreign key (owner_id, org_id) references users (id, org_id)
);

create table document_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  document_id uuid not null,
  seq integer not null,
  content_hash text not null,
  byte_size integer not null check (byte_size > 0),
  created_by uuid not null,
  source text not null check (source in ('web', 'mcp')),
  created_at timestamptz not null default now(),
  unique (document_id, seq),
  unique (id, org_id),
  foreign key (document_id, org_id) references documents (id, org_id),
  foreign key (created_by, org_id) references users (id, org_id)
);

alter table documents
  add constraint documents_current_version_fk
  foreign key (current_version_id, org_id) references document_versions (id, org_id);

-- Versions are immutable: no UPDATE, no DELETE except via document purge.
create or replace function forbid_version_mutation() returns trigger as $$
begin
  raise exception 'document_versions are immutable';
end;
$$ language plpgsql;

create trigger document_versions_immutable
  before update on document_versions
  for each row execute function forbid_version_mutation();

create table comments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  document_id uuid not null,
  version_id uuid not null,
  author_id uuid not null,
  body text not null check (length(body) > 0),
  anchor jsonb not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (document_id, org_id) references documents (id, org_id),
  foreign key (version_id, org_id) references document_versions (id, org_id),
  foreign key (author_id, org_id) references users (id, org_id),
  foreign key (resolved_by, org_id) references users (id, org_id)
);

create table comment_replies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  comment_id uuid not null,
  author_id uuid not null,
  body text not null check (length(body) > 0),
  created_at timestamptz not null default now(),
  foreign key (comment_id, org_id) references comments (id, org_id),
  foreign key (author_id, org_id) references users (id, org_id)
);

create table share_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  subject_type text not null check (subject_type in ('document', 'project')),
  subject_id uuid not null,
  grantee_type text not null check (grantee_type in ('link', 'user')),
  grantee_user_id uuid,
  -- 'edit' is intentionally not in this check: never grantable (CONSTITUTION.md §9).
  permission text not null check (permission in ('read', 'comment')),
  token_hash text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check ((grantee_type = 'user') = (grantee_user_id is not null)),
  check ((grantee_type = 'link') = (token_hash is not null)),
  foreign key (grantee_user_id, org_id) references users (id, org_id),
  foreign key (created_by, org_id) references users (id, org_id)
);

create table upload_ledger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  user_id uuid not null,
  version_id uuid not null,
  byte_size integer not null,
  created_at timestamptz not null default now(),
  foreign key (user_id, org_id) references users (id, org_id),
  foreign key (version_id, org_id) references document_versions (id, org_id)
);

create table comment_anchor_resolutions (
  comment_id uuid not null,
  version_id uuid not null,
  org_id uuid not null references organizations (id),
  method text not null check (method in ('exact', 'context', 'fuzzy', 'orphan')),
  confidence real not null,
  start_offset integer,
  end_offset integer,
  computed_at timestamptz not null default now(),
  primary key (comment_id, version_id),
  foreign key (comment_id, org_id) references comments (id, org_id),
  foreign key (version_id, org_id) references document_versions (id, org_id)
);

create index documents_org_project_idx on documents (org_id, project_id);
create index document_versions_doc_idx on document_versions (org_id, document_id);
create index comments_doc_idx on comments (org_id, document_id, status);
create index comment_replies_comment_idx on comment_replies (org_id, comment_id);
create index share_grants_subject_idx on share_grants (org_id, subject_type, subject_id);
create index upload_ledger_user_time_idx on upload_ledger (org_id, user_id, created_at);

-- ---------- Row-level security ----------
-- current_setting('app.org_id') is bound per transaction by the persistence
-- layer (SET LOCAL). Missing setting => error => no rows. FORCE applies the
-- policy even to the table owner.

create or replace function current_org_id() returns uuid as $$
  select current_setting('app.org_id')::uuid;
$$ language sql stable;

-- organizations: a tenant sees only its own row.
alter table organizations enable row level security;
alter table organizations force row level security;
create policy org_isolation on organizations
  using (id = current_org_id())
  with check (id = current_org_id());

do $$
declare t text;
begin
  foreach t in array array[
    'users', 'projects', 'documents', 'document_versions', 'comments',
    'comment_replies', 'share_grants', 'upload_ledger', 'comment_anchor_resolutions'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = current_org_id()) with check (org_id = current_org_id())',
      t
    );
  end loop;
end
$$;

grant usage on schema public to mdloop_app;
grant select, insert, update, delete on all tables in schema public to mdloop_app;

-- Provisioning (DirectoryRepository) runs as a separate role that owns only
-- org/user bootstrap. It has RLS-free access to exactly these two tables.
do $$
begin
  if not exists (select from pg_roles where rolname = 'mdloop_provisioner') then
    create role mdloop_provisioner nologin bypassrls noinherit;
  end if;
end
$$;
grant usage on schema public to mdloop_provisioner;
grant select, insert on organizations, users to mdloop_provisioner;
grant update (role, display_name) on users to mdloop_provisioner;
