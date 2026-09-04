import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PgDirectoryRepository, PgGuestUserRepository } from '@mdloop/persistence';
import type { OrgId } from '@mdloop/shared';
import { decodeSession } from './auth/session.js';
import { createTestServer, loginAs } from './test-support/test-server.js';
import type { TestServer } from './test-support/test-server.js';

/**
 * HTTP coverage for `POST/GET/DELETE /projects/:id/shares` (ADR 0014, Phase
 * 42) — the project-sharing use-cases already have unit coverage in
 * `packages/app/src/use-cases/project-sharing.test.ts` and money-path Gherkin
 * in `features/project-sharing.feature`; this file proves the three routes
 * in `project-routes.ts` wire up correctly end to end (admin-only gate,
 * `shareErrorStatus` mapping, guest refusal) the same way `shares-api.test.ts`
 * proves the document-share routes.
 */
describe('project sharing API', () => {
  let ts: TestServer;
  let server: FastifyInstance;
  let admin: string;
  let member: string; // org member, not admin
  let projectId: string;
  let memberUserId: string;

  beforeAll(async () => {
    ts = await createTestServer();
    server = ts.server;
    admin = await loginAs(server, 'project-share-admin');

    const adminSession = decodeSession(admin, [ts.config.sessionSecret])?.payload;
    if (!adminSession) throw new Error('bad admin session');
    const directory = new PgDirectoryRepository(ts.db.pool);
    const memberUser = await directory.createUser(adminSession.orgId as OrgId, {
      workosUserId: `wos_project_share_member_${String(Math.random())}`,
      email: 'project-member@share.test',
      displayName: 'Member',
      role: 'member',
    });
    memberUserId = memberUser.id;
    const iat = Date.now();
    const { encodeSession, SESSION_TTL_MS } = await import('./auth/session.js');
    member = encodeSession(
      {
        userId: memberUser.id,
        orgId: adminSession.orgId,
        role: 'member',
        iat,
        exp: iat + SESSION_TTL_MS,
      },
      ts.config.sessionSecret,
    );

    const created = await server.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { mdloop_session: admin },
      payload: { name: 'Runbooks' },
    });
    expect(created.statusCode, created.body).toBe(201);
    projectId = created.json<{ id: string }>().id;
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  function inject(
    session: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) {
    return server.inject({
      method,
      url: `/api${url}`,
      cookies: { mdloop_session: session },
      ...(payload ? { payload } : {}),
    });
  }

  it('a non-admin org member cannot create, list, or revoke a project grant — even one they can otherwise see', async () => {
    const denied = await inject(member, 'POST', `/projects/${projectId}/shares`, {
      userId: memberUserId,
      permission: 'read',
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ error: string }>().error).toBe('forbidden');

    const deniedList = await inject(member, 'GET', `/projects/${projectId}/shares`);
    expect(deniedList.statusCode).toBe(403);

    const deniedRevoke = await inject(
      member,
      'DELETE',
      `/projects/${projectId}/shares/00000000-0000-0000-0000-000000000000`,
    );
    expect(deniedRevoke.statusCode).toBe(403);
  });

  it('an admin can create, list, and revoke a project grant', async () => {
    const created = await inject(admin, 'POST', `/projects/${projectId}/shares`, {
      userId: memberUserId,
      permission: 'comment',
    });
    expect(created.statusCode, created.body).toBe(201);
    const grant = created.json<{ grant: { id: string; permission: string } }>().grant;
    expect(grant.permission).toBe('comment');

    const listed = await inject(admin, 'GET', `/projects/${projectId}/shares`);
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ grants: { id: string }[] }>().grants.map((g) => g.id)).toContain(grant.id);

    const revoked = await inject(admin, 'DELETE', `/projects/${projectId}/shares/${grant.id}`);
    expect(revoked.statusCode).toBe(204);

    const afterList = await inject(admin, 'GET', `/projects/${projectId}/shares`);
    expect(afterList.json<{ grants: { id: string }[] }>().grants.map((g) => g.id)).not.toContain(
      grant.id,
    );
  });

  it('a guest grantee is refused share/edit on a project grant, same as a document grant', async () => {
    const adminSession = decodeSession(admin, [ts.config.sessionSecret])?.payload;
    if (!adminSession) throw new Error('bad admin session');
    const guests = new PgGuestUserRepository(ts.db.pool);
    const guestUser = await guests.createGuest(
      { orgId: adminSession.orgId as OrgId, userId: adminSession.userId as never },
      'project-guest@partner.test',
    );

    const edit = await inject(admin, 'POST', `/projects/${projectId}/shares`, {
      userId: guestUser.id,
      permission: 'edit',
    });
    expect(edit.statusCode).toBe(403);
    expect(edit.json<{ error: string }>().error).toBe('guest_edit_forbidden');

    const share = await inject(admin, 'POST', `/projects/${projectId}/shares`, {
      userId: guestUser.id,
      permission: 'share',
    });
    expect(share.statusCode).toBe(403);
    expect(share.json<{ error: string }>().error).toBe('guest_edit_forbidden');
  });

  it('an unknown project 404s on all three routes', async () => {
    const created = await inject(
      admin,
      'POST',
      '/projects/00000000-0000-0000-0000-000000000000/shares',
      {
        userId: memberUserId,
        permission: 'read',
      },
    );
    expect(created.statusCode).toBe(404);
    const listed = await inject(
      admin,
      'GET',
      '/projects/00000000-0000-0000-0000-000000000000/shares',
    );
    expect(listed.statusCode).toBe(404);
    const revoked = await inject(
      admin,
      'DELETE',
      '/projects/00000000-0000-0000-0000-000000000000/shares/00000000-0000-0000-0000-000000000000',
    );
    expect(revoked.statusCode).toBe(404);
  });
});
