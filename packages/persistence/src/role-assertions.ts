/**
 * Minimal query surface the role assertion needs — just enough of `pg.Pool`
 * to run one read, so the check is unit-testable with a fake result and no
 * live database.
 */
export interface RoleQueryable {
  query(sql: string): Promise<{ rows: { rolsuper: boolean; rolbypassrls: boolean }[] }>;
}

/**
 * Code-level backstop for CONSTITUTION §4 ("the application connects as a
 * non-superuser role that cannot skip RLS"). `withTenant` does `set local role
 * mdloop_app`, but a superuser or BYPASSRLS *login* role (from `DATABASE_URL`)
 * ignores every RLS policy regardless — silently defeating the sole
 * tenant-isolation guarantee, with no other signal. Every prod entrypoint
 * calls this right after pool creation and throws before serving a request if
 * the connected role is privileged. Prod DATABASE_URL must use `mdloop_login`
 * (migration 0024): NOSUPERUSER + NOBYPASSRLS, member of the three tenant
 * roles. Local dev (`dev-main.ts`) intentionally connects as a trust-socket
 * superuser and never calls this — it is not a prod entrypoint.
 */
export async function assertNonSuperuserRole(db: RoleQueryable): Promise<void> {
  const { rows } = await db.query(
    'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
  );
  const row = rows[0];
  if (!row) {
    throw new Error('cannot determine the connected DB role — refusing to start');
  }
  if (row.rolsuper || row.rolbypassrls) {
    throw new Error(
      'DATABASE_URL connects as a SUPERUSER or BYPASSRLS role — RLS tenant isolation ' +
        'would be silently defeated (CONSTITUTION §4). Connect as the non-superuser ' +
        'mdloop_login role instead.',
    );
  }
}
