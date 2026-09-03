import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PgDirectoryRepository } from '@vorlyn/persistence';
import type { OrgId } from '@vorlyn/shared';
import { encodeSession, SESSION_TTL_MS } from './auth/session.js';
import { createTestServer, loginAs, testConfig } from './test-support/test-server.js';
import type { TestServer } from './test-support/test-server.js';

interface ExportedVersionDto {
  seq: number;
  changeNote: string | null;
  purged: boolean;
}
interface ExportedCommentDto {
  id: string;
  body: string;
  replies: { body: string }[];
}
interface ExportedDocumentDto {
  id: string;
  title: string;
  markdown: string | null;
  versions: ExportedVersionDto[];
  comments: ExportedCommentDto[];
}
interface ExportDto {
  orgId: string;
  orgName: string;
  documents: ExportedDocumentDto[];
  nextCursor: string | null;
}

/**
 * `GET /org/export` (Phase 14, GDPR Art. 20; keyset-paged per the ADR 0003
 * completeness pass) has no web UI (grep confirms nothing in packages/web
 * calls it — the only callers today are the admin-API and the MCP `export_org`
 * tool) and no existing test exercises it through the real HTTP stack: the
 * use-case's field-mapping is unit-tested against fakes
 * (erasure-export.test.ts) and the DB-level keyset order is proven directly
 * against `listForExport` (export-pagination.integration.test.ts), but nothing
 * proves the route wiring itself — auth, the cursor/limit query params
 * actually threading through, the full multi-page walk, admin-only 403, and
 * tenant isolation — end to end. This file closes that gap (Phase 24.G).
 */
describe('org export API (Phase 14, GDPR Art. 20)', () => {
  let ts: TestServer;
  let server: FastifyInstance;
  let admin: string;
  let outsider: string;
  const documentIds: string[] = [];

  /** Session's own org id — same technique review-api.test.ts uses to learn
   *  the personal org bootstrapped for `admin` without a second query. */
  function adminOrgId(): OrgId {
    const [body] = admin.split('.');
    const payload = JSON.parse(Buffer.from(body ?? '', 'base64url').toString()) as {
      orgId: string;
    };
    return payload.orgId as OrgId;
  }

  beforeAll(async () => {
    ts = await createTestServer();
    server = ts.server;
    admin = await loginAs(server, 'export-admin');
    outsider = await loginAs(server, 'export-outsider');

    // Three docs so a limit=2 walk needs exactly two page round trips.
    for (const title of ['alpha.md', 'beta.md', 'gamma.md']) {
      const res = await server.inject({
        method: 'POST',
        url: '/api/documents',
        cookies: { vorlyn_session: admin },
        payload: { title, content: `# ${title}` },
      });
      expect(res.statusCode, res.body).toBe(201);
      documentIds.push(res.json<{ document: { id: string } }>().document.id);
    }

    // A second version (with a change note) plus a comment + reply on the
    // first doc — proves the versions[]/comments[]/replies[] shape survives
    // the real upload/comment use-cases, not just a hand-built fixture.
    const [firstDoc] = documentIds;
    const versionRes = await server.inject({
      method: 'POST',
      url: `/api/documents/${firstDoc}/versions`,
      cookies: { vorlyn_session: admin },
      payload: { content: '# alpha.md\n\nRevised.', changeNote: 'Reworked the intro' },
    });
    expect(versionRes.statusCode, versionRes.body).toBe(200);

    const commentRes = await server.inject({
      method: 'POST',
      url: `/api/documents/${firstDoc}/comments`,
      cookies: { vorlyn_session: admin },
      payload: { body: 'Looks solid', anchor: { type: 'document' } },
    });
    expect(commentRes.statusCode, commentRes.body).toBe(201);
    const commentId = commentRes.json<{ id: string }>().id;

    const replyRes = await server.inject({
      method: 'POST',
      url: `/api/comments/${commentId}/replies`,
      cookies: { vorlyn_session: admin },
      payload: { body: 'Agreed' },
    });
    expect(replyRes.statusCode, replyRes.body).toBe(201);
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  it('walks every page via cursor with no dupes or gaps, shaped honestly', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let calls = 0;
    let firstPage: ExportDto | undefined;
    do {
      const res = await server.inject({
        method: 'GET',
        url: `/api/org/export?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        cookies: { vorlyn_session: admin },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-disposition']).toBe('attachment; filename="vorlyn-export.json"');
      const page = res.json<ExportDto>();
      firstPage ??= page;
      seen.push(...page.documents.map((d) => d.id));
      cursor = page.nextCursor ?? undefined;
      calls += 1;
    } while (cursor && calls < 10);

    // 3 docs at limit=2 is exactly one full page then one partial page.
    expect(calls).toBe(2);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining(documentIds));
    expect(seen).toHaveLength(documentIds.length);

    expect(firstPage.orgId).toBe(adminOrgId());
    const alpha = firstPage.documents.find((d) => d.id === documentIds[0]);
    expect(alpha?.markdown).toBe('# alpha.md\n\nRevised.');
    expect(alpha?.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ seq: 1, changeNote: null, purged: false }),
        expect.objectContaining({ seq: 2, changeNote: 'Reworked the intro', purged: false }),
      ]),
    );
    expect(alpha?.comments).toHaveLength(1);
    expect(alpha?.comments[0]).toMatchObject({ body: 'Looks solid' });
    expect(alpha?.comments[0]?.replies).toEqual([expect.objectContaining({ body: 'Agreed' })]);
  });

  it('is admin-only: a member of the same org gets 403', async () => {
    const directory = new PgDirectoryRepository(ts.db.pool);
    const member = await directory.createUser(adminOrgId(), {
      workosUserId: 'wos_export-member',
      email: 'export-member@acme.test',
      displayName: 'Export Member',
      role: 'member',
    });
    const iat = Date.now();
    const memberSession = encodeSession(
      { userId: member.id, orgId: adminOrgId(), role: 'member', iat, exp: iat + SESSION_TTL_MS },
      testConfig.sessionSecret,
    );
    const res = await server.inject({
      method: 'GET',
      url: '/api/org/export',
      cookies: { vorlyn_session: memberSession },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
  });

  it('never crosses tenants: a different org admin sees only their own (empty) org', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/org/export',
      cookies: { vorlyn_session: outsider },
    });
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json<ExportDto>();
    expect(page.documents).toHaveLength(0);
    expect(page.orgId).not.toBe(adminOrgId());
  });
});
