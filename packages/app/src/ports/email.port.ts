/**
 * Outbound email seam (lifecycle notices only — document content never
 * enters an email, Core Principle 3 posture). Prod adapter arrives with
 * Phase 10 infra (SES); until then a logging noop is wired.
 */
export interface EmailPort {
  /** Idle free-org warning: purge happens at `purgeAt` unless they return. */
  sendIdleWarning(to: string, orgName: string, purgeAt: Date): Promise<void>;
  /** Org invite (Phase 15): token is embedded in `acceptUrl`, never in the log. */
  sendOrgInvite(to: string, orgName: string, acceptUrl: string, expiresAt: Date): Promise<void>;
  /**
   * External guest share (Phase 18): the redeem token is embedded in `url`,
   * never in the log. Carries only the document title (no content).
   */
  sendGuestShare(input: {
    to: string;
    documentTitle: string;
    url: string;
    expiresAt: Date;
  }): Promise<void>;
}
