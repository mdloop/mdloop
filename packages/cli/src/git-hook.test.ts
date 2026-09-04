import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GIT_HOOK_MARKER,
  GIT_HOOK_PUSH_LINE,
  POST_COMMIT_HOOK,
  gitHookStatus,
  installGitPostCommitHook,
  resolveGitRoot,
  uninstallGitPostCommitHook,
} from './git-hook.js';

const run = promisify(execFile);

async function gitInit(folder: string): Promise<void> {
  await run('git', ['init', '--quiet'], { cwd: folder });
}

function hookPath(folder: string): string {
  return path.join(folder, '.git', 'hooks', 'post-commit');
}

async function isExecutable(file: string): Promise<boolean> {
  const { mode } = await stat(file);
  return (mode & 0o111) !== 0;
}

describe('installGitPostCommitHook', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-hook-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('writes an executable hook into a fresh git repo', async () => {
    await gitInit(folder);
    expect(await installGitPostCommitHook(folder)).toBe('installed');
    expect(await readFile(hookPath(folder), 'utf8')).toBe(POST_COMMIT_HOOK);
    expect(await isExecutable(hookPath(folder))).toBe(true);
  });

  it('marks the hook as ours on the line after the shebang', async () => {
    await gitInit(folder);
    await installGitPostCommitHook(folder);
    const lines = (await readFile(hookPath(folder), 'utf8')).split('\n');
    expect(lines[0]).toBe('#!/usr/bin/env bash');
    expect(lines[1]).toBe(GIT_HOOK_MARKER);
  });

  it('is idempotent — a second run reports unchanged and rewrites nothing', async () => {
    await gitInit(folder);
    await installGitPostCommitHook(folder);
    // Backdate several seconds so "did it rewrite?" is answerable without
    // depending on filesystem timestamp resolution.
    const backdated = new Date(Date.now() - 5000);
    await utimes(hookPath(folder), backdated, backdated);
    expect(await installGitPostCommitHook(folder)).toBe('unchanged');
    // Closeness, not equality. `utimes` hands the filesystem a value it stores
    // at its own precision and hands back rounded: ext4 returns fractional
    // milliseconds, so an exact `toBe` compared 1787944435970.999 against
    // 1787944435971 and failed on Linux while passing on macOS/APFS, which
    // stores whole milliseconds. The assertion only has to distinguish "not
    // rewritten" from "rewritten", and a rewrite moves mtime forward by the
    // full 5s backdate — four orders of magnitude clear of this tolerance.
    expect((await stat(hookPath(folder))).mtimeMs).toBeCloseTo(backdated.getTime(), -1);
  });

  it('upgrades a stale hook of ours in place', async () => {
    await gitInit(folder);
    await installGitPostCommitHook(folder);
    // An older mdloop-managed hook: our marker, different body.
    await writeFile(
      hookPath(folder),
      `#!/usr/bin/env bash\n${GIT_HOOK_MARKER}\nmdloop push --ancient-flag\n`,
      'utf8',
    );
    expect(await installGitPostCommitHook(folder)).toBe('updated');
    const content = await readFile(hookPath(folder), 'utf8');
    expect(content).toBe(POST_COMMIT_HOOK);
    expect(content).not.toMatch(/ancient-flag/);
    expect(await isExecutable(hookPath(folder))).toBe(true);
  });

  it('leaves a foreign hook byte-for-byte untouched', async () => {
    await gitInit(folder);
    const foreign = '#!/bin/sh\n# husky\n. "$(dirname "$0")/_/husky.sh"\nnpx lint-staged\n';
    await writeFile(hookPath(folder), foreign, { encoding: 'utf8', mode: 0o755 });
    expect(await installGitPostCommitHook(folder)).toBe('foreign');
    expect(await readFile(hookPath(folder), 'utf8')).toBe(foreign);
  });

  it('offers a paste-able one-liner for the foreign-hook case', () => {
    expect(GIT_HOOK_PUSH_LINE).toMatch(/mdloop/);
    expect(GIT_HOOK_PUSH_LINE).toMatch(/push --note/);
    expect(GIT_HOOK_PUSH_LINE).toMatch(/MDLOOP_CLI_PATH/);
    // One line, so it can go straight into an existing hook.
    expect(GIT_HOOK_PUSH_LINE).not.toMatch(/\n/);
  });

  it('does nothing at all outside a git repo', async () => {
    expect(await installGitPostCommitHook(folder)).toBe('not_a_git_repo');
    expect(await readdir(folder)).toEqual([]);
  });
});

describe('uninstallGitPostCommitHook', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-unhook-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('removes a mdloop-managed hook and returns removed', async () => {
    await gitInit(folder);
    await installGitPostCommitHook(folder);
    expect(await uninstallGitPostCommitHook(folder)).toBe('removed');
    await expect(readFile(hookPath(folder), 'utf8')).rejects.toThrow();
  });

  it('leaves a foreign hook byte-for-byte untouched and returns foreign', async () => {
    await gitInit(folder);
    const foreign = '#!/bin/sh\n# husky\n. "$(dirname "$0")/_/husky.sh"\nnpx lint-staged\n';
    await writeFile(hookPath(folder), foreign, { encoding: 'utf8', mode: 0o755 });
    expect(await uninstallGitPostCommitHook(folder)).toBe('foreign');
    expect(await readFile(hookPath(folder), 'utf8')).toBe(foreign);
  });

  it('returns not_present in a git repo with no hook file', async () => {
    await gitInit(folder);
    expect(await uninstallGitPostCommitHook(folder)).toBe('not_present');
  });

  it('returns not_a_git_repo outside a repo', async () => {
    expect(await uninstallGitPostCommitHook(folder)).toBe('not_a_git_repo');
  });
});

describe('gitHookStatus', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-hookstatus-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('returns not_a_git_repo outside a repo', async () => {
    expect(await gitHookStatus(folder)).toBe('not_a_git_repo');
  });

  it('returns missing inside a fresh repo with no hook file', async () => {
    await gitInit(folder);
    expect(await gitHookStatus(folder)).toBe('missing');
  });

  it('returns foreign for a hand-written hook', async () => {
    await gitInit(folder);
    await writeFile(hookPath(folder), '#!/bin/sh\nnpx lint-staged\n', {
      encoding: 'utf8',
      mode: 0o755,
    });
    expect(await gitHookStatus(folder)).toBe('foreign');
  });

  it('returns mdloop_managed after installGitPostCommitHook', async () => {
    await gitInit(folder);
    await installGitPostCommitHook(folder);
    expect(await gitHookStatus(folder)).toBe('mdloop_managed');
  });

  it('has zero side effects — a fresh repo gets no post-commit file from just checking', async () => {
    await gitInit(folder);
    expect(await gitHookStatus(folder)).toBe('missing');
    // `git init` seeds `.git/hooks/` with its own `*.sample` files, so the
    // side-effect-free assertion is about the specific file, not the dir.
    await expect(readFile(hookPath(folder), 'utf8')).rejects.toThrow();
  });
});

describe('resolveGitRoot', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-root-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('finds the root from a nested subdirectory', async () => {
    await gitInit(folder);
    const nested = path.join(folder, 'docs', 'deep');
    await mkdir(nested, { recursive: true });
    // git reports the realpath; macOS tmpdir is a symlink into /private.
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd: folder });
    expect(await resolveGitRoot(nested)).toBe(stdout.trim());
  });

  it('returns undefined rather than throwing outside a repo', async () => {
    expect(await resolveGitRoot(folder)).toBeUndefined();
  });
});
