import { spawn } from 'node:child_process';
import { open as openFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DataDirLayout } from './data-dir.js';
import { ensureDataDir, resolveDataDir } from './data-dir.js';
import {
  acquireInstanceRecord,
  InstanceConflictError,
  liveInstance,
  markInstanceRunning,
  readInstanceRecord,
  releaseInstanceRecord,
} from './instance-record.js';
import type { InstanceRecord } from './instance-record.js';
import type { LocalInstance } from './local-instance.js';
import { realLocalInstanceDeps, startLocalInstance } from './local-instance.js';
import { isProcessAlive } from './process-alive.js';
import type { Io } from './output.js';

const SERVE_START_TIMEOUT_MS = 40_000;
const SERVE_STOP_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 200;
const LOG_TAIL_LINES = 20;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SpawnedSupervisor {
  pid: number;
  unref(): void;
}

export interface ServeDeps {
  dataDir: () => string;
  ensureDataDir: (dataDir: string) => Promise<DataDirLayout>;
  /** Spawns this same CLI as `serve start --foreground`, detached, stdio redirected to `logFd`. */
  spawnSupervisor: (logFd: number, env: NodeJS.ProcessEnv) => SpawnedSupervisor;
  startLocalInstance: (dataDir: string, io: Io) => Promise<LocalInstance>;
  isAlive: (pid: number) => boolean;
  /** Threaded into every `liveInstance()` call so tests can fake the `/readyz` probe instead of
   *  standing up a real HTTP server — same seam `instance-record.ts`'s own `liveInstance` already
   *  exposes as its third parameter, just not previously reachable from here. */
  fetchImpl: typeof fetch;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Where SIGINT/SIGTERM arrive in `--foreground` (the supervisor body) — same seam as `open.ts`. */
  signals: NodeJS.EventEmitter;
  exit: (code: number) => void;
  /**
   * Threaded through so `runServeStart`'s poll loop (below) is fakeable —
   * that loop calls this every `POLL_INTERVAL_MS` (200ms) for up to
   * `SERVE_START_TIMEOUT_MS` (40s), ~200 real filesystem reads per run
   * when unfaked. A test exercising the full timeout with `vi
   * .useFakeTimers()` has no reason to pay for 200 real syscalls — the
   * fake-clock advance is instant, but each real read still costs whatever
   * the actual filesystem costs, and that compounded reliably past this
   * test's real-wall-clock budget on a slower CI runner while never
   * reproducing locally, where the same reads are fast. Was a direct
   * `readInstanceRecord` import with no seam to fake at all.
   */
  readInstanceRecord: (dataDir: string) => Promise<InstanceRecord | undefined>;
}

/**
 * This file's own compiled/source location — mirrors `local-instance.ts`'s
 * `entrypointForPackageRoot` dist-vs-src decision, but for the CLI's own
 * entrypoint rather than `@vorlyn/api`'s or `@vorlyn/mcp`'s: `vorlyn
 * serve start` needs to re-invoke *itself*, detached, as `serve start
 * --foreground`. `dist/serve.js` sits next to `dist/main.js` once built;
 * unbuilt, this file is `src/serve.ts` and `main.ts` is its sibling in
 * `src/`. Takes `thisFile` as a parameter (defaulting to this module's own
 * `import.meta.url`) purely so it's unit-testable against a throwaway path
 * rather than this repo's own real build output.
 */
export function resolveSelfEntrypoint(thisFile: string = fileURLToPath(import.meta.url)): {
  command: string;
  args: string[];
} {
  const dir = path.dirname(thisFile);
  if (thisFile.endsWith('.js')) {
    return { command: process.execPath, args: [path.join(dir, 'main.js')] };
  }
  return {
    command: process.execPath,
    args: ['--experimental-strip-types', path.join(dir, 'main.ts')],
  };
}

function realSpawnSupervisor(logFd: number, env: NodeJS.ProcessEnv): SpawnedSupervisor {
  const { command, args } = resolveSelfEntrypoint();
  const child = spawn(command, [...args, 'serve', 'start', '--foreground'], {
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  return {
    pid: child.pid ?? -1,
    unref: () => {
      child.unref();
    },
  };
}

export const realServeDeps: ServeDeps = {
  dataDir: resolveDataDir,
  ensureDataDir,
  spawnSupervisor: realSpawnSupervisor,
  startLocalInstance: (dataDir, io) => startLocalInstance(dataDir, io, realLocalInstanceDeps),
  isAlive: isProcessAlive,
  fetchImpl: fetch,
  // ESRCH — no such process — is a real, expected outcome here, not a
  // failure: every call site races against a process that may have already
  // exited on its own (the timeout path below, or a supervisor that failed
  // and exited before this ever fires). `isProcessAlive`/`lock.ts` already
  // treat ESRCH as "already gone" rather than an error; this must too, or
  // an already-exited target crashes the caller with an uncaught exception
  // instead of the no-op it actually is.
  kill: (pid, signal) => {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  },
  exit: (code) => process.exit(code),
  signals: process,
  readInstanceRecord,
};

async function tailLog(logFile: string): Promise<string[]> {
  try {
    const raw = await readFile(logFile, 'utf8');
    return raw.split('\n').filter(Boolean).slice(-LOG_TAIL_LINES);
  } catch {
    return [];
  }
}

/**
 * `vorlyn serve start` — the launcher half. Idempotent (returns promptly
 * either way): if a usable instance is already running, says so and
 * returns; otherwise spawns the supervisor (`--foreground`, below) detached
 * and waits for it to report `running` in `<dataDir>/instance.json` before
 * returning, so a caller (a human, or `vorlyn-ensure.sh`) never has to
 * poll separately.
 */
async function runServeStart(io: Io, deps: ServeDeps): Promise<number> {
  const dataDir = deps.dataDir();
  await deps.ensureDataDir(dataDir);

  const existing = await liveInstance(dataDir, deps.isAlive, deps.fetchImpl);
  if (existing) {
    io.println(
      `Vorlyn is already running at ${existing.rootUrl ?? '(unknown)'} (pid ${String(existing.pid)}).`,
    );
    return 0;
  }

  const logFile = path.join(dataDir, 'serve.log');
  const fd = await openFile(logFile, 'a');
  let supervisor: SpawnedSupervisor;
  try {
    supervisor = deps.spawnSupervisor(fd.fd, { ...process.env, VORLYN_DATA_DIR: dataDir });
  } finally {
    await fd.close();
  }

  const deadline = Date.now() + SERVE_START_TIMEOUT_MS;
  let record: InstanceRecord | undefined;
  let supervisorDied = false;
  while (Date.now() < deadline) {
    record = await deps.readInstanceRecord(dataDir);
    if (record?.state === 'running') break;
    // A dead supervisor will never reach `running` — most commonly a fixed
    // default port (DEFAULT_API_PORT/DEFAULT_MCP_PORT, or an override) was
    // already taken, which `startLocalInstance`'s own early-exit race
    // already makes the supervisor fail fast on and log clearly (see
    // `local-instance.ts`). Checking here is what lets that fast failure
    // actually reach this command promptly instead of still sitting out
    // the full timeout below, polling a state file a dead process can
    // never update.
    if (!deps.isAlive(supervisor.pid)) {
      supervisorDied = true;
      break;
    }
    await delay(POLL_INTERVAL_MS);
  }

  if (record?.state !== 'running') {
    deps.kill(supervisor.pid, 'SIGTERM');
    await releaseInstanceRecord(dataDir);
    io.errln(
      supervisorDied
        ? 'The Vorlyn server process exited before it finished starting.'
        : 'Timed out waiting for the local Vorlyn server to start.',
    );
    for (const line of await tailLog(logFile)) io.errln(`  ${line}`);
    return 1;
  }

  io.println(
    `Vorlyn is running at ${record.rootUrl ?? '(unknown)'} (pid ${String(record.pid)}). ` +
      `Logs: ${logFile}. Stop it with "vorlyn serve stop".`,
  );
  return 0;
}

/**
 * The supervisor body — what actually runs detached, as `serve start
 * --foreground`. Also directly usable in a terminal for debugging (logs
 * inline, Ctrl-C stops it) rather than being a hidden implementation detail
 * reachable only via the launcher above.
 */
async function runServeForeground(io: Io, deps: ServeDeps): Promise<number> {
  const dataDir = deps.dataDir();
  await deps.ensureDataDir(dataDir);

  let record: InstanceRecord;
  try {
    record = await acquireInstanceRecord(
      dataDir,
      { owner: 'serve', pid: process.pid },
      deps.isAlive,
    );
  } catch (error) {
    if (error instanceof InstanceConflictError) {
      io.println(`Vorlyn is already running (pid ${String(error.existing.pid)}).`);
      return 0;
    }
    throw error;
  }

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

  try {
    const instance = await deps.startLocalInstance(dataDir, io);
    record = await markInstanceRunning(dataDir, record, {
      apiPort: instance.apiPort,
      mcpPort: instance.mcpPort,
      rootUrl: instance.rootUrl,
      mcpEndpoint: instance.mcpEndpoint,
    });
    io.println(`vorlyn serve: running at ${instance.rootUrl} (pid ${String(process.pid)}).`);

    await interrupted;

    io.println('vorlyn serve: stopping...');
    await instance.stop();
    await releaseInstanceRecord(dataDir, record);
    return 0;
  } catch (error) {
    await releaseInstanceRecord(dataDir, record);
    io.errln(`vorlyn serve failed: ${(error as Error).message}`);
    // Force-exit rather than letting the event loop drain naturally: a
    // failed startup (most commonly a port collision) can leave something
    // — an OTel export timer, a not-fully-released embedded-Postgres
    // handle — still holding the loop open, and this process (detached,
    // stdio to a log file) has no legitimate further work once it's
    // decided to stop. Same seam and reasoning as the double-SIGINT force
    // quit above; `io.errln` above is synchronous, so nothing is lost by
    // exiting immediately after it.
    deps.exit(1);
    return 1;
  } finally {
    deps.signals.off('SIGINT', onSignal);
    deps.signals.off('SIGTERM', onSignal);
  }
}

/**
 * `vorlyn serve stop`. Idempotent when nothing is running. Refuses to stop
 * a `vorlyn open` foreground session from here — SIGTERM would work (its
 * own handler tears down cleanly), but silently killing someone's foreground
 * terminal session from a different one is the wrong default; tell them to
 * Ctrl-C it instead.
 */
async function runServeStop(io: Io, deps: ServeDeps): Promise<number> {
  const dataDir = deps.dataDir();
  const record = await deps.readInstanceRecord(dataDir);
  if (!record || !deps.isAlive(record.pid)) {
    io.println('The local Vorlyn server is not running.');
    return 0;
  }
  if (record.owner === 'open') {
    io.errln(
      `That instance is a foreground "vorlyn open" session (pid ${String(record.pid)}) — press Ctrl-C in the terminal running it.`,
    );
    return 1;
  }

  deps.kill(record.pid, 'SIGTERM');
  const deadline = Date.now() + SERVE_STOP_TIMEOUT_MS;
  while (Date.now() < deadline && deps.isAlive(record.pid)) {
    await delay(POLL_INTERVAL_MS);
  }
  if (deps.isAlive(record.pid)) {
    // Process GROUP kill (negative pid) — `detached: true` at spawn time
    // made the supervisor a group leader, and its own api/mcp children are
    // in that same group. Killing the leader alone would orphan them,
    // still holding their ports.
    deps.kill(-record.pid, 'SIGKILL');
  }
  await releaseInstanceRecord(dataDir);
  io.println('Stopped.');
  return 0;
}

/** `vorlyn serve status`. Exit 0 running / 1 not — `systemctl is-active` shaped, deliberately: it's
 *  what makes `vorlyn serve status || vorlyn serve start` a correct one-liner for a hook to use. */
async function runServeStatus(io: Io, deps: ServeDeps, json: boolean): Promise<number> {
  const dataDir = deps.dataDir();
  const record = await liveInstance(dataDir, deps.isAlive, deps.fetchImpl);
  if (!record) {
    if (json) io.println(JSON.stringify({ running: false }));
    else io.println('Not running.');
    return 1;
  }
  if (json) {
    io.println(JSON.stringify({ running: true, ...record }));
    return 0;
  }
  const uptimeMs = Date.now() - new Date(record.startedAt).getTime();
  io.println(
    [
      `Running at ${record.rootUrl ?? '(unknown)'} (pid ${String(record.pid)}, owner ${record.owner})`,
      `MCP endpoint: ${record.mcpEndpoint ?? '(unknown)'}`,
      `Data directory: ${dataDir}`,
      `Uptime: ${String(Math.max(0, Math.round(uptimeMs / 1000)))}s`,
      ...(record.logFile ? [`Log file: ${record.logFile}`] : []),
    ].join('\n'),
  );
  return 0;
}

export interface ServeOptions {
  foreground?: boolean;
  json?: boolean;
}

/** `vorlyn serve start|stop|status [--foreground] [--json]` — dispatched from `cli.ts`. */
export async function runServe(
  subcommand: string | undefined,
  options: ServeOptions,
  io: Io,
  deps: ServeDeps = realServeDeps,
): Promise<number> {
  switch (subcommand) {
    case 'start':
      return options.foreground ? runServeForeground(io, deps) : runServeStart(io, deps);
    case 'stop':
      return runServeStop(io, deps);
    case 'status':
      return runServeStatus(io, deps, options.json ?? false);
    default:
      io.errln(
        `Unknown "vorlyn serve" subcommand: ${subcommand ?? '(none)'}. Use start, stop, or status.`,
      );
      return 1;
  }
}
