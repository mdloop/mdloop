import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../migrate.js';

/**
 * Dual-mode test database (README):
 *  - TEST_DATABASE_URL set -> use that server (native Postgres),
 *  - else if Docker present -> Testcontainers postgres:16 (added when CI needs it),
 *  - else -> local server on default socket (Homebrew install).
 * Either way: create an ephemeral database, migrate, hand back a pool; drop on close.
 */
export interface TestDb {
  pool: Pool;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const adminUrl =
    process.env.TEST_DATABASE_URL ??
    `postgres://${process.env.USER ?? 'postgres'}@localhost:5432/postgres`;
  const dbName = `vorlyn_test_${randomBytes(6).toString('hex')}`;

  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  // `drop database ... (force)` below can race a client that pool.end() has
  // already logically closed but whose socket teardown hasn't finished —
  // Postgres's termination signal then lands on a client with no listener,
  // and node-pg's Pool/Client treat an unlistened 'error' as fatal. Harmless
  // in this codepath (the pool is already shutting down); swallow it.
  admin.on('error', () => undefined);
  await admin.query(`create database ${dbName}`);

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const pool = new Pool({ connectionString: url.toString(), max: 5 });
  pool.on('error', () => undefined);
  await migrate(pool);

  return {
    pool,
    async close() {
      await pool.end();
      await admin.query(`drop database ${dbName} (force)`);
      await admin.end();
    },
  };
}
