import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor, OverviewAccess, OverviewKeyset } from '@vorlyn/app';
import type { DocumentId } from '@vorlyn/shared';
import { PgDirectoryRepository, PgDocumentRepository } from './repositories/pg-repositories.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

/**
 * The home-overview page query (Phase 24.F) against real Postgres: proves the
 * owner/grant/admin access predicate, the (last_activity desc, id desc) keyset,
 * and the LIMIT all live in SQL — a member paging an org of 200 documents only
 * ever sees their accessible slice, and the keyset walks the whole set with no
 * duplicates or gaps regardless of org size. The in-memory fake can't prove the
 * SQL agrees with Postgres on ordering + the access EXISTS clause; this does.
 */
describe('overviewPage keyset + access predicate', () => {
  let db: TestDb;
  let documents: PgDocumentRepository;
  let member: Actor;
  let adminActor: Actor;
  let grantsAccess: OverviewAccess;
  let adminAccess: OverviewAccess;
  let accessibleIds: DocumentId[];

  beforeAll(async () => {
    db = await createTestDb();
    documents = new PgDocumentRepository(db.pool);
    const directory = new PgDirectoryRepository(db.pool);
    const org = await directory.createOrganization('Acme');
    const mem = await directory.createUser(org.id, {
      workosUserId: 'wos_member',
      email: 'member@acme.test',
      displayName: 'Member',
      role: 'member',
    });
    const admin = await directory.createUser(org.id, {
      workosUserId: 'wos_admin',
      email: 'admin@acme.test',
      displayName: 'Admin',
      role: 'admin',
    });
    member = { ctx: { orgId: org.id, userId: mem.id }, role: 'member' };
    adminActor = { ctx: { orgId: org.id, userId: admin.id }, role: 'admin' };
    grantsAccess = { userId: mem.id, role: 'member' };
    adminAccess = { userId: admin.id, role: 'admin' };

    // 200 documents: even-index owned by the member (accessible), odd-index
    // owned by the admin (inaccessible to the member) — of those, every 5th is
    // granted to the member. Distinct created_at gives a deterministic activity
    // order (no comments/versions ⇒ last_activity = created_at).
    const base = Date.parse('2026-07-01T00:00:00.000Z');
    const accessible: DocumentId[] = [];
    for (let i = 0; i < 200; i += 1) {
      const memberOwned = i % 2 === 0;
      const ctx = memberOwned ? member.ctx : adminActor.ctx;
      const doc = await documents.create(ctx, {
        projectId: null,
        title: `doc-${String(i)}`,
        ownerId: ctx.userId,
      });
      await db.pool.query('update documents set created_at = $2 where id = $1', [
        doc.id,
        new Date(base + i * 1000),
      ]);
      if (memberOwned) {
        accessible.push(doc.id);
      } else if (i % 5 === 0) {
        await db.pool.query(
          `insert into share_grants
             (org_id, subject_type, subject_id, grantee_type, grantee_user_id, permission, created_by)
           values ($1, 'document', $2, 'user', $3, 'comment', $4)`,
          [org.id, doc.id, member.ctx.userId, member.ctx.userId],
        );
        accessible.push(doc.id);
      }
    }
    // Expected member order: activity desc (created_at desc), id desc tiebreak
    // (created_at is unique here, so just created_at desc = reverse insertion).
    accessibleIds = [...accessible].reverse();
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  it('returns exactly the requested page size and keyset-walks the accessible set', async () => {
    // First full page is exactly the limit, never the whole org.
    const first = await documents.overviewPage(member.ctx, grantsAccess, {}, null, 50);
    expect(first).toHaveLength(50);
    expect(first.map((r) => r.document.id)).toEqual(accessibleIds.slice(0, 50));

    // Walk the whole accessible set 25 rows at a time.
    const seen: DocumentId[] = [];
    let after: OverviewKeyset | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const rows = await documents.overviewPage(member.ctx, grantsAccess, {}, after, 25);
      seen.push(...rows.map((r) => r.document.id));
      if (rows.length < 25) break;
      const last = rows[rows.length - 1]!;
      after = { lastActivityAt: last.lastActivityAt, id: last.document.id };
    }
    // Complete coverage, correct order, no duplicates or gaps — and never any
    // inaccessible (admin-owned, ungranted) document.
    expect(seen).toEqual(accessibleIds);
  });

  it('counts and openByProject are access-scoped; admin sees the whole org', async () => {
    const memberCounts = await documents.overviewCounts(member.ctx, grantsAccess);
    expect(memberCounts.all).toBe(accessibleIds.length);
    expect(memberCounts.openByProject).toEqual([]);

    const adminPage = await documents.overviewPage(adminActor.ctx, adminAccess, {}, null, 300);
    expect(adminPage).toHaveLength(200);
    const adminCounts = await documents.overviewCounts(adminActor.ctx, adminAccess);
    expect(adminCounts.all).toBe(200);
  });

  it('keyset-walks real (DB-assigned) timestamps with no gaps at sub-millisecond boundaries', async () => {
    // Unlike the fixture above (hand-set, millisecond-round Date.parse values),
    // these documents get their created_at from the DB's own now() — real
    // microsecond precision, the exact case that silently dropped documents
    // before last_activity_at was truncated consistently in the keyset
    // comparison and ORDER BY (Phase 24.G finding). limit=1 forces a cursor
    // round trip after every single row, maximizing boundary exposure.
    const org = adminActor.ctx.orgId;
    const solo: Actor = { ctx: { orgId: org, userId: adminActor.ctx.userId }, role: 'admin' };
    const soloAccess: OverviewAccess = { userId: adminActor.ctx.userId, role: 'admin' };
    const created: DocumentId[] = [];
    for (let i = 0; i < 40; i += 1) {
      const doc = await documents.create(solo.ctx, {
        projectId: null,
        title: `real-ts-${String(i)}`,
        ownerId: solo.ctx.userId,
      });
      created.push(doc.id);
    }

    const seen: DocumentId[] = [];
    let after: OverviewKeyset | null = null;
    for (let i = 0; i < 200; i += 1) {
      const rows = await documents.overviewPage(solo.ctx, soloAccess, {}, after, 1);
      if (rows.length === 0) break;
      const [row] = rows;
      if (!row) break;
      seen.push(row.document.id);
      after = { lastActivityAt: row.lastActivityAt, id: row.document.id };
    }

    // Every real-timestamped doc created in this test must appear exactly
    // once — no gaps from the truncation mismatch, no duplicates from the
    // fix's tie-break.
    for (const id of created) {
      expect(seen.filter((s) => s === id)).toHaveLength(1);
    }
  });
});
