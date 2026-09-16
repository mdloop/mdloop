import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolveDataDir } from './data-dir.js';
import { uninstallGlobalAgentInstructions } from './agent-instructions.js';
import { listFolderProjects } from './folder-projects.js';
import { liveInstance } from './instance-record.js';
import { readManifest } from './manifest.js';
import type { Io } from './output.js';
import { runUnlink } from './unlink.js';

export interface UninstallOptions {
  /** Override for tests; defaults to the real platform data directory. */
  dataDir?: string;
  /** Override for tests; defaults to the real home directory (`uninstallGlobalAgentInstructions`'s
   *  own default) — never omit this in a test, or it writes to the real `~/.claude/CLAUDE.md`. */
  homeDir?: string;
  /** `true` for `mdloop uninstall --purge-data` — also deletes the platform data directory
   *  (embedded Postgres, uploaded blobs). Defaults to leaving it in place. */
  purgeData?: boolean;
}

/**
 * `mdloop uninstall` — undoes everything "mdloop link" and "mdloop instructions install --global"
 * ever wrote outside of `.mdloop/`'s own folder, across every repo this machine has ever
 * auto-linked, plus the global CLAUDE.md/AGENTS.md block.
 *
 * Exists because `npm uninstall -g mdloop` does NOT do this on its own — empirically (tested
 * against npm 10.9.4, both `preuninstall` and `postuninstall`, both with and without
 * `--foreground-scripts`), npm does not run either lifecycle script for a global package
 * uninstall at all, so a `preuninstall` hook in packages/mdloop/package.json would be silent,
 * untested dead code. `uninstall.sh` (the documented uninstall path, mirroring `install.sh`) calls
 * this explicitly, in order, before running `npm uninstall -g mdloop` itself — this command is
 * what actually does the work; the script is just the one-liner wrapper.
 *
 * Reuses `runUnlink` per folder rather than reimplementing its git-hook/agent-instructions/
 * `.mdloop/` cleanup — same reasoning `mdloop unlink` already encodes (a foreign hook or block is
 * always left untouched, regardless of who's calling it in). `folder-projects.json` (this data
 * directory's own record of every folder ever auto-linked, kept independent of any running
 * server — see `folder-projects.ts`) is the source of which folders to visit; a folder that no
 * longer exists on disk, or was already unlinked by hand, is skipped rather than resurrected
 * (`runUnlink`'s own `ensureMdloopDir` would otherwise recreate a deleted folder just to delete it
 * again).
 *
 * Deliberately never touches the platform data directory (embedded Postgres, uploaded blobs) by
 * default — that is real document content, not configuration written on someone's behalf, and
 * deleting it silently on every uninstall would be a data-loss bug wearing a cleanup feature's
 * clothes. `--purge-data` removes it too, exactly like asking for it by name; refused outright
 * while a local server is still running against it, rather than deleting live Postgres files out
 * from under a running process.
 */
export async function runUninstall(options: UninstallOptions, io: Io): Promise<number> {
  const dataDir = options.dataDir ?? resolveDataDir();
  const entries = await listFolderProjects(dataDir);

  let anyFailure = false;
  let cleanedAnything = false;
  for (const entry of entries) {
    if (!existsSync(entry.folder)) continue;
    const manifest = await readManifest(entry.folder);
    if (!manifest) continue;
    const code = await runUnlink({ folder: entry.folder }, io);
    if (code === 0) cleanedAnything = true;
    else anyFailure = true; // a live lock (an active push) refused unlink — not "foreign"
  }

  const globalOutcomes = await uninstallGlobalAgentInstructions(options.homeDir);
  for (const { agent, file, result } of globalOutcomes) {
    switch (result) {
      case 'removed':
        io.println(`${agent} (${file}): removed`);
        cleanedAnything = true;
        break;
      case 'foreign':
        io.println(
          `${agent} (${file}): has a block that was not installed by mdloop — left untouched.`,
        );
        anyFailure = true;
        break;
      case 'not_present':
      case 'no_target_dir':
        break;
    }
  }

  if (options.purgeData) {
    const live = await liveInstance(dataDir);
    if (live) {
      io.errln(
        `A local mdloop server is still running (pid ${String(live.pid)}) against ${dataDir}. ` +
          'Run "mdloop serve stop" first, then retry with --purge-data.',
      );
      return 1;
    }
    if (existsSync(dataDir)) {
      await rm(dataDir, { recursive: true, force: true });
      io.println(`Removed local document data at ${dataDir}.`);
      cleanedAnything = true;
    }
  } else {
    io.println(
      `Local document data (embedded Postgres, blobs) at ${dataDir} was left in place — ` +
        're-run with --purge-data to remove that too.',
    );
  }

  if (!cleanedAnything && !anyFailure) {
    io.println('Nothing to clean up.');
  }
  return anyFailure ? 1 : 0;
}
