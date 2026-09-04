-- Phase 15: org invite/join flow.
--
-- Two provisioning paths. org_invites: admin-sent, hashed single-use token,
-- same shape as share_grants' token_hash. org_allowlist_entries: enterprise
-- JIT allowlist-mode membership list. organizations gains provisioning_mode
-- (enterprise JIT: open | allowlist) and sso_connection_id (maps a WorkOS
-- SSO connection to this org for JIT auto-provisioning on login).

alter table organizations
  add column provisioning_mode text not null default 'allowlist'
    check (provisioning_mode in ('open', 'allowlist')),
  add column sso_connection_id text unique;

create table org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  email text not null,
  role text not null check (role in ('admin', 'member')),
  token_hash text not null unique,
  invited_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  unique (id, org_id),
  foreign key (invited_by, org_id) references users (id, org_id)
);

-- One live (unaccepted, unrevoked, unexpired-agnostic-at-DB-level) invite per
-- email per org; expiry is checked in application logic, not here.
create unique index org_invites_live_email_idx
  on org_invites (org_id, lower(email))
  where accepted_at is null and revoked_at is null;

create table org_allowlist_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  email text not null,
  added_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (added_by, org_id) references users (id, org_id)
);

create unique index org_allowlist_entries_email_idx
  on org_allowlist_entries (org_id, lower(email));

create index org_invites_org_idx on org_invites (org_id, email);

alter table org_invites enable row level security;
alter table org_invites force row level security;
create policy tenant_isolation on org_invites
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

alter table org_allowlist_entries enable row level security;
alter table org_allowlist_entries force row level security;
create policy tenant_isolation on org_allowlist_entries
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

grant select, insert, update, delete on org_invites to mdloop_app;
grant select, insert, delete on org_allowlist_entries to mdloop_app;

-- Invite acceptance and SSO JIT join both happen before any tenant context
-- exists (the token / SSO profile IS the identity, same trust boundary as
-- org bootstrap and api_keys lookup-by-hash) so the provisioner needs
-- RLS-free read of both new tables plus write of the accepted_at marker,
-- and read of the new organizations columns (already covered by the
-- existing `grant select ... on organizations to mdloop_provisioner`).
grant select on org_invites to mdloop_provisioner;
grant update (accepted_at) on org_invites to mdloop_provisioner;
grant select on org_allowlist_entries to mdloop_provisioner;
grant update (provisioning_mode, sso_connection_id) on organizations to mdloop_provisioner;
