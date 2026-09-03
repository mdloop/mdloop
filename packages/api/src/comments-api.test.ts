import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PgApiKeyRepository, PgCommentRepository } from '@vorlyn/persistence';
import { decodeSession } from './auth/session.js';
import { createTestServer, loginAs, testConfig } from './test-support/test-server.js';
import type { TestServer } from './test-support/test-server.js';

interface CommentDto {
  id: string;
  documentId: string;
  versionId: string;
  body: string;
  status: 'open' | 'resolved';
  viaApiKeyName: string | null;
}

interface ThreadDto {
  comment: CommentDto;
  replies: { id: string; body: string; viaApiKeyName: string | null }[];
}

const docAnchor = { type: 'document' };

describe('comments API', () => {
  let ts: TestServer;
  let server: FastifyInstance;
  let owner: string; // uploads the doc (org A)
  let peer: string; // same org — sign-in flow puts each new user in a fresh org, so re-check
  let outsider: string; // different org
  let documentId: string;

  beforeAll(async () => {
    ts = await createTestServer();
    server = ts.server;
    owner = await loginAs(server, 'owner');
    outsider = await loginAs(server, 'outsider');
    const upload = await server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { vorlyn_session: owner },
      payload: { title: 'design.md', content: '# Design\n\nThe payment flow retries twice.' },
    });
    expect(upload.statusCode).toBe(201);
    documentId = upload.json<{ document: { id: string } }>().document.id;
    peer = owner; // MVP: every sign-in bootstraps its own org; same-org peer = owner session
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  async function comment(session: string, body: string, anchor: unknown = docAnchor) {
    return server.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/comments`,
      cookies: { vorlyn_session: session },
      payload: { body, anchor },
    });
  }

  it('creates a comment pinned to the current version', async () => {
    const res = await comment(owner, 'looks wrong');
    expect(res.statusCode).toBe(201);
    const created = res.json<CommentDto>();
    expect(created.status).toBe('open');
    expect(created.versionId).toBeTruthy();
  });

  it('creates a text-anchored comment', async () => {
    const res = await comment(peer, 'clarify retries', {
      type: 'text',
      exact: 'retries twice',
      prefix: 'The payment flow ',
      suffix: '.',
      start: 27,
      end: 40,
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects empty bodies and malformed anchors', async () => {
    expect((await comment(owner, '   ')).statusCode).toBe(400);
    const bad = await comment(owner, 'x', {
      type: 'text',
      exact: '',
      prefix: '',
      suffix: '',
      start: 3,
      end: 3,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'invalid_anchor' });
  });

  it('edits a comment: author only, body only', async () => {
    const created = (await comment(owner, 'first draft')).json<CommentDto>();

    const edited = await server.inject({
      method: 'PATCH',
      url: `/api/comments/${created.id}`,
      cookies: { vorlyn_session: owner },
      payload: { body: '  second draft  ' },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const dto = edited.json<CommentDto>();
    expect(dto.body).toBe('second draft');
    // Pinned version and anchor never change on edit.
    expect(dto.versionId).toBe(created.versionId);

    const empty = await server.inject({
      method: 'PATCH',
      url: `/api/comments/${created.id}`,
      cookies: { vorlyn_session: owner },
      payload: { body: '   ' },
    });
    expect(empty.statusCode).toBe(400);

    // Cross-org caller can't even see the comment (RLS): 404, not 403.
    const foreign = await server.inject({
      method: 'PATCH',
      url: `/api/comments/${created.id}`,
      cookies: { vorlyn_session: outsider },
      payload: { body: 'hijack' },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('threads replies and resolves (owner only)', async () => {
    const created = (await comment(owner, 'root comment')).json<CommentDto>();

    const reply = await server.inject({
      method: 'POST',
      url: `/api/comments/${created.id}/replies`,
      cookies: { vorlyn_session: owner },
      payload: { body: 'following up' },
    });
    expect(reply.statusCode).toBe(201);

    const resolve = await server.inject({
      method: 'POST',
      url: `/api/comments/${created.id}/resolve`,
      cookies: { vorlyn_session: owner },
    });
    expect(resolve.statusCode).toBe(204);

    const threads = await server.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/comments`,
      cookies: { vorlyn_session: owner },
    });
    const thread = threads
      .json<{ threads: ThreadDto[] }>()
      .threads.find((t) => t.comment.id === created.id);
    expect(thread?.comment.status).toBe('resolved');
    expect(thread?.replies.map((r) => r.body)).toEqual(['following up']);

    const again = await server.inject({
      method: 'POST',
      url: `/api/comments/${created.id}/resolve`,
      cookies: { vorlyn_session: owner },
    });
    expect(again.statusCode).toBe(409);
  });

  it('re-anchors comments across a new version with confidence, and orphans deletions', async () => {
    // Fresh document so earlier scenarios don't interfere.
    const upload = await server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { vorlyn_session: owner },
      payload: {
        title: 'versioned.md',
        content: '# V\n\nThe cache expires hourly.\n\nRetries use backoff.\n',
      },
    });
    const docId = upload.json<{ document: { id: string } }>().document.id;

    const mkComment = (anchor: unknown) =>
      server.inject({
        method: 'POST',
        url: `/api/documents/${docId}/comments`,
        cookies: { vorlyn_session: owner },
        payload: { body: 'check', anchor },
      });
    const edited = (
      await mkComment({
        type: 'text',
        exact: 'The cache expires hourly.',
        prefix: '# V\n\n',
        suffix: '\n\nRetries',
        start: 5,
        end: 30,
      })
    ).json<CommentDto>();
    const deleted = (
      await mkComment({
        type: 'text',
        exact: 'Retries use backoff.',
        prefix: 'hourly.\n\n',
        suffix: '\n',
        start: 32,
        end: 52,
      })
    ).json<CommentDto>();

    const v2 = await server.inject({
      method: 'POST',
      url: `/api/documents/${docId}/versions`,
      cookies: { vorlyn_session: owner },
      payload: { content: '# V\n\nThe cache expires every two hours.\n' },
    });
    expect(v2.statusCode).toBe(200);

    const threads = await server.inject({
      method: 'GET',
      url: `/api/documents/${docId}/comments`,
      cookies: { vorlyn_session: owner },
    });
    const byId = new Map(
      threads
        .json<{
          threads: { comment: CommentDto; resolution: { method: string; confidence: number } }[];
        }>()
        .threads.map((t) => [t.comment.id, t.resolution]),
    );
    const editedRes = byId.get(edited.id);
    expect(editedRes?.method).toBe('fuzzy');
    expect(editedRes?.confidence).toBeGreaterThanOrEqual(0.6);
    expect(byId.get(deleted.id)?.method).toBe('orphan');

    // Versions endpoints: list + per-version content.
    const versions = await server.inject({
      method: 'GET',
      url: `/api/documents/${docId}/versions`,
      cookies: { vorlyn_session: owner },
    });
    const versionList = versions.json<{
      versions: { id: string; seq: number }[];
      currentVersionId: string;
    }>();
    expect(versionList.versions.map((v) => v.seq)).toEqual([1, 2]);
    const v1Content = await server.inject({
      method: 'GET',
      url: `/api/documents/${docId}/versions/${versionList.versions[0]?.id ?? ''}/content`,
      cookies: { vorlyn_session: owner },
    });
    expect(v1Content.body).toContain('Retries use backoff.');

    // Cross-org: version content 404s for the outsider.
    const denied = await server.inject({
      method: 'GET',
      url: `/api/documents/${docId}/versions/${versionList.versions[0]?.id ?? ''}/content`,
      cookies: { vorlyn_session: outsider },
    });
    expect(denied.statusCode).toBe(404);
  });

  it('toggles upvotes and surfaces the count on the thread', async () => {
    const created = (await comment(owner, 'prioritize me')).json<CommentDto>();

    const up = await server.inject({
      method: 'POST',
      url: `/api/comments/${created.id}/upvote`,
      cookies: { vorlyn_session: owner },
    });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toEqual({ upvoted: true, count: 1 });

    const threads = await server.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/comments`,
      cookies: { vorlyn_session: owner },
    });
    const thread = threads
      .json<{ threads: (ThreadDto & { upvotes: { count: number; mine: boolean } })[] }>()
      .threads.find((t) => t.comment.id === created.id);
    expect(thread?.upvotes).toEqual({ count: 1, mine: true });

    const down = await server.inject({
      method: 'POST',
      url: `/api/comments/${created.id}/upvote`,
      cookies: { vorlyn_session: owner },
    });
    expect(down.json()).toEqual({ upvoted: false, count: 0 });

    // Cross-org caller cannot upvote (RLS hides the comment): 404.
    const foreign = await server.inject({
      method: 'POST',
      url: `/api/comments/${created.id}/upvote`,
      cookies: { vorlyn_session: outsider },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('keeps comments inside the org boundary', async () => {
    const created = (await comment(owner, 'org A secret')).json<CommentDto>();

    const list = await server.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/comments`,
      cookies: { vorlyn_session: outsider },
    });
    expect(list.statusCode).toBe(404);

    const write = await comment(outsider, 'drive-by');
    expect(write.statusCode).toBe(404);

    const reply = await server.inject({
      method: 'POST',
      url: `/api/comments/${created.id}/replies`,
      cookies: { vorlyn_session: outsider },
      payload: { body: 'nope' },
    });
    expect(reply.statusCode).toBe(404);

    const resolve = await server.inject({
      method: 'POST',
      url: `/api/comments/${created.id}/resolve`,
      cookies: { vorlyn_session: outsider },
    });
    expect(resolve.statusCode).toBe(404);
  });

  it('decorates thread comments and replies with the agent key name (Phase A)', async () => {
    const session = decodeSession(owner, [testConfig.sessionSecret])?.payload;
    if (!session) throw new Error('bad test session');
    const ctx = { orgId: session.orgId as never, userId: session.userId as never };
    const apiKeys = new PgApiKeyRepository(ts.db.pool);
    const comments = new PgCommentRepository(ts.db.pool);
    const key = await apiKeys.create(ctx, {
      userId: ctx.userId,
      name: 'ci bot',
      keyHash: 'irrelevant-for-this-test',
    });

    const created = (await comment(owner, 'root via agent')).json<CommentDto>();
    // Human-authored via the HTTP route; directly attribute it to the key to
    // exercise the read-time join without standing up an MCP client.
    const attributed = await comments.create(ctx, {
      documentId: documentId as never,
      versionId: (await comments.byId(ctx, created.id as never))?.versionId as never,
      authorId: ctx.userId,
      body: 'from an agent',
      anchor: docAnchor as never,
      viaApiKeyId: key.id,
    });
    await comments.addReply(ctx, {
      commentId: attributed.id,
      parentReplyId: null,
      authorId: ctx.userId,
      body: 'agent reply',
      viaApiKeyId: key.id,
    });

    const threads = await server.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/comments`,
      cookies: { vorlyn_session: owner },
    });
    const { threads: list } = threads.json<{ threads: ThreadDto[] }>();
    const humanThread = list.find((t) => t.comment.id === created.id);
    expect(humanThread?.comment.viaApiKeyName).toBeNull();

    const agentThread = list.find((t) => t.comment.id === attributed.id);
    expect(agentThread?.comment.viaApiKeyName).toBe('ci bot');
    expect(agentThread?.replies[0]?.viaApiKeyName).toBe('ci bot');

    // Revoking the key never erases attribution on past rows (honest history).
    await apiKeys.revoke(ctx, key.id);
    const afterRevoke = await server.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/comments`,
      cookies: { vorlyn_session: owner },
    });
    const stillNamed = afterRevoke
      .json<{ threads: ThreadDto[] }>()
      .threads.find((t) => t.comment.id === attributed.id);
    expect(stillNamed?.comment.viaApiKeyName).toBe('ci bot');
  });
});
