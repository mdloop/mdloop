import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uploadNewVersion } from '@mdloop/app';
import { MAX_UPLOAD_BYTES } from '@mdloop/domain';
import {
  PgApiKeyRepository,
  PgCommentRepository,
  PgDirectoryRepository,
  PgDocumentRepository,
  PgProjectRepository,
  PgShareGrantRepository,
  PgUploadUnitOfWork,
  PgVersionRepository,
} from '@mdloop/persistence';
import { decodeSession } from './auth/session.js';
import { testConfig, createTestServer, loginAs } from './test-support/test-server.js';
import type { TestServer } from './test-support/test-server.js';

interface DocumentDto {
  id: string;
  projectId: string | null;
  title: string;
  path: string | null;
  currentVersionId: string | null;
  archivedAt: string | null;
}

describe('documents + projects API', () => {
  let ts: TestServer;
  let server: FastifyInstance;
  let alice: string; // org A owner
  let bob: string; // org B user

  beforeAll(async () => {
    ts = await createTestServer();
    server = ts.server;
    alice = await loginAs(server, 'alice');
    bob = await loginAs(server, 'bob');
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  async function upload(session: string, title: string, content = `# ${title}`) {
    const res = await server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { mdloop_session: session },
      payload: { title, content },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ document: DocumentDto; version: { id: string; seq: number } }>();
  }

  it('uploads, lists and fetches a document with its content', async () => {
    const { document } = await upload(alice, 'runbook.md', '# Runbook\n\nsteps');
    expect(document.currentVersionId).not.toBeNull();

    const list = await server.inject({
      method: 'GET',
      url: '/api/documents',
      cookies: { mdloop_session: alice },
    });
    expect(list.json<{ documents: DocumentDto[] }>().documents.map((d) => d.id)).toContain(
      document.id,
    );

    const content = await server.inject({
      method: 'GET',
      url: `/api/documents/${document.id}/content`,
      cookies: { mdloop_session: alice },
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers['content-type']).toContain('text/markdown');
    expect(content.body).toBe('# Runbook\n\nsteps');
  });

  it('rejects an upload over the 500KB cap with 413', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { mdloop_session: alice },
      payload: { title: 'big.md', content: 'x'.repeat(MAX_UPLOAD_BYTES + 1) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'file_too_large' });
  });

  it('rejects non-markdown content with 415 (ADR 0011)', async () => {
    // A renamed binary as it actually arrives: the transport is a JSON string,
    // so the give-away is the control bytes that survived the client's decode.
    const withNul = await server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { mdloop_session: alice },
      payload: { title: 'renamed.md', content: '# Notes\n\u0000binary' },
    });
    expect(withNul.statusCode).toBe(415);
    expect(withNul.json()).toMatchObject({ error: 'control_byte_detected' });

    // Magic bytes that survive a lossy decode intact are caught by signature.
    const pdf = await server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { mdloop_session: alice },
      payload: { title: 'report.md', content: '%PDF-1.7 rest of the file' },
    });
    expect(pdf.statusCode).toBe(415);
    expect(pdf.json()).toMatchObject({ error: 'binary_signature_detected' });

    // Same gate on the new-version route, not just document creation.
    const { document } = await upload(alice, 'legit.md', '# Legit');
    const version = await server.inject({
      method: 'POST',
      url: `/api/documents/${document.id}/versions`,
      cookies: { mdloop_session: alice },
      payload: { content: '# Legit\n\u0000' },
    });
    expect(version.statusCode).toBe(415);
    expect(version.json()).toMatchObject({ error: 'control_byte_detected' });
    // Give the doc-cap headroom back: alice's org is shared by every test in
    // this file and sits on the free tier, so a scratch document left behind
    // here fails an unrelated upload later in the run.
    await server.inject({
      method: 'DELETE',
      url: `/api/documents/${document.id}`,
      cookies: { mdloop_session: alice },
    });
  });

  it('appends versions; identical content is a deduplicated no-op', async () => {
    const { document } = await upload(alice, 'versioned.md', 'v1');
    const v2 = await server.inject({
      method: 'POST',
      url: `/api/documents/${document.id}/versions`,
      cookies: { mdloop_session: alice },
      payload: { content: 'v2' },
    });
    expect(v2.statusCode).toBe(200);
    expect(v2.json()).toMatchObject({ version: { seq: 2 }, deduplicated: false });

    const again = await server.inject({
      method: 'POST',
      url: `/api/documents/${document.id}/versions`,
      cookies: { mdloop_session: alice },
      payload: { content: 'v2' },
    });
    expect(again.json()).toMatchObject({ version: { seq: 2 }, deduplicated: true });
  });

  it('decorates versions with the agent key name (Phase A), null for human uploads', async () => {
    const { document } = await upload(alice, 'agent-versioned.md', 'v1');
    const session = decodeSession(alice, [testConfig.sessionSecret])?.payload;
    if (!session) throw new Error('bad test session');
    const ctx = { orgId: session.orgId as never, userId: session.userId as never };
    const apiKeys = new PgApiKeyRepository(ts.db.pool);
    const versions = new PgVersionRepository(ts.db.pool);
    const key = await apiKeys.create(ctx, {
      userId: ctx.userId,
      name: 'ci bot',
      keyHash: 'irrelevant-for-this-test',
    });
    await versions.append(ctx, {
      documentId: document.id as never,
      contentHash: 'agent-hash',
      byteSize: 4,
      createdBy: ctx.userId,
      source: 'mcp',
      viaApiKeyId: key.id,
    });

    const list = await server.inject({
      method: 'GET',
      url: `/api/documents/${document.id}/versions`,
      cookies: { mdloop_session: alice },
    });
    const { versions: versionDtos } = list.json<{
      versions: { seq: number; viaApiKeyName: string | null }[];
    }>();
    expect(versionDtos.find((v) => v.seq === 1)?.viaApiKeyName).toBeNull();
    expect(versionDtos.find((v) => v.seq === 2)?.viaApiKeyName).toBe('ci bot');
  });

  it('creates projects, files documents, filters views', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { mdloop_session: alice },
      payload: { name: 'Ops', color: '#7c3aed' },
    });
    expect(created.statusCode).toBe(201);
    const project = created.json<{ id: string; color: string }>();
    expect(project.color).toBe('#7c3aed');

    const { document } = await upload(alice, 'filed.md');
    const moved = await server.inject({
      method: 'PATCH',
      url: `/api/documents/${document.id}`,
      cookies: { mdloop_session: alice },
      payload: { projectId: project.id },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json<DocumentDto>().projectId).toBe(project.id);

    const inProject = await server.inject({
      method: 'GET',
      url: `/api/documents?projectId=${project.id}`,
      cookies: { mdloop_session: alice },
    });
    expect(inProject.json<{ documents: DocumentDto[] }>().documents.map((d) => d.id)).toEqual([
      document.id,
    ]);

    const unfiled = await server.inject({
      method: 'GET',
      url: '/api/documents?view=unfiled',
      cookies: { mdloop_session: alice },
    });
    expect(unfiled.json<{ documents: DocumentDto[] }>().documents.map((d) => d.id)).not.toContain(
      document.id,
    );
  });

  it('the workspace tree mixes path-backed and manually-uploaded documents (Phase 29)', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { mdloop_session: alice },
      payload: { name: 'Tree', color: '#7c3aed' },
    });
    const project = created.json<{ id: string }>();

    // A manual upload: REST never accepts `path` (see uploadBodySchema's
    // comment on document-routes.ts) — the sync CLI is its only writer, so a
    // path only ever arrives via the same use-case call the MCP tool makes.
    const { document: manual } = await upload(alice, 'manual.md');
    await server.inject({
      method: 'PATCH',
      url: `/api/documents/${manual.id}`,
      cookies: { mdloop_session: alice },
      payload: { projectId: project.id },
    });

    const { document: mirrored } = await upload(alice, 'auth.md');
    await server.inject({
      method: 'PATCH',
      url: `/api/documents/${mirrored.id}`,
      cookies: { mdloop_session: alice },
      payload: { projectId: project.id },
    });
    const session = decodeSession(alice, [testConfig.sessionSecret])?.payload;
    if (!session) throw new Error('bad test session');
    const actor = {
      ctx: { orgId: session.orgId as never, userId: session.userId as never },
      role: session.role,
    };
    const uploadUow = new PgUploadUnitOfWork(ts.db.pool);
    const pushed = await uploadNewVersion(uploadUow, ts.storage, actor, {
      documentId: mirrored.id as never,
      content: new TextEncoder().encode('# Auth\n\nrewritten'),
      source: 'mcp',
      path: 'docs/specs/auth.md',
    });
    expect(pushed.ok).toBe(true);

    const tree = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/tree`,
      cookies: { mdloop_session: alice },
    });
    expect(tree.statusCode).toBe(200);
    const body = tree.json<{
      projectId: string;
      tooLarge: boolean;
      documentCount: number;
      documents: { id: string; title: string; path: string | null; openCommentCount: number }[];
    }>();
    expect(body.tooLarge).toBe(false);
    expect(body.documentCount).toBe(2);
    const byId = new Map(body.documents.map((d) => [d.id, d]));
    expect(byId.get(manual.id)).toMatchObject({ path: null, openCommentCount: 0 });
    expect(byId.get(mirrored.id)).toMatchObject({
      path: 'docs/specs/auth.md',
      openCommentCount: 0,
    });

    // Reading `path` back over HTTP proves the reverse direction (documentDto
    // returns it) without REST ever having been the one to set it.
    const read = await server.inject({
      method: 'GET',
      url: `/api/documents/${mirrored.id}`,
      cookies: { mdloop_session: alice },
    });
    expect(read.json<DocumentDto>().path).toBe('docs/specs/auth.md');

    // Free tier caps at 100 active documents (TIER_PROFILES.free.maxActiveDocs,
    // Phase 33) and this suite shares one org across every test in the file —
    // clean up after ourselves the same way 'soft delete hides the document' does.
    for (const id of [manual.id, mirrored.id]) {
      await server.inject({
        method: 'DELETE',
        url: `/api/documents/${id}`,
        cookies: { mdloop_session: alice },
      });
    }
  });

  it('renames a project and deletes it, unfiling its documents', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { mdloop_session: alice },
      payload: { name: 'Temp', color: '#7c3aed' },
    });
    const project = created.json<{ id: string }>();

    const renamed = await server.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      cookies: { mdloop_session: alice },
      payload: { name: 'Renamed' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ name: string }>().name).toBe('Renamed');

    const { document } = await upload(alice, 'in-deleted-project.md');
    await server.inject({
      method: 'PATCH',
      url: `/api/documents/${document.id}`,
      cookies: { mdloop_session: alice },
      payload: { projectId: project.id },
    });

    const deleted = await server.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}`,
      cookies: { mdloop_session: alice },
    });
    expect(deleted.statusCode).toBe(204);

    const missing = await server.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}`,
      cookies: { mdloop_session: alice },
    });
    expect(missing.statusCode).toBe(404);

    const doc = await server.inject({
      method: 'GET',
      url: `/api/documents/${document.id}`,
      cookies: { mdloop_session: alice },
    });
    expect(doc.json<DocumentDto>().projectId).toBeNull();
  });

  it('rejects invalid project colors', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { mdloop_session: alice },
      payload: { name: 'Bad', color: 'red' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_color' });
  });

  it('archives and unarchives a document', async () => {
    const { document } = await upload(alice, 'archive-me.md');
    const archived = await server.inject({
      method: 'PATCH',
      url: `/api/documents/${document.id}`,
      cookies: { mdloop_session: alice },
      payload: { archived: true },
    });
    expect(archived.json<DocumentDto>().archivedAt).not.toBeNull();

    const view = await server.inject({
      method: 'GET',
      url: '/api/documents?view=archived',
      cookies: { mdloop_session: alice },
    });
    expect(view.json<{ documents: DocumentDto[] }>().documents.map((d) => d.id)).toContain(
      document.id,
    );
  });

  it('soft delete hides the document; content 404s afterwards', async () => {
    const { document } = await upload(alice, 'delete-me.md');
    const del = await server.inject({
      method: 'DELETE',
      url: `/api/documents/${document.id}`,
      cookies: { mdloop_session: alice },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ deleted: true, purged: false });

    for (const url of [`/documents/${document.id}`, `/documents/${document.id}/content`]) {
      const res = await server.inject({ method: 'GET', url, cookies: { mdloop_session: alice } });
      expect(res.statusCode, url).toBe(404);
    }
  });

  describe('tenant isolation over HTTP', () => {
    it("bob cannot read, list, modify or delete alice's documents", async () => {
      const { document } = await upload(alice, 'secret.md', 'org A only');

      const list = await server.inject({
        method: 'GET',
        url: '/api/documents',
        cookies: { mdloop_session: bob },
      });
      expect(list.json<{ documents: DocumentDto[] }>().documents.map((d) => d.id)).not.toContain(
        document.id,
      );

      const reads = [
        server.inject({
          method: 'GET',
          url: `/api/documents/${document.id}`,
          cookies: { mdloop_session: bob },
        }),
        server.inject({
          method: 'GET',
          url: `/api/documents/${document.id}/content`,
          cookies: { mdloop_session: bob },
        }),
      ];
      for (const res of await Promise.all(reads)) expect(res.statusCode).toBe(404);

      const write = await server.inject({
        method: 'POST',
        url: `/api/documents/${document.id}/versions`,
        cookies: { mdloop_session: bob },
        payload: { content: 'tampered' },
      });
      expect(write.statusCode).toBe(404);

      const del = await server.inject({
        method: 'DELETE',
        url: `/api/documents/${document.id}`,
        cookies: { mdloop_session: bob },
      });
      expect(del.statusCode).toBe(404);

      const still = await server.inject({
        method: 'GET',
        url: `/api/documents/${document.id}`,
        cookies: { mdloop_session: alice },
      });
      expect(still.statusCode).toBe(200);
    });

    it('comment rollup counts stay inside the org', async () => {
      const { document } = await upload(alice, 'commented.md');
      const session = decodeSession(alice, [testConfig.sessionSecret])?.payload;
      if (!session) throw new Error('bad test session');
      const ctx = {
        orgId: session.orgId as never,
        userId: session.userId as never,
      };
      const comments = new PgCommentRepository(ts.db.pool);
      await comments.create(ctx, {
        documentId: document.id as never,
        versionId: document.currentVersionId as never,
        authorId: ctx.userId,
        body: 'needs work',
        anchor: { type: 'document' },
      });

      const mine = await server.inject({
        method: 'GET',
        url: '/api/comments/rollup',
        cookies: { mdloop_session: alice },
      });
      expect(mine.statusCode).toBe(200);
      const rollup = mine.json<{ rollup: { documentId: string; open: number }[] }>().rollup;
      expect(rollup.find((r) => r.documentId === document.id)).toMatchObject({ open: 1 });

      const theirs = await server.inject({
        method: 'GET',
        url: '/api/comments/rollup',
        cookies: { mdloop_session: bob },
      });
      expect(
        theirs
          .json<{ rollup: { documentId: string }[] }>()
          .rollup.find((r) => r.documentId === document.id),
      ).toBeUndefined();
    });

    // ADR 0008 (Phase 28): an `edit` share grant is a new way to be allowed to
    // write a document, so it needs the same three-surface isolation proof as
    // every other write right. HTTP surface; the MCP twin is in
    // packages/mcp/src/server.test.ts, the repository twin in
    // features/tenant-isolation.feature.
    it('an edit grantee in org B still cannot push to an org A document', async () => {
      const { document } = await upload(alice, 'org-a-only.md', 'org A only');

      const session = decodeSession(bob, [testConfig.sessionSecret])?.payload;
      if (!session) throw new Error('bad test session');
      const bobCtx = { orgId: session.orgId as never, userId: session.userId as never };

      // Make bob a genuine editor — of a document in his OWN org.
      const directory = new PgDirectoryRepository(ts.db.pool);
      const documents = new PgDocumentRepository(ts.db.pool);
      const grants = new PgShareGrantRepository(ts.db.pool);
      const colleague = await directory.createUser(bobCtx.orgId, {
        workosUserId: `wos_colleague_${String(Math.random())}`,
        email: `colleague_${String(Math.random())}@orgb.test`,
        displayName: 'Colleague',
        role: 'member',
      });
      const theirDoc = await documents.create(
        { orgId: bobCtx.orgId, userId: colleague.id },
        { projectId: null, ownerId: colleague.id, title: 'org-b.md' },
      );
      await grants.create(bobCtx, {
        subject: { type: 'document', id: theirDoc.id },
        grantee: { type: 'user', userId: bobCtx.userId },
        permission: 'edit',
        tokenHash: null,
        createdBy: colleague.id,
      });

      // The grant really works, over HTTP, on the document it names.
      const own = await server.inject({
        method: 'POST',
        url: `/api/documents/${theirDoc.id}/versions`,
        cookies: { mdloop_session: bob },
        payload: { content: '# pushed by a grantee' },
      });
      expect(own.statusCode, own.body).toBe(200);
      expect(own.json<{ deduplicated: boolean }>().deduplicated).toBe(false);

      // And buys nothing across the org boundary, even forged to name org A's
      // document: RLS never lets the document be found at all.
      await grants.create(bobCtx, {
        subject: { type: 'document', id: document.id as never },
        grantee: { type: 'user', userId: bobCtx.userId },
        permission: 'edit',
        tokenHash: null,
        createdBy: bobCtx.userId,
      });
      const across = await server.inject({
        method: 'POST',
        url: `/api/documents/${document.id}/versions`,
        cookies: { mdloop_session: bob },
        payload: { content: 'tampered' },
      });
      expect(across.statusCode).toBe(404);
      expect(across.json()).toMatchObject({ error: 'document_not_found' });
    });

    // ADR 0014's second isolation proof (project-subject grants, not just
    // document-subject ones) — HTTP twin of
    // features/tenant-isolation.feature's "A project grantee cannot reach
    // another organization's document"; the MCP twin is in
    // packages/mcp/src/server.test.ts.
    it('a project edit grantee in org B still cannot push to an org A document, even filed in a project', async () => {
      const { document } = await upload(alice, 'org-a-in-project.md', 'org A, in a project');

      const session = decodeSession(bob, [testConfig.sessionSecret])?.payload;
      if (!session) throw new Error('bad test session');
      const bobCtx = { orgId: session.orgId as never, userId: session.userId as never };
      const aliceSession = decodeSession(alice, [testConfig.sessionSecret])?.payload;
      if (!aliceSession) throw new Error('bad alice session');
      const aliceCtx = {
        orgId: aliceSession.orgId as never,
        userId: aliceSession.userId as never,
      };

      const projects = new PgProjectRepository(ts.db.pool);
      const documents = new PgDocumentRepository(ts.db.pool);
      const grants = new PgShareGrantRepository(ts.db.pool);

      // A real project-edit grantee — of a project in his OWN org.
      const ownProject = await projects.create(bobCtx, {
        name: 'Bob project',
        color: '#123456',
      });
      await grants.create(bobCtx, {
        subject: { type: 'project', id: ownProject.id },
        grantee: { type: 'user', userId: bobCtx.userId },
        permission: 'edit',
        tokenHash: null,
        createdBy: bobCtx.userId,
      });
      const ownDoc = await documents.create(bobCtx, {
        projectId: ownProject.id,
        ownerId: bobCtx.userId,
        title: 'bobs-project-doc.md',
      });
      const ownPush = await server.inject({
        method: 'POST',
        url: `/api/documents/${ownDoc.id}/versions`,
        cookies: { mdloop_session: bob },
        payload: { content: '# pushed via a project grant' },
      });
      expect(ownPush.statusCode, ownPush.body).toBe(200);

      // Move alice's document into an Acme-side project, then forge a
      // project grant naming that project (org RLS still stamps the row into
      // Globex, since bob's the one inserting it).
      const aliceProject = await projects.create(aliceCtx, {
        name: 'Alice project',
        color: '#654321',
      });
      await documents.moveToProject(aliceCtx, document.id as never, aliceProject.id);

      await grants.create(bobCtx, {
        subject: { type: 'project', id: aliceProject.id },
        grantee: { type: 'user', userId: bobCtx.userId },
        permission: 'edit',
        tokenHash: null,
        createdBy: bobCtx.userId,
      });
      const across = await server.inject({
        method: 'POST',
        url: `/api/documents/${document.id}/versions`,
        cookies: { mdloop_session: bob },
        payload: { content: 'tampered via forged project grant' },
      });
      expect(across.statusCode).toBe(404);
      expect(across.json()).toMatchObject({ error: 'document_not_found' });
    });

    it("bob cannot file documents into alice's project", async () => {
      const created = await server.inject({
        method: 'POST',
        url: '/api/projects',
        cookies: { mdloop_session: alice },
        payload: { name: 'A-only' },
      });
      const projectId = created.json<{ id: string }>().id;
      const res = await server.inject({
        method: 'POST',
        url: '/api/documents',
        cookies: { mdloop_session: bob },
        payload: { title: 'sneak.md', content: 'x', projectId },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'project_not_found' });
    });

    // The workspace tree (Phase 29) is a project-scoped read with no
    // permission semantics beyond "can you read this project's documents" —
    // same tenant boundary as every other project route: a project in
    // another org does not resolve at all, RLS-shaped like the rest of this
    // suite (the tenant boundary and "not found" are the same answer). Proven
    // on an empty project rather than uploading a document into it — the
    // resolution check is what's under test, and alice's org is already
    // running close to the free-tier document cap by this point in the file.
    it("bob cannot read alice's project tree", async () => {
      const created = await server.inject({
        method: 'POST',
        url: '/api/projects',
        cookies: { mdloop_session: alice },
        payload: { name: 'Tree-only' },
      });
      const projectId = created.json<{ id: string }>().id;

      const asOwner = await server.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/tree`,
        cookies: { mdloop_session: alice },
      });
      expect(asOwner.statusCode).toBe(200);
      expect(asOwner.json<{ documentCount: number }>().documentCount).toBe(0);

      const asBob = await server.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/tree`,
        cookies: { mdloop_session: bob },
      });
      expect(asBob.statusCode).toBe(404);
      expect(asBob.json()).toMatchObject({ error: 'project_not_found' });
    });
  });
});

describe('rate limiting', () => {
  it('429s past the upload limit without touching the global limit', async () => {
    const ts = await createTestServer({ global: 1000, upload: 2 });
    try {
      const session = await loginAs(ts.server, 'ratelimited');
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await ts.server.inject({
          method: 'POST',
          url: '/api/documents',
          cookies: { mdloop_session: session },
          payload: { title: `d${String(i)}.md`, content: `c${String(i)}` },
        });
        statuses.push(res.statusCode);
      }
      expect(statuses).toEqual([201, 201, 429]);

      const list = await ts.server.inject({
        method: 'GET',
        url: '/api/documents',
        cookies: { mdloop_session: session },
      });
      expect(list.statusCode).toBe(200);
    } finally {
      await ts.close();
    }
  }, 60_000);
});

/**
 * Phase 33: `maxActiveDocsPerProject` is a separate, tighter-scoped sibling
 * of the org-wide `maxActiveDocs` cap. HTTP-level coverage that hitting it
 * maps to 403 `project_doc_cap_exceeded` (document-routes.ts's
 * `uploadErrorStatus` map) the same way `doc_cap_exceeded` does — and,
 * critically, that it fires independently of the org-wide cap: team tier's
 * org cap (5,000) has plenty of headroom left while its per-project cap
 * (500) is exhausted, so a 403 here can only be the project gate.
 */
describe('project doc cap (Phase 33)', () => {
  it('403s "project_doc_cap_exceeded" once a project hits its own ceiling', async () => {
    const ts = await createTestServer();
    try {
      const session = await loginAs(ts.server, 'project-cap-owner');
      const payload = decodeSession(session, [testConfig.sessionSecret])?.payload;
      if (!payload) throw new Error('bad test session');

      await ts.db.pool.query('update organizations set tier = $1 where id = $2', [
        'team',
        payload.orgId,
      ]);

      const project = await ts.server.inject({
        method: 'POST',
        url: '/api/projects',
        cookies: { mdloop_session: session },
        payload: { name: 'capped-project' },
      });
      expect(project.statusCode, project.body).toBe(201);
      const projectId = project.json<{ id: string }>().id;

      // Seed straight to the 500-doc-per-project ceiling without spending
      // 500 HTTP round trips — same technique as the version-cap scenario in
      // tier-limits.feature.test.ts. The cap counts active (non-deleted)
      // rows, not uploads, so a bare insert is equivalent.
      await ts.db.pool.query(
        `insert into documents (org_id, project_id, owner_id, title)
         select $1, $2, $3, 'seed-' || g
         from generate_series(1, 500) g`,
        [payload.orgId, projectId, payload.userId],
      );

      const res = await ts.server.inject({
        method: 'POST',
        url: '/api/documents',
        cookies: { mdloop_session: session },
        payload: { title: 'over-project-cap.md', content: '# over the project cap', projectId },
      });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json<{ error: string }>().error).toBe('project_doc_cap_exceeded');
    } finally {
      await ts.close();
    }
  }, 60_000);
});
