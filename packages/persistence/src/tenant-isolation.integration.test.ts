import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '@vorlyn/app';
import type { Document, Organization, User } from '@vorlyn/domain';
import { withTenant } from './db.js';
import {
  PgCommentRepository,
  PgDirectoryRepository,
  PgDocumentRepository,
  PgProjectRepository,
  PgShareGrantRepository,
  PgUploadLedgerRepository,
  PgVersionRepository,
} from './repositories/pg-repositories.js';
import {
  PgAllowlistRepository,
  PgOrgInviteRepository,
} from './repositories/pg-invite-repository.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';
import type { CommentId } from '@vorlyn/shared';

/**
 * Core Principle 1: org A can never see org B, proven against real Postgres
 * on every tenant-scoped table, through repositories and raw SQL.
 */
describe('tenant isolation (RLS)', () => {
  let db: TestDb;
  let orgA: Organization;
  let orgB: Organization;
  let userA: User;
  let userB: User;
  let ctxA: TenantContext;
  let ctxB: TenantContext;
  let docA: Document;
  let docB: Document;
  let commentAId: CommentId;

  let documents: PgDocumentRepository;
  let projects: PgProjectRepository;
  let versions: PgVersionRepository;
  let comments: PgCommentRepository;
  let grants: PgShareGrantRepository;
  let ledger: PgUploadLedgerRepository;
  let invites: PgOrgInviteRepository;
  let allowlist: PgAllowlistRepository;

  beforeAll(async () => {
    db = await createTestDb();
    const directory = new PgDirectoryRepository(db.pool);
    documents = new PgDocumentRepository(db.pool);
    projects = new PgProjectRepository(db.pool);
    versions = new PgVersionRepository(db.pool);
    comments = new PgCommentRepository(db.pool);
    grants = new PgShareGrantRepository(db.pool);
    ledger = new PgUploadLedgerRepository(db.pool);
    invites = new PgOrgInviteRepository(db.pool);
    allowlist = new PgAllowlistRepository(db.pool);

    orgA = await directory.createOrganization('Org A');
    orgB = await directory.createOrganization('Org B');
    userA = await directory.createUser(orgA.id, {
      workosUserId: 'wos_a',
      email: 'a@org-a.test',
      displayName: 'A',
      role: 'admin',
    });
    userB = await directory.createUser(orgB.id, {
      workosUserId: 'wos_b',
      email: 'b@org-b.test',
      displayName: 'B',
      role: 'admin',
    });
    ctxA = { orgId: orgA.id, userId: userA.id };
    ctxB = { orgId: orgB.id, userId: userB.id };

    // Seed a full object graph in each org.
    for (const [ctx, user, label] of [
      [ctxA, userA, 'A'],
      [ctxB, userB, 'B'],
    ] as const) {
      const project = await projects.create(ctx, { name: `Project ${label}`, color: '#112233' });
      const doc = await documents.create(ctx, {
        projectId: project.id,
        ownerId: user.id,
        title: `Doc ${label}`,
      });
      const version = await versions.append(ctx, {
        documentId: doc.id,
        contentHash: `hash-${label}`,
        byteSize: 10,
        createdBy: user.id,
        source: 'web',
      });
      await ledger.record(ctx, version.id, 10);
      const comment = await comments.create(ctx, {
        documentId: doc.id,
        versionId: version.id,
        authorId: user.id,
        body: `comment ${label}`,
        anchor: { type: 'document' },
      });
      await comments.addReply(ctx, {
        commentId: comment.id,
        parentReplyId: null,
        authorId: user.id,
        body: `reply ${label}`,
      });
      await comments.toggleUpvote(ctx, comment.id, user.id);
      await grants.create(ctx, {
        subject: { type: 'document', id: doc.id },
        grantee: { type: 'link' },
        permission: 'comment',
        tokenHash: `token-${label}`,
        createdBy: user.id,
      });
      await invites.create(ctx, {
        email: `invitee-${label}@test.test`,
        role: 'member',
        tokenHash: `invite-token-${label}`,
        expiresAt: new Date(Date.now() + 86_400_000),
        invitedBy: user.id,
      });
      await allowlist.add(ctx, { email: `allowed-${label}@test.test`, addedBy: user.id });
      if (label === 'A') {
        docA = doc;
        commentAId = comment.id;
      } else {
        docB = doc;
      }
    }
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  it("documents: B cannot read, list, or soft-delete A's document", async () => {
    expect(await documents.byId(ctxB, docA.id)).toBeUndefined();
    const listB = await documents.list(ctxB);
    expect(listB.map((d) => d.id)).toEqual([docB.id]);
    expect(await documents.softDelete(ctxB, docA.id, new Date())).toBe(false);
    // and A still sees it untouched
    const stillThere = await documents.byId(ctxA, docA.id);
    expect(stillThere?.deletedAt).toBeNull();
  });

  it('projects, versions, comments, replies, grants, ledger: cross-org reads return nothing', async () => {
    expect(await projects.list(ctxB)).toHaveLength(1);
    expect(await versions.listForDocument(ctxB, docA.id)).toHaveLength(0);
    expect(await comments.listForDocument(ctxB, docA.id)).toHaveLength(0);
    expect(await grants.listForDocument(ctxB, docA.id)).toHaveLength(0);
    // upload_ledger has no repository read method left (the rolling-window
    // usageFor query it backed was retired in the rate-limiting redesign,
    // 2026-08-11 — the table and its RLS policy are unchanged, only the
    // gating read is gone) — proven directly against the table instead,
    // same raw-SQL-under-withTenant pattern as every other RLS proof here.
    const rows = await withTenant(db.pool, ctxB, (c) =>
      c.query<{ count: string }>('select count(*) from upload_ledger where user_id = $1', [
        ctxA.userId,
      ]),
    );
    expect(Number(rows.rows[0]?.count)).toBe(0);
  });

  it("org invites + allowlist: B cannot see, count, revoke, or remove A's rows", async () => {
    expect(await invites.list(ctxB)).toHaveLength(1);
    expect(await invites.list(ctxB)).not.toEqual(await invites.list(ctxA));
    const invitesA = await invites.list(ctxA);
    expect(await invites.revoke(ctxB, invitesA[0]!.id)).toBe(false);
    expect(await allowlist.list(ctxB)).toHaveLength(1);
    const allowlistA = await allowlist.list(ctxA);
    expect(await allowlist.remove(ctxB, allowlistA[0]!.id)).toBe(false);
  });

  it("comments: B cannot resolve A's comment", async () => {
    expect(await comments.resolve(ctxB, commentAId, ctxB.userId)).toBe(false);
    const still = await comments.byId(ctxA, commentAId);
    expect(still?.status).toBe('open');
  });

  it("raw SQL under B's tenant context sees zero rows of A on every table", async () => {
    const tables = [
      'users',
      'projects',
      'documents',
      'document_versions',
      'comments',
      'comment_replies',
      'comment_upvotes',
      'share_grants',
      'upload_ledger',
      'org_invites',
      'org_allowlist_entries',
    ];
    for (const table of tables) {
      const rows = await withTenant(db.pool, ctxB, async (c) => {
        const res = await c.query<{ org_id: string }>(`select org_id from ${table}`);
        return res.rows;
      });
      expect(
        rows.every((r) => r.org_id === orgB.id),
        `${table} leaked cross-org rows`,
      ).toBe(true);
    }
    // organizations table: B sees only its own row
    const orgs = await withTenant(db.pool, ctxB, async (c) => {
      const res = await c.query<{ id: string }>('select id from organizations');
      return res.rows;
    });
    expect(orgs).toEqual([{ id: orgB.id }]);
  });

  it('WITH CHECK blocks writing rows into another org', async () => {
    await expect(
      withTenant(db.pool, ctxB, (c) =>
        c.query('insert into projects (org_id, name) values ($1, $2)', [orgA.id, 'smuggled']),
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it('cross-org foreign references are impossible (composite FKs carry org_id)', async () => {
    // B tries to comment on A's document by guessing IDs. FK checks bypass
    // RLS, so FKs are composite on (id, org_id): (docA, orgB) cannot exist.
    const versionA = (await versions.listForDocument(ctxA, docA.id))[0]!;
    await expect(
      comments.create(ctxB, {
        documentId: docA.id,
        versionId: versionA.id,
        authorId: ctxB.userId,
        body: 'sneaky',
        anchor: { type: 'document' },
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  it('missing tenant context yields an error, never all rows', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role vorlyn_app');
      await expect(client.query('select * from documents')).rejects.toThrow(
        /unrecognized configuration parameter|invalid input syntax/i,
      );
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('document_versions are immutable', async () => {
    const versionA = (await versions.listForDocument(ctxA, docA.id))[0]!;
    await expect(
      withTenant(db.pool, ctxA, (c) =>
        c.query('update document_versions set byte_size = 999 where id = $1', [versionA.id]),
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('share_grants cannot hold an edit permission alongside a guest email (DB check constraint)', async () => {
    // ADR 0008 widened the enum to read|comment|edit, so a plain grant may now
    // carry 'edit'. What migration 0030 keeps structurally impossible is 'edit'
    // on any row with a grantee_email — which every guest grant has, by
    // construction (CONSTITUTION §9).
    await expect(
      withTenant(db.pool, ctxA, (c) =>
        c.query(
          `insert into share_grants (org_id, subject_type, subject_id, grantee_type, grantee_user_id,
             permission, token_hash, grantee_email, created_by)
           values ($1, 'document', $2, 'user', $3, 'edit', 'x', 'ext@partner.test', $3)`,
          [orgA.id, docA.id, userA.id],
        ),
      ),
    ).rejects.toThrow(/share_grants_no_guest_edit|check constraint/i);
  });

  it('version seq increments transactionally and moves current_version_id', async () => {
    const v2 = await versions.append(ctxA, {
      documentId: docA.id,
      contentHash: 'hash-A2',
      byteSize: 20,
      createdBy: ctxA.userId,
      source: 'mcp',
    });
    expect(v2.seq).toBe(2);
    const doc = await documents.byId(ctxA, docA.id);
    expect(doc?.currentVersionId).toBe(v2.id);
  });
});
