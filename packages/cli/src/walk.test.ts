import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { walkMarkdownFiles } from './walk.js';

describe('walkMarkdownFiles', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-walk-'));
    await mkdir(path.join(folder, 'docs', 'nested'), { recursive: true });
    await mkdir(path.join(folder, 'node_modules', 'x'), { recursive: true });
    await mkdir(path.join(folder, '.git'), { recursive: true });
    await mkdir(path.join(folder, '.mdloop'), { recursive: true });
    await writeFile(path.join(folder, 'root.md'), '# root');
    await writeFile(path.join(folder, 'docs', 'guide.md'), '# guide');
    await writeFile(path.join(folder, 'docs', 'nested', 'deep.md'), '# deep');
    await writeFile(path.join(folder, 'docs', 'notes.txt'), 'not markdown');
    await writeFile(path.join(folder, 'node_modules', 'x', 'ignored.md'), '# ignored');
    await writeFile(path.join(folder, '.git', 'ignored.md'), '# ignored');
    await writeFile(path.join(folder, '.mdloop', 'manifest.json'), '{}');
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('finds markdown files while skipping noise directories', async () => {
    const files = await walkMarkdownFiles(folder);
    expect(files).toEqual(
      [path.join('docs', 'guide.md'), path.join('docs', 'nested', 'deep.md'), 'root.md'].sort(),
    );
  });

  it('returns an empty list for an empty folder', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-walk-empty-'));
    try {
      expect(await walkMarkdownFiles(empty)).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('does not descend into ordinary nested subdirectories with no .mdloop anywhere', async () => {
    const files = await walkMarkdownFiles(folder);
    // Regression coverage: docs/nested/deep.md (an ordinary nested
    // subdirectory two levels down, with no .mdloop/ anywhere in it) still
    // walks exactly as before.
    expect(files).toContain(path.join('docs', 'nested', 'deep.md'));
  });

  it('walks straight through a nested .mdloop-linked subdirectory rather than walling it off', async () => {
    // A doc legitimately wanting review in two places at once (e.g. an
    // internal project and a separate, narrower distribution project living
    // in the same repo) is a deliberate, supported setup — each linked root
    // tracks and pushes its own copy as an independent document.
    const root = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-walk-nested-'));
    try {
      await mkdir(path.join(root, 'nested', '.mdloop'), { recursive: true });
      await writeFile(path.join(root, 'a.md'), '# a');
      await writeFile(path.join(root, 'nested', '.mdloop', 'manifest.json'), '{}');
      await writeFile(path.join(root, 'nested', 'b.md'), '# b');

      const files = await walkMarkdownFiles(root);
      expect(files).toEqual(['a.md', path.join('nested', 'b.md')].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
