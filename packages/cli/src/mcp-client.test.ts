import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { connectMcpClient } from './mcp-client.js';
import type { FakeMcpServer } from './test-support/fake-mcp-server.js';
import { startFakeMcpServer } from './test-support/fake-mcp-server.js';

describe('connectMcpClient', () => {
  let fake: FakeMcpServer | undefined;

  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it('rejects a wrong Authorization header at the real HTTP layer', async () => {
    fake = await startFakeMcpServer();
    await expect(connectMcpClient(fake.url, 'wrong-key')).rejects.toThrow();
  });

  it('lists projects over a real HTTP round trip', async () => {
    fake = await startFakeMcpServer();
    const client = await connectMcpClient(fake.url, fake.apiKey);
    try {
      const result = await client.listProjects();
      expect(result).toEqual({ ok: true, value: fake.state.projects });
    } finally {
      await client.close();
    }
  });

  it('reads a document, mapping version_seq to versionSeq', async () => {
    fake = await startFakeMcpServer();
    fake.state.documents.set('doc_1', { id: 'doc_1', title: 'T', versionSeq: 5, content: 'hi' });
    const client = await connectMcpClient(fake.url, fake.apiKey);
    try {
      const result = await client.getDocument('doc_1');
      expect(result).toEqual({
        ok: true,
        value: { id: 'doc_1', title: 'T', versionSeq: 5, content: 'hi' },
      });
    } finally {
      await client.close();
    }
  });

  it('reads document status without the body, mapping every snake_case field', async () => {
    fake = await startFakeMcpServer();
    fake.state.documents.set('doc_1', {
      id: 'doc_1',
      title: 'T',
      versionSeq: 5,
      content: 'hi',
      myPermission: 'comment',
    });
    const client = await connectMcpClient(fake.url, fake.apiKey);
    try {
      const result = await client.getDocumentStatus('doc_1');
      expect(result).toEqual({
        ok: true,
        value: {
          documentId: 'doc_1',
          versionSeq: 5,
          // Bare sha256 hex, the server's format — not the manifest's
          // `sha256:` prefixed one.
          contentHash: createHash('sha256').update('hi').digest('hex'),
          myPermission: 'comment',
        },
      });
    } finally {
      await client.close();
    }
  });

  it('returns a typed error result for a forbidden document status', async () => {
    fake = await startFakeMcpServer();
    const client = await connectMcpClient(fake.url, fake.apiKey);
    try {
      const result = await client.getDocumentStatus('doc_forbidden');
      expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
    } finally {
      await client.close();
    }
  });

  it('returns a typed error result for a forbidden document', async () => {
    fake = await startFakeMcpServer();
    const client = await connectMcpClient(fake.url, fake.apiKey);
    try {
      const result = await client.getDocument('doc_forbidden');
      expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
    } finally {
      await client.close();
    }
  });

  it('creates a new document via upload_document without document_id', async () => {
    fake = await startFakeMcpServer();
    const client = await connectMcpClient(fake.url, fake.apiKey);
    try {
      const result = await client.uploadDocument({
        content: '# hi',
        title: 'Hi',
        projectId: 'proj_1',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.versionSeq).toBe(1);
        expect(result.value.deduplicated).toBe(false);
      }
    } finally {
      await client.close();
    }
  });

  it('appends a new version via upload_document with document_id', async () => {
    fake = await startFakeMcpServer();
    fake.state.documents.set('doc_1', { id: 'doc_1', title: 'T', versionSeq: 1, content: 'old' });
    const client = await connectMcpClient(fake.url, fake.apiKey);
    try {
      const result = await client.uploadDocument({ content: 'new', documentId: 'doc_1' });
      expect(result).toEqual({
        ok: true,
        value: { documentId: 'doc_1', versionSeq: 2, deduplicated: false },
      });
    } finally {
      await client.close();
    }
  });

  // C1: `path` used to be missing from UploadDocumentInput entirely, which
  // is why every CLI push left the server-side `path` column NULL. These two
  // prove the tool-call arg is actually wired, matching the existing
  // omit-when-falsy pattern the other optional fields already follow.
  it('includes a path field in the upload_document call when path is given', async () => {
    fake = await startFakeMcpServer();
    const client = await connectMcpClient(fake.url, fake.apiKey);
    try {
      const result = await client.uploadDocument({
        content: '# hi',
        title: 'Hi',
        path: 'docs/x.md',
      });
      expect(result.ok).toBe(true);
      const created = [...fake.state.documents.values()][0];
      expect(created?.path).toBe('docs/x.md');
    } finally {
      await client.close();
    }
  });

  it('omits the path field entirely when path is not given', async () => {
    fake = await startFakeMcpServer();
    const client = await connectMcpClient(fake.url, fake.apiKey);
    try {
      const result = await client.uploadDocument({ content: '# hi', title: 'Hi' });
      expect(result.ok).toBe(true);
      const created = [...fake.state.documents.values()][0];
      expect(created?.path).toBeNull();
    } finally {
      await client.close();
    }
  });

  // Phase 33.A.1: parseToolResult used to discard everything but `error` off
  // the tool's error payload. These two prove it now surfaces `limit`/
  // `message` when the server sends them (the tier-cap sentinel in
  // test-support/fake-mcp-server.ts), and stays exactly `{ code }` — no
  // stray keys — when the server doesn't, same as before this field existed.
  it('surfaces limit and message on a tier-cap error result', async () => {
    fake = await startFakeMcpServer();
    const client = await connectMcpClient(fake.url, fake.apiKey);
    try {
      const result = await client.uploadDocument({ content: '# Over', title: 'cap-exceeded' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('doc_cap_exceeded');
        expect(result.error.limit).toBe(100);
        expect(result.error.message).toContain('100 active documents');
      }
    } finally {
      await client.close();
    }
  });

  it('falls back to a code-only error result when the server sends no message or limit', async () => {
    fake = await startFakeMcpServer();
    const client = await connectMcpClient(fake.url, fake.apiKey);
    try {
      const result = await client.getDocument('doc_forbidden');
      expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
      if (!result.ok) {
        expect(result.error).not.toHaveProperty('message');
        expect(result.error).not.toHaveProperty('limit');
      }
    } finally {
      await client.close();
    }
  });

  it('reads org usage, mapping every snake_case field, with no project_usage when not requested', async () => {
    fake = await startFakeMcpServer();
    fake.state.orgUsage = { tier: 'free', activeDocCount: 42, maxActiveDocs: 100 };
    const client = await connectMcpClient(fake.url, fake.apiKey);
    try {
      const result = await client.getOrgUsage();
      expect(result).toEqual({
        ok: true,
        value: { tier: 'free', activeDocCount: 42, maxActiveDocs: 100 },
      });
      if (result.ok) expect(result.value).not.toHaveProperty('projectUsage');
    } finally {
      await client.close();
    }
  });

  it('includes projectUsage only when a project id is passed', async () => {
    fake = await startFakeMcpServer();
    fake.state.orgUsage = {
      tier: 'team',
      activeDocCount: 10,
      maxActiveDocs: 5_000,
      projectUsage: { activeDocCount: 3, maxActiveDocsPerProject: 500 },
    };
    const client = await connectMcpClient(fake.url, fake.apiKey);
    try {
      const withProject = await client.getOrgUsage('proj_1');
      expect(withProject).toEqual({
        ok: true,
        value: {
          tier: 'team',
          activeDocCount: 10,
          maxActiveDocs: 5_000,
          projectUsage: { activeDocCount: 3, maxActiveDocsPerProject: 500 },
        },
      });
      const withoutProject = await client.getOrgUsage();
      if (withoutProject.ok) expect(withoutProject.value).not.toHaveProperty('projectUsage');
    } finally {
      await client.close();
    }
  });

  it('returns a typed error result when org usage fails', async () => {
    fake = await startFakeMcpServer();
    fake.state.orgUsage = 'fail';
    const client = await connectMcpClient(fake.url, fake.apiKey);
    try {
      const result = await client.getOrgUsage();
      expect(result).toEqual({ ok: false, error: { code: 'org_not_found' } });
    } finally {
      await client.close();
    }
  });
});
