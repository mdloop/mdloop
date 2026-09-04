import { readMdloopConfig } from './mdloop-config.js';
import { gitHookStatus } from './git-hook.js';

/**
 * Closes a specific silent gap: `mdloop link` run before `git init` skips
 * installing the commit-trigger hook — that is link's own established,
 * deliberate behaviour for a folder that genuinely has no git yet, and there
 * is nothing wrong with it in the moment. The problem is that nothing ever
 * points out the gap again once the folder *does* become a git repo (a plain
 * `git init` after the fact). `.mdloop/config.json` still says `trigger:
 * "commit"` (the default), but neither push mechanism is actually active:
 * the git hook was never installed, and the Claude Code plugin's Stop hook
 * deliberately stands down whenever it reads `"commit"`, on the assumption
 * that the git hook is the one doing the job (see
 * `claude-plugin/hooks/mdloop-sync.sh`). The result is a linked folder that
 * looks configured but never pushes anything, automatically, ever — until
 * someone notices by hand.
 *
 * This is the check that closes that loop: called from `push`/`status` (both
 * already touch the filesystem locally before any network call), so every
 * routine run of either command re-surfaces the gap for as long as it exists.
 *
 * Returns undefined whenever there is nothing to warn about:
 * - the resolved trigger is `'agent-turn'` — the Stop hook is the active
 *   mechanism regardless of whether a git hook exists, so there's nothing
 *   wrong to report;
 * - `gitHookStatus` is `'not_a_git_repo'` — this folder still has no git at
 *   all, which is a different, not-actionable-the-same-way state that
 *   `link` already had its own moment to report (re-running `mdloop link`
 *   would not fix it, since there is still no git to hook);
 * - `gitHookStatus` is `'foreign'` or `'mdloop_managed'` — a hook already
 *   exists (someone else's, or ours), so this is simply not the scenario
 *   this function exists to catch.
 *
 * Only `gitHookStatus() === 'missing'` — a real git repo, hook genuinely
 * absent — produces the warning string below.
 */
export async function commitTriggerMissingHookWarning(folder: string): Promise<string | undefined> {
  const config = await readMdloopConfig(folder);
  // No config file yet is the CLI-side default before anyone edited
  // anything — same tolerant fallback `readMdloopConfig` itself applies.
  const trigger = config?.trigger ?? 'commit';
  if (trigger === 'agent-turn') return undefined;

  const status = await gitHookStatus(folder);
  if (status !== 'missing') return undefined;

  return (
    'trigger is "commit" but no git post-commit hook is installed — nothing pushes ' +
    'automatically. Re-run "mdloop link" to install it (this can happen if link ran ' +
    'before "git init").'
  );
}
