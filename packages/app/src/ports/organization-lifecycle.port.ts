import type { Organization } from '@vorlyn/domain';
import type { OrgId } from '@vorlyn/shared';

/**
 * Privileged (no `TenantContext`) org lifecycle operations — GDPR erasure
 * only. Both methods run outside any tenant session: `orgById` is a plain
 * lookup by id (used to check an org still exists before purging it),
 * and `purgeOrganization` deletes every row belonging to the org.
 *
 * Was `BillingRepository.purgeOrganization` (misfiled — the implementation
 * has never touched a payment provider, it's pure GDPR org deletion under
 * RLS) until the billing-removal spike (S4) relocated it here. Callers:
 * `erasure-replay.ts` (post-restore replay of the erasure log) and
 * `operator-offboarding.ts` (operator-triggered immediate purge).
 */
export interface OrgLifecyclePort {
  orgById(orgId: OrgId): Promise<Organization | undefined>;
  /** Deletes every row of the org (documents, versions, comments, users, org). */
  purgeOrganization(orgId: OrgId): Promise<void>;
}
