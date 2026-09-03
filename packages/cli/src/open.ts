import open from 'open';
import { isLocalEndpoint } from './endpoint-trust.js';
import { readLocalBootstrapApiKey, resolveApiKey, writeCredentials } from './credentials.js';
import type { DataDirLayout } from './data-dir.js';
import { ensureDataDir, resolveDataDir } from './data-dir.js';
import { liveInstance } from './instance-record.js';
import type { InstanceRecord } from './instance-record.js';
import type { LocalInstance, LocalInstanceDeps } from './local-instance.js';
import { realLocalInstanceDeps, startLocalInstance } from './local-instance.js';
import type { LocalConfig } from './local-config.js';
import { loadOrCreateLocalConfig } from './local-config.js';
import type { LinkOptions } from './link.js';
import { runLink } from './link.js';
import { readManifest } from './manifest.js';
import { isProcessAlive } from './process-alive.js';
import type { Io } from './output.js';
import type { PushOptions } from './push.js';
import { runPush } from './push.js';

export interface OpenOptions {
  folder: string;
  /**
   * Skip `deps.openBrowser` — for a headless/SSH/CI environment where
   * `open`'s `xdg-open`-or-equivalent launch either throws (no display, no
   * launcher installed) or spawns something nobody asked for. This is a real
   * flag rather than a test-only env hook because it's exactly what a
   * remote/CI user of a *published* `vorlyn` needs too, not just a test
   * harness — the packaging smoke test uses it, but it isn't only for that.
   */
  noBrowser?: boolean;
}

export interface OpenDeps {
  dataDir: () => string;
  ensureDataDir: (dataDir: string) => Promise<DataDirLayout>;
  loadOrCreateLocalConfig: (dataDir: string) => Promise<LocalConfig>;
  /** Starts embedded Postgres + spawns both children — extracted to `local-instance.ts` so
   *  `vorlyn serve` can share exactly the same implementation. Overridable in tests via
   *  `localInstanceDeps` rather than this function directly (see below). */
  startLocalInstance: (dataDir: string, io: Io) => Promise<LocalInstance>;
  /** Whether an instance is already running (and, if so, what it is) — the attach/own-mode
   *  decision this file's whole `runOpen` hinges on. */
  liveInstance: (dataDir: string) => Promise<InstanceRecord | undefined>;
  runLink: (options: LinkOptions, io: Io) => Promise<number>;
  runPush: (options: PushOptions, io: Io) => Promise<number>;
  openBrowser: (url: string) => Promise<void>;
  /** Where SIGINT/SIGTERM arrive — same seam as `watch.ts`'s `WatchDeps.signals`. */
  signals: NodeJS.EventEmitter;
  /**
   * Process exit, for the second-Ctrl-C force-quit only — same seam and same
   * reason as `push.ts`'s `PushDeps.exit`: injectable so the force path can be
   * tested without killing the test runner.
   */
  exit: (code: number) => void;
}

const realDeps: OpenDeps = {
  dataDir: resolveDataDir,
  ensureDataDir,
  loadOrCreateLocalConfig,
  startLocalInstance: (dataDir, io) => startLocalInstance(dataDir, io, realLocalInstanceDeps),
  liveInstance: (dataDir) => liveInstance(dataDir, isProcessAlive),
  runLink,
  runPush,
  openBrowser: async (url) => {
    await open(url);
  },
  exit: (code: number) => process.exit(code),
  signals: process,
};

/**
 * `vorlyn open ./folder` — the zero-install local experience: link-if-needed
 * (auto-provisioning a project named after the folder — `packages/cli/src/
 * project-resolution.ts`, via `runLink`'s `autoProvision` option), push the
 * folder's markdown files, open the browser, then block until Ctrl-C.
 *
 * Two modes, decided by whether a usable instance is already up
 * (`deps.liveInstance`):
 *
 * - **attach mode**: skip starting anything — reuse the already-running
 *   instance's ports. Ctrl-C here never tears the instance down; it may be
 *   serving other folders (`vorlyn serve`, or another `vorlyn open`).
 * - **own mode**: today's original behavior — start embedded Postgres, spawn
 *   both children, and tear all of it down on Ctrl-C. This is the only mode
 *   that existed before `vorlyn serve` did.
 *
 * Every expensive real-I/O step is an injected `OpenDeps` field so the
 * orchestration itself — ordering, error handling, cleanup-on-early-failure
 * — is unit-testable with fakes; data-dir creation and config persistence
 * are cheap enough to run for real even in tests and so are not part of the
 * seam.
 */
export async function runOpen(
  options: OpenOptions,
  io: Io,
  deps: OpenDeps = realDeps,
): Promise<number> {
  const dataDir = deps.dataDir();
  await deps.ensureDataDir(dataDir);
  await deps.loadOrCreateLocalConfig(dataDir);

  const existing = await deps.liveInstance(dataDir);

  /**
   * Signal handling has to be live from here — the first moment there is
   * anything to tear down (in own mode) or anything to *not* tear down (in
   * attach mode) — not from the point the instance is fully up. Flag-plus-
   * promise rather than exiting from the handler, same reasoning as
   * `push.ts`: teardown must actually run. `state` is an object property,
   * not a bare `let`, for the TS-narrowing reason documented there.
   */
  const state = { interrupted: false };
  let signalInterrupt: () => void = () => undefined;
  const interrupted = new Promise<void>((resolve) => {
    signalInterrupt = resolve;
  });
  const onSignal = (): void => {
    if (state.interrupted) {
      deps.exit(130);
      return;
    }
    state.interrupted = true;
    signalInterrupt();
  };
  deps.signals.on('SIGINT', onSignal);
  deps.signals.on('SIGTERM', onSignal);
  const wasInterrupted = (): boolean => state.interrupted;

  // Declared here, not inside the `try` below, so the outer `catch` can
  // still reach it — an exception thrown after `startLocalInstance`
  // succeeds but before the function's own explicit cleanup calls (a
  // genuinely unexpected error, e.g. mid-push) must not leak the started
  // Postgres + children.
  let ownedInstance: LocalInstance | undefined;
  async function cleanup(): Promise<void> {
    // Own mode only — attach mode never touches an instance it did not
    // start; other folders (or a `vorlyn serve` daemon) may depend on it.
    if (ownedInstance) await ownedInstance.stop();
  }

  try {
    let rootUrl: string;
    let mcpEndpoint: string;

    if (existing) {
      io.println(
        `Attaching to the already-running local Vorlyn instance (pid ${String(existing.pid)})...`,
      );
      if (!existing.rootUrl || !existing.mcpEndpoint) {
        io.errln('The running instance has no recorded URL — try "vorlyn serve stop" then retry.');
        return 1;
      }
      rootUrl = existing.rootUrl;
      mcpEndpoint = existing.mcpEndpoint;
    } else {
      io.println(`Starting local Vorlyn instance (data: ${dataDir})...`);
      // Raced against the interrupt rather than simply awaited: this is the
      // long pole, so it is where a Ctrl-C is most likely to land, and the
      // whole reason signal handlers are already live by this point (see
      // the comment above). `startLocalInstance` bundles spawning both
      // children and waiting for them into one atomic operation now, so
      // there is no intermediate "spawned but not ready" handle to await a
      // real teardown against the way the pre-`vorlyn serve` version of
      // this file could — if the interrupt wins, whatever
      // `startLocalInstance` eventually produces (or fails with) is torn
      // down / discarded once it settles, without blocking this function's
      // own prompt return.
      const startPromise = deps.startLocalInstance(dataDir, io);
      const raced = await Promise.race([
        startPromise
          .then((instance) => ({ kind: 'ready', instance }) as const)
          .catch((error: unknown) => ({ kind: 'error', error }) as const),
        interrupted.then(() => ({ kind: 'interrupted' }) as const),
      ]);
      if (raced.kind === 'interrupted') {
        startPromise.then((instance) => instance.stop()).catch(() => undefined);
        io.errln('Interrupted before the local instance was ready — shutting down.');
        return 1;
      }
      if (raced.kind === 'error') {
        io.errln(`Could not start the local Vorlyn instance: ${(raced.error as Error).message}`);
        return 1;
      }
      ownedInstance = raced.instance;
      rootUrl = ownedInstance.rootUrl;
      mcpEndpoint = ownedInstance.mcpEndpoint;
    }

    const manifest = await readManifest(options.folder);
    if (!manifest) {
      const existingKey = await resolveApiKey(options.folder);
      // Missing when `existingKey` is already set (e.g. VORLYN_API_KEY set
      // by hand against a non-fresh data dir) is not fatal — fall through to
      // `runLink`'s normal behavior for that folder. `readLocalBootstrapApiKey`
      // (`credentials.ts`) is the same fallback `vorlyn link --autoProvision`
      // now also reaches for on its own against a local endpoint.
      if (!existingKey) {
        const bootstrapKey = await readLocalBootstrapApiKey(dataDir);
        if (!bootstrapKey) {
          io.errln(
            'No admin API key found for this local instance — the embedded server should have minted one on first boot. Try deleting the data directory and running "vorlyn open" again.',
          );
          await cleanup();
          return 1;
        }
        await writeCredentials(options.folder, { apiKey: bootstrapKey });
      }
      // Project resolution — reuse-or-create named after the folder — is
      // `runLink`'s job via `autoProvision`, not this file's (see
      // `packages/cli/src/project-resolution.ts`).
      const linkCode = await deps.runLink(
        { folder: options.folder, endpoint: mcpEndpoint, autoProvision: true, dataDir },
        io,
      );
      if (linkCode !== 0) {
        await cleanup();
        return linkCode;
      }
    } else if (!isLocalEndpoint(manifest.endpoint)) {
      io.errln(
        `${options.folder} is already linked to ${manifest.endpoint}, which is not a local endpoint. ` +
          '"vorlyn open" only works with a local embedded instance — run "vorlyn unlink" here first if you want to relink locally.',
      );
      await cleanup();
      return 1;
    }

    // Best-effort: push failures/conflicts are reported by runPush itself
    // (never suppressed) but don't tear down an otherwise-healthy local
    // instance — the user can re-run "vorlyn push" once they've resolved
    // whatever it flagged.
    await deps.runPush({ folder: options.folder, force: false, concurrency: 3, quiet: false }, io);

    if (wasInterrupted()) {
      io.errln('Interrupted before the local instance was ready — shutting down.');
      await cleanup();
      return 1;
    }

    if (!options.noBrowser) {
      await deps.openBrowser(rootUrl);
    }
    // Attach mode owns no child process (own mode's spawned api/mcp children
    // are themselves what keeps Node's event loop alive while waiting for a
    // signal) — with nothing else pending, `await interrupted` below would
    // otherwise be sitting on a promise the event loop has no other reason
    // to stay open for, and Node exits on its own (a real, reproducible
    // "unsettled top-level await", exit code 13) the instant its microtask
    // queue drains, never actually waiting for Ctrl-C at all. A referenced,
    // otherwise-inert interval holds the loop open exactly as long as
    // needed; cleared the moment there's something to clear it for.
    const keepAlive = ownedInstance ? undefined : setInterval(() => undefined, 1 << 30);
    if (ownedInstance) {
      io.println(`Vorlyn is running at ${rootUrl} — Ctrl-C to stop.`);
    } else {
      io.println(
        `Vorlyn is running at ${rootUrl}. It was already running in the background — Ctrl-C here only stops this command, not the server ("vorlyn serve stop" does that).`,
      );
    }

    try {
      await interrupted;
    } finally {
      clearInterval(keepAlive);
    }

    if (ownedInstance) {
      io.println('Stopping local Vorlyn instance...');
    } else {
      io.println(
        'The local Vorlyn server is still running in the background — "vorlyn serve stop" to stop it.',
      );
    }
    await cleanup();
    return 0;
  } catch (error) {
    io.errln(`vorlyn open failed: ${(error as Error).message}`);
    await cleanup();
    return 1;
  } finally {
    deps.signals.off('SIGINT', onSignal);
    deps.signals.off('SIGTERM', onSignal);
  }
}

export type { LocalInstanceDeps };
