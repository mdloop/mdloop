import {
  globalAgentInstructionsStatus,
  installGlobalAgentInstructions,
  installRepoAgentInstructions,
  repoAgentInstructionsStatus,
  uninstallGlobalAgentInstructions,
  uninstallRepoAgentInstructions,
} from './agent-instructions.js';
import type {
  GlobalInstructionsOutcome,
  InstructionInstallResult,
  InstructionRemoveResult,
  InstructionStatus,
  RepoInstructionsOutcome,
} from './agent-instructions.js';
import type { Io } from './output.js';

export interface InstructionsCommandOptions {
  folder: string;
  /** `true` for `mdloop instructions ... --global` — targets every agent's machine-wide config
   *  instead of this repo's CLAUDE.md/AGENTS.md. */
  global: boolean;
}

/**
 * `mdloop instructions install|status|remove` — the direct CLI surface onto `agent-instructions.ts`,
 * for anyone who wants to manage the review-loop block outside of `mdloop link`/`unlink` (which
 * drive the repo-scope case automatically). `--global` is the machine-wide case `install.sh` calls
 * once per machine so every repo is steered without per-repo setup.
 */
export async function runInstructions(
  subcommand: string | undefined,
  options: InstructionsCommandOptions,
  io: Io,
): Promise<number> {
  switch (subcommand) {
    case 'install':
      return options.global ? installGlobal(io) : installRepo(options.folder, io);
    case 'status':
      return options.global ? statusGlobal(io) : statusRepo(options.folder, io);
    case 'remove':
      return options.global ? removeGlobal(io) : removeRepo(options.folder, io);
    default:
      io.errln(
        `Unknown "mdloop instructions" subcommand: ${subcommand ?? '(none)'}. Use "install", "status", or "remove".`,
      );
      return 1;
  }
}

function describeInstall(result: InstructionInstallResult): string {
  switch (result) {
    case 'created':
      return 'created, with mdloop’s review-loop instructions';
    case 'installed':
      return 'the review-loop instructions were added';
    case 'updated':
      return 'the review-loop instructions were updated to the latest version';
    case 'unchanged':
      return 'already up to date';
    case 'foreign':
      return 'has a block that looks incomplete or hand-edited — left untouched';
    case 'no_target_dir':
      return 'skipped — its parent directory does not exist';
  }
}

async function installRepo(folder: string, io: Io): Promise<number> {
  const { file, result }: RepoInstructionsOutcome = await installRepoAgentInstructions(folder);
  io.println(`${file}: ${describeInstall(result)}`);
  return result === 'foreign' ? 1 : 0;
}

async function installGlobal(io: Io): Promise<number> {
  const outcomes: GlobalInstructionsOutcome[] = await installGlobalAgentInstructions();
  let failed = false;
  for (const { agent, file, result } of outcomes) {
    if (result === 'no_target_dir') {
      io.println(`${agent}: skipped ${file} — ${agent} does not appear to be installed here.`);
      continue;
    }
    io.println(`${agent}: ${file}: ${describeInstall(result)}`);
    if (result === 'foreign') failed = true;
  }
  return failed ? 1 : 0;
}

function describeStatus(status: InstructionStatus): string {
  switch (status) {
    case 'missing':
      return 'not installed';
    case 'managed':
      return 'installed';
    case 'foreign':
      return 'present but not ours — looks incomplete or hand-edited';
    case 'no_target_dir':
      return 'not applicable — parent directory does not exist';
  }
}

async function statusRepo(folder: string, io: Io): Promise<number> {
  const { file, status } = await repoAgentInstructionsStatus(folder);
  io.println(`${file}: ${describeStatus(status)}`);
  return 0;
}

async function statusGlobal(io: Io): Promise<number> {
  const outcomes = await globalAgentInstructionsStatus();
  for (const { agent, file, status } of outcomes) {
    io.println(`${agent} (${file}): ${describeStatus(status)}`);
  }
  return 0;
}

function describeRemove(result: InstructionRemoveResult): string {
  switch (result) {
    case 'removed':
      return 'removed';
    case 'not_present':
      return 'nothing to remove';
    case 'foreign':
      return 'has a block that was not installed by mdloop — left untouched';
    case 'no_target_dir':
      return 'nothing to remove — parent directory does not exist';
  }
}

async function removeRepo(folder: string, io: Io): Promise<number> {
  const { file, result } = await uninstallRepoAgentInstructions(folder);
  io.println(`${file}: ${describeRemove(result)}`);
  return result === 'foreign' ? 1 : 0;
}

async function removeGlobal(io: Io): Promise<number> {
  const outcomes = await uninstallGlobalAgentInstructions();
  let failed = false;
  for (const { agent, file, result } of outcomes) {
    io.println(`${agent} (${file}): ${describeRemove(result)}`);
    if (result === 'foreign') failed = true;
  }
  return failed ? 1 : 0;
}
