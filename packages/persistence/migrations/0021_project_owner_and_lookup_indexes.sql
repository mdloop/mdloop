-- Phase 24.B (entitlements hardening).
--
-- 1. projects.created_by — the owner column the project-authZ gate keys off
--    (owner-or-admin mutations; a null-owner row is admin-only after backfill).
--    Composite FK on (created_by, org_id): Postgres FK checks bypass RLS, so a
--    plain FK to users(id) would let one org reference another org's user row.
--    Every FK between tenant tables is composite on (id, org_id) — see 0001.
--    Existing rows keep created_by NULL (a multi-column FK with a NULL column
--    is not enforced, MATCH SIMPLE), which the domain reads as admin-only.
--
-- 2. users member-list index — the member-list route paginates keyset over
--    (org_id, lower(display_name), id) with an optional name prefix search
--    (Phase 24 member-list policy); without this the page + search seq-scans.
--
-- 3. share_grants grantee index — listForUser / grant-lookup filters
--    (org_id, grantee_user_id); 0001 indexed only the subject side, so this
--    per-user read had no supporting index. Partial: link grants have no user.

alter table projects add column created_by uuid;

alter table projects
  add constraint projects_created_by_fk
  foreign key (created_by, org_id) references users (id, org_id);

create index users_org_name_idx on users (org_id, lower(display_name), id);

create index share_grants_grantee_idx
  on share_grants (org_id, grantee_user_id)
  where grantee_user_id is not null;
