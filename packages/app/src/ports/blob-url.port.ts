import type { VersionKey } from './storage.port.js';

/**
 * Blob delivery seam (API proxy vs CloudFront signed URLs). Deliberately separate from
 * `StoragePort`: `StoragePort` is where bytes live, `BlobUrlPort` is how a
 * client gets at them. Stage 1 keeps the API proxy (`ApiProxyBlobUrl`);
 * stage 2 (or whenever blob egress exceeds ~$50/mo) flips to
 * `CloudFrontSignedBlobUrl` — a `main.ts` line + a CDK flag, not a rewrite,
 * because every call site already goes through this interface.
 */
export interface BlobUrlPort {
  /**
   * A URL a client can fetch the given version's content from. `ttlSeconds`
   * bounds how long the URL stays valid — meaningful for a real signed URL
   * (CloudFront), irrelevant for a same-origin API proxy that re-checks
   * permission on every byte (see `ApiProxyBlobUrl`).
   */
  signedUrlFor(key: VersionKey, ttlSeconds: number): Promise<string>;
}
