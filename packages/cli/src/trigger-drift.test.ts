import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mdloopConfigPath, ensureMdloopConfig } from './mdloop-config.js';
import { ensureMdloopDir } from './mdloop-dir.js';
import { installGitPostCommitHook } from './git-hook.js';
import { commitTriggerMissingHookWarning } from './trigger-drift.js';

const run = promisify(execFile);

async function gitInit(folder: string): Promise<void> {
  await run('git', ['init', '--quiet'], { cwd: folder });
}

function hookPath(folder: string): string {
  return path.join(folder, '.git', 'hooks', 'post-commit');
}

describe('commitTriggerMissingHookWarning', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-drift-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('warns when there is no config.json at all (default trigger is commit)', async () => {
    await gitInit(folder);
    expect(await commitTriggerMissingHookWarning(folder)).toBe(
      'trigger is "commit" but no git post-commit hook is installed — nothing pushes ' +
        'automatically. Re-run "mdloop link" to install it (this can happen if link ran ' +
        'before "git init").',
    );
  });

  it('warns with the exact message for an explicit commit trigger, git repo, no hook', async () => {
    await gitInit(folder);
    await ensureMdloopConfig(folder, 'commit');
    const warning = await commitTriggerMissingHookWarning(folder);
    expect(warning).toBe(
      'trigger is "commit" but no git post-commit hook is installed — nothing pushes ' +
        'automatically. Re-run "mdloop link" to install it (this can happen if link ran ' +
        'before "git init").',
    );
  });

  it('is silent when a mdloop-managed hook is installed', async () => {
    await gitInit(folder);
    await ensureMdloopConfig(folder, 'commit');
    await installGitPostCommitHook(folder);
    expect(await commitTriggerMissingHookWarning(folder)).toBeUndefined();
  });

  it('is silent when a foreign hook is present — not the scenario this warns about', async () => {
    await gitInit(folder);
    await ensureMdloopConfig(folder, 'commit');
    await writeFile(hookPath(folder), '#!/bin/sh\nnpx lint-staged\n', {
      encoding: 'utf8',
      mode: 0o755,
    });
    expect(await commitTriggerMissingHookWarning(folder)).toBeUndefined();
  });

  it('is silent outside a git repo — that is link’s own moment to have said something', async () => {
    await ensureMdloopConfig(folder, 'commit');
    expect(await commitTriggerMissingHookWarning(folder)).toBeUndefined();
  });

  it('is silent under agent-turn regardless of hook state — the Stop hook covers it', async () => {
    await gitInit(folder);
    await ensureMdloopConfig(folder, 'agent-turn');
    expect(await commitTriggerMissingHookWarning(folder)).toBeUndefined();
  });

  it('is silent under agent-turn even outside a git repo', async () => {
    await ensureMdloopConfig(folder, 'agent-turn');
    expect(await commitTriggerMissingHookWarning(folder)).toBeUndefined();
  });

  it('ignores unrelated fields in config.json (other tools may write them)', async () => {
    await gitInit(folder);
    await ensureMdloopDir(folder);
    await writeFile(
      mdloopConfigPath(folder),
      '{"trigger":"commit","includeGlobs":["docs/**"]}',
      'utf8',
    );
    expect(await commitTriggerMissingHookWarning(folder)).toMatch(/no git post-commit hook/);
  });
});
