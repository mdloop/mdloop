import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { FsStorage } from './fs-storage.js';
import { S3Storage } from './s3-storage.js';
import { storageFromEnv } from './storage-from-env.js';

/**
 * `S3Storage` builds its `S3Client` lazily, the first time any method needs
 * it (see `s3-storage.ts`'s doc comment — deliberate, so constructing an
 * `S3Storage` never touches `@aws-sdk/client-s3` on its own). Reaching into
 * the private `getClient()` seam and awaiting it is what these tests need
 * to inspect the client the class actually builds, without going through a
 * real S3 call.
 */
async function internalClient(storage: S3Storage): Promise<S3Client> {
  return (storage as unknown as { getClient(): Promise<S3Client> }).getClient();
}

describe('storageFromEnv', () => {
  it('defaults to FsStorage with no env set (local dev)', () => {
    expect(storageFromEnv({})).toBeInstanceOf(FsStorage);
  });

  it('picks S3Storage when VORLYN_BLOBS_BUCKET is set', () => {
    const storage = storageFromEnv({ VORLYN_BLOBS_BUCKET: 'vorlyn-dev-blobs-123-use1' });
    expect(storage).toBeInstanceOf(S3Storage);
  });

  it('treats a blank VORLYN_BLOBS_BUCKET the same as unset', () => {
    expect(storageFromEnv({ VORLYN_BLOBS_BUCKET: '' })).toBeInstanceOf(FsStorage);
  });

  it('treats a whitespace-only VORLYN_BLOBS_BUCKET the same as unset', () => {
    expect(storageFromEnv({ VORLYN_BLOBS_BUCKET: '   ' })).toBeInstanceOf(FsStorage);
  });

  it('throws under NODE_ENV=production with no bucket configured, instead of silently using FsStorage', () => {
    expect(() => storageFromEnv({ NODE_ENV: 'production' })).toThrow(/VORLYN_BLOBS_BUCKET/);
  });

  it('does not throw under NODE_ENV=production once a bucket is set', () => {
    expect(() =>
      storageFromEnv({ NODE_ENV: 'production', VORLYN_BLOBS_BUCKET: 'vorlyn-prod-blobs' }),
    ).not.toThrow();
  });

  it('allows FsStorage under NODE_ENV=production when VORLYN_ALLOW_LOCAL_BLOB_STORAGE=true (self-host)', () => {
    const storage = storageFromEnv({
      NODE_ENV: 'production',
      VORLYN_ALLOW_LOCAL_BLOB_STORAGE: 'true',
    });
    expect(storage).toBeInstanceOf(FsStorage);
  });

  it('still throws under NODE_ENV=production when VORLYN_ALLOW_LOCAL_BLOB_STORAGE is set to anything other than "true"', () => {
    expect(() =>
      storageFromEnv({ NODE_ENV: 'production', VORLYN_ALLOW_LOCAL_BLOB_STORAGE: 'yes' }),
    ).toThrow(/VORLYN_BLOBS_BUCKET/);
    expect(() =>
      storageFromEnv({ NODE_ENV: 'production', VORLYN_ALLOW_LOCAL_BLOB_STORAGE: '' }),
    ).toThrow(/VORLYN_BLOBS_BUCKET/);
  });

  it('a bucket still wins over VORLYN_ALLOW_LOCAL_BLOB_STORAGE when both are set', () => {
    const storage = storageFromEnv({
      NODE_ENV: 'production',
      VORLYN_ALLOW_LOCAL_BLOB_STORAGE: 'true',
      VORLYN_BLOBS_BUCKET: 'vorlyn-prod-blobs',
    });
    expect(storage).toBeInstanceOf(S3Storage);
  });

  it('is unaffected by NODE_ENV=development or test with no bucket set', () => {
    expect(storageFromEnv({ NODE_ENV: 'development' })).toBeInstanceOf(FsStorage);
    expect(storageFromEnv({ NODE_ENV: 'test' })).toBeInstanceOf(FsStorage);
  });

  it('threads VORLYN_BLOBS_ENDPOINT and VORLYN_BLOBS_FORCE_PATH_STYLE into S3Storage when set', async () => {
    const storage = storageFromEnv({
      VORLYN_BLOBS_BUCKET: 'vorlyn-selfhost-blobs',
      VORLYN_BLOBS_ENDPOINT: 'http://localhost:9000',
      VORLYN_BLOBS_FORCE_PATH_STYLE: 'true',
    });
    expect(storage).toBeInstanceOf(S3Storage);
    const client = await internalClient(storage as S3Storage);
    expect(client.config.forcePathStyle).toBe(true);
    const resolvedEndpoint = await client.config.endpoint?.();
    expect(resolvedEndpoint).toMatchObject({
      hostname: 'localhost',
      port: 9000,
      protocol: 'http:',
    });
  });

  it('leaves endpoint/forcePathStyle at SDK defaults when those env vars are unset (real AWS S3)', async () => {
    const storage = storageFromEnv({ VORLYN_BLOBS_BUCKET: 'vorlyn-prod-blobs' });
    const client = await internalClient(storage as S3Storage);
    expect(client.config.forcePathStyle).toBe(false);
    expect(client.config.endpoint).toBeUndefined();
  });

  it('treats VORLYN_BLOBS_FORCE_PATH_STYLE=false explicitly the same as unset', async () => {
    const storage = storageFromEnv({
      VORLYN_BLOBS_BUCKET: 'vorlyn-prod-blobs',
      VORLYN_BLOBS_FORCE_PATH_STYLE: 'false',
    });
    const client = await internalClient(storage as S3Storage);
    expect(client.config.forcePathStyle).toBe(false);
  });
});
