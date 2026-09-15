import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * mdloop's whole premise is that a human signs off on agent-written markdown — but nothing tells a
 * coding agent to actually route its plans and artifacts *through* mdloop instead of presenting
 * them inline in the transcript for a rubber-stamp. This module is that instruction, written into
 * a file the agent already reads on its own: `CLAUDE.md`/`AGENTS.md` at repo scope (written by
 * `mdloop link`, so it travels via git the way `.mdloop/` already does — see link.ts), or the
 * equivalent global config (written once per machine by `install.sh`, via `mdloop instructions
 * install --global`, so every repo is steered without per-repo setup).
 *
 * Structurally this mirrors git-hook.ts on purpose: a marker identifying a span we own, an
 * install/status/uninstall triple with explicit result unions including `'foreign'`, and the same
 * rule — a file carrying our marker is ours to regenerate, a file (or span) without it is left
 * completely untouched. The one deliberate divergence: `installGitPostCommitHook` treats an
 * unmarked *file* as foreign and refuses outright, because a hook script is expected to be nothing
 * but our content. A `CLAUDE.md` is expected to have other content, so an unmarked file here is
 * appended to, not refused.
 *
 * This is a bigger deal than the git hook, and worth being honest about: `.git/hooks/post-commit`
 * is untracked, invisible to teammates. A `CLAUDE.md`/`AGENTS.md` block is git-tracked and shows up
 * in every diff — see the ADR this shipped with.
 */

export const INSTRUCTIONS_BEGIN =
  '<!-- mdloop:begin — managed by mdloop; safe to regenerate, do not hand-edit -->';
export const INSTRUCTIONS_END = '<!-- mdloop:end -->';

/**
 * The payload. Kept short on purpose — this lands in a file other people own, and every extra line
 * here is a line every teammate's agent re-reads on every turn. Names the real MCP tools
 * (`upload_document`, `request_review`, `get_review_status`, `get_feedback_bundle` — registered in
 * `packages/mcp/src/server.ts`) rather than describing the loop in the abstract, and says plainly
 * that the agent's own summary is not sign-off — the specific inline-approval habit this exists to
 * break.
 */
const INSTRUCTIONS_BODY = `## Review loop (mdloop)

Plans and review-worthy artifacts — specs, PRDs, design docs, ADRs, runbooks, implementation
plans — go through mdloop for human sign-off, never presented for approval inline in the
transcript.

1. \`upload_document\` the markdown, with a \`change_note\` saying what changed and why.
2. \`request_review\` naming the human who signs off; hand them the \`url\` it returns.
3. \`get_review_status\` for the verdict; \`get_feedback_bundle\` for comments still to act on.
4. Revise, then \`upload_document\` again — every upload is a new immutable version.

Your own summary of a document is not sign-off. Approval is a recorded human verdict.`;

/** The exact span `installBlock` writes and `findManagedSpan` looks for. No trailing newline. */
export const INSTRUCTIONS_BLOCK = `${INSTRUCTIONS_BEGIN}\n${INSTRUCTIONS_BODY}\n${INSTRUCTIONS_END}`;

interface BlockTarget {
  /** Absolute path of the file to write the block into. */
  file: string;
  /**
   * Whether this file's parent directory may be created if missing. `true` for a repo's
   * CLAUDE.md/AGENTS.md (the parent is the repo root, which always exists by construction) and for
   * `~/.claude` (mdloop's primary agent integration — always ensured). `false` for a target like
   * `~/.codex`: creating a config directory for a tool the user may not have installed is
   * presumptuous, so a missing one is reported (`'no_target_dir'`) rather than created.
   */
  ensureDir: boolean;
}

export type InstructionInstallResult =
  'created' | 'installed' | 'updated' | 'unchanged' | 'foreign' | 'no_target_dir';
export type InstructionStatus = 'missing' | 'managed' | 'foreign' | 'no_target_dir';
export type InstructionRemoveResult = 'removed' | 'foreign' | 'not_present' | 'no_target_dir';

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

interface ManagedSpan {
  /** Index of the first character of `INSTRUCTIONS_BEGIN`. */
  start: number;
  /** Index just past `INSTRUCTIONS_END`, plus one trailing `\n` if present — see the doc comment. */
  end: number;
}

/**
 * Locates the block inside `content`, tolerant of exactly where it sits — same philosophy as
 * `isMdloopManagedHook` in git-hook.ts ("tolerate ... rather than being brittle about exact
 * position"). `end` absorbs a single trailing newline so a replace can splice the span back out
 * without leaving (or losing) a blank line relative to what a clean install produces.
 *
 * Returns `undefined` when neither marker is present (nothing to do — the caller appends fresh),
 * `'foreign'` when only one marker is present or `end` precedes `begin` (something unexpected
 * happened; guessing the span risks eating content that isn't ours), or the span otherwise.
 */
function findManagedSpan(content: string): ManagedSpan | 'foreign' | undefined {
  const beginIdx = content.indexOf(INSTRUCTIONS_BEGIN);
  const endIdx = content.indexOf(INSTRUCTIONS_END);
  if (beginIdx === -1 && endIdx === -1) return undefined;
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return 'foreign';

  let end = endIdx + INSTRUCTIONS_END.length;
  if (content[end] === '\n') end += 1;
  return { start: beginIdx, end };
}

/**
 * Installs or refreshes the block in `target.file`.
 *
 * - No file yet → written alone, `'created'`.
 * - File exists, no marker → appended after a normalized single blank line (or, for an empty
 *   file, with no separator at all), `'installed'`. This is the divergence from git-hook.ts noted
 *   in the module doc comment: an unmarked file is expected content here, not a refusal.
 * - File exists, marker present → **only** the span between the markers is replaced, byte-identical
 *   before and after; `'updated'`, or `'unchanged'` if the span already matches. This is what makes
 *   a re-run upgrade the block instead of stacking duplicates.
 * - Only one marker, or `end` before `begin` → `'foreign'`, file untouched. A half-marked file means
 *   something unexpected happened; the marker's own text says "safe to regenerate", but a corrupted
 *   marker is not a marker we trust.
 * - Target's directory missing and `ensureDir` is false → `'no_target_dir'`, nothing written.
 */
export async function installBlock(target: BlockTarget): Promise<InstructionInstallResult> {
  const dir = path.dirname(target.file);
  if (target.ensureDir) {
    await mkdir(dir, { recursive: true });
  } else if (!(await dirExists(dir))) {
    return 'no_target_dir';
  }

  let current: string | undefined;
  try {
    current = await readFile(target.file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (current === undefined) {
    await writeFile(target.file, `${INSTRUCTIONS_BLOCK}\n`, 'utf8');
    return 'created';
  }

  const span = findManagedSpan(current);
  if (span === 'foreign') return 'foreign';

  if (span === undefined) {
    const trimmed = current.replace(/\s+$/, '');
    const next =
      trimmed === '' ? `${INSTRUCTIONS_BLOCK}\n` : `${trimmed}\n\n${INSTRUCTIONS_BLOCK}\n`;
    await writeFile(target.file, next, 'utf8');
    return 'installed';
  }

  const before = current.slice(0, span.start);
  const after = current.slice(span.end);
  const next = `${before}${INSTRUCTIONS_BLOCK}\n${after}`;
  if (next === current) return 'unchanged';
  await writeFile(target.file, next, 'utf8');
  return 'updated';
}

/** Read-only classification of `target.file` — never writes, so it is safe to call just to check. */
export async function blockStatus(target: BlockTarget): Promise<InstructionStatus> {
  if (!target.ensureDir && !(await dirExists(path.dirname(target.file)))) return 'no_target_dir';

  let current: string | undefined;
  try {
    current = await readFile(target.file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (current === undefined) return 'missing';

  const span = findManagedSpan(current);
  if (span === 'foreign') return 'foreign';
  return span === undefined ? 'missing' : 'managed';
}

/**
 * Removes the block from `target.file`, the counterpart `uninstallBlock` — mirrors
 * `uninstallGitPostCommitHook`'s non-clobbering rule: a foreign file/span is left byte-for-byte
 * untouched and reported, never guessed at.
 *
 * Collapses the blank-line separator `installBlock`'s append path adds, so installing then
 * uninstalling round-trips a file that ended in a single trailing newline (the common case) back to
 * its original bytes; a file already carrying unusual whitespace immediately around the block is
 * not guaranteed byte-for-byte, since nothing records which whitespace was ours to begin with. A
 * file that becomes empty as a result is deleted rather than left as a zero-byte file, so installing
 * into a brand-new file and then uninstalling leaves no file behind at all.
 */
export async function uninstallBlock(target: BlockTarget): Promise<InstructionRemoveResult> {
  if (!target.ensureDir && !(await dirExists(path.dirname(target.file)))) return 'no_target_dir';

  let current: string | undefined;
  try {
    current = await readFile(target.file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (current === undefined) return 'not_present';

  const span = findManagedSpan(current);
  if (span === 'foreign') return 'foreign';
  if (span === undefined) return 'not_present';

  const before = current.slice(0, span.start).replace(/\n+$/, '');
  const after = current.slice(span.end);

  if (before === '' && after === '') {
    await rm(target.file, { force: true });
    return 'removed';
  }
  const next =
    after === ''
      ? `${before}\n`
      : before === ''
        ? after.replace(/^\n+/, '')
        : `${before}\n\n${after}`;
  await writeFile(target.file, next, 'utf8');
  return 'removed';
}

/** `CLAUDE.md` at repo root if it already exists, else `AGENTS.md` (created if neither is present). */
export async function resolveRepoInstructionsFile(folder: string): Promise<string> {
  const claudeMd = path.join(folder, 'CLAUDE.md');
  if (await fileExists(claudeMd)) return claudeMd;
  return path.join(folder, 'AGENTS.md');
}

export interface RepoInstructionsOutcome {
  file: string;
  result: InstructionInstallResult;
}

/** Repo-scope install — called from `mdloop link` by default; `--no-agent-instructions` skips it. */
export async function installRepoAgentInstructions(
  folder: string,
): Promise<RepoInstructionsOutcome> {
  const file = await resolveRepoInstructionsFile(folder);
  const result = await installBlock({ file, ensureDir: false });
  return { file, result };
}

export async function repoAgentInstructionsStatus(
  folder: string,
): Promise<{ file: string; status: InstructionStatus }> {
  const file = await resolveRepoInstructionsFile(folder);
  return { file, status: await blockStatus({ file, ensureDir: false }) };
}

export async function uninstallRepoAgentInstructions(
  folder: string,
): Promise<{ file: string; result: InstructionRemoveResult }> {
  const file = await resolveRepoInstructionsFile(folder);
  return { file, result: await uninstallBlock({ file, ensureDir: false }) };
}

interface GlobalTarget {
  /** Short identifier for the coding agent this file belongs to — surfaced in CLI output. */
  agent: string;
  target: BlockTarget;
}

/**
 * Every machine-wide agent config file mdloop knows how to steer. `homeDir` defaults to the real
 * home directory and exists as a parameter purely so tests never touch it — no real caller passes
 * it. Adding a new agent is one more entry here, not a new code path.
 */
function globalTargets(homeDir: string): GlobalTarget[] {
  return [
    {
      agent: 'claude',
      target: { file: path.join(homeDir, '.claude', 'CLAUDE.md'), ensureDir: true },
    },
    {
      agent: 'codex',
      target: { file: path.join(homeDir, '.codex', 'AGENTS.md'), ensureDir: false },
    },
  ];
}

export interface GlobalInstructionsOutcome {
  agent: string;
  file: string;
  result: InstructionInstallResult;
}

/** User-scope install — called once per machine by `install.sh` (`mdloop instructions install --global`). */
export async function installGlobalAgentInstructions(
  homeDir: string = homedir(),
): Promise<GlobalInstructionsOutcome[]> {
  const outcomes: GlobalInstructionsOutcome[] = [];
  for (const { agent, target } of globalTargets(homeDir)) {
    outcomes.push({ agent, file: target.file, result: await installBlock(target) });
  }
  return outcomes;
}

export async function globalAgentInstructionsStatus(
  homeDir: string = homedir(),
): Promise<{ agent: string; file: string; status: InstructionStatus }[]> {
  const outcomes: { agent: string; file: string; status: InstructionStatus }[] = [];
  for (const { agent, target } of globalTargets(homeDir)) {
    outcomes.push({ agent, file: target.file, status: await blockStatus(target) });
  }
  return outcomes;
}

export async function uninstallGlobalAgentInstructions(
  homeDir: string = homedir(),
): Promise<{ agent: string; file: string; result: InstructionRemoveResult }[]> {
  const outcomes: { agent: string; file: string; result: InstructionRemoveResult }[] = [];
  for (const { agent, target } of globalTargets(homeDir)) {
    outcomes.push({ agent, file: target.file, result: await uninstallBlock(target) });
  }
  return outcomes;
}
