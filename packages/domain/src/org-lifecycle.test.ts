import { describe, expect, it } from 'vitest';
import type { OrgId } from '@mdloop/shared';
import type { Organization } from './entities.js';
import { orgIsWriteLocked } from './org-lifecycle.js';

function org(readOnlyAt: Date | null): Organization {
  return {
    id: 'org-1' as OrgId,
    name: 'Acme',
    sharingMode: 'link',
    retentionDays: 30,
    purgeImmediately: false,
    tier: 'free',
    versionRetention: null,
    subscriptionStatus: 'none',
    billingCustomerId: null,
    trialEndsAt: null,
    readOnlyAt,
    purgeScheduledAt: null,
    idleWarningSentAt: null,
    provisioningMode: 'open',
    ssoConnectionId: null,
    externalSharing: true,
    approvalGate: 'soft',
    sessionMaxHours: null,
    createdAt: new Date(),
  };
}

describe('orgIsWriteLocked', () => {
  it('is unlocked when readOnlyAt is null', () => {
    expect(orgIsWriteLocked(org(null))).toBe(false);
  });

  it('is locked once readOnlyAt is set', () => {
    expect(orgIsWriteLocked(org(new Date('2026-01-01')))).toBe(true);
  });

  it('does not treat the lock as time-bounded — any timestamp locks', () => {
    // The column records *when* the freeze began, not when it expires. A
    // future-dated value is still a freeze; unlocking is clearing the column,
    // never waiting for a date to pass.
    expect(orgIsWriteLocked(org(new Date(Date.now() + 86_400_000)))).toBe(true);
  });
});
