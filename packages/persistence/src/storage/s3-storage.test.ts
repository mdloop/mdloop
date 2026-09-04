import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { describe } from 'vitest';
import { S3Storage } from './s3-storage.js';
import { contractOrgId, contractPublicKey, runStorageContractTests } from './storage-contract.js';

/**
 * Full behavioral contract against a real S3 bucket (exit criterion:
 * "existing fs-storage.test.ts contract suite green against a real
 * dev-account bucket, nightly"). ADR 0005 forbids
 * LocalStack/fake-AWS-in-a-container — this either runs for real or skips,
 * same convention `TEST_DATABASE_URL` uses for Postgres
 * (`packages/persistence/src/test-support/test-db.ts`): unset locally/in
 * normal CI, set only where a real dev-account bucket is reachable (the
 * nightly workflow — `.github/workflows/nightly-s3-contract.yml`).
 */
const bucket = process.env.TEST_S3_BUCKET;
const region = process.env.TEST_AWS_REGION ?? 'us-east-1';

describe.skipIf(!bucket)('S3Storage (real bucket, TEST_S3_BUCKET)', () => {
  runStorageContractTests('S3Storage', () => {
    const client = new S3Client({ region });
    const storage = new S3Storage({ bucket: bucket!, region, client });
    return Promise.resolve({
      storage,
      cleanup: async () => {
        // Tenant keyspace: deleteOrg is the port's own sweep, exercised for
        // real by this cleanup as a side effect.
        await storage.deleteOrg(contractOrgId);
        // Public Docs Hub keyspace has no port-level delete (ADR 0004 has no
        // retraction concept yet) — clean up the one fixed contract key
        // directly against the injected client so runs don't accumulate
        // objects in the real bucket.
        await client.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: `public/${contractPublicKey(1).publicDocId}/v1`,
          }),
        );
        // Belt-and-suspenders: sweep anything else left under the contract
        // org's prefix in case a test failed mid-way before its own asserts.
        const leftovers = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: `orgs/${contractOrgId}/` }),
        );
        for (const obj of leftovers.Contents ?? []) {
          if (obj.Key) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
        }
      },
    });
  });
});
