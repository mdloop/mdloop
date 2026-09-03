import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vorlynGitignorePath, ensureVorlynDir } from './vorlyn-dir.js';
import { writeCredentials } from './credentials.js';
import { acquireLock } from './lock.js';
import { writeManifest } from './manifest.js';

async function ignoreLines(folder: string): Promise<string[]> {
  const raw = await readFile(vorlynGitignorePath(folder), 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

describe('.vorlyn/.gitignore', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'vorlyn-cli-dir-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('creates the directory with every local-only entry ignored', async () => {
    await ensureVorlynDir(folder);
    expect(await ignoreLines(folder)).toEqual(['credentials', '.lock', 'endpoint-trust.json']);
  });

  it('explains itself, so nobody deletes it as noise', async () => {
    await ensureVorlynDir(folder);
    expect(await readFile(vorlynGitignorePath(folder), 'utf8')).toMatch(/never commit these/);
  });

  it('is idempotent', async () => {
    await ensureVorlynDir(folder);
    const first = await readFile(vorlynGitignorePath(folder), 'utf8');
    await ensureVorlynDir(folder);
    expect(await readFile(vorlynGitignorePath(folder), 'utf8')).toBe(first);
  });

  it('merges missing entries into an existing file without clobbering it', async () => {
    await ensureVorlynDir(folder);
    await writeFile(vorlynGitignorePath(folder), '# hand written\nscratch/\ncredentials\n');
    await ensureVorlynDir(folder);
    const raw = await readFile(vorlynGitignorePath(folder), 'utf8');
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
    await ensureVorlynDir(folder);
    await writeFile(vorlynGitignorePath(folder), 'scratch/');
    await ensureVorlynDir(folder);
    expect(await ignoreLines(folder)).toEqual([
      'scratch/',
      'credentials',
      '.lock',
      'endpoint-trust.json',
    ]);
  });

  // The gitignore must be unskippable, so every writer of .vorlyn/ creates it —
  // not just `vorlyn link`.
  it.each([
    ['writeCredentials', async (f: string) => writeCredentials(f, { apiKey: 'vorlyn_x' })],
    [
      'writeManifest',
      async (f: string) =>
        writeManifest(f, { endpoint: 'https://x/mcp', projectId: 'p', files: {} }),
    ],
    ['acquireLock', async (f: string) => void (await acquireLock(f))],
  ])('%s alone is enough to create it', async (_name, write) => {
    await write(folder);
    expect(await ignoreLines(folder)).toContain('credentials');
  });
});
