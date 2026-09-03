import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { OAuthTokenVerifierPort } from '@vorlyn/app';

export interface OidcJwtVerifierConfig {
  /** JWKS endpoint the OIDC provider publishes for OAuth/Connect access
   * tokens — for AuthKit this defaults to `${issuer}/oauth2/jwks` in
   * env-config.ts. */
  readonly jwksUrl: string;
  /** The `iss` claim to require (`WORKOS_AUTHKIT_ISSUER` for AuthKit). */
  readonly issuer: string;
  /** The MCP server's own public URL — the `aud` claim to require, matching
   * the Resource Indicator configured on the provider's dashboard. */
  readonly audience: string;
}

/**
 * Validates OIDC-provider-issued OAuth access tokens as a protected
 * resource (ADR 0013) — signature (via the provider's live JWKS), issuer,
 * audience and expiry only. No authorization-server logic: the provider
 * issues and refreshes tokens entirely outside this codebase, this class
 * only checks what it's handed. Constructor-DI'd like `CloudFrontSignedBlobUrl`
 * (`packages/persistence/src/storage/cloudfront-signed-blob-url.ts`) — every
 * dependency (the JWKS URL, issuer, audience) is passed in, nothing read
 * from the environment here. Works against any OIDC provider (AuthKit today;
 * any self-host provider that publishes a standard JWKS tomorrow) — nothing
 * in this class is WorkOS-specific.
 */
export class OidcJwtVerifier implements OAuthTokenVerifierPort {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: OidcJwtVerifierConfig) {
    // Caches the JWKS response and re-fetches on an unrecognized kid — the
    // standard rotation-safe pattern `jose` provides out of the box.
    this.jwks = createRemoteJWKSet(new URL(config.jwksUrl));
  }

  async verify(token: string): Promise<{ readonly sub: string } | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        // Explicit allowlist, not just "whatever the matched JWK advertises":
        // defense-in-depth against algorithm-confusion, same instinct as the
        // rest of this codebase's auth surfaces.
        algorithms: ['RS256'],
      });
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) return undefined;
      return { sub: payload.sub };
    } catch {
      // Any failure — bad signature, wrong iss/aud, expired, unknown kid,
      // disallowed alg, or a JWKS fetch fault — reads as "not a valid token".
      // The port contract never throws.
      return undefined;
    }
  }
}
