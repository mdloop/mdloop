import type {
  ApprovalGate,
  Organization,
  ProvisioningMode,
  SharingMode,
  User,
  UserRole,
  VersionRetentionConfig,
} from '@vorlyn/domain';
import {
  clampVersionRetention,
  isValidRetentionDays,
  isValidSessionMaxHours,
  isValidVersionRetention,
} from '@vorlyn/domain';
import type { Result, UserId } from '@vorlyn/shared';
import { err, ok } from '@vorlyn/shared';
import type { TenantContext } from '../tenant-context.js';

/** Caller identity as needed for authorization decisions. */
export interface Actor {
  readonly ctx: TenantContext;
  readonly role: UserRole;
  /** Set when the actor is an MCP/API-key call — the key that authenticated it. Undefined for session (web) actors. */
  readonly apiKeyId?: string;
}

export interface OrgSettingsPatch {
  /** Rename: the personal→org upgrade path keeps data in place (Phase 13). */
  readonly name?: string;
  readonly sharingMode?: SharingMode;
  readonly retentionDays?: number;
  readonly purgeImmediately?: boolean;
  /** Version auto-purge rule (ADR 0001); null resets to the tier default. */
  readonly versionRetention?: VersionRetentionConfig | null;
  /** Enterprise SSO JIT mode (Phase 15); irrelevant without an sso_connection_id. */
  readonly provisioningMode?: ProvisioningMode;
  /** External guest sharing master switch (Phase 18). */
  readonly externalSharing?: boolean;
  /** Sign-off gate (Phase B, ADR 0002): soft (advisory) or hard (blocks approve while open comments). */
  readonly approvalGate?: ApprovalGate;
  /**
   * Session ceiling (Phase 24): integer 1..24 hours (may only shorten below
   * the 24h global default), or null to reset to that default.
   */
  readonly sessionMaxHours?: number | null;
}

export type OrgSettingsError =
  | { readonly code: 'forbidden' }
  | { readonly code: 'invalid_name' }
  | { readonly code: 'invalid_retention_days' }
  | { readonly code: 'invalid_version_retention' }
  | { readonly code: 'version_retention_exceeds_tier_ceiling' }
  | { readonly code: 'invalid_session_max_hours' }
  | { readonly code: 'org_not_found' };

/** Port implemented by persistence: the org's own row, RLS-scoped. */
export interface OrganizationRepository {
  current(ctx: TenantContext): Promise<Organization | undefined>;
  updateSettings(ctx: TenantContext, patch: OrgSettingsPatch): Promise<Organization | undefined>;
  /**
   * Org members (RLS-scoped): the directory-mode grant picker and the invite
   * seat count. Excludes role 'guest' (Phase 18) — guests are external
   * identities, never seats.
   */
  listUsers(ctx: TenantContext): Promise<User[]>;
  /**
   * Keyset-paged member listing for the share/mention/reviewer pickers
   * (Phase 24): stable order (lower(display_name), id), optional prefix
   * search on display name and email, `limit + 1` probe for `nextCursor`.
   * Excludes guests like listUsers. At thousands-member orgs the pickers page
   * and search server-side instead of materializing the whole directory.
   */
  listUsersPage(
    ctx: TenantContext,
    opts: { q?: string; cursor?: string; limit: number },
  ): Promise<{ users: User[]; nextCursor: string | null }>;
  /**
   * Tenant-scoped by-id user lookup — unlike listUsers, this INCLUDES guests
   * (Phase B needs to validate a guest reviewer). Returns undefined when the
   * id is not in the caller's org.
   */
  userById(ctx: TenantContext, id: UserId): Promise<User | undefined>;
}

export interface RoleDirectory {
  setUserRole(ctx: TenantContext, userId: UserId, role: UserRole): Promise<boolean>;
}

/**
 * Keyset cursor codec for `listUsersPage` — (lower(display_name), id)
 * ascending, matching that method's own JSDoc above. Delimiter is `:`,
 * matching every other keyset cursor in this codebase (e.g.
 * `encodeThreadCursor`/`decodeThreadCursor` in `comments.ts`) — the only
 * real constraint on a cursor delimiter is "never appears in the id half,"
 * which `:` satisfies since ids here are UUIDs. Pure encoding helpers living
 * next to the interface that uses them, same placement as
 * `versionObjectKey`/`publicObjectKey` in `storage.port.ts`.
 *
 * `decodeNameKeysetCursor` validates the id half against a UUID shape rather
 * than trusting it, so a malformed or stale cursor — including a legacy
 * NUL-separated cursor from before this delimiter changed — degrades to "no
 * cursor" (page 1) instead of reaching the database with a value that fails
 * `::uuid` casting. That degradation is deliberate and sufficient: this
 * cursor is never persisted (no DB column, no localStorage — it's a
 * short-lived `?cursor=` query param round-tripped within one paging
 * session), so the only real exposure is a client mid-pagination across a
 * deploy that changed this format, and re-starting at page 1 is a harmless
 * outcome for that.
 */
export function encodeNameKeysetCursor(displayName: string, id: string): string {
  return Buffer.from(`${displayName.toLowerCase()}:${id}`, 'utf8').toString('base64url');
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeNameKeysetCursor(cursor: string): { name: string; id: string } | null {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = decoded.lastIndexOf(':');
  if (sep === -1) return null;
  const id = decoded.slice(sep + 1);
  if (!UUID_SHAPE.test(id)) return null;
  return { name: decoded.slice(0, sep), id };
}

/** Admin-only (CONSTITUTION.md §4): update org sharing/retention settings. */
export async function updateOrgSettings(
  orgs: OrganizationRepository,
  actor: Actor,
  patch: OrgSettingsPatch,
): Promise<Result<Organization, OrgSettingsError>> {
  if (actor.role !== 'admin') return err({ code: 'forbidden' });
  if (patch.name !== undefined && (patch.name.trim().length === 0 || patch.name.length > 200)) {
    return err({ code: 'invalid_name' });
  }
  if (patch.retentionDays !== undefined && !isValidRetentionDays(patch.retentionDays)) {
    return err({ code: 'invalid_retention_days' });
  }
  if (
    patch.sessionMaxHours !== undefined &&
    patch.sessionMaxHours !== null &&
    !isValidSessionMaxHours(patch.sessionMaxHours)
  ) {
    return err({ code: 'invalid_session_max_hours' });
  }
  if (patch.versionRetention != null) {
    if (!isValidVersionRetention(patch.versionRetention)) {
      return err({ code: 'invalid_version_retention' });
    }
    // Stricter than the ceiling is fine; looser is rejected outright rather
    // than silently clamped, so the admin sees what their tier allows.
    const org = await orgs.current(actor.ctx);
    if (!org) return err({ code: 'org_not_found' });
    const clamped = clampVersionRetention(patch.versionRetention, org.tier);
    if (
      clamped.keepLastN !== patch.versionRetention.keepLastN ||
      clamped.keepDays !== patch.versionRetention.keepDays
    ) {
      return err({ code: 'version_retention_exceeds_tier_ceiling' });
    }
  }
  const updated = await orgs.updateSettings(actor.ctx, patch);
  return updated ? ok(updated) : err({ code: 'org_not_found' });
}

export type RoleChangeError =
  | { readonly code: 'forbidden' }
  | { readonly code: 'cannot_demote_self' }
  | { readonly code: 'user_not_found' };

/** Admin-only: toggle another member's role. Admins cannot demote themselves. */
export async function setUserRole(
  directory: RoleDirectory,
  actor: Actor,
  targetUserId: UserId,
  role: UserRole,
): Promise<Result<void, RoleChangeError>> {
  if (actor.role !== 'admin') return err({ code: 'forbidden' });
  if (targetUserId === actor.ctx.userId && role !== 'admin') {
    return err({ code: 'cannot_demote_self' });
  }
  const changed = await directory.setUserRole(actor.ctx, targetUserId, role);
  return changed ? ok(undefined) : err({ code: 'user_not_found' });
}
