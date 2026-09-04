import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Manifest } from './manifest.js';
import { manifestPath, readManifest, writeManifest } from './manifest.js';

describe('manifest read/write', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-manifest-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('returns undefined when the folder is not linked', async () => {
    expect(await readManifest(folder)).toBeUndefined();
  });

  it('round-trips endpoint, projectId, and file entries', async () => {
    const manifest: Manifest = {
      endpoint: 'http://localhost:3001/mcp',
      projectId: 'proj_1',
      files: {
        'a.md': { documentId: 'doc_1', contentHash: 'sha256:aaa', versionSeq: 1 },
        'nested/b.md': { documentId: 'doc_2', contentHash: 'sha256:bbb', versionSeq: 3 },
      },
    };
    await writeManifest(folder, manifest);
    expect(await readManifest(folder)).toEqual(manifest);
  });

  it('overwrites on relink', async () => {
    await writeManifest(folder, { endpoint: 'e1', projectId: 'p1', files: {} });
    await writeManifest(folder, { endpoint: 'e2', projectId: 'p2', files: {} });
    expect(await readManifest(folder)).toEqual({ endpoint: 'e2', projectId: 'p2', files: {} });
  });

  it('rejects a malformed manifest file', async () => {
    await writeManifest(folder, { endpoint: 'e', projectId: 'p', files: {} });
    await writeFile(manifestPath(folder), '{"not":"a manifest"}');
    await expect(readManifest(folder)).rejects.toThrow(/invalid manifest/);
  });
});
