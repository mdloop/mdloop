import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Literal, not read from `.product-identifier.json` (CLAUDE.md "Environment"
 * / Phase E dispatch): no runtime code in this repo reads the identifier
 * dynamically — `scripts/dev/rename.mjs` does a repo-wide find-and-replace
 * when the rename off `vorlyn` (gated on Gate 0 legal/naming clearance)
 * actually happens, and this literal is exactly the kind of string it
 * rewrites. Don't hand-roll a dynamic-identifier mechanism here.
 */
const APP_DIRNAME = 'vorlyn';

/**
 * Resolves the standard per-OS application-data directory for this app —
 * where the self-host / `vorlyn open` composition root's embedded Postgres
 * (Task 1, `packages/persistence/src/embedded-postgres.ts`) and blob storage
 * live.
 *
 * - Explicit override: `VORLYN_DATA_DIR`, if set — checked first, before any
 *   platform branching. This variable was already part of the contract
 *   before this check existed: `serve.ts` sets it for the detached
 *   supervisor process it spawns, and `local-instance.ts` passes it to both
 *   embedded children, but nothing ever read it back on this side. Making
 *   it the first check here, rather than a separate env-lookup layered on
 *   top of `resolveDataDir`, keeps every caller (`open`, `serve`,
 *   `link`, the packaging smoke test) honoring it identically without a
 *   second code path — a hermetic test dir, or a machine where the default
 *   per-OS location isn't writable, needs to move exactly one directory.
 * - macOS:   `~/Library/Application Support/vorlyn/`
 * - Linux:   `$XDG_DATA_HOME/vorlyn/` if set, else `~/.local/share/vorlyn/`
 * - Windows: `%APPDATA%\vorlyn\`
 *
 * Parameterized on `platform`/`env` rather than reading `process.platform`/
 * `process.env` directly — same testable-env-function convention as
 * `storageFromEnv` (`packages/persistence/src/storage/storage-from-env.ts`).
 *
 * Fails fast on a genuinely unresolvable home directory (missing `HOME` on
 * macOS/Linux, missing `APPDATA` on Windows) rather than silently joining
 * against an empty string and producing a nonsense path — same fail-loud
 * posture as `poolConfigFromEnv`'s present-but-garbage env vars.
 */
export function resolveDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.VORLYN_DATA_DIR?.trim();
  if (override) return override;
  if (platform === 'darwin') {
    return path.join(requireHome(env), 'Library', 'Application Support', APP_DIRNAME);
  }
  if (platform === 'win32') {
    const appData = env.APPDATA;
    if (!appData) {
      throw new Error('APPDATA is not set — cannot resolve the Windows application-data directory');
    }
    return path.join(appData, APP_DIRNAME);
  }
  // Linux and every other platform: XDG Base Directory spec.
  const xdgDataHome = env.XDG_DATA_HOME;
  if (xdgDataHome) return path.join(xdgDataHome, APP_DIRNAME);
  return path.join(requireHome(env), '.local', 'share', APP_DIRNAME);
}

function requireHome(env: NodeJS.ProcessEnv): string {
  const home = env.HOME;
  if (!home) {
    throw new Error('HOME is not set — cannot resolve the application-data directory');
  }
  return home;
}

export interface DataDirLayout {
  root: string;
  pgdata: string;
  blobs: string;
}

/**
 * Ensures `dataDir` and its `pgdata`/`blobs` subdirectories exist
 * (`{ recursive: true }`, idempotent — safe to call on every startup).
 * `pgdata` is Task 1's embedded-Postgres persistence directory (matching its
 * own internal `path.join(dataDir, 'pgdata')` join); `blobs` is the local
 * filesystem storage adapter's directory, per the self-host plan's spec of
 * what lives in the data directory.
 */
export async function ensureDataDir(dataDir: string): Promise<DataDirLayout> {
  const pgdata = path.join(dataDir, 'pgdata');
  const blobs = path.join(dataDir, 'blobs');
  await mkdir(pgdata, { recursive: true });
  await mkdir(blobs, { recursive: true });
  return { root: dataDir, pgdata, blobs };
}
