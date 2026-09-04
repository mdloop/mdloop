import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalFolderKey,
  folderProjectsPath,
  listFolderProjects,
  lookupFolderProject,
  readFolderProjects,
  recordFolderProject,
} from './folder-projects.js';
import type { FolderProjectEntry } from './folder-projects.js';

function entry(overrides: Partial<FolderProjectEntry> = {}): FolderProjectEntry {
  return {
    projectId: 'proj_1',
    projectName: 'demo',
    endpointOrigin: 'http://127.0.0.1:3000',
    linkedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('folder-projects', () => {
  let dataDir: string;
  let folder: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-folderprojects-data-'));
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-folderprojects-folder-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });

  describe('canonicalFolderKey', () => {
    it('resolves an existing folder to an absolute path via realpath', async () => {
      const key = await canonicalFolderKey(folder);
      expect(path.isAbsolute(key)).toBe(true);
    });

    it('falls back to path.resolve for a folder that does not exist', async () => {
      const missing = path.join(folder, 'does-not-exist');
      const key = await canonicalFolderKey(missing);
      expect(key).toBe(path.resolve(missing));
    });
  });

  describe('readFolderProjects', () => {
    it('returns the empty shape when the file is absent', async () => {
      expect(await readFolderProjects(dataDir)).toEqual({ version: 1, folders: {} });
    });

    it('returns the empty shape when the file is unparseable JSON', async () => {
      await writeFile(folderProjectsPath(dataDir), 'not json{{{', 'utf8');
      expect(await readFolderProjects(dataDir)).toEqual({ version: 1, folders: {} });
    });

    it('returns the empty shape when it parses but has the wrong version', async () => {
      await writeFile(
        folderProjectsPath(dataDir),
        JSON.stringify({ version: 2, folders: {} }),
        'utf8',
      );
      expect(await readFolderProjects(dataDir)).toEqual({ version: 1, folders: {} });
    });

    it('returns the empty shape when it parses but is missing folders', async () => {
      await writeFile(folderProjectsPath(dataDir), JSON.stringify({ version: 1 }), 'utf8');
      expect(await readFolderProjects(dataDir)).toEqual({ version: 1, folders: {} });
    });

    /**
     * Regression pin: `readFolderProjects` used to return one shared
     * module-level "empty" object on every "file doesn't exist yet" call,
     * and `recordFolderProject` mutates the `.folders` map it gets back in
     * place — so a first-ever write against *any* dataDir was silently
     * accumulating into that one shared object, and every other dataDir's
     * first-ever write inherited all of it. Two entirely unrelated,
     * never-before-touched dataDirs must never see each other's entries.
     */
    it('two different, never-before-touched data directories never see each others entries (no shared "empty" object)', async () => {
      const otherDataDir = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-folderprojects-other-'));
      try {
        await recordFolderProject(dataDir, folder, entry({ projectId: 'proj_here' }));
        expect(await readFolderProjects(otherDataDir)).toEqual({ version: 1, folders: {} });
        expect(await listFolderProjects(otherDataDir)).toEqual([]);
      } finally {
        await rm(otherDataDir, { recursive: true, force: true });
      }
    });
  });

  describe('recordFolderProject + lookupFolderProject', () => {
    it('round-trips: recorded then looked up with the matching endpointOrigin', async () => {
      const recorded = entry();
      await recordFolderProject(dataDir, folder, recorded);

      expect(await lookupFolderProject(dataDir, folder, recorded.endpointOrigin)).toEqual(recorded);
    });

    it('returns undefined when looked up with a different endpointOrigin', async () => {
      await recordFolderProject(
        dataDir,
        folder,
        entry({ endpointOrigin: 'http://127.0.0.1:3000' }),
      );

      expect(await lookupFolderProject(dataDir, folder, 'http://127.0.0.1:9999')).toBeUndefined();
    });

    it('returns undefined for a folder that was never recorded', async () => {
      expect(await lookupFolderProject(dataDir, folder, 'http://127.0.0.1:3000')).toBeUndefined();
    });
  });

  describe('atomicity', () => {
    it('leaves no lingering .tmp file after recordFolderProject', async () => {
      await recordFolderProject(dataDir, folder, entry());

      await expect(stat(`${folderProjectsPath(dataDir)}.tmp`)).rejects.toThrow();
    });
  });

  describe('concurrency', () => {
    it('two concurrent recordFolderProject calls for different folders both survive (no lost update)', async () => {
      const folderA = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-folderprojects-a-'));
      const folderB = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-folderprojects-b-'));
      try {
        await Promise.all([
          recordFolderProject(dataDir, folderA, entry({ projectId: 'proj_a', projectName: 'a' })),
          recordFolderProject(dataDir, folderB, entry({ projectId: 'proj_b', projectName: 'b' })),
        ]);

        const keyA = await canonicalFolderKey(folderA);
        const keyB = await canonicalFolderKey(folderB);
        const file = await readFolderProjects(dataDir);
        expect(file.folders[keyA]?.projectId).toBe('proj_a');
        expect(file.folders[keyB]?.projectId).toBe('proj_b');
      } finally {
        await rm(folderA, { recursive: true, force: true });
        await rm(folderB, { recursive: true, force: true });
      }
    });
  });

  describe('listFolderProjects', () => {
    it('returns entries sorted by linkedAt ascending, each annotated with its folder key', async () => {
      const folderA = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-folderprojects-list-a-'));
      const folderB = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-folderprojects-list-b-'));
      try {
        await recordFolderProject(
          dataDir,
          folderB,
          entry({ projectId: 'proj_b', projectName: 'b', linkedAt: '2024-01-02T00:00:00.000Z' }),
        );
        await recordFolderProject(
          dataDir,
          folderA,
          entry({ projectId: 'proj_a', projectName: 'a', linkedAt: '2024-01-01T00:00:00.000Z' }),
        );

        const list = await listFolderProjects(dataDir);

        expect(list.map((e) => e.projectId)).toEqual(['proj_a', 'proj_b']);
        const keyA = await canonicalFolderKey(folderA);
        expect(list[0]?.folder).toBe(keyA);
      } finally {
        await rm(folderA, { recursive: true, force: true });
        await rm(folderB, { recursive: true, force: true });
      }
    });

    it('returns an empty array when nothing has ever been recorded', async () => {
      expect(await listFolderProjects(dataDir)).toEqual([]);
    });
  });
});
