import type { OrgId, UserId } from '@mdloop/shared';

/**
 * Ambient tenant identity for every data access (CONSTITUTION.md §3).
 * Repositories require this explicitly — there is no default, no global, and
 * no way to construct a query without one. Persistence binds `orgId` to the
 * Postgres RLS session variable inside the transaction.
 */
export interface TenantContext {
  readonly orgId: OrgId;
  readonly userId: UserId;
}

export function tenantContext(orgId: OrgId, userId: UserId): TenantContext {
  return { orgId, userId };
}
