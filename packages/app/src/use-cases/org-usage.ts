import type { Tier } from '@vorlyn/domain';
import { TIER_PROFILES } from '@vorlyn/domain';
import type { ProjectId, Result } from '@vorlyn/shared';
import { err, ok } from '@vorlyn/shared';
import type {
  DocumentRepository,
  ShareGrantRepository,
  VersionRepository,
} from '../ports/repositories.port.js';
import type { Actor, OrganizationRepository } from './org-settings.js';

export interface OrgUsage {
  readonly tier: Tier;
  readonly activeDocCount: number;
  readonly maxActiveDocs: number | null;
  /** Human members (guests excluded, Phase 18) vs the tier's seat ceiling. */
  readonly memberCount: number;
  readonly maxCollaborators: number | null;
  /** Live (non-tombstoned) version blob bytes across the org. No tier caps
   *  storage today (see `TierCeilings`), so there is no matching ceiling field. */
  readonly storageBytes: number;
  /** Distinct active (non-revoked, unexpired) external guest emails (Phase 18). */
  readonly activeGuestCount: number;
  readonly maxExternalGuests: number | null;
  readonly projectUsage?: {
    readonly activeDocCount: number;
    readonly maxActiveDocsPerProject: number | null;
  };
}

export interface OrgUsageError {
  readonly code: 'org_not_found';
}

/**
 * Current usage against the org's tier ceilings (Phase 33.D doc counts,
 * extended Phase 39.B with seats/storage/guests) — the read-only signal a
 * pre-flight warning is built on (e.g. the sync CLI telling a user how close
 * a batch push will bring them to the doc cap before it starts uploading, or
 * the org-settings UI showing headroom before an admin sends an invite).
 * `projectId` is optional: when given, also reads that project's own
 * headroom against the tighter per-project ceiling. Every read here goes
 * through the caller's own `TenantContext` (RLS via `withTenant()`), never a
 * cross-org path — this function is reachable by any org member, unlike the
 * operator directory's equivalent org-wide reads.
 */
export async function orgUsage(
  orgs: OrganizationRepository,
  documents: DocumentRepository,
  versions: VersionRepository,
  grants: ShareGrantRepository,
  actor: Actor,
  projectId?: ProjectId,
): Promise<Result<OrgUsage, OrgUsageError>> {
  const org = await orgs.current(actor.ctx);
  if (!org) return err({ code: 'org_not_found' });

  const { maxActiveDocs, maxActiveDocsPerProject, maxCollaborators, maxExternalGuests } =
    TIER_PROFILES[org.tier].ceilings;

  const [activeDocCount, members, storageBytes, activeGuestEmails] = await Promise.all([
    documents.activeCount(actor.ctx),
    orgs.listUsers(actor.ctx),
    versions.storageBytesUsed(actor.ctx),
    grants.activeGuestEmails(actor.ctx),
  ]);

  const usage: OrgUsage = {
    tier: org.tier,
    activeDocCount,
    maxActiveDocs,
    memberCount: members.length,
    maxCollaborators,
    storageBytes,
    activeGuestCount: activeGuestEmails.length,
    maxExternalGuests,
  };

  if (projectId === undefined) return ok(usage);

  const projectActiveDocCount = await documents.activeCountInProject(actor.ctx, projectId);
  return ok({
    ...usage,
    projectUsage: {
      activeDocCount: projectActiveDocCount,
      maxActiveDocsPerProject,
    },
  });
}
