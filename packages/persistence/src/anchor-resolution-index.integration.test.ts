import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

/**
 * Migration 0020: applies cleanly (createTestDb runs every migration in
 * filename order for every integration test — this just asserts the index it
 * adds actually lands) and backs the `forVersion` read path's
 * `where version_id = $1` under RLS `org_id = current_org_id()`.
 */
describe('migration 0020 — comment_anchor_resolutions_version_idx', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('applies as part of the ordinary migration run', async () => {
    const { rows } = await db.pool.query<{ name: string }>(
      'select name from schema_migrations where name = $1',
      ['0020_anchor_resolution_index.sql'],
    );
    expect(rows).toHaveLength(1);
  });

  it('creates the (org_id, version_id) index used by the version-scoped lookup', async () => {
    const { rows } = await db.pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where tablename = 'comment_anchor_resolutions'
         and indexname = 'comment_anchor_resolutions_version_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toMatch(/\(org_id, version_id\)/);
  });
});
