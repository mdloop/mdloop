import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FsStorage } from './fs-storage.js';
import { runStorageContractTests } from './storage-contract.js';

runStorageContractTests('FsStorage', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vorlyn-fs-storage-'));
  return {
    storage: new FsStorage(root),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
});
