import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NewVersion, TenantContext } from '@vorlyn/app';
import type { UploadSource } from '@vorlyn/domain';
import {
  PgDirectoryRepository,
  PgDocumentRepository,
  PgVersionRepository,
} from './repositories/pg-repositories.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

/**
 * Phase 20.A: `document_versions.source` accepts `cli` (migration 0031), so a
 * repo-mirrored version is distinguishable from an agent authoring in place.
 * Nothing emits it yet — `upload_document` cannot tell a CLI caller from any
 * other MCP client — so this proves the schema and domain union are ready,
 * writing through the repository directly rather than through the MCP path.
 */
describe('upload source vocabulary', () => {
  let db: TestDb;
  let ctx: TenantContext;
  let documents: PgDocumentRepository;
  let versions: PgVersionRepository;

  beforeAll(async () => {
    db = await createTestDb();
    const directory = new PgDirectoryRepository(db.pool);
    const org = await directory.createOrganization('Acme');
    const user = await directory.createUser(org.id, {
      workosUserId: 'wos_source',
      email: 'dev@acme.test',
      displayName: 'Dev',
      role: 'member',
    });
    ctx = { orgId: org.id, userId: user.id };
    documents = new PgDocumentRepository(db.pool);
    versions = new PgVersionRepository(db.pool);
  });

  afterAll(async () => {
    await db.close();
  });

  async function newVersionInput(title: string): Promise<NewVersion> {
    const doc = await documents.create(ctx, { projectId: null, ownerId: ctx.userId, title });
    return {
      documentId: doc.id,
      contentHash: 'h',
      byteSize: 1,
      createdBy: ctx.userId,
      source: 'web',
    };
  }

  it.each<UploadSource>(['web', 'mcp', 'cli'])('round-trips source "%s"', async (source) => {
    const base = await newVersionInput(`${source}.md`);
    const version = await versions.append(ctx, { ...base, source });
    expect(version.source).toBe(source);
    expect((await versions.byId(ctx, version.id))?.source).toBe(source);
  });

  it('still rejects a source outside the vocabulary — the CHECK was widened, not dropped', async () => {
    const base = await newVersionInput('bogus.md');
    await expect(
      versions.append(ctx, { ...base, source: 'smoke-signal' as UploadSource }),
    ).rejects.toThrow(/document_versions_source_check/);
  });
});
