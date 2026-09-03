import { fileURLToPath } from 'node:url';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Actor } from '@vorlyn/app';
import { PgCommentRepository } from '@vorlyn/persistence';
import type { UserId } from '@vorlyn/shared';
import { decodeSession } from './auth/session.js';
import { createTestServer, loginAs, testConfig } from './test-support/test-server.js';
import type { TestServer } from './test-support/test-server.js';

const feature = await loadFeature(
  fileURLToPath(new URL('../../../features/tier-limits.feature', import.meta.url)),
);

interface World {
  ts: TestServer;
  server: FastifyInstance;
  session: string;
  actor: Actor;
  documentId: string;
  projectId: string;
  lastUpload: LightMyRequestResponse;
  limited: LightMyRequestResponse | undefined;
}

describeFeature(feature, ({ Background, Scenario, AfterAllScenarios }) => {
  const w = {} as World;
  let scenarioSeq = 0;

  AfterAllScenarios(async () => {
    await w.ts.close();
  });

  async function upload(title: string): Promise<LightMyRequestResponse> {
    return w.server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { vorlyn_session: w.session },
      payload: { title, content: `# ${title}` },
    });
  }

  function uploadToProject(title: string, projectId: string): Promise<LightMyRequestResponse> {
    return w.server.inject({
      method: 'POST',
      url: '/api/documents',
      cookies: { vorlyn_session: w.session },
      payload: { title, content: `# ${title}`, projectId },
    });
  }

  /** Tier must be set before the org's first authed request — the server
   * caches the tier per org for its rate/caps checks. */
  async function setTier(tier: 'free' | 'team'): Promise<void> {
    await w.ts.db.pool.query('update organizations set tier = $1 where id = $2', [
      tier,
      w.actor.ctx.orgId,
    ]);
  }

  /** Seeds without spending HTTP budget: repo-level comments, real RLS. */
  async function seedDocumentWithComments(count: number): Promise<void> {
    const uploaded = await upload('busy.md');
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    w.documentId = uploaded.json<{ document: { id: string } }>().document.id;
    const comments = new PgCommentRepository(w.ts.db.pool);
    const versionId = uploaded.json<{ version: { id: string } }>().version.id;
    for (let i = 0; i < count; i++) {
      await comments.create(w.actor.ctx, {
        documentId: w.documentId as never,
        versionId: versionId as never,
        body: `note ${String(i)}`,
        anchor: { type: 'document' },
        authorId: w.actor.ctx.userId,
      });
    }
  }

  function commentAgain(): Promise<LightMyRequestResponse> {
    return w.server.inject({
      method: 'POST',
      url: `/api/documents/${w.documentId}/comments`,
      cookies: { vorlyn_session: w.session },
      payload: { body: 'one more', anchor: { type: 'document' } },
    });
  }

  Background(({ Given }) => {
    Given('organization "Acme" with user "alice"', async () => {
      if (!(w as Partial<World>).ts) {
        // Global backstop lifted well above the per-user budgets under test.
        w.ts = await createTestServer({ global: 10_000, upload: 10_000 });
        w.server = w.ts.server;
      }
      scenarioSeq += 1;
      const user = `alice-${String(scenarioSeq)}`;
      w.session = await loginAs(w.server, user);
      // Identity from the cookie, not /me: the first authed request caches
      // the org tier server-side, and each scenario sets the tier first.
      const payload = decodeSession(w.session, [testConfig.sessionSecret])?.payload;
      if (!payload) throw new Error('undecodable session');
      w.actor = {
        ctx: { orgId: payload.orgId as never, userId: payload.userId as UserId },
        role: 'admin',
      };
    });
  });

  Scenario('The free tier blocks the 101st active document', ({ Given, And, Then, When }) => {
    Given('the organization is on the free tier', async () => {
      await setTier('free');
    });
    And('"alice" has 100 active documents', async () => {
      // Seeds without spending HTTP budget: 100 real uploads would trip the
      // free tier's request budget (60/min, and its 2,500/day and 7,500/month
      // windows — tier.ts `RateLimitProfile`, a separate mechanism from this
      // doc-count cap) — same reasoning as the comment/version-cap scenarios
      // below, insert active document rows directly instead.
      const { rows } = await w.ts.db.pool.query<{ id: string }>(
        `insert into documents (org_id, owner_id, title)
         select $1, $2, 'doc-' || g || '.md'
         from generate_series(1, 100) g
         returning id`,
        [w.actor.ctx.orgId, w.actor.ctx.userId],
      );
      w.documentId = rows[0]?.id ?? '';
    });
    Then('uploading a new document is rejected with "doc_cap_exceeded"', async () => {
      const res = await upload('hundred-first.md');
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: string }>().error).toBe('doc_cap_exceeded');
    });
    When('"alice" deletes one document', async () => {
      const res = await w.server.inject({
        method: 'DELETE',
        url: `/api/documents/${w.documentId}`,
        cookies: { vorlyn_session: w.session },
      });
      expect(res.statusCode, res.body).toBe(200);
    });
    Then('uploading a new document succeeds', async () => {
      const res = await upload('hundred-first.md');
      expect(res.statusCode, res.body).toBe(201);
    });
  });

  Scenario('The team tier is not bound by the free doc cap', ({ Given, And, Then }) => {
    Given('the organization is on the team tier', async () => {
      await setTier('team');
    });
    And('"alice" has 10 active documents', async () => {
      for (let i = 1; i <= 10; i++) {
        const res = await upload(`doc-${String(i)}.md`);
        expect(res.statusCode, res.body).toBe(201);
      }
    });
    Then('uploading a new document succeeds', async () => {
      const res = await upload('eleventh.md');
      expect(res.statusCode, res.body).toBe(201);
    });
  });

  Scenario(
    'The per-project cap blocks independently of the org-wide cap',
    ({ Given, And, Then, But }) => {
      Given('the organization is on the team tier', async () => {
        await setTier('team');
      });
      And('"alice" has a project "Big Project" with 500 active documents', async () => {
        const project = await w.server.inject({
          method: 'POST',
          url: '/api/projects',
          cookies: { vorlyn_session: w.session },
          payload: { name: 'Big Project' },
        });
        expect(project.statusCode, project.body).toBe(201);
        w.projectId = project.json<{ id: string }>().id;
        // Seed straight to the 500-doc-per-project ceiling without spending
        // 500 HTTP round trips — same technique the org-wide cap scenario
        // above uses. The cap counts active (non-deleted) rows, not
        // uploads, so a bare insert is equivalent.
        await w.ts.db.pool.query(
          `insert into documents (org_id, project_id, owner_id, title)
           select $1, $2, $3, 'seed-' || g
           from generate_series(1, 500) g`,
          [w.actor.ctx.orgId, w.projectId, w.actor.ctx.userId],
        );
      });
      Then(
        'uploading a new document into "Big Project" is rejected with "project_doc_cap_exceeded"',
        async () => {
          const res = await uploadToProject('over-project-cap.md', w.projectId);
          expect(res.statusCode, res.body).toBe(403);
          expect(res.json<{ error: string }>().error).toBe('project_doc_cap_exceeded');
        },
      );
      But('uploading a new document outside any project succeeds', async () => {
        // Team's org-wide cap is 5,000 — nowhere near exhausted by this
        // project's 500 — so an unfiled upload succeeding here is the proof
        // that the 403 above came from the project gate, not the org gate.
        const res = await upload('unfiled.md');
        expect(res.statusCode, res.body).toBe(201);
      });
    },
  );

  Scenario('The free tier blocks the 101st comment on a document', ({ Given, And, Then }) => {
    Given('the organization is on the free tier', async () => {
      await setTier('free');
    });
    And('"alice" has a document with 100 comments', async () => {
      await seedDocumentWithComments(100);
    });
    Then('commenting again is rejected with "comment_cap_exceeded"', async () => {
      const res = await commentAgain();
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: string }>().error).toBe('comment_cap_exceeded');
    });
  });

  Scenario('Paid tiers never cap comments', ({ Given, And, Then }) => {
    Given('the organization is on the team tier', async () => {
      await setTier('team');
    });
    And('"alice" has a document with 100 comments', async () => {
      await seedDocumentWithComments(100);
    });
    Then('commenting again succeeds', async () => {
      const res = await commentAgain();
      expect(res.statusCode, res.body).toBe(201);
    });
  });

  Scenario(
    'The version cap blocks the append past the live-version ceiling',
    ({ Given, And, Then }) => {
      Given('the organization is on the free tier', async () => {
        await setTier('free');
      });
      And('"alice" has a document at the free live-version ceiling', async () => {
        const uploaded = await upload('versioned.md');
        expect(uploaded.statusCode, uploaded.body).toBe(201);
        w.documentId = uploaded.json<{ document: { id: string } }>().document.id;
        // Seed straight to the 100-live-version ceiling without spending HTTP
        // budget: version rows only, the cap counts rows not blobs.
        await w.ts.db.pool.query(
          `insert into document_versions (org_id, document_id, seq, content_hash, byte_size, created_by, source)
           select $1, $2, g, 'seed-' || g, 10, $3, 'web' from generate_series(2, 100) g`,
          [w.actor.ctx.orgId, w.documentId, w.actor.ctx.userId],
        );
      });
      Then('uploading a new version is rejected with "version_cap_exceeded"', async () => {
        const res = await w.server.inject({
          method: 'POST',
          url: `/api/documents/${w.documentId}/versions`,
          cookies: { vorlyn_session: w.session },
          payload: { content: '# a genuinely new leg' },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json<{ error: string }>().error).toBe('version_cap_exceeded');
      });
    },
  );

  Scenario(
    'A downgrade never deletes anything, it only blocks new creates',
    ({ Given, And, When, Then }) => {
      Given('the organization is on the team tier', async () => {
        await setTier('team');
      });
      And('"alice" has 101 active documents', async () => {
        // Team tier's request budget (tier.ts) is well above 101, so unlike
        // the free-tier seeding above, 101 real uploads here wouldn't trip
        // it — but they'd still be needlessly slow for a seed step. Insert
        // directly instead.
        await w.ts.db.pool.query(
          `insert into documents (org_id, owner_id, title)
           select $1, $2, 'doc-' || g || '.md'
           from generate_series(1, 101) g`,
          [w.actor.ctx.orgId, w.actor.ctx.userId],
        );
      });
      When('the organization is downgraded to the free tier', async () => {
        await setTier('free');
      });
      Then('all 101 documents are still readable', async () => {
        // Default /overview page size (50) is well under 101 — ask for the
        // max page explicitly so this proves nothing was deleted, not just
        // that the first page still loads.
        const res = await w.server.inject({
          method: 'GET',
          url: '/api/overview?limit=200',
          cookies: { vorlyn_session: w.session },
        });
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json<{ documents: unknown[] }>().documents.length).toBeGreaterThanOrEqual(101);
      });
      And('uploading a new document is rejected with "doc_cap_exceeded"', async () => {
        const res = await upload('hundred-second.md');
        expect(res.statusCode).toBe(403);
        expect(res.json<{ error: string }>().error).toBe('doc_cap_exceeded');
      });
    },
  );

  Scenario(
    'Two concurrent creates at the ceiling admit exactly one',
    ({ Given, And, When, Then }) => {
      let raced: LightMyRequestResponse[] = [];
      Given('the organization is on the free tier', async () => {
        await setTier('free');
      });
      And('"alice" has a document with 99 comments', async () => {
        await seedDocumentWithComments(99);
      });
      When('two comments race for the last free slot', async () => {
        raced = await Promise.all([commentAgain(), commentAgain()]);
      });
      Then(
        'exactly one comment is accepted and one is rejected with "comment_cap_exceeded"',
        () => {
          const codes = raced.map((r) => r.statusCode).sort();
          expect(codes).toEqual([201, 403]);
          const rejected = raced.find((r) => r.statusCode === 403);
          expect(rejected?.json<{ error: string }>().error).toBe('comment_cap_exceeded');
        },
      );
    },
  );

  Scenario(
    'HTTP requests beyond the per-minute budget get 429 with Retry-After',
    ({ Given, When, Then }) => {
      Given('the organization is on the free tier', async () => {
        await setTier('free');
      });
      When('"alice" sends requests past the free per-minute budget over HTTP', async () => {
        w.limited = undefined;
        // Free budget is 60/min; the 61st request must trip it.
        for (let i = 0; i < 61 && !w.limited; i++) {
          const res = await w.server.inject({
            method: 'GET',
            url: '/api/me',
            cookies: { vorlyn_session: w.session },
          });
          if (res.statusCode === 429) w.limited = res;
        }
      });
      Then('the API responds 429 with a Retry-After header and error "rate_limited"', () => {
        expect(w.limited).toBeDefined();
        if (!w.limited) return;
        expect(w.limited.headers['retry-after']).toBeDefined();
        expect(w.limited.json<{ error: string; retryAfterSeconds: number }>()).toEqual({
          error: 'rate_limited',
          retryAfterSeconds: expect.any(Number) as number,
        });
      });
    },
  );
});
