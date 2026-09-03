import type { UserId } from '@vorlyn/shared';
import type {
  AnchorResolutionRepository,
  VersionPurgeSweepRepository,
} from '../ports/repositories.port.js';
import type { TenantContext } from '../tenant-context.js';

/**
 * Days a stale anchor-resolution cache row is kept before pruning. Aligned with
 * the free tier's default version-retention window (`tier.ts`,
 * `defaultVersionRetention.keepDays` = 90): a resolution older than this is for
 * a version that has almost certainly been superseded or tombstoned, and the
 * cache is fully recomputable, so dropping it is free. First-pass value
 * (Phase 24.D) — safe to tune once real cache-size telemetry exists.
 */
export const ANCHOR_RESOLUTION_KEEP_DAYS = 90;

const MS_PER_DAY = 86_400_000;

export interface AnchorCacheSweepDeps {
  /** Reused only for `listOrgIds` — the same org roster the purge sweep walks. */
  readonly sweep: VersionPurgeSweepRepository;
  readonly resolutions: AnchorResolutionRepository;
}

export interface AnchorCacheSweepReport {
  readonly orgsSwept: number;
  readonly rowsPruned: number;
}

/**
 * Anchor-resolution cache prune (Phase 24.D). `comment_anchor_resolutions` is a
 * pure cache (comments × versions) with no retention of its own; left alone it
 * grows unboundedly. This sweeps every org and drops rows older than
 * `ANCHOR_RESOLUTION_KEEP_DAYS` whose version is no longer current — the
 * current-version rows (the hot read path) are always kept. Per-org tenant
 * context so every delete runs under RLS, never a bypass.
 */
export async function sweepAnchorResolutionCache(
  deps: AnchorCacheSweepDeps,
  now: Date = new Date(),
): Promise<AnchorCacheSweepReport> {
  const cutoff = new Date(now.getTime() - ANCHOR_RESOLUTION_KEEP_DAYS * MS_PER_DAY);
  const orgIds = await deps.sweep.listOrgIds();
  let rowsPruned = 0;
  for (const orgId of orgIds) {
    const ctx: TenantContext = { orgId, userId: 'system-anchor-cache-prune' as UserId };
    rowsPruned += await deps.resolutions.pruneStale(ctx, cutoff);
  }
  return { orgsSwept: orgIds.length, rowsPruned };
}
