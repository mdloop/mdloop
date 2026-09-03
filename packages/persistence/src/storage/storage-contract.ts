import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublicDocKey, StoragePort, VersionKey } from '@vorlyn/app';
import type { DocumentId, OrgId, PublicDocId } from '@vorlyn/shared';

/** Fixed identifiers every contract test run uses — exported so a real
 * `StoragePort` implementation's test file (no local filesystem sandbox to
 * throw away) knows exactly what it's responsible for cleaning up. */
export const contractOrgId = 'org-a' as OrgId;
export const contractDocId = 'doc-1' as DocumentId;
export const contractPublicDocId = 'pub-1' as PublicDocId;
export const contractVersionKey = (seq: number): VersionKey => ({
  orgId: contractOrgId,
  documentId: contractDocId,
  seq,
});
export const contractPublicKey = (seq: number): PublicDocKey => ({
  publicDocId: contractPublicDocId,
  seq,
});

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

export interface StorageContractHandle {
  storage: StoragePort;
  /** Torn down after every test — must leave no trace for the next run. */
  cleanup: () => Promise<void>;
}

/**
 * Behavioral contract every `StoragePort` implementation must satisfy —
 * shared between `fs-storage.test.ts` and `s3-storage.test.ts` (docs/adr/
 * 0005-*.md: no fake-AWS-in-a-container, either a real service or skip
 * gracefully — this is what makes "the same suite, against whichever
 * implementation" possible without a mock standing in for either one).
 */
export function runStorageContractTests(
  name: string,
  makeStorage: () => Promise<StorageContractHandle>,
): void {
  describe(name, () => {
    let storage: StoragePort;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ storage, cleanup } = await makeStorage());
    });

    afterEach(async () => {
      await cleanup();
    });

    it('round-trips a version blob', async () => {
      await storage.put(contractVersionKey(1), bytes('# hello'));
      expect(new TextDecoder().decode(await storage.get(contractVersionKey(1)))).toBe('# hello');
    });

    it('accepts an identical re-put (retried upload)', async () => {
      await storage.put(contractVersionKey(1), bytes('same'));
      await expect(storage.put(contractVersionKey(1), bytes('same'))).resolves.toBeUndefined();
    });

    it('rejects overwriting a version with different content', async () => {
      await storage.put(contractVersionKey(1), bytes('v1'));
      await expect(storage.put(contractVersionKey(1), bytes('v1-tampered'))).rejects.toThrow(
        /exists with different content/,
      );
    });

    it('stores versions of the same document under separate keys', async () => {
      await storage.put(contractVersionKey(1), bytes('one'));
      await storage.put(contractVersionKey(2), bytes('two'));
      expect(new TextDecoder().decode(await storage.get(contractVersionKey(2)))).toBe('two');
    });

    it('deleteDocument removes every version and is idempotent', async () => {
      await storage.put(contractVersionKey(1), bytes('one'));
      await storage.put(contractVersionKey(2), bytes('two'));
      await storage.deleteDocument(contractOrgId, contractDocId);
      await expect(storage.get(contractVersionKey(1))).rejects.toThrow();
      await expect(storage.get(contractVersionKey(2))).rejects.toThrow();
      await expect(storage.deleteDocument(contractOrgId, contractDocId)).resolves.toBeUndefined();
    });

    describe('Public Docs Hub keyspace (ADR 0004)', () => {
      it('round-trips a public snapshot blob', async () => {
        await storage.putPublic(contractPublicKey(1), bytes('# Public runbook'));
        expect(new TextDecoder().decode(await storage.getPublic(contractPublicKey(1)))).toBe(
          '# Public runbook',
        );
      });

      it('accepts an identical re-put (retried publish)', async () => {
        await storage.putPublic(contractPublicKey(1), bytes('same'));
        await expect(
          storage.putPublic(contractPublicKey(1), bytes('same')),
        ).resolves.toBeUndefined();
      });

      it('rejects overwriting a public snapshot with different content', async () => {
        await storage.putPublic(contractPublicKey(1), bytes('v1'));
        await expect(storage.putPublic(contractPublicKey(1), bytes('v1-tampered'))).rejects.toThrow(
          /exists with different content/,
        );
      });

      it('keeps the public keyspace separate from the tenant orgs/ keyspace', async () => {
        await storage.put(contractVersionKey(1), bytes('tenant content'));
        await storage.putPublic(contractPublicKey(1), bytes('public content'));
        expect(new TextDecoder().decode(await storage.get(contractVersionKey(1)))).toBe(
          'tenant content',
        );
        expect(new TextDecoder().decode(await storage.getPublic(contractPublicKey(1)))).toBe(
          'public content',
        );
        // deleteDocument (tenant-scoped) never touches the public/ prefix.
        await storage.deleteDocument(contractOrgId, contractDocId);
        expect(new TextDecoder().decode(await storage.getPublic(contractPublicKey(1)))).toBe(
          'public content',
        );
      });
    });
  });
}
