import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestServer, loginAs } from './test-support/test-server.js';
import type { TestServer } from './test-support/test-server.js';

interface DocumentDto {
  id: string;
  title: string;
}

interface SearchResponse {
  hits: { documentId: string; title: string }[];
  commentHits: { commentId: string; documentId: string }[];
}

describe('search API', () => {
  let ts: TestServer;
  let server: FastifyInstance;
  let alice: string;

  beforeAll(async () => {
    ts = await createTestServer();
    server = ts.server;
    alice = await loginAs(server, 'search-alice');
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  it('POST /documents/search returns matching documents and comment hits, term never in the URL', async () => {
    const upload = await server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { mdloop_session: alice },
      payload: { title: 'runbook.md', content: '# Runbook\n\nsteps' },
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const { document } = upload.json<{ document: DocumentDto }>();

    const res = await server.inject({
      method: 'POST',
      url: '/api/documents/search',
      cookies: { mdloop_session: alice },
      payload: { q: 'runbook' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SearchResponse>();
    expect(body.hits.map((h) => h.documentId)).toContain(document.id);
    expect(body).toHaveProperty('commentHits');
  });

  // P0.10: the route is POST-only now (search text never rides a URL query
  // string). There's no bare "unregistered route" 404 here — with the GET
  // literal gone, `GET /documents/search` falls through to the parametric
  // `GET /documents/:id` route (Fastify prioritizes static routes over
  // parametric ones only when both exist; id="search" then fails as an
  // invalid document id). What matters for P0.10 is simply that it is not a
  // 200 — the search handler never runs off a query string.
  it('GET /documents/search?q=... is not a valid search request', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/documents/search?q=runbook',
      cookies: { mdloop_session: alice },
    });
    expect(res.statusCode).not.toBe(200);
  });
});
