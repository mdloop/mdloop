import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDataDir } from './data-dir.js';
import {
  acquireInstanceRecord,
  markInstanceRunning,
  readInstanceRecord,
} from './instance-record.js';
import type { LocalInstance, ManagedChild } from './local-instance.js';
import type { Io } from './output.js';
import type { ServeDeps, SpawnedSupervisor } from './serve.js';
import { realServeDeps, resolveSelfEntrypoint, runServe } from './serve.js';

function collectIo(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { println: (l: string) => out.push(l), errln: (l: string) => err.push(l) },
    out,
    err,
  };
}

/** Same fake-`ManagedChild` shape `open.test.ts` uses: a real EventEmitter so `once('exit', ...)`
 *  behaves like the real thing, `kill` synchronously emitting `exit`. */
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

function fakeLocalInstance(overrides: Partial<LocalInstance> = {}): {
  instance: LocalInstance;
  stopCalls: () => number;
} {
  let stopCalls = 0;
  const instance: LocalInstance = {
    apiPort: 4000,
    mcpPort: 4001,
    rootUrl: 'http://127.0.0.1:4000',
    mcpEndpoint: 'http://127.0.0.1:4001/mcp',
    apiChild: fakeChild(),
    mcpChild: fakeChild(),
    stop: () => {
      stopCalls += 1;
      return Promise.resolve();
    },
    ...overrides,
  };
  return { instance, stopCalls: () => stopCalls };
}

describe('serve', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'vorlyn-cli-serve-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  /**
   * `dataDir`/`ensureDataDir` real (cheap fs, per this package's convention);
   * `spawnSupervisor`/`startLocalInstance`/`isAlive`/`kill` faked — the
   * expensive real-process/real-time boundary. `kill` flips `aliveSet`
   * itself so the SIGTERM/SIGKILL poll loops in `runServeStop`/
   * `runServeStart` resolve without waiting out the real 40s/15s timeouts.
   */
  function testDeps(overrides: Partial<ServeDeps> = {}): {
    deps: ServeDeps;
    spawnSupervisorCalls: { logFd: number; env: NodeJS.ProcessEnv }[];
    killCalls: { pid: number; signal: NodeJS.Signals }[];
    aliveSet: Set<number>;
    signals: EventEmitter;
    exitCodes: number[];
    setReadyzOk: (ok: boolean) => void;
  } {
    const spawnSupervisorCalls: { logFd: number; env: NodeJS.ProcessEnv }[] = [];
    const killCalls: { pid: number; signal: NodeJS.Signals }[] = [];
    const aliveSet = new Set<number>();
    const signals = new EventEmitter();
    const exitCodes: number[] = [];
    let nextPid = 90000;
    const { instance: defaultInstance } = fakeLocalInstance();
    // No real HTTP server: `liveInstance`'s `/readyz` probe is faked directly
    // via the injectable `fetchImpl`, so "already running" is exercisable
    // without standing up a socket (and without the cross-test fake-timer
    // interference a real `fetch`'s kept-alive connection caused when this
    // was tried).
    let readyzOk = true;

    const deps: ServeDeps = {
      dataDir: () => dataDir,
      ensureDataDir,
      spawnSupervisor: (logFd, env): SpawnedSupervisor => {
        spawnSupervisorCalls.push({ logFd, env });
        const pid = nextPid;
        nextPid += 1;
        // A just-spawned real process is alive until it actually exits —
        // mirrored here so `runServeStart`'s `deps.isAlive(supervisor.pid)`
        // early-exit check (see below) reads as "still starting", not
        // "already dead", unless a test explicitly removes it from
        // `aliveSet` to simulate a crash.
        aliveSet.add(pid);
        return { pid, unref: () => undefined };
      },
      startLocalInstance: () => Promise.resolve(defaultInstance),
      isAlive: (pid) => aliveSet.has(pid),
      fetchImpl: () => Promise.resolve({ ok: readyzOk }) as Promise<Response>,
      kill: (pid, signal) => {
        killCalls.push({ pid, signal });
        if (signal === 'SIGTERM' || signal === 'SIGKILL') aliveSet.delete(pid >= 0 ? pid : -pid);
      },
      signals,
      exit: (code) => {
        exitCodes.push(code);
      },
      // Delegates to the real function by default, so every test that
      // writes a real record via `acquireInstanceRecord`/
      // `markInstanceRunning` and expects `runServeStart`/`runServeStop` to
      // read it back keeps working unchanged — only the one test that
      // exercises the full poll-to-timeout path overrides this, to remove
      // ~200 real filesystem reads (`SERVE_START_TIMEOUT_MS /
      // POLL_INTERVAL_MS`) from what is otherwise a pure fake-timer test.
      readInstanceRecord: (d) => readInstanceRecord(d),
      ...overrides,
    };

    return {
      deps,
      spawnSupervisorCalls,
      killCalls,
      aliveSet,
      signals,
      exitCodes,
      setReadyzOk: (ok) => {
        readyzOk = ok;
      },
    };
  }

  async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('condition never became true');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /**
   * Drives `vi`'s fake clock forward in small steps rather than one single
   * jump. `runServeStart`/`runServeStop`'s poll loops interleave real fs
   * calls (real microtask ticks, unaffected by the fake clock) between each
   * `setTimeout`-based `delay()` — a single large `advanceTimersByTimeAsync`
   * call exhausts the currently-registered timer queue and returns before
   * that real work has had a chance to register the *next* one, leaving the
   * loop's later `delay()` waiting on a clock that never advances again.
   * Stepping in small increments gives each of those real hops a turn
   * between advances.
   */
  async function advanceFakeTimers(totalMs: number, stepMs = 100): Promise<void> {
    for (let advanced = 0; advanced < totalMs; advanced += stepMs) {
      await vi.advanceTimersByTimeAsync(stepMs);
    }
  }

  describe('runServe("start") — launcher', () => {
    it('nothing running: spawns the supervisor and returns once polling observes a running record', async () => {
      const { deps, spawnSupervisorCalls } = testDeps();
      const { io, out } = collectIo();

      // Simulate the detached supervisor's own progress: a short *real*
      // delay, then write the record straight to `running` via the real
      // instance-record functions, proving the launcher's poll loop itself
      // (not just the immediate already-running path) picks it up. Fully
      // awaited alongside the launcher itself (via Promise.all) so this
      // background work never outlives the test — an un-awaited real timer
      // left dangling here would still be pending when the *next* test
      // installs fake timers, corrupting its clock.
      const writeRunningShortly = (async (): Promise<void> => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const record = await acquireInstanceRecord(dataDir, { owner: 'serve', pid: 55555 });
        await markInstanceRunning(dataDir, record, {
          apiPort: 4000,
          mcpPort: 4001,
          rootUrl: 'http://127.0.0.1:4000',
          mcpEndpoint: 'http://127.0.0.1:4001/mcp',
        });
      })();

      const [code] = await Promise.all([runServe('start', {}, io, deps), writeRunningShortly]);

      expect(code).toBe(0);
      expect(spawnSupervisorCalls).toHaveLength(1);
      expect(out.some((l) => l.includes('http://127.0.0.1:4000'))).toBe(true);
    });

    // "Already running" for the launcher (`runServeStart`'s own idempotency
    // check, distinct from the foreground/supervisor "already running" test
    // below) goes through `liveInstance(dataDir, deps.isAlive, deps.fetchImpl)`
    // — exercisable here via the injectable `fetchImpl` (`setReadyzOk`)
    // rather than a real HTTP server, which previously caused a reproducible
    // cross-test hang: undici's global `fetch` keeps its socket open for
    // reuse, and closing a real server in `afterEach` while a *later* test
    // has `vi.useFakeTimers()` installed (the timeout test right below) left
    // that later test's `setTimeout`-based poll loop never observed as
    // advancing, hanging until the suite's timeout.
    it('already running: does not spawn a supervisor, reports the existing url, returns 0', async () => {
      const { deps, aliveSet, spawnSupervisorCalls } = testDeps();
      const record = await acquireInstanceRecord(dataDir, { owner: 'serve', pid: 55555 });
      await markInstanceRunning(dataDir, record, {
        apiPort: 4000,
        mcpPort: 4001,
        rootUrl: 'http://127.0.0.1:4000',
        mcpEndpoint: 'http://127.0.0.1:4001/mcp',
      });
      aliveSet.add(55555);
      const { io, out } = collectIo();

      const code = await runServe('start', {}, io, deps);

      expect(code).toBe(0);
      expect(spawnSupervisorCalls).toHaveLength(0);
      expect(
        out.some((l) => l.includes('already running') && l.includes('http://127.0.0.1:4000')),
      ).toBe(true);
    });

    it('times out waiting for the supervisor to report running', async () => {
      vi.useFakeTimers();
      // `ensureDataDir` faked here (unlike this file's usual real one) so
      // nothing between `vi.useFakeTimers()` and the poll loop below needs a
      // real fs round trip to resolve — `runServeStart`'s only other real-fs
      // step first (opening the log file) is a single fast open on an
      // already-real `dataDir`, not a multi-syscall `mkdir -p`, so it does
      // not carry the same risk of losing a race against the fake clock's
      // very first advance.
      //
      // `readInstanceRecord` is *also* faked, unlike this file's usual real
      // one — it's called every `POLL_INTERVAL_MS` inside the loop this
      // test drives to its full timeout, ~200 real reads of a file that
      // never gets written in this test (the fake `spawnSupervisor` never
      // marks anything running, so the real read would always resolve
      // `undefined` anyway). Reproducibly added enough real time on a
      // GitHub Actions runner to blow through this test's real-wall-clock
      // budget at both 30s and 60s, while never reproducing locally — see
      // `ServeDeps.readInstanceRecord`'s doc comment in serve.ts.
      const { deps, killCalls } = testDeps({
        ensureDataDir: () =>
          Promise.resolve({
            root: dataDir,
            pgdata: path.join(dataDir, 'pgdata'),
            blobs: path.join(dataDir, 'blobs'),
          }),
        readInstanceRecord: () => Promise.resolve(undefined),
      });
      const { io, err } = collectIo();

      const startPromise = runServe('start', {}, io, deps);
      await advanceFakeTimers(41_000);
      const code = await startPromise;

      expect(code).toBe(1);
      expect(err.some((l) => l.includes('Timed out waiting'))).toBe(true);
      expect(killCalls.some((c) => c.signal === 'SIGTERM')).toBe(true);
      expect(await readInstanceRecord(dataDir)).toBeUndefined();
    }, 30_000);

    it('the supervisor dying before it reports running fails fast, not after the full timeout', async () => {
      // Never added to `aliveSet` (unlike the default fake's spawnSupervisor
      // above) — models a supervisor that crashed immediately, e.g. its
      // DEFAULT_API_PORT/DEFAULT_MCP_PORT (or an override) already taken by
      // something else. `local-instance.ts`'s own early-exit race already
      // makes that failure fast and clearly logged at the supervisor level;
      // this is what makes that reach the launcher promptly too, instead of
      // it still polling a state file the dead process can never update.
      const { deps, killCalls } = testDeps({
        spawnSupervisor: (): SpawnedSupervisor => ({ pid: 12_345, unref: () => undefined }),
      });
      const { io, err } = collectIo();

      const code = await runServe('start', {}, io, deps);

      expect(code).toBe(1);
      expect(err.some((l) => l.includes('exited before it finished starting'))).toBe(true);
      expect(killCalls.some((c) => c.signal === 'SIGTERM')).toBe(true);
      expect(await readInstanceRecord(dataDir)).toBeUndefined();
    });
  });

  describe('runServe("start", {foreground: true}) — supervisor body', () => {
    it('acquires the record, starts the instance, marks it running, then stops cleanly on SIGINT', async () => {
      const { instance, stopCalls } = fakeLocalInstance();
      const { deps, signals } = testDeps({ startLocalInstance: () => Promise.resolve(instance) });
      const { io, out } = collectIo();

      const runPromise = runServe('start', { foreground: true }, io, deps);
      await waitUntil(() => out.some((l) => l.includes('running at')));
      signals.emit('SIGINT');
      const code = await runPromise;

      expect(code).toBe(0);
      expect(stopCalls()).toBe(1);
      expect(await readInstanceRecord(dataDir)).toBeUndefined();
    });

    it('a second SIGINT force-quits before teardown completes', async () => {
      const instance = fakeLocalInstance({
        stop: () => new Promise<void>(() => undefined),
      }).instance;
      const { deps, signals, exitCodes } = testDeps({
        startLocalInstance: () => Promise.resolve(instance),
      });
      const { io, out } = collectIo();

      void runServe('start', { foreground: true }, io, deps);
      await waitUntil(() => out.some((l) => l.includes('running at')));
      signals.emit('SIGINT');
      await waitUntil(() => out.some((l) => l.includes('stopping')));
      signals.emit('SIGINT');

      await waitUntil(() => exitCodes.length > 0);
      expect(exitCodes).toEqual([130]);
    });

    it('startLocalInstance rejecting releases the record, prints the error, returns 1', async () => {
      const { deps, exitCodes } = testDeps({
        startLocalInstance: () => Promise.reject(new Error('boom')),
      });
      const { io, err } = collectIo();

      const code = await runServe('start', { foreground: true }, io, deps);

      expect(code).toBe(1);
      expect(err.some((l) => l.includes('vorlyn serve failed') && l.includes('boom'))).toBe(true);
      expect(await readInstanceRecord(dataDir)).toBeUndefined();
      // Force-exits rather than relying on the event loop draining on its
      // own — see the matching comment in serve.ts. A fake `exit` here is
      // just a spy, so the test still observes the natural `return 1`
      // afterward; the real `process.exit(1)` a live process calls would
      // not.
      expect(exitCodes).toEqual([1]);
    });

    it('already running (a live record already holds the file): prints "already running", returns 0, never starts an instance', async () => {
      await acquireInstanceRecord(dataDir, { owner: 'serve', pid: 424242 });
      let started = false;
      const { deps, aliveSet } = testDeps({
        startLocalInstance: () => {
          started = true;
          return Promise.resolve(fakeLocalInstance().instance);
        },
      });
      aliveSet.add(424242);
      const { io, out } = collectIo();

      const code = await runServe('start', { foreground: true }, io, deps);

      expect(code).toBe(0);
      expect(started).toBe(false);
      expect(out.some((l) => l.includes('already running'))).toBe(true);
    });
  });

  describe('runServe("stop")', () => {
    it('no record at all: "not running", returns 0', async () => {
      const { deps } = testDeps();
      const { io, out } = collectIo();

      const code = await runServe('stop', {}, io, deps);

      expect(code).toBe(0);
      expect(out.some((l) => l.includes('is not running'))).toBe(true);
    });

    it('record present but owner "open": refuses naming the pid, returns 1, never calls kill', async () => {
      const { deps, killCalls, aliveSet } = testDeps();
      await acquireInstanceRecord(dataDir, { owner: 'open', pid: 5555 });
      aliveSet.add(5555);
      const { io, err } = collectIo();

      const code = await runServe('stop', {}, io, deps);

      expect(code).toBe(1);
      expect(err.some((l) => l.includes('5555'))).toBe(true);
      expect(killCalls).toHaveLength(0);
    });

    it('record present, owner "serve", dies promptly after SIGTERM: "Stopped.", returns 0, record gone', async () => {
      const { deps, aliveSet } = testDeps();
      await acquireInstanceRecord(dataDir, { owner: 'serve', pid: 6666 });
      aliveSet.add(6666);
      const { io, out } = collectIo();

      const code = await runServe('stop', {}, io, deps);

      expect(code).toBe(0);
      expect(out).toContain('Stopped.');
      expect(await readInstanceRecord(dataDir)).toBeUndefined();
    });

    it('record present, owner "serve", does not die after SIGTERM: escalates to SIGKILL on the negative pid, then "Stopped."', async () => {
      vi.useFakeTimers();
      const killCalls: { pid: number; signal: NodeJS.Signals }[] = [];
      const aliveSet = new Set<number>([7777]);
      const { deps } = testDeps({
        isAlive: (pid) => aliveSet.has(pid),
        kill: (pid, signal) => {
          killCalls.push({ pid, signal });
          // SIGTERM deliberately does nothing here — only SIGKILL clears it.
          if (signal === 'SIGKILL') aliveSet.delete(pid >= 0 ? pid : -pid);
        },
      });
      await acquireInstanceRecord(dataDir, { owner: 'serve', pid: 7777 });
      const { io, out } = collectIo();

      const stopPromise = runServe('stop', {}, io, deps);
      await advanceFakeTimers(16_000);
      const code = await stopPromise;

      expect(code).toBe(0);
      expect(killCalls[0]).toEqual({ pid: 7777, signal: 'SIGTERM' });
      expect(killCalls.some((c) => c.pid === -7777 && c.signal === 'SIGKILL')).toBe(true);
      expect(out).toContain('Stopped.');
    }, 30_000);

    it('stopping twice in a row is idempotent', async () => {
      const { deps, aliveSet } = testDeps();
      await acquireInstanceRecord(dataDir, { owner: 'serve', pid: 8888 });
      aliveSet.add(8888);
      const { io: io1, out: out1 } = collectIo();
      const { io: io2, out: out2 } = collectIo();

      const first = await runServe('stop', {}, io1, deps);
      const second = await runServe('stop', {}, io2, deps);

      expect(first).toBe(0);
      expect(out1).toContain('Stopped.');
      expect(second).toBe(0);
      expect(out2.some((l) => l.includes('is not running'))).toBe(true);
    });
  });

  describe('runServe("status")', () => {
    it('not running: "Not running.", exit 1', async () => {
      const { deps } = testDeps();
      const { io, out } = collectIo();

      const code = await runServe('status', {}, io, deps);

      expect(code).toBe(1);
      expect(out).toContain('Not running.');
    });

    it('not running, json: {running:false}, exit 1', async () => {
      const { deps } = testDeps();
      const { io, out } = collectIo();

      const code = await runServe('status', { json: true }, io, deps);

      expect(code).toBe(1);
      expect(JSON.parse(out[0] ?? '{}')).toEqual({ running: false });
    });

    it('running: prints pid/owner/urls/uptime, exit 0', async () => {
      const { deps, aliveSet } = testDeps();
      const record = await acquireInstanceRecord(dataDir, { owner: 'serve', pid: 55555 });
      await markInstanceRunning(dataDir, record, {
        apiPort: 4000,
        mcpPort: 4001,
        rootUrl: 'http://127.0.0.1:4000',
        mcpEndpoint: 'http://127.0.0.1:4001/mcp',
      });
      aliveSet.add(55555);
      const { io, out } = collectIo();

      const code = await runServe('status', {}, io, deps);

      expect(code).toBe(0);
      const text = out.join('\n');
      expect(text).toMatch(/Running at http:\/\/127\.0\.0\.1:4000 \(pid 55555, owner serve\)/);
      expect(text).toMatch(/MCP endpoint: http:\/\/127\.0\.0\.1:4001\/mcp/);
      expect(text).toMatch(/Data directory: /);
      expect(text).toMatch(/Uptime: \d+s/);
    });

    it('running, json: {running:true, ...record}, exit 0', async () => {
      const { deps, aliveSet } = testDeps();
      const record = await acquireInstanceRecord(dataDir, { owner: 'serve', pid: 55555 });
      await markInstanceRunning(dataDir, record, {
        apiPort: 4000,
        mcpPort: 4001,
        rootUrl: 'http://127.0.0.1:4000',
        mcpEndpoint: 'http://127.0.0.1:4001/mcp',
      });
      aliveSet.add(55555);
      const { io, out } = collectIo();

      const code = await runServe('status', { json: true }, io, deps);

      expect(code).toBe(0);
      const parsed = JSON.parse(out[0] ?? '{}') as { running: boolean; pid: number; owner: string };
      expect(parsed.running).toBe(true);
      expect(parsed.pid).toBe(55555);
      expect(parsed.owner).toBe('serve');
    });

    it('a dead pid (crashed without cleanup) counts as not running, even with a stale record on disk', async () => {
      const { deps } = testDeps(); // aliveSet stays empty — pid 55555 is "dead"
      const record = await acquireInstanceRecord(dataDir, { owner: 'serve', pid: 55555 });
      await markInstanceRunning(dataDir, record, {
        apiPort: 4000,
        mcpPort: 4001,
        rootUrl: 'http://127.0.0.1:4000',
        mcpEndpoint: 'http://127.0.0.1:4001/mcp',
      });
      const { io, out } = collectIo();

      const code = await runServe('status', {}, io, deps);

      expect(code).toBe(1);
      expect(out).toContain('Not running.');
    });

    it('a live pid whose /readyz does not answer ok counts as not running', async () => {
      const { deps, aliveSet, setReadyzOk } = testDeps();
      setReadyzOk(false);
      const record = await acquireInstanceRecord(dataDir, { owner: 'serve', pid: 55555 });
      await markInstanceRunning(dataDir, record, {
        apiPort: 4000,
        mcpPort: 4001,
        rootUrl: 'http://127.0.0.1:4000',
        mcpEndpoint: 'http://127.0.0.1:4001/mcp',
      });
      aliveSet.add(55555);
      const { io, out } = collectIo();

      const code = await runServe('status', {}, io, deps);

      expect(code).toBe(1);
      expect(out).toContain('Not running.');
    });
  });
});

describe('resolveSelfEntrypoint', () => {
  it('a .js file: resolves to its main.js sibling with no extra flag', () => {
    const result = resolveSelfEntrypoint('/pkg/dist/serve.js');

    expect(result).toEqual({
      command: process.execPath,
      args: [path.join('/pkg/dist', 'main.js')],
    });
  });

  it('a .ts file: resolves to its main.ts sibling with --experimental-strip-types', () => {
    const result = resolveSelfEntrypoint('/pkg/src/serve.ts');

    expect(result).toEqual({
      command: process.execPath,
      args: ['--experimental-strip-types', path.join('/pkg/src', 'main.ts')],
    });
  });
});

describe('realServeDeps.kill', () => {
  /**
   * Regression pin: every real call site races against a process that may
   * have already exited on its own by the time the kill fires (the
   * launcher's timeout path killing a supervisor that already gave up and
   * exited, in particular — reproduced manually against a real instance).
   * `process.kill` throws a real, synchronous `ESRCH` for a pid that no
   * longer exists; `realServeDeps.kill` must swallow exactly that and only
   * that, the same way `isProcessAlive`/`lock.ts` already treat ESRCH as
   * "already gone" rather than a failure.
   */
  it('does not throw when the target pid no longer exists', () => {
    // A pid essentially guaranteed not to exist on any real system.
    const longGonePid = 2_147_483_647;
    expect(() => {
      realServeDeps.kill(longGonePid, 'SIGTERM');
    }).not.toThrow();
  });
});
