import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { decodeSession } from './auth/session.js';
import { createTestServer, loginAs, testConfig } from './test-support/test-server.js';
import type { TestServer } from './test-support/test-server.js';

interface DocumentDto {
  id: string;
  title: string;
}

/**
 * Route-wiring smoke tests for the Public Docs Hub (ADR 0004, Phase 22.B).
 * Business-logic authorization (home-org-admin-only, guest forbidden, member
 * forbidden) is Gherkin-covered against the use-cases directly
 * (`packages/persistence/src/public-hub.feature.test.ts`) — this file only
 * checks the HTTP wiring (status codes, response shapes, ETag/304) plus the
 * two end-to-end proofs CONSTITUTION §8.3 requires at this layer: the public
 * routes never leak an unpublished tenant document, and the admin publish
 * route genuinely 403s a non-home-org admin through the real HTTP stack.
 */
describe('public hub API (ADR 0004)', () => {
  let ts: TestServer;
  let server: FastifyInstance;
  let alice: string; // home-org admin (org configured as publicHubOrgId below)
  let bob: string; // admin of a different org

  async function upload(session: string, title: string, content: string) {
    const res = await server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { vorlyn_session: session },
      payload: { title, content },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ document: DocumentDto }>().document;
  }

  beforeAll(async () => {
    ts = await createTestServer();
    server = ts.server;
    alice = await loginAs(server, 'pubhub-alice');
    bob = await loginAs(server, 'pubhub-bob');

    // The home org is only known once alice has actually signed in (personal
    // org bootstrap happens inside signIn()), so it's set post-construction —
    // `ts.config` is a per-instance mutable copy of testConfig for exactly
    // this reason (see test-support/test-server.ts).
    const aliceSession = decodeSession(alice, [testConfig.sessionSecret])?.payload;
    if (!aliceSession) throw new Error('bad alice session');
    (ts.config as { publicHubOrgId?: string }).publicHubOrgId = aliceSession.orgId;
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  it('publishes, serves, and unpublishes a doc end-to-end through the public routes', async () => {
    const doc = await upload(
      alice,
      'deploy-runbook.md',
      '# Deploy Runbook\n\nContains a canary rollout procedure.',
    );

    const publish = await server.inject({
      method: 'POST',
      url: '/api/public-hub/documents',
      cookies: { vorlyn_session: alice },
      payload: { documentId: doc.id, slug: 'Deploy Runbook!' },
    });
    expect(publish.statusCode, publish.body).toBe(201);
    const published = publish.json<{
      id: string;
      slug: string;
      title: string;
      seq: number;
      publishedAt: string;
    }>();
    expect(published.slug).toBe('deploy-runbook'); // normalized
    expect(published).not.toHaveProperty('sourceDocumentId');
    expect(published).not.toHaveProperty('contentHash');

    // Admin's own view lists it.
    const adminList = await server.inject({
      method: 'GET',
      url: '/api/public-hub/documents',
      cookies: { vorlyn_session: alice },
    });
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json<{ docs: { slug: string }[] }>().docs.map((d) => d.slug)).toContain(
      'deploy-runbook',
    );

    // Fully unauthenticated: no cookies at all.
    const index = await server.inject({ method: 'GET', url: '/public/docs' });
    expect(index.statusCode).toBe(200);
    expect(index.json<{ docs: { slug: string }[] }>().docs.map((d) => d.slug)).toContain(
      'deploy-runbook',
    );

    const detail = await server.inject({ method: 'GET', url: '/public/docs/deploy-runbook' });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ slug: 'deploy-runbook', title: 'deploy-runbook.md' });

    const content = await server.inject({
      method: 'GET',
      url: '/public/docs/deploy-runbook/content',
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers['content-type']).toContain('text/markdown');
    // Version content is content-addressed + immutable, so it caches longer
    // than the metadata routes (Phase 24.F): a new publish bumps the seq/key.
    expect(content.headers['cache-control']).toBe(
      'public, max-age=300, stale-while-revalidate=3600',
    );
    expect(content.body).toBe('# Deploy Runbook\n\nContains a canary rollout procedure.');
    const etag = content.headers.etag!;
    expect(etag).toBeTruthy();

    const revalidated = await server.inject({
      method: 'GET',
      url: '/public/docs/deploy-runbook/content',
      headers: { 'if-none-match': etag },
    });
    expect(revalidated.statusCode).toBe(304);

    const search = await server.inject({ method: 'GET', url: '/public/search?q=canary' });
    expect(search.statusCode).toBe(200);
    expect(search.json<{ hits: { slug: string }[] }>().hits.map((h) => h.slug)).toContain(
      'deploy-runbook',
    );

    const unpublish = await server.inject({
      method: 'DELETE',
      url: '/api/public-hub/documents/deploy-runbook',
      cookies: { vorlyn_session: alice },
    });
    expect(unpublish.statusCode).toBe(204);

    const gone = await server.inject({ method: 'GET', url: '/public/docs/deploy-runbook' });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toEqual({ error: 'not_found' });

    const goneContent = await server.inject({
      method: 'GET',
      url: '/public/docs/deploy-runbook/content',
    });
    expect(goneContent.statusCode).toBe(404);

    const searchAfter = await server.inject({ method: 'GET', url: '/public/search?q=canary' });
    expect(searchAfter.json<{ hits: unknown[] }>().hits).toHaveLength(0);
  });

  it('an empty search query returns no hits without erroring', async () => {
    const res = await server.inject({ method: 'GET', url: '/public/search' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hits: [] });
  });

  it('admin publish routes 403 a non-home-org admin end-to-end', async () => {
    const doc = await upload(bob, 'bobs-doc.md', 'irrelevant');

    const publish = await server.inject({
      method: 'POST',
      url: '/api/public-hub/documents',
      cookies: { vorlyn_session: bob },
      payload: { documentId: doc.id, slug: 'bobs-doc' },
    });
    expect(publish.statusCode).toBe(403);
    expect(publish.json()).toEqual({ error: 'forbidden' });

    const list = await server.inject({
      method: 'GET',
      url: '/api/public-hub/documents',
      cookies: { vorlyn_session: bob },
    });
    expect(list.statusCode).toBe(403);

    const unpublish = await server.inject({
      method: 'DELETE',
      url: '/api/public-hub/documents/anything',
      cookies: { vorlyn_session: bob },
    });
    expect(unpublish.statusCode).toBe(403);
  });

  it('unauthenticated public routes never leak an unpublished tenant document', async () => {
    const doc = await upload(
      alice,
      'secret-plan.md',
      'This tenant content must never be publicly reachable.',
    );

    // Guess at every plausible "slug" a leak might use: the document's own
    // title (normalized) and its raw tenant id — public_documents has no
    // relationship to either, so both must 404, never return tenant bytes.
    for (const guess of ['secret-plan', doc.id]) {
      const detail = await server.inject({ method: 'GET', url: `/public/docs/${guess}` });
      expect(detail.statusCode, guess).toBe(404);
      expect(detail.json()).toEqual({ error: 'not_found' });

      const content = await server.inject({ method: 'GET', url: `/public/docs/${guess}/content` });
      expect(content.statusCode, guess).toBe(404);
      expect(content.body).not.toContain('tenant content');
    }

    const index = await server.inject({ method: 'GET', url: '/public/docs' });
    expect(index.json<{ docs: { slug: string }[] }>().docs.map((d) => d.slug)).not.toContain(
      'secret-plan',
    );

    const search = await server.inject({
      method: 'GET',
      url: '/public/search?q=reachable',
    });
    expect(search.json<{ hits: unknown[] }>().hits).toHaveLength(0);
  });
});
