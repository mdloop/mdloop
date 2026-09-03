import type {
  AnchorResolutionRepository,
  CommentRepository,
  DocumentRepository,
  ErasureLogPort,
  OrganizationRepository,
  OrgLifecyclePort,
  RetentionSweepRepository,
  StoragePort,
  TelemetryPort,
  VersionPurgeSweepRepository,
  VersionRepository,
} from '@vorlyn/app';
import {
  replayErasures,
  sweepAnchorResolutionCache,
  sweepDuePurges,
  sweepVersionPurge,
} from '@vorlyn/app';

/**
 * A periodic job a deployment adds to the cycle — the scheduler's counterpart
 * to `ServerExtension` on the API, and it exists for the same reason: a
 * deployment routinely needs recurring work the core has no opinion about (a
 * payment provider's lifecycle sweep, an internal reconciliation, a
 * company-specific export), and the alternatives are forking the scheduler or
 * running a second timer process that duplicates this one's fault isolation.
 *
 * `run` returns the count reported in the sweep's telemetry event, exactly as
 * a core sweep does. It is called inside the same wrapper, so a failing
 * extra sweep is logged and contained rather than stopping the cycle — a
 * deployment's job cannot take the GDPR sweeps down with it.
 */
export interface ExtraSweep {
  /** Identifies the sweep in `compliance_sweep` telemetry. Keep it opaque (CONSTITUTION §3). */
  readonly name: string;
  readonly run: (now: Date) => Promise<number>;
}

/**
 * Everything the compliance scheduler needs, flat — the jobs entrypoint wires
 * the same Pg* repositories and ports the API does. Each sweep's dependency
 * bundle is assembled from these inside `runComplianceCycle`, so the wiring
 * lives in one place.
 */
export interface ComplianceJobDeps {
  readonly versionPurgeSweep: VersionPurgeSweepRepository;
  readonly retentionSweep: RetentionSweepRepository;
  readonly orgs: OrganizationRepository & OrgLifecyclePort;
  readonly documents: DocumentRepository;
  readonly versions: VersionRepository;
  readonly comments: CommentRepository;
  readonly resolutions: AnchorResolutionRepository;
  readonly storage: StoragePort;
  readonly erasures: ErasureLogPort;
  readonly telemetry: TelemetryPort;
  /**
   * Deployment-supplied jobs, run after every core sweep in the same cycle.
   * Deliberately last and not interleavable: the core keeps ownership of its
   * own ordering, so an extra job cannot wedge itself between two sweeps that
   * were sequenced for a reason. Omitted ⇒ the cycle is exactly the core one.
   */
  readonly extraSweeps?: readonly ExtraSweep[];
}

/** Default cycle interval: hourly. Overridable via `JOB_INTERVAL_MS`. */
export const DEFAULT_JOB_INTERVAL_MS = 3_600_000;

/**
 * Runs one sweep, logging exactly one `compliance_sweep` telemetry event with
 * its outcome and a representative count (CONSTITUTION §3 — opaque operational
 * metadata only, never org data). A sweep failure is caught and logged, never
 * rethrown: one broken sweep must not stop the others in the same cycle.
 */
async function runSweep(
  telemetry: TelemetryPort,
  sweep: string,
  fn: () => Promise<number>,
): Promise<void> {
  try {
    const count = await fn();
    telemetry.log('compliance_sweep', { sweep, outcome: 'ok', count });
  } catch (e) {
    telemetry.log('compliance_sweep', {
      sweep,
      outcome: 'error',
      errorCode: e instanceof Error ? e.name : 'unknown_error',
    });
  }
}

/**
 * One pass of every compliance sweep (Phase 24.D). These use-cases are fully
 * implemented and unit-tested but had no production caller until this package;
 * the scheduler is that caller. Runs sequentially so the sweeps never contend
 * for the same pool at once, and each is independently fault-isolated.
 *
 * The erasure replay is idempotent by construction — a healthy database
 * re-applies nothing. Its primary trigger is a post-restore runbook (an
 * operator's own concern, CONSTITUTION §7); running it here too is cheap
 * defense-in-depth against a silent resurrection.
 */
export async function runComplianceCycle(
  deps: ComplianceJobDeps,
  now: Date = new Date(),
): Promise<void> {
  const t = deps.telemetry;
  await runSweep(t, 'version_purge', async () => {
    const report = await sweepVersionPurge(
      {
        sweep: deps.versionPurgeSweep,
        orgs: deps.orgs,
        documents: deps.documents,
        versions: deps.versions,
        comments: deps.comments,
        storage: deps.storage,
        erasures: deps.erasures,
      },
      now,
    );
    return report.versionsPurged;
  });

  await runSweep(t, 'retention', () =>
    sweepDuePurges(deps.retentionSweep, deps.storage, deps.erasures, now),
  );

  await runSweep(t, 'erasure_replay', async () => {
    const report = await replayErasures({
      erasures: deps.erasures,
      orgs: deps.orgs,
      documents: deps.documents,
      versions: deps.versions,
      storage: deps.storage,
    });
    return report.eventsReplayed;
  });

  await runSweep(t, 'anchor_cache_prune', async () => {
    const report = await sweepAnchorResolutionCache(
      { sweep: deps.versionPurgeSweep, resolutions: deps.resolutions },
      now,
    );
    return report.rowsPruned;
  });

  // Deployment-supplied jobs last, each through the same `runSweep` wrapper —
  // same telemetry event, same fault isolation. See `ExtraSweep`.
  for (const extra of deps.extraSweeps ?? []) {
    await runSweep(t, extra.name, () => extra.run(now));
  }
}

/** Handle for stopping the scheduler and awaiting any in-flight cycle. */
export interface Scheduler {
  /** Clears the timer and resolves once the currently-running cycle finishes. */
  stop(): Promise<void>;
}

/**
 * Single-process interval scheduler — no job-queue framework, one timer. Cycles
 * never overlap: each is chained onto the previous one's completion, so a cycle
 * that outruns the interval simply delays the next rather than stacking. Graceful
 * shutdown (`stop`) clears the timer and waits for the in-flight cycle to drain.
 */
export function startComplianceScheduler(
  deps: ComplianceJobDeps,
  intervalMs: number = DEFAULT_JOB_INTERVAL_MS,
): Scheduler {
  let inFlight: Promise<void> = Promise.resolve();
  let stopped = false;

  const tick = (): void => {
    // runComplianceCycle never rejects (every sweep is fault-isolated), but
    // guard anyway so a surprise can't wedge the chain permanently.
    inFlight = inFlight.then(() =>
      stopped ? undefined : runComplianceCycle(deps).catch(() => undefined),
    );
  };

  const timer = setInterval(tick, intervalMs);

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
