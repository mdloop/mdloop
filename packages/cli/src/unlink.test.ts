import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vorlynConfigPath, ensureVorlynConfig } from './vorlyn-config.js';
import { vorlynDir, vorlynGitignorePath } from './vorlyn-dir.js';
import { credentialsPath, writeCredentials } from './credentials.js';
import { installGitPostCommitHook } from './git-hook.js';
import { acquireLock, releaseLock } from './lock.js';
import { manifestPath, readManifest, writeManifest } from './manifest.js';
import type { Io } from './output.js';
import { runUnlink } from './unlink.js';

const execFileAsync = promisify(execFile);

function collectIo(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { println: (l: string) => out.push(l), errln: (l: string) => err.push(l) },
    out,
    err,
  };
}

/** Puts a folder into the same on-disk state `vorlyn link` would, without a live MCP server. */
async function linkFolder(folder: string): Promise<void> {
  await writeCredentials(folder, { apiKey: 'vorlyn_test' });
  await writeManifest(folder, {
    endpoint: 'http://localhost:3001/mcp',
    projectId: 'proj_1',
    files: {},
  });
  await ensureVorlynConfig(folder, 'commit');
}

async function gitInit(folder: string): Promise<void> {
  await execFileAsync('git', ['init', '--quiet'], { cwd: folder });
}

function hookPath(folder: string): string {
  return path.join(folder, '.git', 'hooks', 'post-commit');
}

describe('runUnlink', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'vorlyn-cli-unlink-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('errors clearly against a folder that was never linked, and touches nothing', async () => {
    const { io, err } = collectIo();
    const code = await runUnlink({ folder }, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/is not linked/);
    await expect(access(vorlynDir(folder))).rejects.toThrow();
  });

  it('removes .vorlyn/ entirely on a linked folder', async () => {
    await linkFolder(folder);
    const { io } = collectIo();
    const code = await runUnlink({ folder }, io);
    expect(code).toBe(0);
    await expect(access(manifestPath(folder))).rejects.toThrow();
    await expect(access(vorlynConfigPath(folder))).rejects.toThrow();
    await expect(access(credentialsPath(folder))).rejects.toThrow();
    await expect(access(vorlynGitignorePath(folder))).rejects.toThrow();
    await expect(access(vorlynDir(folder))).rejects.toThrow();
  });

  it('reports removing a vorlyn-managed git hook by default', async () => {
    await gitInit(folder);
    await linkFolder(folder);
    await installGitPostCommitHook(folder);
    const { io, out } = collectIo();
    const code = await runUnlink({ folder }, io);
    expect(code).toBe(0);
    await expect(access(hookPath(folder))).rejects.toThrow();
    expect(out.join('\n')).toMatch(/[Rr]emoved the git post-commit hook/);
  });

  it('removeGitHook: false leaves a vorlyn-managed hook installed and unlinks anyway', async () => {
    await gitInit(folder);
    await linkFolder(folder);
    await installGitPostCommitHook(folder);
    const { io, out } = collectIo();
    const code = await runUnlink({ folder, removeGitHook: false }, io);
    expect(code).toBe(0);
    expect(await readFile(hookPath(folder), 'utf8')).toMatch(/Managed by "vorlyn link"/);
    expect(out.join('\n')).not.toMatch(/post-commit/);
    await expect(access(vorlynDir(folder))).rejects.toThrow();
  });

  it('leaves a foreign git hook byte-for-byte untouched regardless of the flag, and says so', async () => {
    await gitInit(folder);
    await linkFolder(folder);
    const foreign = '#!/bin/sh\n# husky\n. "$(dirname "$0")/_/husky.sh"\nnpx lint-staged\n';
    await writeFile(hookPath(folder), foreign, { encoding: 'utf8', mode: 0o755 });
    const { io, out } = collectIo();
    const code = await runUnlink({ folder }, io);
    expect(code).toBe(0);
    expect(await readFile(hookPath(folder), 'utf8')).toBe(foreign);
    expect(out.join('\n')).toMatch(/was not installed by "vorlyn link"/);
  });

  it('refuses while .vorlyn/.lock is held by a live process, and leaves .vorlyn/ intact', async () => {
    await linkFolder(folder);
    const lock = await acquireLock(folder);
    const { io, err } = collectIo();
    const code = await runUnlink({ folder }, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/another vorlyn process is running/);
    expect(await readManifest(folder)).toBeDefined();

    await releaseLock(folder, lock);
    const { io: io2 } = collectIo();
    expect(await runUnlink({ folder }, io2)).toBe(0);
  });

  it('never touches files outside .vorlyn/', async () => {
    await linkFolder(folder);
    const unrelated = path.join(folder, 'a.md');
    await writeFile(unrelated, '# A');
    const { io } = collectIo();
    expect(await runUnlink({ folder }, io)).toBe(0);
    await expect(access(unrelated)).resolves.toBeUndefined();
  });

  it('a second unlink reports not linked and is a clean no-op', async () => {
    await linkFolder(folder);
    await runUnlink({ folder }, collectIo().io);
    const { io, err } = collectIo();
    const code = await runUnlink({ folder }, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/is not linked/);
  });
});
