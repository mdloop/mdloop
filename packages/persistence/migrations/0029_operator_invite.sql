-- Phase 26.C: operator-triggered invites. An operator is never a `users` row,
-- so `invited_by` must be nullable — the composite FK on (invited_by, org_id)
-- is satisfied automatically when invited_by is null (Postgres MATCH SIMPLE
-- skips the check when any referencing column is null).
alter table org_invites alter column invited_by drop not null;

grant insert on org_invites to mdloop_provisioner;
