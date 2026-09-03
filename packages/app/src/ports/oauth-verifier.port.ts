/**
 * Verifies a Bearer token issued by an external OAuth authorization server
 * (WorkOS AuthKit, ADR 0013) and resolves it to the subject claim only —
 * mirrors AuthPort's "provider types never leak past this shape" discipline
 * (packages/app/src/ports/auth.port.ts:1-11). `packages/mcp` implements this
 * against AuthKit's JWKS (`WorkosJwtVerifier`); no authorization-server logic
 * (no `/authorize`, no `/token`, no refresh handling) lives behind this port
 * or anywhere else in this codebase — AuthKit is the full AS, this package is
 * only a protected resource that checks the tokens AuthKit already issued.
 */
export interface OAuthTokenVerifierPort {
  /**
   * Verifies signature, issuer, audience and expiry. Resolves to the `sub`
   * claim (the WorkOS user id) on success, `undefined` on any failure — bad
   * signature, wrong issuer/audience, expired, unknown key, wrong algorithm,
   * or a transport/JWKS-fetch fault. Never throws.
   */
  verify(token: string): Promise<{ readonly sub: string } | undefined>;
}
