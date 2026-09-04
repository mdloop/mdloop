import { rm } from 'node:fs/promises';
import { mdloopDir } from './mdloop-dir.js';
import { uninstallGitPostCommitHook } from './git-hook.js';
import type { LockInfo } from './lock.js';
import { acquireLock, releaseLock } from './lock.js';
import { readManifest } from './manifest.js';
import type { Io } from './output.js';

export interface UnlinkOptions {
  folder: string;
  /** `false` for `mdloop unlink --no-git-hook`. Defaults to removing a mdloop-managed hook. */
  removeGitHook?: boolean;
}

/**
 * `mdloop unlink` — reverses `mdloop link`: deletes
 * `.mdloop/` (manifest, config, credentials, lock, endpoint trust pin, the
 * nested `.gitignore`) and, by default, the git post-commit hook link
 * installed.
 *
 * Lock-protected for the same reason `push` is: unlinking while a push is
 * actually running must refuse rather than delete files the running push
 * still expects to write back to (the manifest) out from under it. A live
 * lock is therefore a hard refusal, not something unlink steals or overrides.
 *
 * The git hook default is "remove," the mirror image of link's default of
 * "install" — leaving a hook behind that still fires `mdloop push` against a
 * folder that just declared itself unlinked would be a silent surprise the
 * next time someone commits.
 */
export async function runUnlink(options: UnlinkOptions, io: Io): Promise<number> {
  const manifest = await readManifest(options.folder);
  if (!manifest) {
    io.errln(`${options.folder} is not linked. Nothing to do.`);
    return 1;
  }

  let lock: LockInfo;
  try {
    lock = await acquireLock(options.folder);
  } catch (error) {
    io.errln((error as Error).message);
    return 1;
  }

  try {
    if (options.removeGitHook !== false) await reportGitHookUninstall(options.folder, io);
    await rm(mdloopDir(options.folder), { recursive: true, force: true });
    io.println(`Unlinked ${options.folder} (was linked to project ${manifest.projectId})`);
    return 0;
  } finally {
    await releaseLock(options.folder, lock);
  }
}

/**
 * Mirrors `reportGitHookInstall` in `link.ts`: an outcome that changed
 * something, or that the user needs to know about, says so in full; an
 * outcome that changed nothing (`not_present`, `not_a_git_repo`) stays quiet.
 */
async function reportGitHookUninstall(folder: string, io: Io): Promise<void> {
  const result = await uninstallGitPostCommitHook(folder);
  switch (result) {
    case 'removed':
      io.println('Removed the git post-commit hook — commits will no longer push to mdloop.');
      break;
    case 'foreign':
      io.println(
        'A git post-commit hook exists but was not installed by "mdloop link" — left untouched.',
      );
      break;
    case 'not_present':
    case 'not_a_git_repo':
      // Nothing changed, nothing to report — same philosophy as link.ts.
      break;
  }
}
