import { describe, expect, it } from 'vitest';
import { publicObjectKey, versionObjectKey } from './storage.port.js';
import type { DocumentId, OrgId, PublicDocId } from '@mdloop/shared';

describe('versionObjectKey', () => {
  it('builds the canonical org-prefixed key', () => {
    const key = {
      orgId: 'org-1' as OrgId,
      documentId: 'doc-9' as DocumentId,
      seq: 3,
    };
    expect(versionObjectKey(key)).toBe('orgs/org-1/docs/doc-9/v3');
  });
});

describe('publicObjectKey', () => {
  it('builds the canonical public-hub key, outside the orgs/ tenant keyspace', () => {
    const key = { publicDocId: 'pub-1' as PublicDocId, seq: 2 };
    expect(publicObjectKey(key)).toBe('public/pub-1/v2');
  });
});
