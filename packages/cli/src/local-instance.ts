import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { firstExistingRelative } from '@vorlyn/shared';
import {
  migrate as realMigrate,
  startEmbeddedPostgres as realStartEmbeddedPostgres,
} from '@vorlyn/persistence/embedded';
import type { DataDirLayout } from './data-dir.js';
import { ensureDataDir as realEnsureDataDir } from './data-dir.js';
import type { LocalConfig } from './local-config.js';
import { loadOrCreateLocalConfig as realLoadOrCreateLocalConfig } from './local-config.js';
import type { Io } from './output.js';

/**
 * Fixed default ports for the two embedded children — picked from IANA's
 * "dynamic/private" range (RFC 6335, 49152–65535), nowhere near 3000/3001
 * or any other common dev-server default, but the *same* two numbers on
 * every machine and every restart, not freshly OS-assigned per boot.
 *
 * This reverses an earlier version of this design (`EMBEDDED_API_PORT`/
 * `EMBEDDED_MCP_PORT` used to be exactly this — fixed 3000/3001 — removed
 * in favor of always-random OS-assigned ports specifically to stop two
 * concurrent local instances from colliding on a common default). Pure
 * randomness solved that but created a worse problem: a document link an
 * agent printed to chat, or a human bookmarked, silently stopped resolving
 * on the next `vorlyn serve stop` + `start`, because the port underneath
 * it had moved. A fixed-but-uncommon pair keeps both properties — stable
 * across restarts, unlikely to collide with anything else already running
 * — and where it still can collide, `PORT`/`MCP_PORT` (read below,
 * already-supported overrides on both embedded entrypoints) is the
 * explicit way out; `selfhost-embedded-main.ts` in both `@vorlyn/api` and
 * `@vorlyn/mcp` fails loud and names that escape hatch rather than
 * silently picking something else, which would just reintroduce the same
 * link-instability problem this exists to close.
 */
export const DEFAULT_API_PORT = 58_743;
export const DEFAULT_MCP_PORT = 58_744;

const READY_POLL_INTERVAL_MS = 200;
/**
 * Bounded wait for each child's port-announcement file (`api.port`/
 * `mcp.port` — written by `packages/api`'s and `packages/mcp`'s embedded
 * mains right after `listen()` resolves, since the port they bind is now
 * `0`/OS-assigned rather than a fixed constant) plus the subsequent
 * `/readyz` poll on whatever port that file names. Generous relative to the
 * old fixed-port `READY_TIMEOUT_MS` (20s) because this now covers two
 * sequential waits (port file, then readyz) rather than one.
 */
const READY_TIMEOUT_MS = 30_000;
const CHILD_STOP_TIMEOUT_MS = 5_000;

/** What `startEmbeddedPostgres` (`@vorlyn/persistence`) returns — named
 *  locally so this file doesn't need to import the concrete type just to
 *  describe the seam. */
export interface EmbeddedPostgresHandle {
  connectionString: string;
  stop(): Promise<void>;
}

/**
 * The minimal slice of `node:child_process`'s `ChildProcess` this file
 * needs — real `ChildProcess` instances satisfy this structurally, so
 * `realSpawn*` below needs no wrapping; tests supply a plain object instead
 * of a real second process.
 */
export interface ManagedChild {
  kill(signal: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null) => void): void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Where `@vorlyn/api`'s or `@vorlyn/mcp`'s `selfhost-embedded-main` can be
 * found, relative to *this module's own compiled location* — deliberately
 * not resolved via `import.meta.resolve('@vorlyn/api')`/`'@vorlyn/mcp')`.
 * That approach (this file's previous implementation) assumed both packages
 * were real `dependencies` of `cli` sitting as filesystem siblings under a
 * `packages/` directory — true only by accident of how pnpm's workspace
 * symlinks happen to lay a monorepo checkout out on disk, and false the
 * moment this CLI is installed from npm: `@vorlyn/mcp` was deliberately
 * never a `cli` dependency (`cli-http-only`, see below), so npm never
 * fetches it at all, and even `@vorlyn/api`'s resolved path under pnpm's
 * `.pnpm` content-addressed store has no such sibling.
 *
 * A relative candidate list from `this` file's own URL works in every
 * layout this CLI actually ships in, checked in order:
 *
 *  1. Installed (bundled) package — this file *is* `dist/cli/main.js`
 *     (esbuild inlines `local-instance.ts` into it), and `@vorlyn/api`'s/
 *     `@vorlyn/mcp`'s bundled entrypoints sit at `dist/api/…`, `dist/mcp/…`
 *     as siblings of `dist/cli/`.
 *  2. Monorepo, built — this file is `packages/cli/dist/local-instance.js`;
 *     the target is `packages/<pkg>/dist/selfhost-embedded-main.js`.
 *  3. Monorepo, unbuilt — this file is `packages/cli/src/local-instance.ts`
 *     (run via `--experimental-strip-types`, e.g. `pnpm --filter cli dev`);
 *     the target is `packages/<pkg>/src/selfhost-embedded-main.ts`, run the
 *     same way.
 *
 * All three cases collapse to the same two-hop-up-and-back-down shape
 * because "one level up + `dist/`" and "two levels up + `<pkg>/dist/`"
 * happen to both resolve correctly no matter which of the three positions
 * *this* file itself is running from — no layout-detection branch needed.
 *
 * `@vorlyn/mcp` is still never a `cli` dependency — nothing here needs it
 * to be. `dependency-cruiser`'s `cli-http-only` rule ("cli is an MCP HTTP
 * client only — no app/domain/api/mcp imports") is an import-graph rule, and
 * this is a plain relative path string, never a static or dynamic `import`
 * of `@vorlyn/mcp`'s code — `cli` talks to MCP over HTTP, as before.
 *
 * Takes `fromUrl` as a parameter, not a hardcoded `import.meta.url`, purely
 * so the resolution logic stays unit-testable against a throwaway temp
 * directory (see `local-instance.test.ts`) rather than this repo's own real
 * `packages/api`/`packages/mcp` output.
 */
export function embeddedEntrypointCandidates(fromUrl: string, pkg: 'api' | 'mcp'): string[] {
  const here = path.dirname(fileURLToPath(fromUrl));
  return [
    path.join(here, '..', pkg, 'selfhost-embedded-main.js'),
    path.join(here, '..', '..', pkg, 'dist', 'selfhost-embedded-main.js'),
    path.join(here, '..', '..', pkg, 'src', 'selfhost-embedded-main.ts'),
  ];
}

/**
 * Resolves the command+args to run one of the two embedded-mode composition
 * roots as a child process, given `embeddedEntrypointCandidates`' ordered
 * list. A `.ts` candidate runs under `--experimental-strip-types` (same
 * flag `packages/api/package.json`'s own `dev` script uses for unbuilt
 * source); anything else runs directly with the plain `node` binary this
 * CLI itself is running under (`process.execPath`). If none of the three
 * paths exist, `firstExistingRelative` throws naming every path tried —
 * strictly more actionable than the bare `ENOENT` `spawn()` would otherwise
 * surface.
 */
export async function resolveEmbeddedEntrypointFrom(
  fromUrl: string,
  pkg: 'api' | 'mcp',
  exists?: (candidate: string) => Promise<boolean>,
): Promise<{ command: string; args: string[] }> {
  const entry = await firstExistingRelative(
    embeddedEntrypointCandidates(fromUrl, pkg),
    `@vorlyn/${pkg}'s embedded entrypoint`,
    exists,
  );
  if (entry.endsWith('.ts')) {
    return { command: process.execPath, args: ['--experimental-strip-types', entry] };
  }
  return { command: process.execPath, args: [entry] };
}

/** `resolveEmbeddedEntrypointFrom` rooted at this module's own location — what every real caller wants. */
export async function resolveEmbeddedEntrypoint(
  pkg: 'api' | 'mcp',
): Promise<{ command: string; args: string[] }> {
  return resolveEmbeddedEntrypointFrom(import.meta.url, pkg);
}

async function realSpawnApi(env: NodeJS.ProcessEnv): Promise<ManagedChild> {
  const { command, args } = await resolveEmbeddedEntrypoint('api');
  return spawn(command, args, { env, stdio: 'inherit' });
}

async function realSpawnMcp(env: NodeJS.ProcessEnv): Promise<ManagedChild> {
  const { command, args } = await resolveEmbeddedEntrypoint('mcp');
  return spawn(command, args, { env, stdio: 'inherit' });
}

/**
 * Waits for `<dataDir>/<name>.port` to appear (written by the child right
 * after it binds its OS-assigned port — see the matching comment in
 * `packages/api/src/selfhost-embedded-main.ts` and `packages/mcp/src/
 * selfhost-embedded-main.ts`) and returns the port number it names.
 * Replaces the old fixed `EMBEDDED_API_PORT`/`EMBEDDED_MCP_PORT` constants:
 * there is no longer a port to assume, only one to discover.
 */
async function waitForPortFile(
  dataDir: string,
  name: 'api' | 'mcp',
  timeoutMs: number,
): Promise<number> {
  const filePath = path.join(dataDir, `${name}.port`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(filePath, 'utf8');
      const port = Number.parseInt(raw.trim(), 10);
      if (Number.isInteger(port) && port > 0) return port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await delay(READY_POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out after ${String(timeoutMs)}ms waiting for ${filePath}`);
}

async function realWaitForReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/readyz`);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(READY_POLL_INTERVAL_MS);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(
    `Timed out after ${String(timeoutMs)}ms waiting for http://127.0.0.1:${String(port)}/readyz${detail}`,
  );
}

/**
 * Rejects the moment `child` exits before it was ever announced ready —
 * raced alongside `waitForPortFile`/`waitForReady` above so a startup
 * failure (most commonly `defaultPort` already bound by something else,
 * now that both children default to a fixed port rather than an
 * OS-assigned one — see `DEFAULT_API_PORT`'s doc comment) surfaces in
 * however long the child actually takes to crash, not after the full
 * `READY_TIMEOUT_MS` spent polling for a port file a dead process will
 * never write. Never resolves — a child that starts cleanly should hold
 * this promise open for the rest of the process's life, so the eventual
 * "ready" side of the `Promise.race` always wins that case.
 */
function childExitedEarly(
  child: ManagedChild,
  label: 'api' | 'mcp',
  defaultPort: number,
): Promise<never> {
  return new Promise((_resolve, reject) => {
    child.once('exit', (code) => {
      const envVar = label === 'api' ? 'PORT' : 'MCP_PORT';
      reject(
        new Error(
          `The embedded ${label} process exited before it was ready (code ${String(code)}). ` +
            `If something else on this machine is already using port ${String(defaultPort)}, ` +
            `set ${envVar} to a free port and try again.`,
        ),
      );
    });
  });
}

/** SIGTERM first, SIGKILL only if it hasn't exited within the timeout — never `kill -9` outright. */
export async function stopChild(child: ManagedChild): Promise<void> {
  await new Promise<void>((resolve) => {
    // Declared, and already fully initialized, before anything below can
    // reference it — including a fake's (or a real process signaled while
    // already mid-exit) `'exit'` listener firing synchronously from inside
    // the `child.kill('SIGTERM')` call two lines down.
    const forceKill = setTimeout(() => {
      child.kill('SIGKILL');
    }, CHILD_STOP_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(forceKill);
      resolve();
    });
    // Node's `ChildProcess.kill()` returns `false` when the signal could not
    // be delivered — in practice almost always because the process is
    // already gone (ESRCH). That matters here specifically because a child
    // this function is asked to stop may already have exited *before this
    // call* — e.g. `childExitedEarly` (above) already observed the api
    // child crash on a port collision, and `startLocalInstance`'s own
    // catch-and-cleanup calls this on it moments later. Node only ever
    // emits `'exit'` once, at the real moment of death; the `once('exit',
    // ...)` listener just registered above would then wait forever for an
    // event that already happened before it existed to hear it — this
    // resolves immediately instead of leaving that promise (and whatever
    // awaits `stop()`/`cleanup()` above it) hung.
    if (!child.kill('SIGTERM')) {
      clearTimeout(forceKill);
      resolve();
    }
  });
}

export interface LocalInstanceDeps {
  ensureDataDir: (dataDir: string) => Promise<DataDirLayout>;
  loadOrCreateLocalConfig: (dataDir: string) => Promise<LocalConfig>;
  startEmbeddedPostgres: (dataDir: string) => Promise<EmbeddedPostgresHandle>;
  migrate: (pool: Pool) => Promise<string[]>;
  spawnApi: (env: NodeJS.ProcessEnv) => Promise<ManagedChild>;
  spawnMcp: (env: NodeJS.ProcessEnv) => Promise<ManagedChild>;
  waitForPortFile: (dataDir: string, name: 'api' | 'mcp', timeoutMs: number) => Promise<number>;
  waitForReady: (port: number, timeoutMs: number) => Promise<void>;
}

export const realLocalInstanceDeps: LocalInstanceDeps = {
  ensureDataDir: realEnsureDataDir,
  loadOrCreateLocalConfig: realLoadOrCreateLocalConfig,
  startEmbeddedPostgres: realStartEmbeddedPostgres,
  migrate: (pool) => realMigrate(pool),
  spawnApi: realSpawnApi,
  spawnMcp: realSpawnMcp,
  waitForPortFile,
  waitForReady: realWaitForReady,
};

export interface LocalInstance {
  readonly apiPort: number;
  readonly mcpPort: number;
  readonly rootUrl: string;
  readonly mcpEndpoint: string;
  readonly apiChild: ManagedChild;
  readonly mcpChild: ManagedChild;
  stop(): Promise<void>;
}

/**
 * Starts embedded Postgres, migrates it, spawns the two embedded-mode
 * composition roots, and waits for both to announce a port and answer
 * `/readyz`. The shared core of `vorlyn open`'s "own mode" and `vorlyn
 * serve`'s supervisor — previously duplicated nowhere (this file didn't
 * exist), extracted here so both have exactly one implementation.
 *
 * Does not touch signals, linking, pushing, or the browser — purely "get a
 * local server up and know its ports." Callers own teardown via the
 * returned `stop()`.
 */
export async function startLocalInstance(
  dataDir: string,
  io: Io,
  deps: LocalInstanceDeps = realLocalInstanceDeps,
): Promise<LocalInstance> {
  const layout = await deps.ensureDataDir(dataDir);
  const localConfig = await deps.loadOrCreateLocalConfig(dataDir);

  const pg = await deps.startEmbeddedPostgres(dataDir);

  let apiChild: ManagedChild | undefined;
  let mcpChild: ManagedChild | undefined;
  let cleanedUp = false;
  async function cleanup(): Promise<void> {
    if (cleanedUp) return;
    cleanedUp = true;
    if (mcpChild) await stopChild(mcpChild);
    if (apiChild) await stopChild(apiChild);
    await pg.stop();
  }

  try {
    // `max: 1` because this pool exists only to run migrations, which are
    // sequential — not because of any per-pool limit. The real constraint is
    // server-side and global (`PGLiteSocketServer`'s `maxConnections`, set in
    // embedded-postgres.ts); the two children spawned below use ordinary
    // `poolConfigFromEnv()` pools and are covered by that cap.
    const migratePool = new Pool({ connectionString: pg.connectionString, max: 1 });
    let applied: string[];
    try {
      applied = await deps.migrate(migratePool);
    } finally {
      await migratePool.end();
    }
    if (applied.length > 0) {
      io.println(`Applied ${String(applied.length)} database migration(s) (first run).`);
    }

    const sharedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: pg.connectionString,
      SESSION_SECRET: localConfig.sessionSecret,
      VORLYN_AUTH_MODE: 'single-user',
      VORLYN_ADMIN_EMAIL: localConfig.adminEmail,
      VORLYN_ADMIN_NAME: localConfig.adminName,
      BLOB_STORAGE_DIR: layout.blobs,
      VORLYN_DATA_DIR: dataDir,
      // `??`, not an unconditional set: an explicit PORT/MCP_PORT already in
      // this process's own environment (someone deliberately overriding,
      // e.g. because DEFAULT_API_PORT/DEFAULT_MCP_PORT collide with
      // something else on their machine) always wins over the fixed
      // default — see DEFAULT_API_PORT's doc comment above.
      PORT: process.env.PORT ?? String(DEFAULT_API_PORT),
      MCP_PORT: process.env.MCP_PORT ?? String(DEFAULT_MCP_PORT),
    };

    // A previous run's `api.port`/`mcp.port` are never cleaned up on the way
    // out (nothing needs them once stopped), so a stale one can still be
    // sitting in `dataDir` from an earlier instance. Without removing it
    // first, `waitForPortFile` below could read that leftover file on its
    // very first attempt — before *this* run's child has had a chance to
    // write its own — and return a dead port from a process that's already
    // gone, which then times out waiting for a `/readyz` that will never
    // answer. Removing here, not on the way out, is also what makes this
    // safe against a previous run that crashed without cleaning up at all.
    await Promise.all([
      rm(path.join(dataDir, 'api.port'), { force: true }),
      rm(path.join(dataDir, 'mcp.port'), { force: true }),
    ]);

    apiChild = await deps.spawnApi({ ...sharedEnv, VORLYN_SERVE_WEB: 'true' });
    mcpChild = await deps.spawnMcp(sharedEnv);

    const [apiPort, mcpPort] = await Promise.all([
      Promise.race([
        deps.waitForPortFile(dataDir, 'api', READY_TIMEOUT_MS).then(async (port) => {
          await deps.waitForReady(port, READY_TIMEOUT_MS);
          return port;
        }),
        childExitedEarly(apiChild, 'api', DEFAULT_API_PORT),
      ]),
      Promise.race([
        deps.waitForPortFile(dataDir, 'mcp', READY_TIMEOUT_MS).then(async (port) => {
          await deps.waitForReady(port, READY_TIMEOUT_MS);
          return port;
        }),
        childExitedEarly(mcpChild, 'mcp', DEFAULT_MCP_PORT),
      ]),
    ]);

    // Fixed to the loopback IP, not just any of `localhost`/`127.0.0.1` —
    // the browser (`vorlyn open`) navigates to this exact host, and the
    // single-user login round trip (`/api/auth/login` -> `/api/auth/
    // callback`) sets its CSRF state cookie on whatever host the request
    // arrived on. Browsers treat `localhost` and `127.0.0.1` as separate
    // cookie origins, so `API_BASE_URL`/`WEB_APP_URL`/`WEB_ORIGIN` must stay
    // in lockstep with whichever one is actually used (`configFromEnv`
    // would otherwise fall back to `localhost:3000`/`localhost:5173`).
    // Computed here rather than passed in `sharedEnv` above because the api
    // port isn't known until *after* the child is spawned and announces it
    // (`waitForPortFile`) — the api child instead sets all three itself,
    // once it knows its own port, via `process.env.API_BASE_URL ??= rootUrl`
    // and friends in `selfhost-embedded-main.ts`. This `rootUrl` is this
    // (the CLI's own) process's copy of that same value, used only to talk
    // to the child over HTTP and to print/open it for the user.
    const rootUrl = `http://127.0.0.1:${String(apiPort)}`;
    const mcpEndpoint = `http://127.0.0.1:${String(mcpPort)}/mcp`;

    return { apiPort, mcpPort, rootUrl, mcpEndpoint, apiChild, mcpChild, stop: cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
