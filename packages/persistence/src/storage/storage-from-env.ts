import type { StoragePort } from '@mdloop/app';
import { FsStorage } from './fs-storage.js';
import { S3Storage } from './s3-storage.js';

/**
 * Storage-adapter selection shared by every long-running production
 * entrypoint (api/main.ts, mcp/main.ts, jobs/main.ts) — same "lives in
 * persistence, not each entrypoint's zod schema" shape as `poolConfigFromEnv`
 * (pool-config.ts), for the same reason its doc comment gives: one fail-fast
 * behavior, not one repeated per entrypoint.
 *
 * `MDLOOP_BLOBS_BUCKET` set → `S3Storage` against it (region from
 * `AWS_REGION`, however a deployment injects it).
 * `MDLOOP_BLOBS_ENDPOINT`/`MDLOOP_BLOBS_FORCE_PATH_STYLE` (both optional,
 * unset against real AWS S3) point that `S3Storage` at an S3-compatible
 * self-host backend (MinIO, R2) instead.
 *
 * Unset bucket → `FsStorage`, the local-disk adapter — but refuse under
 * `NODE_ENV=production` unless `MDLOOP_ALLOW_LOCAL_BLOB_STORAGE=true` is also
 * set. The refusal exists because a container-based deployment's root
 * filesystem is commonly ephemeral or mounted read-only, so `FsStorage`
 * cannot actually work there, and that failure mode is worth catching at
 * boot, not on a user's first upload. But a self-hosted single-process instance
 * with a real persistent volume is a legitimate, durable use of local disk
 * (`SELF_HOSTING.md`'s "a real instance" path documents exactly this), and
 * `NODE_ENV=production` there is correct for an unrelated reason —
 * `configFromEnv`'s `secureCookies` flag — so telling a self-hoster to unset
 * it to work around this check would be trading one bug for a worse one.
 * The escape hatch distinguishes "forgot to configure storage" (refuse) from
 * "deliberately chose local disk" (the explicit flag) rather than inferring
 * intent from `NODE_ENV` alone, which cannot tell the two apart.
 *
 * Deliberately NOT used by `dev-main.ts`/`e2e-main.ts` (local/ephemeral
 * harnesses, plain `FsStorage` unconditionally, same carve-out
 * `poolConfigFromEnv`'s doc comment already makes for those two) or
 * `stdio-main.ts` (single-user local process, no prod deployment shape).
 */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): StoragePort {
  const bucket = env.MDLOOP_BLOBS_BUCKET?.trim();
  if (!bucket) {
    const allowLocal = env.MDLOOP_ALLOW_LOCAL_BLOB_STORAGE?.trim() === 'true';
    if (env.NODE_ENV === 'production' && !allowLocal) {
      throw new Error(
        'MDLOOP_BLOBS_BUCKET must be set under NODE_ENV=production, or set ' +
          'MDLOOP_ALLOW_LOCAL_BLOB_STORAGE=true to use local-disk storage deliberately ' +
          '(a self-hosted single instance with a persistent volume) — FsStorage silently ' +
          'loses everything on an ephemeral filesystem otherwise, which is what this refuses.',
      );
    }
    return new FsStorage(env.BLOB_STORAGE_DIR ?? '.mdloop-blobs');
  }
  const endpoint = env.MDLOOP_BLOBS_ENDPOINT?.trim();
  return new S3Storage({
    bucket,
    region: env.AWS_REGION ?? 'us-east-1',
    // S3-compatible backends for self-hosting (MinIO, R2) — unset against
    // real AWS S3, which never sets these two.
    ...(endpoint ? { endpoint } : {}),
    ...(env.MDLOOP_BLOBS_FORCE_PATH_STYLE !== undefined
      ? { forcePathStyle: env.MDLOOP_BLOBS_FORCE_PATH_STYLE.trim() === 'true' }
      : {}),
  });
}
