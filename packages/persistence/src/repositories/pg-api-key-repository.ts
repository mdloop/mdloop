import type { Pool } from 'pg';
import type { ApiKey, ApiKeyIdentity, ApiKeyRepository, TenantContext } from '@mdloop/app';
import type { OrgId, UserId } from '@mdloop/shared';
import { withProvisioner, withTenant } from '../db.js';

interface ApiKeyRow {
  id: string;
  org_id: string;
  user_id: string;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

function toApiKey(r: ApiKeyRow): ApiKey {
  return {
    id: r.id,
    orgId: r.org_id as OrgId,
    userId: r.user_id as UserId,
    name: r.name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  };
}

export class PgApiKeyRepository implements ApiKeyRepository {
  constructor(private readonly pool: Pool) {}

  async create(
    ctx: TenantContext,
    input: { userId: UserId; name: string; keyHash: string },
  ): Promise<ApiKey> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<ApiKeyRow>(
        `insert into api_keys (org_id, user_id, name, key_hash)
         values ($1, $2, $3, $4) returning id, org_id, user_id, name, created_at, last_used_at, revoked_at`,
        [ctx.orgId, input.userId, input.name, input.keyHash],
      );
      const row = rows[0];
      if (!row) throw new Error('insert returned no row');
      return toApiKey(row);
    });
  }

  async listForUser(ctx: TenantContext, userId: UserId): Promise<ApiKey[]> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<ApiKeyRow>(
        `select id, org_id, user_id, name, created_at, last_used_at, revoked_at
         from api_keys where user_id = $1 order by created_at`,
        [userId],
      );
      return rows.map(toApiKey);
    });
  }

  async listAll(ctx: TenantContext): Promise<ApiKey[]> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<ApiKeyRow>(
        `select id, org_id, user_id, name, created_at, last_used_at, revoked_at
         from api_keys order by created_at`,
      );
      return rows.map(toApiKey);
    });
  }

  async revoke(ctx: TenantContext, id: string): Promise<boolean> {
    return withTenant(this.pool, ctx, async (c) => {
      const { rowCount } = await c.query(
        'update api_keys set revoked_at = now() where id = $1 and revoked_at is null',
        [id],
      );
      return (rowCount ?? 0) > 0;
    });
  }

  async namesByIds(ctx: TenantContext, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    return withTenant(this.pool, ctx, async (c) => {
      const { rows } = await c.query<{ id: string; name: string }>(
        // Revoked keys included on purpose — a past comment/version made
        // through a since-revoked key still deserves honest attribution.
        'select id, name from api_keys where id = any($1)',
        [ids],
      );
      return new Map(rows.map((r) => [r.id, r.name]));
    });
  }

  async identityByHash(keyHash: string): Promise<ApiKeyIdentity | undefined> {
    return withProvisioner(this.pool, async (c) => {
      const { rows } = await c.query<{
        id: string;
        org_id: string;
        user_id: string;
        role: 'admin' | 'member';
      }>(
        `select k.id, k.org_id, k.user_id, u.role
         from api_keys k join users u on u.id = k.user_id
         where k.key_hash = $1 and k.revoked_at is null`,
        [keyHash],
      );
      const row = rows[0];
      if (!row) return undefined;
      await c.query('update api_keys set last_used_at = now() where id = $1', [row.id]);
      return {
        keyId: row.id,
        orgId: row.org_id as OrgId,
        userId: row.user_id as UserId,
        role: row.role,
      };
    });
  }
}
