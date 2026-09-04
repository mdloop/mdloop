import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDataDir } from './data-dir.js';
import { loadOrCreateLocalConfig } from './local-config.js';
import type { Io } from './output.js';
import type { EmbeddedPostgresHandle, LocalInstanceDeps, ManagedChild } from './local-instance.js';
import {
  DEFAULT_API_PORT,
  DEFAULT_MCP_PORT,
  embeddedEntrypointCandidates,
  realLocalInstanceDeps,
  resolveEmbeddedEntrypointFrom,
  startLocalInstance,
  stopChild,
} from './local-instance.js';

function collectIo(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { println: (l: string) => out.push(l), errln: (l: string) => err.push(l) },
    out,
    err,
  };
}

/** Same fake shape `open.test.ts` uses — a real EventEmitter so `once('exit', ...)` behaves like
 *  the real thing, plus a `kill` spy that synchronously emits `exit` (simulating a clean shutdown). */
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

/**
 * Models a real `ChildProcess` that already exited *before* anything calls
 * `.kill()` on it — its own `'exit'` event fired at that earlier, unobserved
 * moment, exactly like a process crashing on a port collision moments after
 * spawn. `kill()` on a real already-dead pid returns `false` (ESRCH) rather
 * than throwing or emitting anything new; `once('exit', ...)` registered
 * this late genuinely never fires again, matching real `EventEmitter`
 * semantics ('exit' is emitted once, at the real moment of death).
 */
function alreadyExitedChild(): ManagedChild {
  return {
    kill: () => false,
    once: () => undefined,
  };
}

describe('startLocalInstance', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mdloop-local-instance-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Real `ensureDataDir`/`loadOrCreateLocalConfig` (cheap fs, not part of the seam, matching
   *  `open.test.ts`'s own convention); fake everything expensive. */
  function testDeps(overrides: Partial<LocalInstanceDeps> = {}): {
    deps: LocalInstanceDeps;
    pgStopped: () => boolean;
    api: ReturnType<typeof fakeChild>;
    mcp: ReturnType<typeof fakeChild>;
  } {
    let stopped = false;
    const api = fakeChild();
    const mcp = fakeChild();
    const pg: EmbeddedPostgresHandle = {
      connectionString: 'postgres://postgres:postgres@127.0.0.1:1/postgres',
      stop: () => {
        stopped = true;
        return Promise.resolve();
      },
    };
    const deps: LocalInstanceDeps = {
      ensureDataDir,
      loadOrCreateLocalConfig,
      startEmbeddedPostgres: () => Promise.resolve(pg),
      migrate: () => Promise.resolve([]),
      spawnApi: () => Promise.resolve(api),
      spawnMcp: () => Promise.resolve(mcp),
      waitForPortFile: (_dataDir, name) => Promise.resolve(name === 'api' ? 4000 : 4001),
      waitForReady: () => Promise.resolve(),
      ...overrides,
    };
    return { deps, pgStopped: () => stopped, api, mcp };
  }

  it('discovers both ports, waits ready, and returns the derived urls', async () => {
    const { deps } = testDeps();
    const { io } = collectIo();

    const instance = await startLocalInstance(dataDir, io, deps);

    expect(instance.apiPort).toBe(4000);
    expect(instance.mcpPort).toBe(4001);
    expect(instance.rootUrl).toBe('http://127.0.0.1:4000');
    expect(instance.mcpEndpoint).toBe('http://127.0.0.1:4001/mcp');
  });

  describe('PORT/MCP_PORT passed to the children', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('defaults both children to the fixed DEFAULT_API_PORT/DEFAULT_MCP_PORT when nothing overrides them', async () => {
      vi.stubEnv('PORT', undefined);
      vi.stubEnv('MCP_PORT', undefined);
      let apiEnv: NodeJS.ProcessEnv | undefined;
      let mcpEnv: NodeJS.ProcessEnv | undefined;
      const { deps } = testDeps({
        spawnApi: (env) => {
          apiEnv = env;
          return Promise.resolve(fakeChild());
        },
        spawnMcp: (env) => {
          mcpEnv = env;
          return Promise.resolve(fakeChild());
        },
      });

      await startLocalInstance(dataDir, collectIo().io, deps);

      expect(apiEnv?.PORT).toBe(String(DEFAULT_API_PORT));
      expect(mcpEnv?.MCP_PORT).toBe(String(DEFAULT_MCP_PORT));
    });

    it('an explicit PORT/MCP_PORT already in this process wins over the fixed defaults', async () => {
      vi.stubEnv('PORT', '19999');
      vi.stubEnv('MCP_PORT', '19998');
      let apiEnv: NodeJS.ProcessEnv | undefined;
      let mcpEnv: NodeJS.ProcessEnv | undefined;
      const { deps } = testDeps({
        spawnApi: (env) => {
          apiEnv = env;
          return Promise.resolve(fakeChild());
        },
        spawnMcp: (env) => {
          mcpEnv = env;
          return Promise.resolve(fakeChild());
        },
      });

      await startLocalInstance(dataDir, collectIo().io, deps);

      expect(apiEnv?.PORT).toBe('19999');
      expect(mcpEnv?.MCP_PORT).toBe('19998');
    });
  });

  it('the api child exiting before it announces a port rejects immediately, naming PORT as the way out — not the full readiness timeout', async () => {
    const api = fakeChild();
    const { deps } = testDeps({
      spawnApi: () => {
        // Deferred, not synchronous: `childExitedEarly`'s `once('exit', ...)`
        // listener is only attached once `startLocalInstance` reaches the
        // race, a few awaits after this function returns — scheduling the
        // "crash" for shortly afterward (same timing pattern the "stale
        // port file" test above uses for its own just-started child) is
        // what a real process dying a moment after spawn actually looks
        // like, and avoids a same-tick race in the test itself.
        setTimeout(() => api.kill('SIGTERM'), 5);
        return Promise.resolve(api);
      },
      // Never resolves on its own — if the early-exit race didn't win,
      // this test would hang until Vitest's own test timeout instead of
      // settling promptly.
      waitForPortFile: (_dataDir, name) =>
        name === 'api' ? new Promise(() => undefined) : Promise.resolve(4001),
    });

    await expect(startLocalInstance(dataDir, collectIo().io, deps)).rejects.toThrow(
      /exited before it was ready.*PORT/s,
    );
  });

  /**
   * Regression: whatever actually surfaces a startup failure, cleanup must
   * never hang trying to `stopChild` a child that's already dead by the
   * time it gets there — `stopChild`'s own dedicated tests below cover the
   * unit; this pins the same bug at the level it was actually found live
   * (`mdloop serve start` against an occupied port left the detached
   * supervisor running forever, `cleanup()` stuck awaiting an `'exit'`
   * event from an api child that had already exited).
   */
  it('an already-dead api child never causes cleanup to hang, however the failure was discovered', async () => {
    const mcp = fakeChild();
    const { deps, pgStopped } = testDeps({
      spawnApi: () => Promise.resolve(alreadyExitedChild()),
      spawnMcp: () => Promise.resolve(mcp),
      waitForPortFile: (_dataDir, name) =>
        name === 'api'
          ? Promise.reject(new Error('api never announced a port — it was already dead'))
          : Promise.resolve(4001),
    });

    await expect(startLocalInstance(dataDir, collectIo().io, deps)).rejects.toThrow(/already dead/);
    expect(mcp.killed).toEqual(['SIGTERM']);
    expect(pgStopped()).toBe(true);
  });

  /**
   * Regression pin: a previous run's `api.port`/`mcp.port` files are never
   * cleaned up on the way out (nothing needs them once stopped), so a fresh
   * `startLocalInstance` used to be able to read a *stale* leftover file on
   * its very first attempt — before the new child had written its own —
   * and hand back a dead port from an already-gone process, which then
   * timed out waiting for a `/readyz` that would never answer. Uses the
   * real `waitForPortFile` (via `realLocalInstanceDeps`), not the faked one
   * `testDeps()` normally supplies, since the bug lives in the real
   * file-reading/cleanup interaction — the fake bypasses it entirely.
   */
  it('ignores a stale port file left over from a previous run, and picks up the new one instead', async () => {
    await writeFile(path.join(dataDir, 'api.port'), '9999\n', 'utf8'); // stale — nothing is listening there
    const { deps } = testDeps({
      waitForPortFile: realLocalInstanceDeps.waitForPortFile,
      spawnApi: () => {
        // Simulates the real child: writes its *own* fresh port shortly
        // after starting, same as `selfhost-embedded-main.ts` does right
        // after `listen()` resolves.
        void (async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          await writeFile(path.join(dataDir, 'api.port'), '5000\n', 'utf8');
        })();
        return Promise.resolve(fakeChild());
      },
      spawnMcp: () => {
        void (async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          await writeFile(path.join(dataDir, 'mcp.port'), '5001\n', 'utf8');
        })();
        return Promise.resolve(fakeChild());
      },
      waitForReady: () => Promise.resolve(),
    });

    const instance = await startLocalInstance(dataDir, collectIo().io, deps);

    expect(instance.apiPort).toBe(5000);
    expect(instance.rootUrl).toBe('http://127.0.0.1:5000');
  });

  it('stop() tears down both children then the database, in mcp-then-api-then-pg order', async () => {
    const { deps, api, mcp, pgStopped } = testDeps();
    const instance = await startLocalInstance(dataDir, collectIo().io, deps);

    await instance.stop();

    expect(api.killed).toEqual(['SIGTERM']);
    expect(mcp.killed).toEqual(['SIGTERM']);
    expect(pgStopped()).toBe(true);
  });

  it('stop() is idempotent — a second call is a harmless no-op', async () => {
    const { deps, api, mcp } = testDeps();
    const instance = await startLocalInstance(dataDir, collectIo().io, deps);

    await instance.stop();
    await instance.stop();

    expect(api.killed).toEqual(['SIGTERM']);
    expect(mcp.killed).toEqual(['SIGTERM']);
  });

  it('startEmbeddedPostgres failure: rejects, spawns nothing', async () => {
    let spawned = false;
    const { deps } = testDeps({
      startEmbeddedPostgres: () => Promise.reject(new Error('boom')),
      spawnApi: () => {
        spawned = true;
        return Promise.reject(new Error('should not spawn'));
      },
    });

    await expect(startLocalInstance(dataDir, collectIo().io, deps)).rejects.toThrow('boom');
    expect(spawned).toBe(false);
  });

  it('a port file that never appears: rejects, and still tears down both children and the database', async () => {
    const { deps, api, mcp, pgStopped } = testDeps({
      waitForPortFile: () => Promise.reject(new Error('timed out waiting for api.port')),
    });

    await expect(startLocalInstance(dataDir, collectIo().io, deps)).rejects.toThrow(
      'timed out waiting for api.port',
    );
    expect(api.killed).toEqual(['SIGTERM']);
    expect(mcp.killed).toEqual(['SIGTERM']);
    expect(pgStopped()).toBe(true);
  });

  it('/readyz never answering: rejects, and still tears down both children and the database', async () => {
    const { deps, api, mcp, pgStopped } = testDeps({
      waitForReady: () => Promise.reject(new Error('timed out waiting for /readyz')),
    });

    await expect(startLocalInstance(dataDir, collectIo().io, deps)).rejects.toThrow(
      'timed out waiting for /readyz',
    );
    expect(api.killed).toEqual(['SIGTERM']);
    expect(mcp.killed).toEqual(['SIGTERM']);
    expect(pgStopped()).toBe(true);
  });

  it('prints a migration count only when migrations actually ran', async () => {
    const ranMigrations = testDeps({ migrate: () => Promise.resolve(['0001', '0002']) });
    const ran = collectIo();
    await startLocalInstance(dataDir, ran.io, ranMigrations.deps);
    expect(ran.out.some((l) => l.includes('Applied 2 database migration'))).toBe(true);

    const noMigrations = testDeps();
    const clean = collectIo();
    await startLocalInstance(dataDir, clean.io, noMigrations.deps);
    expect(clean.out.some((l) => l.includes('Applied'))).toBe(false);
  });
});

describe('embeddedEntrypointCandidates / resolveEmbeddedEntrypointFrom', () => {
  let tmpRoot: string | undefined;

  afterEach(async () => {
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  });

  it('lists the installed, monorepo-built, and monorepo-src candidates in that order', () => {
    const fromUrl = 'file:///pkg/dist/cli/main.js';
    expect(embeddedEntrypointCandidates(fromUrl, 'api')).toEqual([
      path.join('/pkg/dist/cli', '..', 'api', 'selfhost-embedded-main.js'),
      path.join('/pkg/dist/cli', '..', '..', 'api', 'dist', 'selfhost-embedded-main.js'),
      path.join('/pkg/dist/cli', '..', '..', 'api', 'src', 'selfhost-embedded-main.ts'),
    ]);
  });

  it('prefers the installed (bundled) layout — a sibling dist/<pkg>/ next to its own dist/cli/', async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'mdloop-entrypoint-'));
    const cliDir = path.join(tmpRoot, 'dist', 'cli');
    const apiDir = path.join(tmpRoot, 'dist', 'api');
    await mkdir(cliDir, { recursive: true });
    await mkdir(apiDir, { recursive: true });
    await writeFile(path.join(apiDir, 'selfhost-embedded-main.js'), '', 'utf8');

    const fromUrl = `file://${path.join(cliDir, 'main.js')}`;
    const result = await resolveEmbeddedEntrypointFrom(fromUrl, 'api');

    expect(result).toEqual({
      command: process.execPath,
      args: [path.join(apiDir, 'selfhost-embedded-main.js')],
    });
  });

  it('falls back to the monorepo-built layout — packages/<pkg>/dist/ two levels up', async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'mdloop-entrypoint-'));
    const cliDistDir = path.join(tmpRoot, 'packages', 'cli', 'dist');
    const apiDistDir = path.join(tmpRoot, 'packages', 'api', 'dist');
    await mkdir(cliDistDir, { recursive: true });
    await mkdir(apiDistDir, { recursive: true });
    await writeFile(path.join(apiDistDir, 'selfhost-embedded-main.js'), '', 'utf8');

    const fromUrl = `file://${path.join(cliDistDir, 'local-instance.js')}`;
    const result = await resolveEmbeddedEntrypointFrom(fromUrl, 'api');

    expect(result).toEqual({
      command: process.execPath,
      args: [path.join(apiDistDir, 'selfhost-embedded-main.js')],
    });
  });

  it('falls back to the monorepo-src layout and runs it under --experimental-strip-types', async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'mdloop-entrypoint-'));
    const cliSrcDir = path.join(tmpRoot, 'packages', 'cli', 'src');
    const mcpSrcDir = path.join(tmpRoot, 'packages', 'mcp', 'src');
    await mkdir(cliSrcDir, { recursive: true });
    await mkdir(mcpSrcDir, { recursive: true });
    await writeFile(path.join(mcpSrcDir, 'selfhost-embedded-main.ts'), '', 'utf8');

    const fromUrl = `file://${path.join(cliSrcDir, 'local-instance.ts')}`;
    const result = await resolveEmbeddedEntrypointFrom(fromUrl, 'mcp');

    expect(result).toEqual({
      command: process.execPath,
      args: ['--experimental-strip-types', path.join(mcpSrcDir, 'selfhost-embedded-main.ts')],
    });
  });

  it('throws naming every candidate tried when none exist', async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'mdloop-entrypoint-'));
    const cliDir = path.join(tmpRoot, 'dist', 'cli');
    await mkdir(cliDir, { recursive: true });
    const fromUrl = `file://${path.join(cliDir, 'main.js')}`;

    await expect(resolveEmbeddedEntrypointFrom(fromUrl, 'api')).rejects.toThrow(
      /Could not find @mdloop\/api's embedded entrypoint/,
    );
  });
});

describe('stopChild', () => {
  it('signals a live child and waits for it to actually exit', async () => {
    const child = fakeChild();

    await stopChild(child);

    expect(child.killed).toEqual(['SIGTERM']);
  });

  /**
   * Regression: a child that already exited before `stopChild` was ever
   * called on it (its real `'exit'` event fired at that earlier, unobserved
   * moment) used to hang this function forever — `once('exit', ...)`
   * registered this late can never see an event that already happened, and
   * nothing else was resolving the promise. First surfaced by a real
   * `mdloop serve start` against an occupied port: the api child crashed
   * immediately, `childExitedEarly` correctly rejected fast, but
   * `startLocalInstance`'s own cleanup then hung indefinitely trying to
   * `stopChild` that already-dead process — leaving the detached supervisor
   * running forever with nothing to show for it.
   */
  it('resolves immediately for a child that already exited, instead of hanging forever', async () => {
    await expect(stopChild(alreadyExitedChild())).resolves.toBeUndefined();
  });
});
