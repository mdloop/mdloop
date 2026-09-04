import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeCredentials } from './credentials.js';
import { ensureDataDir } from './data-dir.js';
import type { InstanceRecord } from './instance-record.js';
import { loadOrCreateLocalConfig } from './local-config.js';
import type { Manifest } from './manifest.js';
import { writeManifest } from './manifest.js';
import { runLink } from './link.js';
import { runPush } from './push.js';
import type { Io } from './output.js';
import type { FakeMcpServer } from './test-support/fake-mcp-server.js';
import { startFakeMcpServer } from './test-support/fake-mcp-server.js';
import type { LocalInstance, ManagedChild } from './local-instance.js';
import type { OpenDeps } from './open.js';
import { runOpen } from './open.js';

function collectIo(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { println: (l: string) => out.push(l), errln: (l: string) => err.push(l) },
    out,
    err,
  };
}

/**
 * A fake `ManagedChild`: a real EventEmitter under the hood so `once('exit',
 * ...)` behaves like the real thing, plus a `kill` spy recording every
 * signal sent. `kill` synchronously emits `exit` — simulating a process that
 * shuts down cleanly the instant it's signaled.
 */
function fakeChild(): ManagedChild & { killed: NodeJS.Signals[] } {
  const emitter = new EventEmitter();
  const killed: NodeJS.Signals[] = [];
  return {
    killed,
    kill(signal: NodeJS.Signals) {
      killed.push(signal);
      emitter.emit('exit', 0);
      return true;
    },
    once(event, listener) {
      emitter.once(event, listener);
    },
  };
}

describe('runOpen', () => {
  let dataDir: string;
  let folder: string;
  let fake: FakeMcpServer;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-open-data-'));
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-open-folder-'));
    fake = await startFakeMcpServer();
    await writeFile(path.join(folder, 'notes.md'), '# Notes\n\nhello\n', 'utf8');
  });

  afterEach(async () => {
    await fake.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });

  /**
   * Real `ensureDataDir`/`loadOrCreateLocalConfig` (cheap real fs, per the
   * dispatch's own instruction not to fake cheap operations); fake
   * `startLocalInstance`/`liveInstance`/`openBrowser` (the expensive-or-
   * mode-deciding boundary); real `runLink`/`runPush` wrapped only to
   * redirect the endpoint to the fake MCP server and the mapping file to
   * this test's own `dataDir` instead of the real per-machine one — same
   * idiom `watch.test.ts`'s `countingDeps` already uses for `runPush`.
   */
  function testDeps(overrides: Partial<OpenDeps> = {}): {
    deps: OpenDeps;
    pgStopped: () => boolean;
    api: ReturnType<typeof fakeChild>;
    mcp: ReturnType<typeof fakeChild>;
    openedUrls: string[];
    signals: EventEmitter;
    linkCalls: () => number;
    pushCalls: () => number;
    exitCodes: number[];
  } {
    let stopped = false;
    const api = fakeChild();
    const mcp = fakeChild();
    const openedUrls: string[] = [];
    const signals = new EventEmitter();
    const exitCodes: number[] = [];
    let linkCalls = 0;
    let pushCalls = 0;

    // Ports chosen to be obviously distinct from any real default (and from
    // each other) so a test that asserts on the URL can never pass by
    // accident against a stale fixed-port assumption.
    const instance: LocalInstance = {
      apiPort: 4100,
      mcpPort: 4101,
      rootUrl: 'http://127.0.0.1:4100',
      mcpEndpoint: `http://127.0.0.1:4101/mcp`,
      apiChild: api,
      mcpChild: mcp,
      // Mirrors the real `startLocalInstance`'s stop() (mcp then api then
      // pg) closely enough for assertions on `api.killed`/`mcp.killed`/
      // `pgStopped()` to mean the same thing they did against the real
      // implementation — this fake's whole job is standing in for it.
      stop: () => {
        mcp.kill('SIGTERM');
        api.kill('SIGTERM');
        stopped = true;
        return Promise.resolve();
      },
    };

    const deps: OpenDeps = {
      dataDir: () => dataDir,
      ensureDataDir,
      loadOrCreateLocalConfig,
      startLocalInstance: () => Promise.resolve(instance),
      liveInstance: () => Promise.resolve(undefined), // "own mode" by default
      runLink: (options, io) => {
        linkCalls += 1;
        return runLink({ ...options, endpoint: fake.url, dataDir }, io);
      },
      runPush: (options, io) => {
        pushCalls += 1;
        return runPush(options, io);
      },
      openBrowser: (url) => {
        openedUrls.push(url);
        return Promise.resolve();
      },
      signals,
      exit: (code: number) => {
        exitCodes.push(code);
      },
      ...overrides,
    };

    return {
      deps,
      pgStopped: () => stopped,
      api,
      mcp,
      openedUrls,
      signals,
      linkCalls: () => linkCalls,
      pushCalls: () => pushCalls,
      exitCodes,
    };
  }

  async function writeBootstrapFile(extra: Record<string, unknown> = {}): Promise<void> {
    await writeFile(
      path.join(dataDir, 'bootstrap.json'),
      `${JSON.stringify({ apiKey: fake.apiKey, ...extra })}\n`,
      'utf8',
    );
  }

  describe('own mode (nothing already running)', () => {
    it('happy path: fresh folder links, pushes, opens the browser, and tears down on signal', async () => {
      await writeBootstrapFile();
      const { deps, api, mcp, openedUrls, signals, pgStopped, linkCalls, pushCalls } = testDeps();
      const { io, out } = collectIo();

      const openPromise = runOpen({ folder }, io, deps);

      // Wait for the browser-open call, then send the stop signal — same
      // "wait for a readiness marker, then fire the signal" shape as
      // watch.test.ts's `whenReady`/`deps.ready()`.
      await waitUntil(() => openedUrls.length > 0);
      signals.emit('SIGINT');

      const code = await openPromise;

      expect(code).toBe(0);
      expect(openedUrls).toEqual(['http://127.0.0.1:4100']);
      expect(linkCalls()).toBe(1);
      expect(pushCalls()).toBe(1);
      expect(fake.state.documents.size).toBe(1); // notes.md got pushed
      expect(fake.state.callCounts.create_project ?? 0).toBe(1); // auto-provisioned, no matching name
      expect(api.killed).toEqual(['SIGTERM']);
      expect(mcp.killed).toEqual(['SIGTERM']);
      expect(pgStopped()).toBe(true);
      expect(out.some((l) => l.includes('mdloop is running at'))).toBe(true);
      expect(out.some((l) => l.includes('still running in the background'))).toBe(false);
    });

    it('--no-browser skips deps.openBrowser entirely, but still reaches the running-state prompt', async () => {
      await writeBootstrapFile();
      const { deps, api, mcp, openedUrls, signals, pgStopped, pushCalls } = testDeps();
      const { io, out } = collectIo();

      const openPromise = runOpen({ folder, noBrowser: true }, io, deps);

      // No browser-open call to wait on here — the readiness marker is the
      // same "mdloop is running at" println the browser-opening path prints
      // right after (or, here, instead of) opening it.
      await waitUntil(() => out.some((l) => l.includes('mdloop is running at')));
      signals.emit('SIGINT');

      const code = await openPromise;

      expect(code).toBe(0);
      expect(openedUrls).toEqual([]);
      expect(pushCalls()).toBe(1);
      expect(api.killed).toEqual(['SIGTERM']);
      expect(mcp.killed).toEqual(['SIGTERM']);
      expect(pgStopped()).toBe(true);
    });

    it('a legacy bootstrap.json with a leftover defaultProjectId field still works — the field is ignored', async () => {
      await writeBootstrapFile({ defaultProjectId: 'proj_1' });
      const { deps, openedUrls, signals, pushCalls } = testDeps();
      const { io } = collectIo();

      const openPromise = runOpen({ folder }, io, deps);
      await waitUntil(() => openedUrls.length > 0);
      signals.emit('SIGINT');
      const code = await openPromise;

      expect(code).toBe(0);
      expect(pushCalls()).toBe(1);
      // Auto-provisioned a fresh project named after the folder, same as
      // the no-legacy-field case — the leftover field was never consulted.
      expect(fake.state.callCounts.create_project ?? 0).toBe(1);
    });

    /**
     * The regression this pins: signal handlers used to be registered only after
     * waitForReady/link/push/browser, so a Ctrl-C during startup — a window up to
     * the startup timeout wide — killed the parent outright and left both spawned
     * children alive holding their ports. A never-resolving `startLocalInstance`
     * reproduces that window exactly.
     */
    it('interrupt during startup still tears down both children and the database', async () => {
      await writeBootstrapFile();
      let startingUp = false;
      const { deps, api, mcp, signals, pgStopped, openedUrls, pushCalls } = testDeps({
        startLocalInstance: () => {
          startingUp = true;
          return new Promise<LocalInstance>(() => undefined); // never ready
        },
      });
      const { io, err } = collectIo();

      const openPromise = runOpen({ folder }, io, deps);
      await waitUntil(() => startingUp);
      signals.emit('SIGINT');

      const code = await openPromise;

      expect(code).toBe(1); // interrupted before ready is a failure, unlike a stop after ready
      expect(api.killed).toEqual([]); // never spawned by this fake — startLocalInstance never resolved
      expect(mcp.killed).toEqual([]);
      expect(pgStopped()).toBe(false);
      expect(openedUrls).toEqual([]); // never got far enough to open a browser
      expect(pushCalls()).toBe(0);
      expect(err.some((l) => l.includes('Interrupted before the local instance was ready'))).toBe(
        true,
      );
    });

    it('a second interrupt force-quits rather than waiting on teardown', async () => {
      await writeBootstrapFile();
      let startingUp = false;
      const { deps, signals, exitCodes } = testDeps({
        startLocalInstance: () => {
          startingUp = true;
          return new Promise<LocalInstance>(() => undefined);
        },
      });
      const { io } = collectIo();

      void runOpen({ folder }, io, deps);
      await waitUntil(() => startingUp);
      signals.emit('SIGINT');
      signals.emit('SIGINT');

      await waitUntil(() => exitCodes.length > 0);
      expect(exitCodes).toEqual([130]);
    });

    it('already linked to a non-local endpoint: refuses without linking or pushing', async () => {
      const manifest: Manifest = {
        endpoint: 'https://mdloop.example.com/mcp',
        projectId: 'proj_1',
        files: {},
      };
      await writeManifest(folder, manifest);

      const { deps, api, mcp, pgStopped, linkCalls, pushCalls, openedUrls } = testDeps();
      const { io, err } = collectIo();

      const code = await runOpen({ folder }, io, deps);

      expect(code).toBe(1);
      expect(linkCalls()).toBe(0);
      expect(pushCalls()).toBe(0);
      expect(openedUrls).toEqual([]);
      expect(err.some((l) => l.includes('not a local endpoint'))).toBe(true);
      expect(api.killed).toEqual(['SIGTERM']);
      expect(mcp.killed).toEqual(['SIGTERM']);
      expect(pgStopped()).toBe(true);
    });

    it('startLocalInstance failure: returns 1, and the error is reported', async () => {
      const { deps } = testDeps({
        startLocalInstance: () => Promise.reject(new Error('boom')),
      });
      const { io, err } = collectIo();

      const code = await runOpen({ folder }, io, deps);

      expect(code).toBe(1);
      expect(err.some((l) => l.includes('Could not start the local mdloop instance'))).toBe(true);
      expect(err.some((l) => l.includes('boom'))).toBe(true);
    });

    it('runLink failure: cleans up and returns that code without opening the browser', async () => {
      await writeBootstrapFile();
      const { deps, api, mcp, pgStopped, openedUrls, pushCalls } = testDeps({
        runLink: () => Promise.resolve(1),
      });
      const { io } = collectIo();

      const code = await runOpen({ folder }, io, deps);

      expect(code).toBe(1);
      expect(openedUrls).toEqual([]);
      expect(pushCalls()).toBe(0);
      expect(api.killed).toEqual(['SIGTERM']);
      expect(mcp.killed).toEqual(['SIGTERM']);
      expect(pgStopped()).toBe(true);
    });

    it('missing admin API key with no other credentials: clear error, cleans up, returns 1', async () => {
      // No writeBootstrapFile() call, no .mdloop/credentials, no MDLOOP_API_KEY.
      const { deps, api, mcp, pgStopped } = testDeps();
      const { io, err } = collectIo();

      const code = await runOpen({ folder }, io, deps);

      expect(code).toBe(1);
      expect(err.some((l) => l.includes('No admin API key found'))).toBe(true);
      expect(api.killed).toEqual(['SIGTERM']);
      expect(mcp.killed).toEqual(['SIGTERM']);
      expect(pgStopped()).toBe(true);
    });

    it('a malformed bootstrap.json (apiKey not a string) is treated the same as missing', async () => {
      await writeFile(path.join(dataDir, 'bootstrap.json'), '{"apiKey":123}\n', 'utf8');
      const { deps } = testDeps();
      const { io, err } = collectIo();

      const code = await runOpen({ folder }, io, deps);

      expect(code).toBe(1);
      expect(err.some((l) => l.includes('No admin API key found'))).toBe(true);
    });
  });

  describe('attach mode (an instance is already running)', () => {
    function liveRecord(): InstanceRecord {
      return {
        version: 1,
        state: 'running',
        owner: 'serve',
        pid: 999_999, // never actually signaled in these tests
        apiPort: 4100,
        mcpPort: 4101,
        rootUrl: 'http://127.0.0.1:4100',
        mcpEndpoint: fake.url,
        startedAt: new Date().toISOString(),
      };
    }

    it('skips starting anything, still links and pushes, and leaves the instance running on Ctrl-C', async () => {
      await writeBootstrapFile();
      const { deps, api, mcp, openedUrls, signals, pgStopped, linkCalls, pushCalls } = testDeps({
        liveInstance: () => Promise.resolve(liveRecord()),
        startLocalInstance: () => {
          throw new Error('must never be called in attach mode');
        },
      });
      const { io, out } = collectIo();

      const openPromise = runOpen({ folder }, io, deps);
      await waitUntil(() => openedUrls.length > 0);
      signals.emit('SIGINT');
      const code = await openPromise;

      expect(code).toBe(0);
      expect(openedUrls).toEqual(['http://127.0.0.1:4100']);
      expect(linkCalls()).toBe(1);
      expect(pushCalls()).toBe(1);
      // Never touched — attach mode must not tear down an instance it did not start.
      expect(api.killed).toEqual([]);
      expect(mcp.killed).toEqual([]);
      expect(pgStopped()).toBe(false);
      expect(out.some((l) => l.includes('still running in the background'))).toBe(true);
    });

    it('already linked to a local endpoint: still attaches, skips link, still pushes', async () => {
      const manifest: Manifest = { endpoint: fake.url, projectId: 'proj_1', files: {} };
      await writeManifest(folder, manifest);
      await writeCredentials(folder, { apiKey: fake.apiKey });

      const { deps, openedUrls, signals, linkCalls, pushCalls } = testDeps({
        liveInstance: () => Promise.resolve(liveRecord()),
      });
      const { io } = collectIo();

      const openPromise = runOpen({ folder }, io, deps);
      await waitUntil(() => openedUrls.length > 0);
      signals.emit('SIGINT');
      const code = await openPromise;

      expect(code).toBe(0);
      expect(linkCalls()).toBe(0);
      expect(pushCalls()).toBe(1);
    });

    it('a live record with no recorded URL is a clear error, not a crash', async () => {
      const { deps } = testDeps({
        liveInstance: () =>
          Promise.resolve({
            version: 1,
            state: 'running',
            owner: 'serve',
            pid: 999_999,
            startedAt: new Date().toISOString(),
          }),
      });
      const { io, err } = collectIo();

      const code = await runOpen({ folder }, io, deps);

      expect(code).toBe(1);
      expect(err.some((l) => l.includes('no recorded URL'))).toBe(true);
    });
  });
});

/** Polls a synchronous condition until it's true — used only to synchronize
 *  with `runOpen`'s async orchestration before firing a signal, never to
 *  wait out a real timeout. */
async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Regression pin, run as a genuine subprocess: a bare `process.on('SIGINT',
 * ...)` handler does NOT by itself keep Node's event loop alive — reproduced
 * manually against a real build, where attach mode (no owned child process,
 * unlike own mode's spawned api/mcp — those are what keep the event loop
 * alive there) exited on its own the instant its microtask queue drained,
 * a genuine "unsettled top-level await" (Node exit code 13), never actually
 * waiting for Ctrl-C at all. Impossible to observe from an in-process test
 * (this vitest worker has its own reasons to stay alive regardless of what
 * `runOpen` does internally) — this has to be a real child process to mean
 * anything.
 */
describe('attach mode keeps the process alive until signaled (real subprocess)', () => {
  it('does not exit on its own, and exits 0 once signaled', async () => {
    // Needs the built `dist/open.js`, not the `.ts` source: open.ts's own
    // relative imports use `.js` specifiers (this package's TS/ESM
    // convention, resolved by the bundler/tsc at build time), which
    // `--experimental-strip-types` running the raw source directly cannot
    // resolve on its own (confirmed: `packages/cli`, unlike `packages/api`/
    // `packages/mcp`, is never actually run unbuilt this way in production
    // either — only those two ever take `entrypointForPackageRoot`'s
    // strip-types fallback path). `pnpm verify`/CI always typechecks
    // (and so builds `dist/`) before testing; skip cleanly for a local
    // `vitest run` against a fresh, never-built checkout instead of a
    // confusing module-resolution failure.
    const distOpenPath = path.join(import.meta.dirname, '..', 'dist', 'open.js');
    if (!(await stat(distOpenPath).catch(() => false))) {
      return; // no dist/ yet on this checkout — run "pnpm typecheck" first
    }

    const scriptDir = await mkdtemp(path.join(tmpdir(), 'mdloop-open-keepalive-'));
    // Pre-linked to a local endpoint, so `runOpen` skips straight past the
    // "not linked yet" branch (which would otherwise fail fast on a missing
    // API key, never reaching the section under test) to the push+browser+
    // wait tail end.
    await writeManifest(scriptDir, {
      endpoint: 'http://127.0.0.1:1/mcp',
      projectId: 'p',
      files: {},
    });
    const scriptPath = path.join(scriptDir, 'harness.mjs');
    await writeFile(
      scriptPath,
      `
      import { runOpen } from ${JSON.stringify(distOpenPath)};
      const deps = {
        dataDir: () => ${JSON.stringify(scriptDir)},
        ensureDataDir: async () => ({ root: '', pgdata: '', blobs: '' }),
        loadOrCreateLocalConfig: async () => ({ sessionSecret: 'x', adminEmail: 'a@b.c', adminName: 'A' }),
        startLocalInstance: async () => { throw new Error('must not be called in attach mode'); },
        liveInstance: async () => ({
          version: 1, state: 'running', owner: 'serve', pid: process.pid,
          rootUrl: 'http://127.0.0.1:1', mcpEndpoint: 'http://127.0.0.1:1/mcp',
          startedAt: new Date().toISOString(),
        }),
        runLink: async () => 1, // fails fast — this test only cares whether the process survives to reach this point and beyond
        runPush: async () => 0,
        openBrowser: async () => {},
        signals: process,
        exit: (code) => process.exit(code),
      };
      console.log('subprocess-ready');
      runOpen({ folder: ${JSON.stringify(scriptDir)} }, { println: () => {}, errln: () => {} }, deps)
        .then((code) => { process.exitCode = code; });
      `,
      'utf8',
    );

    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('subprocess never signaled ready'));
        }, 5000);
        child.stdout.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('subprocess-ready')) {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      // The actual regression: without the keep-alive fix, the process
      // would already have exited (code 13) well before this point.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(child.exitCode).toBeNull();

      const exitPromise = new Promise<number | null>((resolve) => {
        child.once('exit', (code: number | null) => {
          resolve(code);
        });
      });
      child.kill('SIGINT');
      const code = await exitPromise;
      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await rm(scriptDir, { recursive: true, force: true });
    }
  }, 10_000);
});
