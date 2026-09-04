import type { Pool } from 'pg';
import type {
  OrganizationRepository,
  OrgLifecyclePort,
  OrgSettingsPatch,
  RoleDirectory,
  TenantContext,
} from '@mdloop/app';
import { decodeNameKeysetCursor, encodeNameKeysetCursor } from '@mdloop/app';
import type { Organization, User, UserRole } from '@mdloop/domain';
import type { OrgId, UserId } from '@mdloop/shared';
import { withProvisioner, withTenant } from '../db.js';
import { toOrganization, toUser } from './row-mappers.js';
import type { OrganizationRow, UserRow } from './row-mappers.js';

/** The org's own row; RLS restricts to current_org_id() on both read and write. */
export class PgOrganizationRepository
  implements OrganizationRepository, RoleDirectory, OrgLifecyclePort
{
  constructor(private readonly pool: Pool) {}

  async current(ctx: TenantContext): Promise<Organization | undefined> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<OrganizationRow>('select * from organizations');
      return rows[0] ? toOrganization(rows[0]) : undefined;
    });
  }

  async updateSettings(
    ctx: TenantContext,
    patch: OrgSettingsPatch,
  ): Promise<Organization | undefined> {
    return withTenant(this.pool, ctx, async (c) => {
      // versionRetention is tri-state: undefined = untouched, null = reset to
      // tier default, object = set — hence the explicit flag instead of coalesce.
      const { rows } = await c.query<OrganizationRow>(
        `update organizations set
           name = coalesce($1, name),
           sharing_mode = coalesce($2, sharing_mode),
           retention_days = coalesce($3, retention_days),
           purge_immediately = coalesce($4, purge_immediately),
           version_retention = case when $5 then $6::jsonb else version_retention end,
           provisioning_mode = coalesce($7, provisioning_mode),
           external_sharing = coalesce($8, external_sharing),
           approval_gate = coalesce($9, approval_gate),
           session_max_hours = case when $10 then $11::int else session_max_hours end
         where id = $12
         returning *`,
        [
          patch.name?.trim() ?? null,
          patch.sharingMode ?? null,
          patch.retentionDays ?? null,
          patch.purgeImmediately ?? null,
          patch.versionRetention !== undefined,
          patch.versionRetention ? JSON.stringify(patch.versionRetention) : null,
          patch.provisioningMode ?? null,
          patch.externalSharing ?? null,
          patch.approvalGate ?? null,
          // Tri-state like versionRetention: undefined = untouched, null = reset
          // to the global default (stored NULL), number = the org's shorter max.
          patch.sessionMaxHours !== undefined,
          patch.sessionMaxHours ?? null,
          ctx.orgId,
        ],
      );
      return rows[0] ? toOrganization(rows[0]) : undefined;
    });
  }

  async listUsers(ctx: TenantContext): Promise<User[]> {
    return withTenant(this.pool, ctx, async (c) => {
      // Guests are external identities (Phase 18): never listed as members,
      // never seats, never billable.
      const { rows } = await c.query<UserRow>(
        `select * from users where role <> 'guest' order by display_name, email`,
      );
      return rows.map(toUser);
    });
  }

  async listUsersPage(
    ctx: TenantContext,
    opts: { q?: string; cursor?: string; limit: number },
  ): Promise<{ users: User[]; nextCursor: string | null }> {
    return withTenant(this.pool, ctx, async (c) => {
      // Keyset over (lower(display_name), id) — served by users_org_name_idx
      // (0021). The cursor encodes the last row's sort key; `limit + 1` probes
      // for a next page without a count. Prefix search hits name and email.
      const params: unknown[] = [];
      const where: string[] = [`role <> 'guest'`];
      if (opts.q) {
        params.push(`${opts.q.toLowerCase()}%`);
        where.push(
          `(lower(display_name) like $${String(params.length)} or lower(email) like $${String(params.length)})`,
        );
      }
      if (opts.cursor) {
        // Malformed/stale cursors (including a legacy NUL-separated cursor
        // from before this delimiter changed — see decodeNameKeysetCursor's
        // own doc comment) decode to null and are treated as "no cursor," not
        // an error: falling back to page 1 is a harmless outcome for a value
        // that was never going to `::uuid`-cast cleanly anyway.
        const decoded = decodeNameKeysetCursor(opts.cursor);
        if (decoded) {
          params.push(decoded.name, decoded.id);
          where.push(
            `(lower(display_name), id) > ($${String(params.length - 1)}, $${String(params.length)}::uuid)`,
          );
        }
      }
      params.push(opts.limit + 1);
      const { rows } = await c.query<UserRow>(
        `select * from users where ${where.join(' and ')}
         order by lower(display_name), id
         limit $${String(params.length)}`,
        params,
      );
      const page = rows.slice(0, opts.limit).map(toUser);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > opts.limit && last ? encodeNameKeysetCursor(last.displayName, last.id) : null;
      return { users: page, nextCursor };
    });
  }

  async userById(ctx: TenantContext, id: UserId): Promise<User | undefined> {
    return withTenant(this.pool, ctx, async (c) => {
      // Unlike listUsers, this includes guests — Phase B validates a guest
      // reviewer. RLS still bounds it to the caller's org.
      const { rows } = await c.query<UserRow>('select * from users where id = $1', [id]);
      return rows[0] ? toUser(rows[0]) : undefined;
    });
  }

  async setUserRole(ctx: TenantContext, userId: UserId, role: UserRole): Promise<boolean> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rowCount } = await c.query('update users set role = $2 where id = $1', [
        userId,
        role,
      ]);
      return (rowCount ?? 0) > 0;
    });
  }

  /** Privileged (no tenant context) existence check — erasure replay only. */
  async orgById(orgId: OrgId): Promise<Organization | undefined> {
    return withProvisioner(this.pool, async (c) => {
      const { rows } = await c.query<OrganizationRow>('select * from organizations where id = $1', [
        orgId,
      ]);
      return rows[0] ? toOrganization(rows[0]) : undefined;
    });
  }

  /**
   * Whole-org purge (idle grace or cancellation grace elapsed, or an
   * operator-triggered immediate purge): every tenant row goes, dependency
   * order respecting FKs. Deliberately re-enters the RLS-scoped tenant path
   * — the purge executes *as* the doomed org, so it structurally cannot
   * touch a neighbour, and mdloop_app's ordinary grants suffice. No
   * privileged step is needed to unlink `billing_events`: that FK is
   * `on delete set null` (migration 0006), so the final `organizations`
   * delete below nulls it automatically.
   */
  async purgeOrganization(orgId: OrgId): Promise<void> {
    const ctx: TenantContext = { orgId, userId: 'system-org-purge' as UserId };
    await withTenant(this.pool, ctx, async (c) => {
      const del = (sql: string) => c.query(sql, [orgId]);
      await del('delete from comment_anchor_resolutions where org_id = $1');
      await del('delete from comment_replies where org_id = $1');
      await del('delete from comments where org_id = $1');
      // Sign-off rows (Phase B) are append-only at the grant level (no
      // delete) — they disappear via the `on delete cascade` FKs to
      // document_versions and documents, deleted further down.
      await del('delete from share_grants where org_id = $1');
      await del('delete from search_index where org_id = $1');
      await del('delete from api_keys where org_id = $1');
      await del('update documents set current_version_id = null where org_id = $1');
      await del('delete from upload_ledger where org_id = $1');
      await del('delete from document_versions where org_id = $1');
      await del('delete from documents where org_id = $1');
      await del('delete from projects where org_id = $1');
      // Invites and allowlist entries carry plain (non-cascading) FKs to
      // users via invited_by/added_by — they must go before the users delete,
      // or an org that ever sent an invite or added an allowlist entry
      // (i.e. nearly every real multi-user org) fails the FK check and rolls
      // back the whole purge, defeating GDPR erasure (Phase 24.D).
      await del('delete from org_invites where org_id = $1');
      await del('delete from org_allowlist_entries where org_id = $1');
      await del('delete from users where org_id = $1');
      await c.query('delete from organizations where id = $1', [orgId]);
    });
  }
}
