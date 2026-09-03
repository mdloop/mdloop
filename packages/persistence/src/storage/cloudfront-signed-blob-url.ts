import { getSignedUrl } from '@aws-sdk/cloudfront-signer';
import type { BlobUrlPort, VersionKey } from '@vorlyn/app';
import { versionObjectKey } from '@vorlyn/app';

/**
 * Stage-2 adapter: signs a
 * CloudFront URL for the exact S3 object path (reusing the same
 * `versionObjectKey` layout `S3Storage` writes under, so nothing here can
 * drift from the canonical key scheme). Not wired to real infra in this
 * pass — no CloudFront distribution or key group exists yet (`infra/`,
 * built separately). The private key and key pair id are injected via the
 * constructor, never read from `process.env` inside this class, matching
 * this repo's adapter DI style (`WorkosAuthAdapter`).
 */
export interface CloudFrontSignedBlobUrlConfig {
  /** CloudFront distribution domain, e.g. `d123abc.cloudfront.net`. */
  readonly domain: string;
  readonly keyPairId: string;
  /** PEM-encoded private key for `keyPairId`, e.g. from `vorlyn/prod/cloudfront-signer`. */
  readonly privateKey: string;
  /**
   * Defensive cap, not just documentation: policy is max TTL 300s, signed
   * per exact object path with 60s expiry, kept short so a leaked signed URL
   * has a small blast radius — every caller is expected to pass ~60s, but
   * nothing forces that at the call site, so this class enforces the
   * ceiling itself rather than trusting every call site to remember the
   * policy. Defaults to 300 if unset.
   */
  readonly maxTtlSeconds?: number;
}

export class CloudFrontSignedBlobUrl implements BlobUrlPort {
  private readonly maxTtlSeconds: number;

  constructor(private readonly config: CloudFrontSignedBlobUrlConfig) {
    this.maxTtlSeconds = config.maxTtlSeconds ?? 300;
  }

  signedUrlFor(key: VersionKey, ttlSeconds: number): Promise<string> {
    // A validation failure must surface as a rejected promise, not a thrown
    // synchronous exception — this method isn't declared `async` (no `await`
    // to justify it), so the throw below is wrapped explicitly rather than
    // relying on `async` to do that conversion implicitly.
    try {
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > this.maxTtlSeconds) {
        throw new RangeError(
          `ttlSeconds must be in (0, ${String(this.maxTtlSeconds)}] (kept short so a leaked signed URL has a small blast radius), got ${String(ttlSeconds)}`,
        );
      }
      const url = `https://${this.config.domain}/${versionObjectKey(key)}`;
      const dateLessThan = new Date(Date.now() + ttlSeconds * 1000).toISOString();
      return Promise.resolve(
        getSignedUrl({
          url,
          keyPairId: this.config.keyPairId,
          privateKey: this.config.privateKey,
          dateLessThan,
        }),
      );
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
