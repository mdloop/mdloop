import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mdloopGitignorePath, ensureMdloopDir } from './mdloop-dir.js';
import { writeCredentials } from './credentials.js';
import { acquireLock } from './lock.js';
import { writeManifest } from './manifest.js';

async function ignoreLines(folder: string): Promise<string[]> {
  const raw = await readFile(mdloopGitignorePath(folder), 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

describe('.mdloop/.gitignore', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-dir-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('creates the directory with every local-only entry ignored', async () => {
    await ensureMdloopDir(folder);
    expect(await ignoreLines(folder)).toEqual(['credentials', '.lock', 'endpoint-trust.json']);
  });

  it('explains itself, so nobody deletes it as noise', async () => {
    await ensureMdloopDir(folder);
    expect(await readFile(mdloopGitignorePath(folder), 'utf8')).toMatch(/never commit these/);
  });

  it('is idempotent', async () => {
    await ensureMdloopDir(folder);
    const first = await readFile(mdloopGitignorePath(folder), 'utf8');
    await ensureMdloopDir(folder);
    expect(await readFile(mdloopGitignorePath(folder), 'utf8')).toBe(first);
  });

  it('merges missing entries into an existing file without clobbering it', async () => {
    await ensureMdloopDir(folder);
    await writeFile(mdloopGitignorePath(folder), '# hand written\nscratch/\ncredentials\n');
    await ensureMdloopDir(folder);
    const raw = await readFile(mdloopGitignorePath(folder), 'utf8');
    expect(raw).toMatch(/# hand written/);
    expect(raw).toMatch(/scratch\//);
    expect(await ignoreLines(folder)).toEqual([
      'scratch/',
      'credentials',
      '.lock',
      'endpoint-trust.json',
    ]);
  });

  it('appends a newline when the existing file lacks a trailing one', async () => {
    await ensureMdloopDir(folder);
    await writeFile(mdloopGitignorePath(folder), 'scratch/');
    await ensureMdloopDir(folder);
    expect(await ignoreLines(folder)).toEqual([
      'scratch/',
      'credentials',
      '.lock',
      'endpoint-trust.json',
    ]);
  });

  // The gitignore must be unskippable, so every writer of .mdloop/ creates it —
  // not just `mdloop link`.
  it.each([
    ['writeCredentials', async (f: string) => writeCredentials(f, { apiKey: 'mdloop_x' })],
    [
      'writeManifest',
      async (f: string) =>
        writeManifest(f, { endpoint: 'https://x/mcp', projectId: 'p', files: {} }),
    ],
    [
      'acquireLock',
      async (f: string) => {
        await acquireLock(f);
      },
    ],
  ])('%s alone is enough to create it', async (_name, write) => {
    await write(folder);
    expect(await ignoreLines(folder)).toContain('credentials');
  });
});
