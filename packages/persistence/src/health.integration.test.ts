import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { pingPool } from './health.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

describe('pingPool', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  it('resolves true against a live pool', async () => {
    expect(await pingPool(db.pool)).toBe(true);
  });

  it('resolves false against an unreachable server, without throwing', async () => {
    const dead = new Pool({
      connectionString: 'postgres://localhost:1/nope',
      connectionTimeoutMillis: 500,
    });
    dead.on('error', () => undefined);
    try {
      expect(await pingPool(dead, 1_000)).toBe(false);
    } finally {
      await dead.end();
    }
  });
});
