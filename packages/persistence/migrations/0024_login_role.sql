-- Phase 24.E: dedicated non-superuser login role.
--
-- withTenant/withProvisioner/withPublicReader (db.ts) do `set local role
-- vorlyn_app | vorlyn_provisioner | vorlyn_public_reader`, which requires the
-- connecting *login* role (from DATABASE_URL) to be a MEMBER of each. Until
-- now that membership was a deployment convention — whatever role DATABASE_URL
-- happened to point at. This binds it to a committed role: vorlyn_login is
-- NOSUPERUSER + NOBYPASSRLS, so RLS — the sole tenant-isolation guarantee —
-- cannot be silently skipped. It reaches vorlyn_provisioner's BYPASSRLS only by
-- an explicit `set role`, never passively (NOINHERIT, matching vorlyn_app and
-- vorlyn_provisioner in 0001). CONSTITUTION §4 ("connects as a non-superuser
-- role that cannot skip RLS") is now schema, not convention; the startup
-- assertion in the entrypoints (assertNonSuperuserRole) is the runtime backstop.
--
-- No password: local dev connects over the trust socket (README, .env.example),
-- exactly as vorlyn_app/vorlyn_provisioner/vorlyn_public_reader are created here
-- and in 0019. Prod supplies credentials via the connection string / secrets
-- manager (Phase 10), not this migration.
do $$
begin
  if not exists (select from pg_roles where rolname = 'vorlyn_login') then
    create role vorlyn_login login nosuperuser nobypassrls noinherit;
  end if;
end
$$;

-- Membership only — vorlyn_login SET ROLEs into these; it inherits no privilege
-- passively (NOINHERIT), so the BYPASSRLS on vorlyn_provisioner is reachable
-- only through the provisioning code path's explicit `set local role`.
grant vorlyn_app to vorlyn_login;
grant vorlyn_provisioner to vorlyn_login;
grant vorlyn_public_reader to vorlyn_login;
