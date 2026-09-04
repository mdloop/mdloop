import { createHash, randomBytes } from 'node:crypto';
import type { UserRole } from '@mdloop/domain';
import type { OrgId, Result, UserId } from '@mdloop/shared';
import { err, ok } from '@mdloop/shared';
import type { TenantContext } from '../tenant-context.js';
import type { Actor } from './org-settings.js';

export interface ApiKey {
  readonly id: string;
  readonly orgId: OrgId;
  readonly userId: UserId;
  readonly name: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

/** Identity a valid key resolves to — becomes the Actor for the MCP call. */
export interface ApiKeyIdentity {
  readonly keyId: string;
  readonly orgId: OrgId;
  readonly userId: UserId;
  readonly role: UserRole;
}

export interface ApiKeyRepository {
  create(
    ctx: TenantContext,
    input: { userId: UserId; name: string; keyHash: string },
  ): Promise<ApiKey>;
  listForUser(ctx: TenantContext, userId: UserId): Promise<ApiKey[]>;
  listAll(ctx: TenantContext): Promise<ApiKey[]>;
  revoke(ctx: TenantContext, id: string): Promise<boolean>;
  /**
   * Privileged pre-auth lookup: the key is the identity, so no tenant
   * context exists yet. Returns undefined for unknown or revoked keys.
   */
  identityByHash(keyHash: string): Promise<ApiKeyIdentity | undefined>;
  /**
   * Read-time id→name lookup for attribution display. Includes revoked keys
   * — a revoked key's past comments/versions still deserve honest
   * attribution. Missing ids are simply absent from the returned map.
   */
  namesByIds(ctx: TenantContext, ids: string[]): Promise<Map<string, string>>;
}

export type ApiKeyError =
  | { readonly code: 'invalid_name' }
  | { readonly code: 'key_not_found' }
  | { readonly code: 'forbidden' };

export const API_KEY_PREFIX = 'mdloop_';

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Guest containment (Phase 24): guests never hold agent surfaces. Shared by
 * every Bearer-token→Actor resolver — the API-key path below and the OAuth
 * path (`actorForOAuthToken`, `use-cases/oauth-tokens.ts`) — so this refusal
 * has exactly one source of truth instead of one copy per transport.
 */
export function isAgentSurfaceRole(role: UserRole): boolean {
  return role !== 'guest';
}

/** Creates a key for the calling user. The key string is returned once. */
export async function createApiKey(
  keys: ApiKeyRepository,
  actor: Actor,
  name: string,
): Promise<Result<{ key: string; record: ApiKey }, ApiKeyError>> {
  // Guests are external identities: they never hold agent surfaces (Phase 24).
  // The route allowlist already blocks POST /api-keys, but the use-case
  // default-denies too, so no transport can mint a guest key.
  if (actor.role === 'guest') return err({ code: 'forbidden' });
  if (name.trim().length === 0) return err({ code: 'invalid_name' });
  const key = `${API_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
  const record = await keys.create(actor.ctx, {
    userId: actor.ctx.userId,
    name: name.trim(),
    keyHash: hashApiKey(key),
  });
  return ok({ key, record });
}

/** Own keys for everyone; the whole org for admins. */
export async function listApiKeys(keys: ApiKeyRepository, actor: Actor): Promise<ApiKey[]> {
  return actor.role === 'admin'
    ? keys.listAll(actor.ctx)
    : keys.listForUser(actor.ctx, actor.ctx.userId);
}

/** Revoke own key; admins may revoke any key in the org. */
export async function revokeApiKey(
  keys: ApiKeyRepository,
  actor: Actor,
  keyId: string,
): Promise<Result<void, ApiKeyError>> {
  const visible = await listApiKeys(keys, actor);
  if (!visible.some((k) => k.id === keyId && k.revokedAt === null)) {
    return err({ code: 'key_not_found' });
  }
  const revoked = await keys.revoke(actor.ctx, keyId);
  return revoked ? ok(undefined) : err({ code: 'key_not_found' });
}

/** Resolves a presented key to an Actor, or undefined when invalid/revoked. */
export async function actorForApiKey(
  keys: ApiKeyRepository,
  presented: string,
): Promise<Actor | undefined> {
  if (!presented.startsWith(API_KEY_PREFIX)) return undefined;
  const identity = await keys.identityByHash(hashApiKey(presented));
  if (!identity) return undefined;
  // Guests never hold agent surfaces (Phase 24). createApiKey refuses guests,
  // but a key whose owner was later demoted to guest — or any future path that
  // mints one — dies here: every MCP transport resolves actors through this
  // function, so a guest key is structurally unusable, mirroring the HTTP
  // default-deny allowlist.
  if (!isAgentSurfaceRole(identity.role)) return undefined;
  return {
    ctx: { orgId: identity.orgId, userId: identity.userId },
    role: identity.role,
    apiKeyId: identity.keyId,
  };
}
