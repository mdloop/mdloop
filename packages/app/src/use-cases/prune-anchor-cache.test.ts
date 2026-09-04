import { describe, expect, it } from 'vitest';
import type { OrgId } from '@mdloop/shared';
import { FakeAnchorResolutionRepository } from '../test-support/fakes.js';
import { ANCHOR_RESOLUTION_KEEP_DAYS, sweepAnchorResolutionCache } from './prune-anchor-cache.js';

describe('sweepAnchorResolutionCache', () => {
  const orgIds = ['org-a', 'org-b'] as OrgId[];
  const sweep = { listOrgIds: () => Promise.resolve(orgIds) };

  it('prunes every org with a cutoff KEEP_DAYS behind now and sums the counts', async () => {
    const resolutions = new FakeAnchorResolutionRepository();
    resolutions.pruneReturns = 3;
    const now = new Date('2026-07-20T00:00:00.000Z');

    const report = await sweepAnchorResolutionCache({ sweep, resolutions }, now);

    expect(report).toEqual({ orgsSwept: 2, rowsPruned: 6 });
    // One prune per org, each scoped to that org's tenant context.
    expect(resolutions.pruneCalls.map((c) => c.orgId)).toEqual(orgIds);
    const expectedCutoff = new Date(now.getTime() - ANCHOR_RESOLUTION_KEEP_DAYS * 86_400_000);
    for (const call of resolutions.pruneCalls) {
      expect(call.olderThan).toEqual(expectedCutoff);
    }
  });

  it('reports zero pruned when nothing is stale', async () => {
    const resolutions = new FakeAnchorResolutionRepository();
    resolutions.pruneReturns = 0;
    const report = await sweepAnchorResolutionCache({ sweep, resolutions });
    expect(report.rowsPruned).toBe(0);
    expect(report.orgsSwept).toBe(2);
  });
});
