/**
 * Identity provider seam (CONSTITUTION.md §2: WorkOS AuthKit behind a port).
 * The application never sees WorkOS types — only this profile shape — so the
 * provider can be swapped without touching use-cases.
 */
export interface AuthPort {
  /** Hosted sign-in page URL to redirect the browser to. */
  authorizationUrl(redirectUri: string, state: string): string;
  /** Exchanges the callback code for the authenticated profile. */
  exchangeCode(code: string): Promise<AuthProfile>;
}

export interface AuthProfile {
  readonly providerUserId: string;
  readonly email: string;
  readonly displayName: string;
  /**
   * Present when this login came through a WorkOS SSO connection — the seam
   * enterprise JIT provisioning (Phase 15) keys off. Absent for AuthKit
   * email/OTP/magic-link logins.
   */
  readonly ssoConnectionId?: string;
}
