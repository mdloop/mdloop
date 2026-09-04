import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeCredentials } from './credentials.js';
import type { Manifest } from './manifest.js';
import { writeManifest } from './manifest.js';
import { runPush } from './push.js';
import type { Io } from './output.js';
import type { FakeMcpServer } from './test-support/fake-mcp-server.js';
import { startFakeMcpServer } from './test-support/fake-mcp-server.js';
import type { WatchDeps } from './watch.js';
import { runWatch } from './watch.js';

function collectIo(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { println: (l: string) => out.push(l), errln: (l: string) => err.push(l) },
    out,
    err,
  };
}

/** Waits for a real setTimeout — used to let a real debounce window (short,
 *  injected via `debounceMs`) actually elapse. Never used to wait out the
 *  15s production default. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEBOUNCE_MS = 150;

describe('runWatch', () => {
  let folder: string;
  let fake: FakeMcpServer;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-watch-'));
    fake = await startFakeMcpServer();
    await writeCredentials(folder, { apiKey: fake.apiKey });
  });

  afterEach(async () => {
    await fake.close();
    await rm(folder, { recursive: true, force: true });
  });

  async function link(): Promise<void> {
    const manifest: Manifest = { endpoint: fake.url, projectId: 'proj_1', files: {} };
    await writeManifest(folder, manifest);
  }

  /** Real runPush underneath, wrapped only to count invocations and to keep
   *  push's own signal handling isolated from the watch-level fake signals
   *  used to stop the watcher in these tests. */
  function countingDeps(): { deps: WatchDeps; pushCalls: () => number; whenReady: Promise<void> } {
    let calls = 0;
    let resolveReady: () => void;
    const whenReady = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const deps: WatchDeps = {
      runPush: (options, io) => {
        calls += 1;
        return runPush(options, io);
      },
      signals: new EventEmitter(),
      ready: () => {
        resolveReady();
      },
    };
    return { deps, pushCalls: () => calls, whenReady };
  }

  it('refuses to start on an unlinked folder', async () => {
    const { io, err } = collectIo();
    const code = await runWatch({ folder, debounceMs: DEBOUNCE_MS }, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/not linked/);
  });

  it('a single write triggers exactly one push after the debounce settles', async () => {
    await link();
    const { io } = collectIo();
    const { deps, pushCalls, whenReady } = countingDeps();

    const runPromise = runWatch({ folder, debounceMs: DEBOUNCE_MS, quiet: true }, io, deps);
    await whenReady;

    await writeFile(path.join(folder, 'a.md'), '# A');
    // Past the debounce window: the timer has fired and schedulePush() ran.
    await delay(DEBOUNCE_MS + 200);

    deps.signals.emit('SIGINT');
    const code = await runPromise;

    expect(code).toBe(0);
    expect(pushCalls()).toBe(1);
    expect(fake.state.documents.size).toBe(1);
  }, 15_000);

  it('two rapid writes within the window trigger exactly one push, not two', async () => {
    await link();
    const { io } = collectIo();
    const { deps, pushCalls, whenReady } = countingDeps();

    const runPromise = runWatch({ folder, debounceMs: DEBOUNCE_MS, quiet: true }, io, deps);
    await whenReady;

    await writeFile(path.join(folder, 'a.md'), '# A v1');
    await delay(DEBOUNCE_MS / 3);
    // Second write lands well within the window — resets the per-file timer
    // rather than starting a second one.
    await writeFile(path.join(folder, 'a.md'), '# A v2');
    await delay(DEBOUNCE_MS + 200);

    deps.signals.emit('SIGINT');
    const code = await runPromise;

    expect(code).toBe(0);
    expect(pushCalls()).toBe(1);
    expect(fake.state.documents.size).toBe(1);
    const [doc] = [...fake.state.documents.values()];
    expect(doc?.content).toBe('# A v2');
  }, 15_000);

  it('stopping before the debounce settles does not flush a push', async () => {
    await link();
    const { io } = collectIo();
    const { deps, pushCalls, whenReady } = countingDeps();

    const runPromise = runWatch({ folder, debounceMs: DEBOUNCE_MS, quiet: true }, io, deps);
    await whenReady;

    await writeFile(path.join(folder, 'a.md'), '# A');
    // Stop well before the debounce window elapses.
    await delay(20);
    deps.signals.emit('SIGINT');
    const code = await runPromise;

    expect(code).toBe(0);
    expect(pushCalls()).toBe(0);
    expect(fake.state.documents.size).toBe(0);
  }, 15_000);

  it('SIGTERM stops the watcher the same way as SIGINT', async () => {
    await link();
    const { io } = collectIo();
    const { deps, whenReady } = countingDeps();

    const runPromise = runWatch({ folder, debounceMs: DEBOUNCE_MS, quiet: true }, io, deps);
    await whenReady;
    deps.signals.emit('SIGTERM');
    const code = await runPromise;
    expect(code).toBe(0);
  }, 15_000);

  it('ignores non-markdown files', async () => {
    await link();
    const { io } = collectIo();
    const { deps, pushCalls, whenReady } = countingDeps();

    const runPromise = runWatch({ folder, debounceMs: DEBOUNCE_MS, quiet: true }, io, deps);
    await whenReady;

    await writeFile(path.join(folder, 'notes.txt'), 'not markdown');
    await delay(DEBOUNCE_MS + 200);

    deps.signals.emit('SIGINT');
    const code = await runPromise;

    expect(code).toBe(0);
    expect(pushCalls()).toBe(0);
  }, 15_000);

  it('prints a watching line unless quiet', async () => {
    await link();
    const { io, out } = collectIo();
    const { deps, whenReady } = countingDeps();

    const runPromise = runWatch({ folder, debounceMs: DEBOUNCE_MS }, io, deps);
    await whenReady;
    deps.signals.emit('SIGINT');
    await runPromise;

    expect(out.some((l) => l.includes('watching'))).toBe(true);
  }, 15_000);
});
