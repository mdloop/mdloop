-- Phase 24.D: RLS on the compliance ledgers.
--
-- billing_events (0006) and erasure_log (0007) are org-referencing tables that
-- were, until now, kept isolated only by grant-absence — mdloop_app has no
-- SELECT on billing_events at all, and only INSERT on erasure_log. That is
-- safe today but fragile: a future grant would silently open a cross-tenant
-- read. This adds the same FORCE ROW LEVEL SECURITY + org-scoped policy every
-- tenant table carries (0001), so isolation is a standing DB guarantee, not a
-- property of what happens to be un-granted.
--
-- The system paths are unaffected: both ledgers are read/written by the
-- provisioner (webhooks, lifecycle sweeps, post-restore replay have no tenant
-- on the call stack), and mdloop_provisioner is BYPASSRLS — it never consults
-- these policies, so the org-spanning replay read (erasure_log ordered across
-- every org) and the purge unlink (billing_events.org_id -> null) keep working.
-- The policies bind only the non-superuser mdloop_app role's future access.

alter table billing_events enable row level security;
alter table billing_events force row level security;
create policy tenant_isolation on billing_events
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

alter table erasure_log enable row level security;
alter table erasure_log force row level security;
create policy tenant_isolation on erasure_log
  using (org_id = current_org_id())
  with check (org_id = current_org_id());
