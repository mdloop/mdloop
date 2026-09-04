-- Phase 8: per-user org-scoped API keys for the MCP server
-- (ARCHITECTURE.md §9). Only the SHA-256 hash is stored; the key itself is
-- shown once at creation. Every MCP call executes as the key's user through
-- the same use-cases as the HTTP API.

create table api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  user_id uuid not null,
  name text not null check (length(name) > 0),
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  unique (id, org_id),
  foreign key (user_id, org_id) references users (id, org_id)
);

create index api_keys_user_idx on api_keys (org_id, user_id);

alter table api_keys enable row level security;
alter table api_keys force row level security;
create policy tenant_isolation on api_keys
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

grant select, insert, update, delete on api_keys to mdloop_app;

-- Key authentication happens before any tenant context exists (the key IS
-- the identity), so the lookup-by-hash runs as the provisioner. It touches
-- exactly this table and only by unique hash.
grant select on api_keys to mdloop_provisioner;
grant update (last_used_at) on api_keys to mdloop_provisioner;
