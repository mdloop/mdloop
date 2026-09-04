import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { VersionKey } from '@mdloop/app';
import type { DocumentId, OrgId } from '@mdloop/shared';
import { CloudFrontSignedBlobUrl } from './cloudfront-signed-blob-url.js';

// CloudFront URL signing is pure local RSA signing (@aws-sdk/cloudfront-signer
// makes no network call) — a self-generated test keypair exercises the real
// signing code end to end, no AWS credentials or mocking needed.
let privateKey: string;

beforeAll(() => {
  ({ privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }));
});

const key: VersionKey = { orgId: 'org-a' as OrgId, documentId: 'doc-1' as DocumentId, seq: 7 };

describe('CloudFrontSignedBlobUrl', () => {
  it('signs a URL over the exact object path, expiring per the requested ttl', async () => {
    const adapter = new CloudFrontSignedBlobUrl({
      domain: 'd123abc.cloudfront.net',
      keyPairId: 'K2TESTKEYPAIRID',
      privateKey,
    });
    const before = Date.now();
    const url = await adapter.signedUrlFor(key, 60);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://d123abc.cloudfront.net/orgs/org-a/docs/doc-1/v7',
    );
    expect(parsed.searchParams.get('Key-Pair-Id')).toBe('K2TESTKEYPAIRID');
    expect(parsed.searchParams.get('Signature')).toBeTruthy();
    const expires = Number(parsed.searchParams.get('Expires'));
    // dateLessThan was computed from ttlSeconds; allow slack for test runtime.
    expect(expires).toBeGreaterThanOrEqual(Math.floor(before / 1000) + 55);
    expect(expires).toBeLessThanOrEqual(Math.floor(before / 1000) + 65);
  });

  it('rejects a ttl above the configured max (default 300s)', async () => {
    const adapter = new CloudFrontSignedBlobUrl({
      domain: 'd123abc.cloudfront.net',
      keyPairId: 'K2TESTKEYPAIRID',
      privateKey,
    });
    await expect(adapter.signedUrlFor(key, 301)).rejects.toThrow(RangeError);
    await expect(adapter.signedUrlFor(key, 301)).rejects.toThrow(/ttlSeconds/);
  });

  it('rejects zero/negative ttl', async () => {
    const adapter = new CloudFrontSignedBlobUrl({
      domain: 'd123abc.cloudfront.net',
      keyPairId: 'K2TESTKEYPAIRID',
      privateKey,
    });
    await expect(adapter.signedUrlFor(key, 0)).rejects.toThrow(RangeError);
    await expect(adapter.signedUrlFor(key, -5)).rejects.toThrow(RangeError);
  });

  it('honors a caller-configured lower max (e.g. a stricter policy than the doc default)', async () => {
    const adapter = new CloudFrontSignedBlobUrl({
      domain: 'd123abc.cloudfront.net',
      keyPairId: 'K2TESTKEYPAIRID',
      privateKey,
      maxTtlSeconds: 60,
    });
    await expect(adapter.signedUrlFor(key, 61)).rejects.toThrow(RangeError);
    await expect(adapter.signedUrlFor(key, 60)).resolves.toContain('Signature=');
  });
});
