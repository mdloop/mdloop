import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PublicDocKey, StoragePort, VersionKey } from '@mdloop/app';
import { publicObjectKey, versionObjectKey } from '@mdloop/app';
import type { DocumentId, OrgId } from '@mdloop/shared';

/**
 * Local filesystem blob store (dev + tests; S3 in prod). Mirrors the canonical
 * object key layout under `rootDir` so lifecycle semantics match S3: one file
 * per immutable version, whole-document prefix delete on purge.
 */
export class FsStorage implements StoragePort {
  constructor(private readonly rootDir: string) {}

  private filePath(key: VersionKey): string {
    return path.join(this.rootDir, ...versionObjectKey(key).split('/'));
  }

  private publicFilePath(key: PublicDocKey): string {
    return path.join(this.rootDir, ...publicObjectKey(key).split('/'));
  }

  private async writeOnce(
    file: string,
    content: Uint8Array,
    describe: () => string,
  ): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    try {
      await writeFile(file, content, { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Write-once: identical bytes = retried write whose DB commit failed,
      // safe to treat as done; different bytes = programming error.
      const existing = await readFile(file);
      if (existing.length === content.length && existing.equals(content)) return;
      throw new Error(`storage object exists with different content: ${describe()}`);
    }
  }

  async put(key: VersionKey, content: Uint8Array): Promise<void> {
    await this.writeOnce(this.filePath(key), content, () => versionObjectKey(key));
  }

  async get(key: VersionKey): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.filePath(key)));
  }

  async putPublic(key: PublicDocKey, content: Uint8Array): Promise<void> {
    await this.writeOnce(this.publicFilePath(key), content, () => publicObjectKey(key));
  }

  async getPublic(key: PublicDocKey): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.publicFilePath(key)));
  }

  async delete(key: VersionKey): Promise<void> {
    await rm(this.filePath(key), { force: true });
  }

  async deleteDocument(orgId: OrgId, documentId: DocumentId): Promise<void> {
    await rm(path.join(this.rootDir, 'orgs', orgId, 'docs', documentId), {
      recursive: true,
      force: true,
    });
  }

  async deleteOrg(orgId: OrgId): Promise<void> {
    await rm(path.join(this.rootDir, 'orgs', orgId), { recursive: true, force: true });
  }
}
