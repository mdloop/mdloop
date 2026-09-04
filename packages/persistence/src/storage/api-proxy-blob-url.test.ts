import { describe, expect, it } from 'vitest';
import type { VersionKey } from '@mdloop/app';
import type { DocumentId, OrgId } from '@mdloop/shared';
import { ApiProxyBlobUrl } from './api-proxy-blob-url.js';

describe('ApiProxyBlobUrl', () => {
  it('returns a document/version-scoped proxy path, ignoring ttl', async () => {
    const key: VersionKey = { orgId: 'org-a' as OrgId, documentId: 'doc-1' as DocumentId, seq: 3 };
    const url = new ApiProxyBlobUrl();
    await expect(url.signedUrlFor(key, 60)).resolves.toBe(
      '/documents/doc-1/versions/seq/3/content',
    );
    // ttl is documented as irrelevant for this adapter — same path regardless.
    await expect(url.signedUrlFor(key, 99_999)).resolves.toBe(
      '/documents/doc-1/versions/seq/3/content',
    );
  });
});
