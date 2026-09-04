import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@mdloop/app';
import { createComment, uploadNewDocument } from '@mdloop/app';
import { createHash } from 'node:crypto';
import {
  PgAllowlistRepository,
  PgOrgInviteRepository,
} from './repositories/pg-invite-repository.js';
import { PgOrganizationRepository } from './repositories/pg-organization-repository.js';
import {
  PgCommentRepository,
  PgDirectoryRepository,
  PgDocumentRepository,
  PgShareGrantRepository,
  PgUploadUnitOfWork,
} from './repositories/pg-repositories.js';
import { FsStorage } from './storage/fs-storage.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

/**
 * Whole-org purge FK correctness (Phase 24.D). org_invites and
 * org_allowlist_entries (migration 0008) carry plain non-cascading FKs to
 * users via invited_by/added_by; a purge that skips them fails the users
 * delete and rolls back the entire GDPR erasure. This proves an org that has
 * sent an invite AND added an allowlist entry — the realistic multi-user
 * case — purges cleanly and leaves both tables empty for that org.
 */
describe('purgeOrganization with invite + allowlist rows present', () => {
  let db: TestDb;
  let storageDir: string;

  beforeAll(async () => {
    db = await createTestDb();
    storageDir = await mkdtemp(path.join(tmpdir(), 'mdloop-purge-org-'));
  });

  afterAll(async () => {
    await db.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  it('deletes invites and allowlist entries and does not throw', async () => {
    const storage = new FsStorage(storageDir);
    const directory = new PgDirectoryRepository(db.pool);
    const documents = new PgDocumentRepository(db.pool);
    const comments = new PgCommentRepository(db.pool);
    const orgs = new PgOrganizationRepository(db.pool);
    const grants = new PgShareGrantRepository(db.pool);
    const invites = new PgOrgInviteRepository(db.pool);
    const allowlist = new PgAllowlistRepository(db.pool);
    const uow = new PgUploadUnitOfWork(db.pool);

    const org = await directory.createOrganization('Acme');
    const admin = await directory.createUser(org.id, {
      workosUserId: `wos_admin_${String(Math.random())}`,
      email: `admin_${String(Math.random())}@acme.test`,
      displayName: 'Admin',
      role: 'admin',
    });
    const actor: Actor = { ctx: { orgId: org.id, userId: admin.id }, role: 'admin' };

    // A document + comment so the tenant-table delete order is exercised end to end.
    const uploaded = await uploadNewDocument(uow, storage, actor, {
      title: 'spec.md',
      projectId: null,
      content: new TextEncoder().encode('# Spec\n\nbody\n'),
      source: 'web',
    });
    if (!uploaded.ok) throw new Error('setup upload');
    const comment = await createComment(documents, comments, orgs, grants, actor, {
      documentId: uploaded.value.document.id,
      body: 'please check',
      anchor: { type: 'document' },
    });
    if (!comment.ok) throw new Error('setup comment');

    // The two rows the buggy purge omitted: a pending invite and an allowlist entry.
    await invites.create(actor.ctx, {
      email: 'invitee@acme.test',
      role: 'member',
      tokenHash: createHash('sha256')
        .update(`tok_${String(Math.random())}`)
        .digest('hex'),
      invitedBy: admin.id,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    });
    await allowlist.add(actor.ctx, { email: 'allowed@acme.test', addedBy: admin.id });

    // The purge must complete without an FK violation rolling it back.
    await expect(orgs.purgeOrganization(org.id)).resolves.toBeUndefined();

    // Both previously-omitted tables are empty for the org, as is the org itself.
    const countOf = async (sql: string): Promise<string> => {
      const { rows } = await db.pool.query<{ count: string }>(sql, [org.id]);
      return rows[0]?.count ?? 'missing';
    };
    expect(await countOf('select count(*) from org_invites where org_id = $1')).toBe('0');
    expect(await countOf('select count(*) from org_allowlist_entries where org_id = $1')).toBe('0');
    expect(await countOf('select count(*) from organizations where id = $1')).toBe('0');
    expect(await countOf('select count(*) from users where org_id = $1')).toBe('0');
  });
});
