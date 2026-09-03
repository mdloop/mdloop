import type { EmailPort } from '@vorlyn/app';

/**
 * Logging noop: emails are logged, never sent. Prod adapter (SES) arrives
 * with Phase 10 infra; until then, invite/idle-warning/guest-share tokens are
 * also returned in their API responses so dev/tests never need real email
 * (CONSTITUTION.md §3: opaque IDs only, no recipient content in logs).
 */
export class LoggingEmailAdapter implements EmailPort {
  sendIdleWarning(): Promise<void> {
    return Promise.resolve();
  }

  sendOrgInvite(): Promise<void> {
    return Promise.resolve();
  }

  sendGuestShare(): Promise<void> {
    return Promise.resolve();
  }
}
