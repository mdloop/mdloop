import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DIFF_MAX_BYTES } from '@vorlyn/domain';
import { PgVersionRepository } from '@vorlyn/persistence';
import { decodeSession } from './auth/session.js';
import { createTestServer, loginAs, testConfig } from './test-support/test-server.js';
import type { TestServer } from './test-support/test-server.js';

/**
 * Rendered leg diff route (ADR 0003 §A): happy-path structured JSON, the
 * pair-hash ETag + 304, purged-leg 410 honesty, over-cap 413 fallback signal,
 * change-note round-trip, and cross-org isolation.
 */
interface DiffBody {
  from: { seq: number; contentHash: string; changeNote: string | null };
  to: { seq: number; contentHash: string; changeNote: string | null };
  blocks: { type: string }[];
}

describe('document diff API', () => {
  let ts: TestServer;
  let server: FastifyInstance;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    ts = await createTestServer();
    server = ts.server;
    alice = await loginAs(server, 'alice');
    bob = await loginAs(server, 'bob');
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  async function upload(session: string, title: string, content: string, changeNote?: string) {
    const res = await server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { vorlyn_session: session },
      payload: { title, content, ...(changeNote ? { changeNote } : {}) },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ document: { id: string }; version: { id: string; seq: number } }>();
  }

  async function newVersion(session: string, id: string, content: string, changeNote?: string) {
    const res = await server.inject({
      method: 'POST',
      url: `/api/documents/${id}/versions`,
      cookies: { vorlyn_session: session },
      payload: { content, ...(changeNote ? { changeNote } : {}) },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ version: { seq: number } }>();
  }

  it('returns a structured block diff with notes and a strong pair ETag', async () => {
    const { document } = await upload(alice, 'diff.md', '# Title\n\nOriginal body.', 'first');
    await newVersion(alice, document.id, '# Title\n\nRewritten body entirely.', 'reworked');

    const res = await server.inject({
      method: 'GET',
      url: `/api/documents/${document.id}/diff?from_seq=1&to_seq=2`,
      cookies: { vorlyn_session: alice },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<DiffBody>();
    expect(body.from.changeNote).toBe('first');
    expect(body.to.changeNote).toBe('reworked');
    expect(body.blocks.map((b) => b.type)).toContain('unchanged');
    expect(body.blocks.some((b) => b.type !== 'unchanged')).toBe(true);

    const etag = res.headers.etag;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const revalidate = await server.inject({
      method: 'GET',
      url: `/api/documents/${document.id}/diff?from_seq=1&to_seq=2`,
      cookies: { vorlyn_session: alice },
      headers: { 'if-none-match': String(etag) },
    });
    expect(revalidate.statusCode).toBe(304);
  });

  it('304s a conditional GET off metadata alone, without reading either blob', async () => {
    const { document } = await upload(alice, 'etag-diff.md', '# Title\n\nOriginal body.');
    await newVersion(alice, document.id, '# Title\n\nRewritten body entirely.');

    const first = await server.inject({
      method: 'GET',
      url: `/api/documents/${document.id}/diff?from_seq=1&to_seq=2`,
      cookies: { vorlyn_session: alice },
    });
    expect(first.statusCode, first.body).toBe(200);
    const etag = String(first.headers.etag);

    const getSpy = vi.spyOn(ts.storage, 'get');
    const revalidate = await server.inject({
      method: 'GET',
      url: `/api/documents/${document.id}/diff?from_seq=1&to_seq=2`,
      cookies: { vorlyn_session: alice },
      headers: { 'if-none-match': etag },
    });
    expect(revalidate.statusCode).toBe(304);
    expect(getSpy).not.toHaveBeenCalled();
    getSpy.mockRestore();
  });

  it('410s when a leg is a purged tombstone (ADR A.5)', async () => {
    const { document } = await upload(alice, 'purge-diff.md', 'leg one');
    await newVersion(alice, document.id, 'leg two');
    const session = decodeSession(alice, [testConfig.sessionSecret])?.payload;
    if (!session) throw new Error('bad session');
    const ctx = { orgId: session.orgId as never, userId: session.userId as never };
    const versions = new PgVersionRepository(ts.db.pool);
    const [v1] = await versions.listForDocument(ctx, document.id as never);
    if (!v1) throw new Error('no v1');
    await versions.tombstone(ctx, v1.id);

    const res = await server.inject({
      method: 'GET',
      url: `/api/documents/${document.id}/diff?from_seq=1&to_seq=2`,
      cookies: { vorlyn_session: alice },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ error: 'version_purged' });
  });

  it('413s over the byte cap so the client falls back to the source view', async () => {
    const { document } = await upload(alice, 'big-diff.md', 'small leg one');
    await newVersion(alice, document.id, 'x'.repeat(DIFF_MAX_BYTES + 1));
    const res = await server.inject({
      method: 'GET',
      url: `/api/documents/${document.id}/diff?from_seq=1&to_seq=2`,
      cookies: { vorlyn_session: alice },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'diff_too_large' });
  });

  it('404s an unknown seq', async () => {
    const { document } = await upload(alice, 'one-leg.md', 'only one');
    const res = await server.inject({
      method: 'GET',
      url: `/api/documents/${document.id}/diff?from_seq=1&to_seq=7`,
      cookies: { vorlyn_session: alice },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'version_not_found' });
  });

  it("bob cannot diff alice's document (404, no oracle)", async () => {
    const { document } = await upload(alice, 'secret-diff.md', 'v1');
    await newVersion(alice, document.id, 'v2');
    const res = await server.inject({
      method: 'GET',
      url: `/api/documents/${document.id}/diff?from_seq=1&to_seq=2`,
      cookies: { vorlyn_session: bob },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'document_not_found' });
  });

  it('validates a change note over 20k at the schema layer', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { vorlyn_session: alice },
      payload: { title: 'toolong.md', content: 'x', changeNote: 'n'.repeat(20001) },
    });
    expect(res.statusCode).toBe(400);
  });
});
