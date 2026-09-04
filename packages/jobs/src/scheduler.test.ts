import { describe, expect, it } from 'vitest';
import {
  CapturingTelemetry,
  FakeAnchorResolutionRepository,
  FakeCommentRepository,
  FakeDocumentRepository,
  FakeErasureLog,
  FakeOrganizationRepository,
  FakeRetentionSweepRepository,
  FakeStorage,
  FakeVersionRepository,
  FakeWorld,
} from '@mdloop/app/test-support';
import type { ComplianceJobDeps } from './scheduler.js';
import { runComplianceCycle, startComplianceScheduler } from './scheduler.js';

/** The order runComplianceCycle drives the sweeps in — asserted end to end. */
const SWEEPS = ['version_purge', 'retention', 'erasure_replay', 'anchor_cache_prune'] as const;

function makeDeps(): { deps: ComplianceJobDeps; telemetry: CapturingTelemetry; world: FakeWorld } {
  const world = new FakeWorld();
  const telemetry = new CapturingTelemetry();
  const deps: ComplianceJobDeps = {
    // No FakeVersionPurgeSweepRepository exists; the interface is one method.
    versionPurgeSweep: { listOrgIds: () => Promise.resolve([]) },
    retentionSweep: new FakeRetentionSweepRepository(world),
    orgs: new FakeOrganizationRepository(world),
    documents: new FakeDocumentRepository(world),
    versions: new FakeVersionRepository(world),
    comments: new FakeCommentRepository(world),
    resolutions: new FakeAnchorResolutionRepository(),
    storage: new FakeStorage(),
    erasures: new FakeErasureLog(),
    telemetry,
  };
  return { deps, telemetry, world };
}

describe('runComplianceCycle', () => {
  it('runs every sweep once and logs one compliance_sweep event per sweep', async () => {
    const { deps, telemetry } = makeDeps();

    await runComplianceCycle(deps);

    const events = telemetry.logs.filter((l) => l.event === 'compliance_sweep');
    expect(events.map((e) => e.fields.sweep)).toEqual([...SWEEPS]);
    for (const e of events) {
      expect(e.fields.outcome).toBe('ok');
      expect(typeof e.fields.count).toBe('number');
    }
  });

  it('isolates a failing sweep: it logs an error, the rest still run', async () => {
    const { deps, telemetry } = makeDeps();
    // Break only the retention sweep — its listDue is the first thing it calls.
    const broken: ComplianceJobDeps = {
      ...deps,
      retentionSweep: {
        listDue: () => Promise.reject(new Error('db down')),
        purge: () => Promise.resolve(),
      },
    };

    await runComplianceCycle(broken);

    const events = telemetry.logs.filter((l) => l.event === 'compliance_sweep');
    // Still one event per sweep — the failure did not abort the cycle.
    expect(events.map((e) => e.fields.sweep)).toEqual([...SWEEPS]);
    const retention = events.find((e) => e.fields.sweep === 'retention');
    expect(retention?.fields.outcome).toBe('error');
    expect(retention?.fields.errorCode).toBe('Error');
    // The others are unaffected.
    expect(
      events.filter((e) => e.fields.sweep !== 'retention').every((e) => e.fields.outcome === 'ok'),
    ).toBe(true);
  });

  it('never leaks org data into telemetry (opaque fields only)', async () => {
    const { deps, telemetry } = makeDeps();
    await runComplianceCycle(deps);
    // The only strings captured are the fixed sweep labels — no ids, no content.
    const strings = new Set(telemetry.allStrings());
    for (const s of strings) {
      expect([...SWEEPS, 'ok', 'error']).toContain(s);
    }
  });

  it('runs extra sweeps after every core sweep, logging them identically', async () => {
    const { deps, telemetry } = makeDeps();
    const now = new Date('2027-01-01T00:00:00.000Z');
    const seen: Date[] = [];

    await runComplianceCycle(
      {
        ...deps,
        extraSweeps: [
          {
            name: 'deployment_job',
            run: (at) => {
              seen.push(at);
              return Promise.resolve(7);
            },
          },
        ],
      },
      now,
    );

    const events = telemetry.logs.filter((l) => l.event === 'compliance_sweep');
    expect(events.map((e) => e.fields.sweep)).toEqual([...SWEEPS, 'deployment_job']);
    // Same event shape as a core sweep, not a second-class one.
    expect(events.at(-1)?.fields).toMatchObject({ outcome: 'ok', count: 7 });
    // The cycle's `now` is threaded through, so an extra sweep sees the same
    // instant the core sweeps did rather than drifting mid-cycle.
    expect(seen).toEqual([now]);
  });

  it('contains a failing extra sweep: the core sweeps still all report ok', async () => {
    const { deps, telemetry } = makeDeps();

    await runComplianceCycle({
      ...deps,
      extraSweeps: [
        { name: 'broken_job', run: () => Promise.reject(new TypeError('provider down')) },
      ],
    });

    const events = telemetry.logs.filter((l) => l.event === 'compliance_sweep');
    expect(events.filter((e) => e.fields.outcome === 'ok')).toHaveLength(SWEEPS.length);
    expect(events.at(-1)?.fields).toEqual({
      sweep: 'broken_job',
      outcome: 'error',
      errorCode: 'TypeError',
    });
  });
});

describe('startComplianceScheduler', () => {
  it('runs cycles on the interval and drains the in-flight one on stop', async () => {
    const { deps, telemetry } = makeDeps();
    const scheduler = startComplianceScheduler(deps, 5);

    // Let at least one cycle fire, then stop and confirm a clean drain.
    await new Promise((r) => setTimeout(r, 40));
    await scheduler.stop();

    const after = telemetry.logs.length;
    expect(after).toBeGreaterThanOrEqual(SWEEPS.length);

    // No cycle runs after stop: the count is stable.
    await new Promise((r) => setTimeout(r, 40));
    expect(telemetry.logs.length).toBe(after);
  });

  it('stop() is safe when no cycle has started yet', async () => {
    const { deps } = makeDeps();
    const scheduler = startComplianceScheduler(deps, 3_600_000);
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });
});
