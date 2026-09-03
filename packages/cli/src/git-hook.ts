import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * `git commit` is the one sync trigger that is harness-agnostic by
 * construction: a git hook fires identically whether the edit came from Claude Code, Codex,
 * Cursor, VS Code, opencode, or a human typing in vim. Every per-harness
 * turn-completion hook, by contrast, has its own exit-code contract and its
 * own failure model — four adapters to build and keep working.
 *
 * So the canonical post-commit script lives here, in the CLI, and `vorlyn link`
 * installs it. It used to live in `claude-plugin/hooks/post-commit.sh.template`
 * as a copy-it-yourself recipe; that file is gone, because two copies of one
 * script drift and because commit-triggered sync was never Claude-Code-specific
 * in the first place.
 */
export const GIT_HOOK_MARKER = '# Managed by "vorlyn link" — safe to regenerate; do not hand-edit.';

/**
 * The single line a user can paste into a post-commit hook they already own.
 * This is the graceful-degradation path: when a foreign hook is present we
 * never touch it, we print this instead.
 *
 * `command -v vorlyn` covers a global npm install; `VORLYN_CLI_PATH` is the
 * escape hatch for a monorepo build that is not on PATH — the same fallback
 * the Claude Code Stop hook honours. Trailing `|| true` so the line is safe to
 * drop into a hook running under `set -e`.
 */
export const GIT_HOOK_PUSH_LINE =
  'VORLYN=$(command -v vorlyn || printf \'%s\' "${VORLYN_CLI_PATH:-}"); ' +
  '[ -x "$VORLYN" ] && "$VORLYN" push --note "$(git log -1 --pretty=%s)" --quiet || true';

/**
 * The whole hook body. Same rules as the Claude Code Stop hook: always exit 0
 * (a failed sync must never fail a commit — the commit already happened), and
 * silent unless something actually went wrong.
 */
export const POST_COMMIT_HOOK = `#!/usr/bin/env bash
${GIT_HOOK_MARKER}
#
# Vorlyn sync — pushes tracked markdown files to Vorlyn after every commit.
# Installed by \`vorlyn link\`; skip it with \`vorlyn link --no-git-hook\`, and
# delete this file to turn commit-triggered sync off.
#
# Harness-agnostic on purpose: this fires no matter which editor or coding
# agent produced the change.
#
# A failed sync must never fail a commit — the commit already happened — so
# every path here exits 0, and nothing is printed unless it matters.
set -u

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -n "$REPO_ROOT" ] || exit 0

# Not linked → nothing to do, quietly.
[ -f "$REPO_ROOT/.vorlyn/manifest.json" ] || exit 0

# Locate the CLI. VORLYN_CLI_PATH is the escape hatch for a monorepo build that
# is not on PATH; no CLI at all is a silent no-op, not an error.
VORLYN=$(command -v vorlyn 2>/dev/null) || VORLYN=""
if [ -z "$VORLYN" ] && [ -n "\${VORLYN_CLI_PATH:-}" ] && [ -x "\${VORLYN_CLI_PATH}" ]; then
  VORLYN="$VORLYN_CLI_PATH"
fi
[ -n "$VORLYN" ] || exit 0

# The commit subject is the change note: it is already the human's own summary
# of what changed, which is exactly what Vorlyn's Compare surface shows the
# reviewer. Write commit subjects accordingly.
cd "$REPO_ROOT" || exit 0
"$VORLYN" push --note "$(git log -1 --pretty=%s)" --quiet

exit 0
`;

const HOOK_FILENAME = 'post-commit';

/**
 * Repo root for `folder`, or undefined when it is not inside a git repo.
 *
 * Tolerant rather than throwing, matching how `push`/`status` treat "not
 * linked" as a clean return: a folder outside git is a perfectly ordinary
 * thing to link, it just cannot have a commit trigger.
 *
 * `execFile` with array args, never a shell string — a folder path is
 * attacker-influenceable in principle and there is no reason to hand it to a
 * shell.
 */
export async function resolveGitRoot(folder: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd: folder });
    const root = stdout.trim();
    return root === '' ? undefined : root;
  } catch {
    return undefined;
  }
}

/**
 * Where git actually looks for hooks. `--git-path hooks` is used rather than
 * `<root>/.git/hooks` because it is correct in the two cases the naive join is
 * not: a linked worktree (where `.git` is a file, not a directory) and a repo
 * that sets `core.hooksPath`.
 */
async function resolveHooksDir(folder: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--git-path', 'hooks'], { cwd: folder });
    const hooks = stdout.trim();
    return hooks === '' ? undefined : path.resolve(folder, hooks);
  } catch {
    return undefined;
  }
}

export type GitHookInstallResult =
  'installed' | 'updated' | 'unchanged' | 'foreign' | 'not_a_git_repo';

/** True when a `post-commit` already on disk is one we wrote. */
function isVorlynManagedHook(content: string): boolean {
  // The marker sits on the line after the shebang; tolerate a stray blank or
  // comment line ahead of it rather than being brittle about exact position.
  return content.split('\n', 3).some((line) => line.trimEnd() === GIT_HOOK_MARKER);
}

/**
 * Installs (or refreshes) `.git/hooks/post-commit`.
 *
 * Writing an executable that fires on every future `git commit` is a bigger
 * deal than the other local-state writes this CLI makes, so it follows the
 * same non-clobbering philosophy as `ensureVorlynGitignore` and the endpoint
 * trust pin, only stricter:
 *
 * - not a git repo → nothing is written at all;
 * - no hook present → write ours, mode 0o755 (passed to `writeFile`, not
 *   chmod'd after, same as `writeCredentials`);
 * - a hook present carrying our marker → we own it, so overwrite with the
 *   current template. This is what makes re-running `vorlyn link` upgrade the
 *   installed hook whenever its logic changes;
 * - a hook present *without* our marker → someone else's (Husky, lint-staged,
 *   a hand-rolled script). Left completely untouched. The caller prints
 *   `GIT_HOOK_PUSH_LINE` so the user can opt in by hand.
 *
 * Never destructive, never silent about what it did.
 */
export async function installGitPostCommitHook(folder: string): Promise<GitHookInstallResult> {
  if ((await resolveGitRoot(folder)) === undefined) return 'not_a_git_repo';
  const hooksDir = await resolveHooksDir(folder);
  if (hooksDir === undefined) return 'not_a_git_repo';

  const file = path.join(hooksDir, HOOK_FILENAME);
  let current: string | undefined;
  try {
    current = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (current === undefined) {
    await mkdir(hooksDir, { recursive: true });
    await writeFile(file, POST_COMMIT_HOOK, { encoding: 'utf8', mode: 0o755 });
    return 'installed';
  }

  if (!isVorlynManagedHook(current)) return 'foreign';
  if (current === POST_COMMIT_HOOK) return 'unchanged';

  await writeFile(file, POST_COMMIT_HOOK, 'utf8');
  // `writeFile`'s `mode` only applies at creation, so refresh it explicitly —
  // a hook git cannot execute is worse than no hook.
  await chmod(file, 0o755);
  return 'updated';
}

export type GitHookStatus = 'not_a_git_repo' | 'missing' | 'foreign' | 'vorlyn_managed';

/**
 * Read-only classification of `.git/hooks/post-commit` — same
 * `resolveGitRoot`/`resolveHooksDir` guards as `installGitPostCommitHook` and
 * `uninstallGitPostCommitHook`, but this one never writes or deletes
 * anything, so it is safe to call just to check.
 *
 * `'not_a_git_repo'` and `'missing'` are deliberately distinct: the former
 * means there was never any git for `vorlyn link`'s own hook-install step to
 * work with (its own established, silent-by-design behaviour); the latter
 * means we ARE inside a git repo right now and the hook still isn't there —
 * the state `trigger-drift.ts` exists to detect and report, since nothing
 * else ever revisits it once a folder becomes a git repo after the fact.
 */
export async function gitHookStatus(folder: string): Promise<GitHookStatus> {
  if ((await resolveGitRoot(folder)) === undefined) return 'not_a_git_repo';
  const hooksDir = await resolveHooksDir(folder);
  if (hooksDir === undefined) return 'not_a_git_repo';

  const file = path.join(hooksDir, HOOK_FILENAME);
  let current: string | undefined;
  try {
    current = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (current === undefined) return 'missing';
  return isVorlynManagedHook(current) ? 'vorlyn_managed' : 'foreign';
}

export type GitHookUninstallResult = 'removed' | 'foreign' | 'not_present' | 'not_a_git_repo';

/**
 * Removes `.git/hooks/post-commit`, the counterpart `vorlyn unlink` calls.
 *
 * Mirrors `installGitPostCommitHook`'s non-clobbering rule rather than
 * loosening it: unlink is allowed to undo only what link did, so a foreign
 * hook (Husky, lint-staged, hand-rolled) is left byte-for-byte untouched here
 * too, and reported rather than silently kept. Only a hook carrying our
 * marker is ever deleted.
 */
export async function uninstallGitPostCommitHook(folder: string): Promise<GitHookUninstallResult> {
  if ((await resolveGitRoot(folder)) === undefined) return 'not_a_git_repo';
  const hooksDir = await resolveHooksDir(folder);
  if (hooksDir === undefined) return 'not_a_git_repo';

  const file = path.join(hooksDir, HOOK_FILENAME);
  let current: string | undefined;
  try {
    current = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (current === undefined) return 'not_present';
  if (!isVorlynManagedHook(current)) return 'foreign';

  await rm(file, { force: true });
  return 'removed';
}
