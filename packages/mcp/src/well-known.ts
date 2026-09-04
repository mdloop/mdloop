/**
 * Protected-resource metadata (RFC 9728) the MCP HTTP transport serves at
 * `GET /.well-known/oauth-protected-resource` once OAuth is configured — it
 * tells an MCP client which authorization server (WorkOS AuthKit) issues
 * tokens for this resource, per ADR 0013's "no authorization server here,
 * only a protected resource" design.
 *
 * Kept in its own module, pure and side-effect free, rather than inline in
 * `main.ts`: `main.ts` runs Pool/env/telemetry setup at import time (it's an
 * entrypoint, not a library), so a function meant to be unit-tested in
 * isolation can't live there without dragging that setup into every test
 * that imports it.
 */
export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: string[];
  readonly bearer_methods_supported: string[];
}

export function protectedResourceMetadata(
  resource: string,
  issuer: string,
): ProtectedResourceMetadata {
  return {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
  };
}

/**
 * `WWW-Authenticate` challenge for a 401 (RFC 9728 §5.1) — points the client
 * at the metadata document above so it can discover where to authenticate.
 */
export function bearerChallengeHeader(resource: string): string {
  return `Bearer error="unauthorized", resource_metadata="${resource}/.well-known/oauth-protected-resource"`;
}
