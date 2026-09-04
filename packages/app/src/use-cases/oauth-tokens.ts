import type { DirectoryRepository } from '../ports/repositories.port.js';
import type { OAuthTokenVerifierPort } from '../ports/oauth-verifier.port.js';
import { isAgentSurfaceRole } from './api-keys.js';
import type { Actor } from './org-settings.js';

/**
 * Resolves a WorkOS AuthKit-issued Bearer token to an Actor — the OAuth
 * sibling of `actorForApiKey` (`api-keys.ts:100`), used by the MCP HTTP
 * transport's second Bearer-token path (interactive/human clients; the
 * `mdloop_`-prefixed API-key path stays primary for headless/agent use).
 * Kept in its own file rather than folded into `api-keys.ts` — distinct
 * concern, same separation `api-keys.ts` itself already gets.
 *
 * No `apiKeyId` is ever set on the returned Actor: an OAuth-authenticated
 * call is a human sitting at an interactive client, not an API key, so it is
 * treated like a session actor — matching ADR 0002's "a session-authenticated
 * actor's apiKeyId is always absent".
 */
export async function actorForOAuthToken(
  directory: DirectoryRepository,
  verifier: OAuthTokenVerifierPort,
  presented: string,
): Promise<Actor | undefined> {
  const claims = await verifier.verify(presented);
  if (!claims) return undefined;
  const user = await directory.userByWorkosId(claims.sub);
  if (!user) return undefined;
  // Guest containment (Phase 24), single source of truth shared with
  // actorForApiKey — a guest token is structurally unusable here exactly like
  // a guest API key, mirroring the HTTP default-deny allowlist.
  if (!isAgentSurfaceRole(user.role)) return undefined;
  return { ctx: { orgId: user.orgId, userId: user.id }, role: user.role };
}
