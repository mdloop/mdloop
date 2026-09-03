import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '@vorlyn/app';
import { PgDirectoryRepository } from './repositories/pg-repositories.js';
import { PgOrganizationRepository } from './repositories/pg-organization-repository.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

/**
 * `listUsersPage`'s keyset cursor at the DB level — real Postgres, not the
 * in-memory fake. Exercises the `:`-delimited codec
 * (encodeNameKeysetCursor/decodeNameKeysetCursor, org-settings.ts) this
 * repository was moved onto after its cursor separator turned out to be a
 * literal NUL byte, which made the file git-binary and every diff/patch
 * tool silently blind to it. Covers the two things that separator change could plausibly
 * have broken: a display name that itself contains the new delimiter or a
 * character the old one didn't reserve, and backward compatibility with a
 * cursor a client might still be holding from before the format changed.
 */
describe('listUsersPage keyset pagination', () => {
  let db: TestDb;
  let ctx: TenantContext;
  let orgs: PgOrganizationRepository;

  beforeAll(async () => {
    db = await createTestDb();
    const directory = new PgDirectoryRepository(db.pool);
    orgs = new PgOrganizationRepository(db.pool);
    const org = await directory.createOrganization('Acme');
    const admin = await directory.createUser(org.id, {
      workosUserId: 'wos_admin',
      email: 'admin@acme.test',
      displayName: 'Zzz Admin',
      role: 'admin',
    });
    ctx = { orgId: org.id, userId: admin.id };
  });

  afterAll(async () => {
    await db.close();
  });

  it('walks every member with no duplicates or gaps, ordered by (lower(display_name), id)', async () => {
    const directory = new PgDirectoryRepository(db.pool);
    const names = ['Bob', 'alice', 'Carl', 'Dana', 'Eve'];
    const created: string[] = [];
    for (const [i, name] of names.entries()) {
      const u = await directory.createUser(ctx.orgId, {
        workosUserId: `wos_walk_${String(i)}`,
        email: `walk${String(i)}@acme.test`,
        displayName: name,
        role: 'member',
      });
      created.push(u.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await orgs.listUsersPage(ctx, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.users.map((u) => u.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    // Every created id appears exactly once, plus the beforeAll admin.
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of created) expect(seen).toContain(id);
    expect(seen).toContain(ctx.userId);
  });

  it('paginates correctly past a display name containing the cursor delimiter', async () => {
    const directory = new PgDirectoryRepository(db.pool);
    const withColon = await directory.createUser(ctx.orgId, {
      workosUserId: 'wos_colon',
      email: 'colon@acme.test',
      displayName: 'Trailer: Sync-To',
      role: 'member',
    });
    const after = await directory.createUser(ctx.orgId, {
      workosUserId: 'wos_after_colon',
      email: 'aftercolon@acme.test',
      displayName: 'Trailer: Zzz',
      role: 'member',
    });

    const first = await orgs.listUsersPage(ctx, {
      q: 'trailer',
      limit: 1,
    });
    expect(first.users).toHaveLength(1);
    expect(first.users[0]!.id).toBe(withColon.id);
    expect(first.nextCursor).toBeTruthy();

    const second = await orgs.listUsersPage(ctx, {
      q: 'trailer',
      cursor: first.nextCursor!,
      limit: 1,
    });
    expect(second.users).toHaveLength(1);
    expect(second.users[0]!.id).toBe(after.id);
  });

  it('paginates correctly past a display name containing a space', async () => {
    const directory = new PgDirectoryRepository(db.pool);
    const withSpace = await directory.createUser(ctx.orgId, {
      workosUserId: 'wos_space',
      email: 'space@acme.test',
      displayName: 'Roomy Name',
      role: 'member',
    });
    const after = await directory.createUser(ctx.orgId, {
      workosUserId: 'wos_after_space',
      email: 'afterspace@acme.test',
      displayName: 'Roomy Zzz',
      role: 'member',
    });

    const first = await orgs.listUsersPage(ctx, { q: 'roomy', limit: 1 });
    expect(first.users[0]!.id).toBe(withSpace.id);

    const second = await orgs.listUsersPage(ctx, {
      q: 'roomy',
      cursor: first.nextCursor!,
      limit: 1,
    });
    expect(second.users[0]!.id).toBe(after.id);
  });

  it('degrades a legacy NUL-separated cursor to page 1 instead of erroring', async () => {
    // The pre-fix format: `${name}\0${id}`, base64url-encoded — a cursor a
    // client could still be holding across a deploy that changed the
    // delimiter. Must not reach the database as an invalid ::uuid cast.
    const legacy = Buffer.from(`zzz\0${crypto.randomUUID()}`, 'utf8').toString('base64url');
    const page = await orgs.listUsersPage(ctx, { cursor: legacy, limit: 2 });
    // Page 1 behavior: same as no cursor at all.
    const noCursor = await orgs.listUsersPage(ctx, { limit: 2 });
    expect(page.users.map((u) => u.id)).toEqual(noCursor.users.map((u) => u.id));
  });

  it('degrades a garbage (non-UUID-tailed) cursor to page 1 instead of erroring', async () => {
    const garbage = Buffer.from('not-a-real-cursor:also-not-a-uuid', 'utf8').toString('base64url');
    const page = await orgs.listUsersPage(ctx, { cursor: garbage, limit: 2 });
    const noCursor = await orgs.listUsersPage(ctx, { limit: 2 });
    expect(page.users.map((u) => u.id)).toEqual(noCursor.users.map((u) => u.id));
  });
});
