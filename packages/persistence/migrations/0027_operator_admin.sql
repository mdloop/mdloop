-- Phase 26.A: Vorlyn operator admin console — auth/audit foundation.
--
-- `operators` is a Vorlyn-staff identity, deliberately NOT a tenant table: no
-- org_id, no RLS (there is no tenant to scope to — an operator's whole point
-- is cross-org reach). It is reached exclusively through vorlyn_provisioner,
-- the same bypass-RLS role org bootstrap and billing already run as
-- (CONSTITUTION.md's RLS guarantee is about tenant data paths; this is the
-- same trust boundary as org_invites/org_allowlist_entries provisioning
-- reads in 0008). vorlyn_app has no grant here at all — ordinary tenant-scoped
-- application code cannot reach this table even by mistake.
--
-- `operator_audit_log` is append-only (insert-only grant, matching the
-- append-only precedent set by review approvals in 0015): every operator
-- write in the admin console records who did what to which org, since
-- everything reachable from `/admin/*` is cross-org and high blast-radius by
-- definition.

create table operators (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now()
);

create table operator_audit_log (
  id uuid primary key default gen_random_uuid(),
  operator_email text not null,
  action text not null,
  target_org_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index operator_audit_log_target_org_idx
  on operator_audit_log (target_org_id, created_at);

create index operator_audit_log_created_idx
  on operator_audit_log (created_at);

-- update needed for the add()'s upsert (on conflict do update, idempotent re-seed).
grant select, insert, update, delete on operators to vorlyn_provisioner;
grant select, insert on operator_audit_log to vorlyn_provisioner;
