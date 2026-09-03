import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentId, OrgId, UserId, VersionId } from '@vorlyn/shared';
import { withPublicReader, withTenant } from './db.js';
import { PgDirectoryRepository, PgPublicHubRepository } from './repositories/pg-repositories.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

/**
 * Public Docs Hub (ADR 0004) against real Postgres:
 *  - publish/getBySlug/search round-trip, re-publish bumps seq, unpublish
 *    removes the row;
 *  - the load-bearing safety proof for the whole ADR — `vorlyn_public_reader`
 *    is structurally incapable of reading `documents`/`document_versions`,
 *    not merely policy-restricted from them.
 */
describe('public hub (ADR 0004)', () => {
  let db: TestDb;
  let publicHub: PgPublicHubRepository;
  let orgId: OrgId;
  let documentId: DocumentId;
  let versionId: VersionId;
  let userId: UserId;

  beforeAll(async () => {
    db = await createTestDb();
    publicHub = new PgPublicHubRepository(db.pool);

    const directory = new PgDirectoryRepository(db.pool);
    const org = await directory.createOrganization('Home Org');
    const user = await directory.createUser(org.id, {
      workosUserId: 'wos_home_admin',
      email: 'admin@home.test',
      displayName: 'Admin',
      role: 'admin',
    });
    orgId = org.id;
    userId = user.id;

    // Seed a real document + version so source_* provenance columns and the
    // isolation proof have a real tenant row to (fail to) reach.
    const ctx = { orgId, userId };
    const doc = await withTenant(db.pool, ctx, (c) =>
      c
        .query<{ id: string }>(
          'insert into documents (org_id, owner_id, title) values ($1, $2, $3) returning id',
          [orgId, userId, 'Runbook'],
        )
        .then((r) => r.rows[0]!),
    );
    documentId = doc.id as DocumentId;
    const version = await withTenant(db.pool, ctx, (c) =>
      c
        .query<{ id: string }>(
          `insert into document_versions (org_id, document_id, seq, content_hash, byte_size, created_by, source)
           values ($1, $2, 1, 'hash-1', 10, $3, 'web') returning id`,
          [orgId, documentId, userId],
        )
        .then((r) => r.rows[0]!),
    );
    versionId = version.id as VersionId;
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  it('publish -> getBySlug/search round-trip; re-publish bumps seq; unpublish removes it', async () => {
    const published = await publicHub.publish({
      slug: 'deploy-runbook',
      title: 'Deploy Runbook',
      body: 'Contains a rollback procedure for production deploys.',
      contentHash: 'hash-1',
      byteSize: 10,
      sourceOrgId: orgId,
      sourceDocumentId: documentId,
      sourceVersionId: versionId,
      publishedBy: userId,
    });
    expect(published.slug).toBe('deploy-runbook');
    expect(published.seq).toBe(1);

    const bySlug = await publicHub.getBySlug('deploy-runbook');
    expect(bySlug?.id).toBe(published.id);
    expect(bySlug?.title).toBe('Deploy Runbook');

    const listed = await publicHub.list();
    expect(listed.map((d) => d.slug)).toContain('deploy-runbook');

    // Body-only term (weight B) still matches — the tsv is built from title
    // (A) + body (B), same pattern as search_index.
    const hits = await publicHub.search('rollback');
    expect(hits.map((h) => h.slug)).toEqual(['deploy-runbook']);
    expect(hits[0]?.snippet).toBeTruthy();

    const noMatch = await publicHub.search('nonexistent-term-xyz');
    expect(noMatch).toEqual([]);

    // Re-publish the same slug: same row (id unchanged), seq bumped, content
    // overwritten — never a second row.
    const republished = await publicHub.publish({
      slug: 'deploy-runbook',
      title: 'Deploy Runbook v2',
      body: 'Now with a new canary rollout section.',
      contentHash: 'hash-2',
      byteSize: 20,
      sourceOrgId: orgId,
      sourceDocumentId: documentId,
      sourceVersionId: versionId,
      publishedBy: userId,
    });
    expect(republished.id).toBe(published.id);
    expect(republished.seq).toBe(2);
    expect(republished.title).toBe('Deploy Runbook v2');
    expect(republished.contentHash).toBe('hash-2');

    const allRows = await publicHub.list();
    expect(allRows.filter((d) => d.slug === 'deploy-runbook')).toHaveLength(1);

    // The old body term no longer matches (tsv overwritten); the new one does.
    expect(await publicHub.search('rollback')).toEqual([]);
    const afterRepublish = await publicHub.search('canary');
    expect(afterRepublish.map((h) => h.slug)).toEqual(['deploy-runbook']);

    await publicHub.unpublish('deploy-runbook');
    expect(await publicHub.getBySlug('deploy-runbook')).toBeNull();
    expect((await publicHub.list()).map((d) => d.slug)).not.toContain('deploy-runbook');
  });

  it('lists newest-first and keyset-pages over (published_at, id) (Phase 24.F)', async () => {
    // Five docs with strictly increasing published_at, so newest-first order is
    // deterministic. Provenance is audit-only, so all point at the same source.
    const base = Date.parse('2026-07-10T00:00:00.000Z');
    const slugs = ['k-a', 'k-b', 'k-c', 'k-d', 'k-e'];
    for (const [i, slug] of slugs.entries()) {
      await publicHub.publish({
        slug,
        title: `Keyset ${slug}`,
        body: 'body',
        contentHash: `hash-${slug}`,
        byteSize: 4,
        sourceOrgId: orgId,
        sourceDocumentId: documentId,
        sourceVersionId: versionId,
        publishedBy: userId,
      });
      await db.pool.query('update public_documents set published_at = $2 where slug = $1', [
        slug,
        new Date(base + i * 1000),
      ]);
    }
    const newestFirst = [...slugs].reverse();

    const first = await publicHub.list(null, 2);
    expect(first.map((d) => d.slug)).toEqual(newestFirst.slice(0, 2));

    // Walk the whole set two at a time via the keyset; no duplicates or gaps.
    const seen: string[] = [];
    let after: { publishedAt: Date; id: (typeof first)[number]['id'] } | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const rows = await publicHub.list(after, 2);
      seen.push(...rows.map((d) => d.slug));
      if (rows.length < 2) break;
      const last = rows[rows.length - 1]!;
      after = { publishedAt: last.publishedAt, id: last.id };
    }
    expect(seen).toEqual(newestFirst);

    for (const slug of slugs) await publicHub.unpublish(slug);
  });

  it('vorlyn_public_reader is structurally incapable of reading documents/document_versions (ADR 0004 safety proof)', async () => {
    // Several possible rejection reasons, all proving the same thing:
    //   1. vorlyn_public_reader has no SELECT grant on either table at all
    //      ("permission denied") — the structural proof, always true.
    //   2. Postgres evaluates the RLS policy's `current_org_id()` (a no-arg
    //      STABLE function) during planning, before the ACL check even runs
    //      (`withPublicReader` deliberately never sets `app.org_id`), so the
    //      unset-GUC error can surface first instead — "unrecognized
    //      configuration parameter" on a session that has never touched
    //      `app.org_id`, or "invalid input syntax for type uuid" on a pooled
    //      connection that had the placeholder defined by an earlier,
    //      unrelated `withTenant` transaction (same non-determinism the
    //      tenant-isolation suite's "missing tenant context" test guards
    //      against). Either way the query never returns a row.
    const deniedOrNoTenant =
      /permission denied|unrecognized configuration parameter|invalid input syntax/i;

    await expect(
      withPublicReader(db.pool, (c) => c.query('select * from documents')),
    ).rejects.toThrow(deniedOrNoTenant);

    await expect(
      withPublicReader(db.pool, (c) => c.query('select * from document_versions')),
    ).rejects.toThrow(deniedOrNoTenant);

    // Even with a (garbage) org bound, the grant itself is still missing —
    // the real, always-present proof regardless of GUC state.
    await expect(
      withPublicReader(db.pool, async (c) => {
        await c.query("select set_config('app.org_id', $1, true)", [
          '00000000-0000-0000-0000-000000000000',
        ]);
        return c.query('select * from documents');
      }),
    ).rejects.toThrow(/permission denied/i);

    // It CAN read public_documents — the one table it's granted.
    const ok = await withPublicReader(db.pool, (c) =>
      c.query('select count(*) from public_documents'),
    );
    expect(ok.rows).toBeDefined();

    // And it has no write access to public_documents either — read-only in
    // practice, enforced by grant (SELECT only for vorlyn_public_reader).
    await expect(
      withPublicReader(db.pool, (c) =>
        c.query(
          `insert into public_documents (slug, title, content_hash, byte_size)
           values ('sneaky', 'x', 'y', 1)`,
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('publish never sets an org_id column / RLS is not enabled on public_documents', async () => {
    // Sanity check on the schema itself: no org_id column exists, so there is
    // nothing to scope — this table is structurally outside the tenant model.
    const cols = await withPublicReader(db.pool, (c) =>
      c.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'public_documents'`,
      ),
    );
    expect(cols.rows.map((r) => r.column_name)).not.toContain('org_id');

    const rls = await withPublicReader(db.pool, (c) =>
      c.query<{ relrowsecurity: boolean }>(
        `select relrowsecurity from pg_class where relname = 'public_documents'`,
      ),
    );
    expect(rls.rows[0]?.relrowsecurity).toBe(false);
  });
});
