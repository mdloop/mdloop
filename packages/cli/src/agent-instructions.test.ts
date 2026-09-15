import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INSTRUCTIONS_BEGIN,
  INSTRUCTIONS_BLOCK,
  INSTRUCTIONS_END,
  globalAgentInstructionsStatus,
  installGlobalAgentInstructions,
  installRepoAgentInstructions,
  repoAgentInstructionsStatus,
  resolveRepoInstructionsFile,
  uninstallGlobalAgentInstructions,
  uninstallRepoAgentInstructions,
} from './agent-instructions.js';

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

describe('installRepoAgentInstructions / repo scope', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-instructions-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('creates AGENTS.md when neither file exists', async () => {
    const { file, result } = await installRepoAgentInstructions(folder);
    expect(file).toBe(path.join(folder, 'AGENTS.md'));
    expect(result).toBe('created');
    expect(await readFile(file, 'utf8')).toBe(`${INSTRUCTIONS_BLOCK}\n`);
  });

  it('prefers an existing CLAUDE.md over AGENTS.md', async () => {
    const claudeMd = path.join(folder, 'CLAUDE.md');
    await writeFile(claudeMd, '# Project notes\n\nSome existing guidance.\n', 'utf8');
    const { file, result } = await installRepoAgentInstructions(folder);
    expect(file).toBe(claudeMd);
    expect(result).toBe('installed');
    expect(await exists(path.join(folder, 'AGENTS.md'))).toBe(false);
  });

  it('appends to an existing file, leaving prior content byte-identical', async () => {
    const claudeMd = path.join(folder, 'CLAUDE.md');
    const original = '# Project notes\n\nSome existing guidance.\n';
    await writeFile(claudeMd, original, 'utf8');
    await installRepoAgentInstructions(folder);
    const content = await readFile(claudeMd, 'utf8');
    expect(content.startsWith(original)).toBe(true);
    expect(content).toBe(`${original}\n${INSTRUCTIONS_BLOCK}\n`);
  });

  it('is idempotent — a second run reports unchanged and does not stack a duplicate block', async () => {
    const claudeMd = path.join(folder, 'CLAUDE.md');
    await writeFile(claudeMd, '# Notes\n', 'utf8');
    await installRepoAgentInstructions(folder);
    const first = await readFile(claudeMd, 'utf8');
    const { result } = await installRepoAgentInstructions(folder);
    expect(result).toBe('unchanged');
    expect(await readFile(claudeMd, 'utf8')).toBe(first);
    expect(first.split(INSTRUCTIONS_BEGIN)).toHaveLength(2);
  });

  it('regenerates a hand-edited block in place, leaving surrounding content untouched', async () => {
    const claudeMd = path.join(folder, 'CLAUDE.md');
    await writeFile(claudeMd, '# Before\n', 'utf8');
    await installRepoAgentInstructions(folder);
    const installed = await readFile(claudeMd, 'utf8');
    const tampered = installed.replace(
      `${INSTRUCTIONS_BEGIN}\n## Review loop (mdloop)`,
      `${INSTRUCTIONS_BEGIN}\n## Hand-edited heading`,
    );
    await writeFile(claudeMd, `${tampered}\n## After\n`, 'utf8');

    const { result } = await installRepoAgentInstructions(folder);
    expect(result).toBe('updated');
    const final = await readFile(claudeMd, 'utf8');
    expect(final).toContain('# Before\n');
    expect(final).toContain('## After\n');
    expect(final).not.toContain('Hand-edited heading');
    expect(final).toContain(INSTRUCTIONS_BLOCK);
  });

  it('leaves a half-marked file untouched and reports foreign', async () => {
    const claudeMd = path.join(folder, 'CLAUDE.md');
    const broken = `# Notes\n\n${INSTRUCTIONS_BEGIN}\nsomething went wrong here, no end marker\n`;
    await writeFile(claudeMd, broken, 'utf8');
    const { result } = await installRepoAgentInstructions(folder);
    expect(result).toBe('foreign');
    expect(await readFile(claudeMd, 'utf8')).toBe(broken);
  });

  it('reports foreign when the end marker precedes the begin marker', async () => {
    const claudeMd = path.join(folder, 'CLAUDE.md');
    const broken = `${INSTRUCTIONS_END}\nstuff\n${INSTRUCTIONS_BEGIN}\n`;
    await writeFile(claudeMd, broken, 'utf8');
    const { result } = await installRepoAgentInstructions(folder);
    expect(result).toBe('foreign');
    expect(await readFile(claudeMd, 'utf8')).toBe(broken);
  });

  it('round-trips: install then uninstall restores the original file', async () => {
    const claudeMd = path.join(folder, 'CLAUDE.md');
    const original = '# Project notes\n\nSome existing guidance.\n';
    await writeFile(claudeMd, original, 'utf8');
    await installRepoAgentInstructions(folder);
    const { result } = await uninstallRepoAgentInstructions(folder);
    expect(result).toBe('removed');
    expect(await readFile(claudeMd, 'utf8')).toBe(original);
  });

  it('uninstall deletes a file it created outright rather than leaving it empty', async () => {
    await installRepoAgentInstructions(folder);
    const file = path.join(folder, 'AGENTS.md');
    expect(await exists(file)).toBe(true);
    const { result } = await uninstallRepoAgentInstructions(folder);
    expect(result).toBe('removed');
    expect(await exists(file)).toBe(false);
  });

  it('uninstall leaves a foreign file byte-for-byte untouched', async () => {
    const claudeMd = path.join(folder, 'CLAUDE.md');
    const foreign = '# Just notes, no mdloop block\n';
    await writeFile(claudeMd, foreign, 'utf8');
    const { result } = await uninstallRepoAgentInstructions(folder);
    expect(result).toBe('not_present');
    expect(await readFile(claudeMd, 'utf8')).toBe(foreign);
  });
});

describe('repoAgentInstructionsStatus', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-instructions-status-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('reports missing when neither file exists', async () => {
    const { status } = await repoAgentInstructionsStatus(folder);
    expect(status).toBe('missing');
  });

  it('has zero side effects — checking status creates nothing', async () => {
    await repoAgentInstructionsStatus(folder);
    expect(await exists(path.join(folder, 'CLAUDE.md'))).toBe(false);
    expect(await exists(path.join(folder, 'AGENTS.md'))).toBe(false);
  });

  it('reports managed after install', async () => {
    await installRepoAgentInstructions(folder);
    const { status } = await repoAgentInstructionsStatus(folder);
    expect(status).toBe('managed');
  });

  it('reports foreign for a file with unrelated content and no marker as missing, not foreign', async () => {
    // Absence of the marker in an otherwise-normal file is "missing" (nothing installed yet),
    // not "foreign" — "foreign" is reserved for a corrupted/half-present marker.
    await writeFile(path.join(folder, 'CLAUDE.md'), '# Just some notes\n', 'utf8');
    const { status } = await repoAgentInstructionsStatus(folder);
    expect(status).toBe('missing');
  });
});

describe('global scope', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-instructions-home-'));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('writes ~/.claude/CLAUDE.md, creating ~/.claude if it does not exist', async () => {
    const outcomes = await installGlobalAgentInstructions(homeDir);
    const claude = outcomes.find((o) => o.agent === 'claude');
    expect(claude?.result).toBe('created');
    expect(await readFile(path.join(homeDir, '.claude', 'CLAUDE.md'), 'utf8')).toBe(
      `${INSTRUCTIONS_BLOCK}\n`,
    );
  });

  it('skips ~/.codex/AGENTS.md and reports no_target_dir when ~/.codex does not exist', async () => {
    const outcomes = await installGlobalAgentInstructions(homeDir);
    const codex = outcomes.find((o) => o.agent === 'codex');
    expect(codex?.result).toBe('no_target_dir');
    expect(await exists(path.join(homeDir, '.codex'))).toBe(false);
  });

  it('writes ~/.codex/AGENTS.md when ~/.codex already exists — never creates the dir itself', async () => {
    await mkdir(path.join(homeDir, '.codex'), { recursive: true });
    const outcomes = await installGlobalAgentInstructions(homeDir);
    const codex = outcomes.find((o) => o.agent === 'codex');
    expect(codex?.result).toBe('created');
    expect(await readFile(path.join(homeDir, '.codex', 'AGENTS.md'), 'utf8')).toBe(
      `${INSTRUCTIONS_BLOCK}\n`,
    );
  });

  it('status reports no_target_dir for codex and missing for claude on a bare home dir', async () => {
    const outcomes = await globalAgentInstructionsStatus(homeDir);
    expect(outcomes.find((o) => o.agent === 'claude')?.status).toBe('missing');
    expect(outcomes.find((o) => o.agent === 'codex')?.status).toBe('no_target_dir');
  });

  it('uninstall removes both files it can reach and reports no_target_dir for the rest', async () => {
    await mkdir(path.join(homeDir, '.codex'), { recursive: true });
    await installGlobalAgentInstructions(homeDir);
    const outcomes = await uninstallGlobalAgentInstructions(homeDir);
    expect(outcomes.find((o) => o.agent === 'claude')?.result).toBe('removed');
    expect(outcomes.find((o) => o.agent === 'codex')?.result).toBe('removed');
  });
});

describe('resolveRepoInstructionsFile', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-instructions-resolve-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('picks AGENTS.md when neither file exists', async () => {
    expect(await resolveRepoInstructionsFile(folder)).toBe(path.join(folder, 'AGENTS.md'));
  });

  it('picks CLAUDE.md when it already exists, even alongside an AGENTS.md', async () => {
    await writeFile(path.join(folder, 'CLAUDE.md'), '# notes\n', 'utf8');
    await writeFile(path.join(folder, 'AGENTS.md'), '# other notes\n', 'utf8');
    expect(await resolveRepoInstructionsFile(folder)).toBe(path.join(folder, 'CLAUDE.md'));
  });
});
