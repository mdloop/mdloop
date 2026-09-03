import type { Pool } from 'pg';
import type {
  AllowlistRepository,
  NewAllowlistEntry,
  NewOrgInvite,
  OrgInviteRepository,
  TenantContext,
} from '@vorlyn/app';
import type { AllowlistEntry, OrgInvite } from '@vorlyn/domain';
import type { AllowlistEntryId, InviteId, OrgId } from '@vorlyn/shared';
import { withProvisioner, withTenant } from '../db.js';
import { toAllowlistEntry, toOrgInvite } from './row-mappers.js';
import type { AllowlistEntryRow, OrgInviteRow } from './row-mappers.js';

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error('insert returned no row');
  return row;
}

/** Admin-managed org invites (Phase 15), always inside the sending admin's tenant context. */
export class PgOrgInviteRepository implements OrgInviteRepository {
  constructor(private readonly pool: Pool) {}

  async create(ctx: TenantContext, input: NewOrgInvite): Promise<OrgInvite> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<OrgInviteRow>(
        `insert into org_invites (org_id, email, role, token_hash, invited_by, expires_at)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [ctx.orgId, input.email, input.role, input.tokenHash, input.invitedBy, input.expiresAt],
      );
      return toOrgInvite(one(rows));
    });
  }

  async createWithinSeatCap(
    ctx: TenantContext,
    input: NewOrgInvite,
    limit: number | null,
  ): Promise<OrgInvite | undefined> {
    return withTenant(this.pool, ctx, async (c) => {
      // Same per-org advisory lock family as the other cap-checked creates
      // (Phase 24): recount-then-insert is serialized, so two concurrent
      // invites at ceiling-1 cannot both commit. Occupied seats = human
      // members (guests never count, Phase 18) + pending invites.
      await c.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [ctx.orgId]);
      if (limit !== null) {
        const { rows } = await c.query<{ n: string }>(
          `select (select count(*) from users where role <> 'guest')
                + (select count(*) from org_invites where accepted_at is null and revoked_at is null)
                as n`,
        );
        if (Number(one(rows).n) >= limit) return undefined;
      }
      const { rows } = await c.query<OrgInviteRow>(
        `insert into org_invites (org_id, email, role, token_hash, invited_by, expires_at)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [ctx.orgId, input.email, input.role, input.tokenHash, input.invitedBy, input.expiresAt],
      );
      return toOrgInvite(one(rows));
    });
  }

  async list(ctx: TenantContext): Promise<OrgInvite[]> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<OrgInviteRow>(
        'select * from org_invites order by created_at desc',
      );
      return rows.map(toOrgInvite);
    });
  }

  async countPending(ctx: TenantContext): Promise<number> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<{ count: string }>(
        'select count(*) from org_invites where accepted_at is null and revoked_at is null',
      );
      return Number(rows[0]?.count ?? 0);
    });
  }

  async revoke(ctx: TenantContext, id: InviteId): Promise<boolean> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rowCount } = await c.query(
        'update org_invites set revoked_at = now() where id = $1 and revoked_at is null',
        [id],
      );
      return (rowCount ?? 0) > 0;
    });
  }

  async createWithinSeatCapForOrg(
    orgId: OrgId,
    input: Omit<NewOrgInvite, 'invitedBy'>,
    limit: number | null,
  ): Promise<OrgInvite | undefined> {
    return withProvisioner(this.pool, async (c) => {
      // No RLS to lean on here (vorlyn_provisioner bypasses it) — every
      // subquery needs an explicit org_id filter, unlike the tenant-scoped
      // createWithinSeatCap above.
      await c.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [orgId]);
      if (limit !== null) {
        const { rows } = await c.query<{ n: string }>(
          `select (select count(*) from users where org_id = $1 and role <> 'guest')
                + (select count(*) from org_invites
                     where org_id = $1 and accepted_at is null and revoked_at is null)
                as n`,
          [orgId],
        );
        if (Number(one(rows).n) >= limit) return undefined;
      }
      const { rows } = await c.query<OrgInviteRow>(
        `insert into org_invites (org_id, email, role, token_hash, invited_by, expires_at)
         values ($1, $2, $3, $4, null, $5) returning *`,
        [orgId, input.email, input.role, input.tokenHash, input.expiresAt],
      );
      return toOrgInvite(one(rows));
    });
  }
}

/** Enterprise `allowlist`-mode entries (Phase 15), admin-managed inside tenant context. */
export class PgAllowlistRepository implements AllowlistRepository {
  constructor(private readonly pool: Pool) {}

  async add(ctx: TenantContext, input: NewAllowlistEntry): Promise<AllowlistEntry> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<AllowlistEntryRow>(
        `insert into org_allowlist_entries (org_id, email, added_by)
         values ($1, $2, $3) returning *`,
        [ctx.orgId, input.email, input.addedBy],
      );
      return toAllowlistEntry(one(rows));
    });
  }

  async list(ctx: TenantContext): Promise<AllowlistEntry[]> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<AllowlistEntryRow>(
        'select * from org_allowlist_entries order by created_at',
      );
      return rows.map(toAllowlistEntry);
    });
  }

  async remove(ctx: TenantContext, id: AllowlistEntryId): Promise<boolean> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rowCount } = await c.query('delete from org_allowlist_entries where id = $1', [id]);
      return (rowCount ?? 0) > 0;
    });
  }
}
