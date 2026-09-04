import path from 'node:path';
import type { FSWatcher } from 'chokidar';
import { watch as chokidarWatch } from 'chokidar';
import { readManifest } from './manifest.js';
import type { Io } from './output.js';
import type { PushOptions } from './push.js';
import { runPush } from './push.js';

/**
 * Real chokidar testing against editor-realistic write timing found 15s is
 * the shortest window that collapses autosave bursts, preserves genuinely
 * separate sessions, and doesn't fragment sustained writing with
 * thinking-pauses. 10s only cleared the tested worst case by a 2s margin —
 * don't go lower as a default.
 */
export const DEFAULT_DEBOUNCE_MS = 15_000;

/** Same ignore list as walkMarkdownFiles (walk.ts) — kept local rather than
 *  exported from there since it's a small literal, not shared logic. */
const IGNORED_DIRS = new Set(['node_modules', '.git', '.mdloop']);

function isIgnoredPath(relPath: string): boolean {
  if (relPath === '') return false;
  return relPath.split(path.sep).some((segment) => IGNORED_DIRS.has(segment));
}

export interface WatchOptions {
  folder: string;
  /** Per-file idle window before a settled change triggers a push. */
  debounceMs: number;
  /** Suppresses push.ts's own per-file/summary lines (conflicts/failures still print). */
  quiet?: boolean;
  /** "What changed" note recorded on every version a triggered push creates. */
  note?: string;
}

export interface WatchDeps {
  /** Same signature as push.ts's own `runPush` — the real function is the
   *  default; tests wrap it to count calls while still exercising the real
   *  lock/manifest/upload machinery. */
  runPush: (options: PushOptions, io: Io) => Promise<number>;
  /** Where SIGINT/SIGTERM arrive — injectable so a graceful-shutdown test
   *  doesn't have to emit a real signal into the test runner's process
   *  (same seam as push.ts's own PushDeps.signals). */
  signals: NodeJS.EventEmitter;
  /** Test-only synchronization hook: fires once the chokidar watcher has
   *  finished its initial scan and is ready to observe new writes. Real
   *  callers have no need for it (a no-op default); without it, a test
   *  writing a file immediately after starting the watcher would race
   *  chokidar's initial scan with no deterministic way to know it's safe to
   *  write yet. */
  ready: () => void;
}

const realDeps: WatchDeps = {
  runPush,
  signals: process,
  ready: () => undefined,
};

/**
 * `mdloop watch` — starts a chokidar watcher over `options.folder`'s markdown
 * files and calls the existing `runPush` (push.ts, unmodified) once a
 * changed file settles for `debounceMs` with no further writes to it. This
 * module owns only *when* to push, never the push mechanics: locking,
 * manifest/content-hash comparison, and concurrency are entirely push.ts's
 * (and, transitively, lock.ts's) job, reused as-is.
 *
 * Refuses to start against a folder with no `.mdloop/manifest.json` — the
 * folder must already be linked via `mdloop link`.
 *
 * Debounce is per file (a timer per changed relative path, reset on every
 * new write to that file within the window), but the push it triggers is
 * folder-wide: push.ts's own content-hash short-circuit means files that
 * haven't actually changed cost nothing extra, so there's no need to push
 * only the one file that settled.
 *
 * Runs until `deps.signals` emits SIGINT or SIGTERM, then stops watching,
 * discards any not-yet-settled debounce timers (a pending edit is not
 * flushed early on shutdown — same "let it be re-picked-up next run"
 * posture as push.ts's own interrupt handling), waits for a push already in
 * flight to finish, and resolves 0.
 */
export async function runWatch(
  options: WatchOptions,
  io: Io,
  deps: WatchDeps = realDeps,
): Promise<number> {
  const manifest = await readManifest(options.folder);
  if (!manifest) {
    io.errln(`${options.folder} is not linked. Run "mdloop link" first.`);
    return 1;
  }

  const pushOptions: PushOptions = {
    folder: options.folder,
    force: false,
    concurrency: 3,
    quiet: options.quiet ?? false,
    ...(options.note === undefined ? {} : { note: options.note }),
  };

  const timers = new Map<string, NodeJS.Timeout>();
  // `queued`/`inFlight` coalesce settles that land while a push triggered by
  // an earlier settle is still running: rather than starting a second
  // concurrent push (push.ts's own .lock would just make it wait anyway),
  // one more run is queued and the loop below picks it up once the current
  // run finishes.
  //
  // A boxed object, not two bare `let`s: both are mutated only inside
  // nested closures (setTimeout callbacks, runQueuedPushes), so TS's
  // control-flow analysis can't see the reassignment and narrows every
  // later read in this function to the declaration's initial value — the
  // same "boxed flag, not a bare let" fix push.ts's own interrupt handling
  // already uses, for the same reason.
  const pushState: { queued: boolean; inFlight: Promise<void> | null } = {
    queued: false,
    inFlight: null,
  };

  async function runQueuedPushes(): Promise<void> {
    while (pushState.queued) {
      pushState.queued = false;
      try {
        await deps.runPush(pushOptions, io);
      } catch (error) {
        io.errln(`watch: push failed: ${(error as Error).message}`);
      }
    }
    pushState.inFlight = null;
  }

  function schedulePush(): void {
    pushState.queued = true;
    pushState.inFlight ??= runQueuedPushes();
  }

  function onFsEvent(absPath: string): void {
    if (!absPath.endsWith('.md')) return;
    const relPath = path.relative(options.folder, absPath);
    if (isIgnoredPath(relPath)) return;
    const existing = timers.get(relPath);
    if (existing) clearTimeout(existing);
    timers.set(
      relPath,
      setTimeout(() => {
        timers.delete(relPath);
        schedulePush();
      }, options.debounceMs),
    );
  }

  const watcher: FSWatcher = chokidarWatch(options.folder, {
    ignoreInitial: true,
    ignored: (candidate: string) => isIgnoredPath(path.relative(options.folder, candidate)),
  });
  watcher.on('add', onFsEvent).on('change', onFsEvent);

  await new Promise<void>((resolve) => watcher.on('ready', resolve));
  deps.ready();
  if (!(options.quiet ?? false)) {
    io.println(
      `watching ${options.folder} (debounce ${String(options.debounceMs)}ms) — Ctrl-C to stop`,
    );
  }

  await new Promise<void>((resolve) => {
    const onSignal = (): void => {
      resolve();
    };
    deps.signals.once('SIGINT', onSignal);
    deps.signals.once('SIGTERM', onSignal);
  });

  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  await watcher.close();
  if (pushState.inFlight) await pushState.inFlight;

  return 0;
}
