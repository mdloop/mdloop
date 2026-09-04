import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import type { EmbeddedPostgres } from './embedded-postgres.js';
import { startEmbeddedPostgres } from './embedded-postgres.js';
import { migrate } from './migrate.js';

/**
 * Real infrastructure, not mocked: a real PGlite instance behind a real
 * Postgres wire-protocol socket server, migrated with this codebase's
 * actual `migrate()` against the actual 33-migration schema, queried with
 * the unmodified `pg` driver.
 */
describe('startEmbeddedPostgres', () => {
  let dataDir: string | undefined;
  let embedded: EmbeddedPostgres | undefined;
  let pool: Pool | undefined;
  let secondPool: Pool | undefined;

  afterEach(async () => {
    await pool?.end();
    await secondPool?.end();
    await embedded?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    pool = undefined;
    secondPool = undefined;
    embedded = undefined;
    dataDir = undefined;
  });

  it('binds an OS-assigned ephemeral port and exposes a usable postgres:// connection string', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mdloop-embedded-pg-'));
    embedded = await startEmbeddedPostgres(dataDir);

    expect(embedded.connectionString).toMatch(
      /^postgres:\/\/postgres:postgres@127\.0\.0\.1:\d+\/postgres$/,
    );
    const port = Number(new URL(embedded.connectionString).port);
    expect(port).toBeGreaterThan(0);
    // An OS-assigned port is never the hardcoded spike port — proves the
    // ephemeral-port path actually ran, not a hardcoded fallback.
    expect(port).not.toBe(55432);
  }, 30_000);

  it('runs the real migrate() against it and round-trips a query', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mdloop-embedded-pg-'));
    embedded = await startEmbeddedPostgres(dataDir);
    // Single-connection pool: PGlite is one embedded engine instance, not a
    // real multi-connection cluster (module doc comment, spike finding).
    pool = new Pool({ connectionString: embedded.connectionString, max: 1 });

    const applied = await migrate(pool);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied).toContain('0001_core_schema.sql');

    const { rows } = await pool.query<{ name: string }>(
      `insert into organizations (name) values ('embedded-pg-test-org') returning name`,
    );
    expect(rows[0]?.name).toBe('embedded-pg-test-org');
  }, 60_000);

  it('enforces RLS via set local role after connecting as the PGlite superuser', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mdloop-embedded-pg-'));
    embedded = await startEmbeddedPostgres(dataDir);
    pool = new Pool({ connectionString: embedded.connectionString, max: 1 });
    await migrate(pool);

    const orgA = await pool.query<{ id: string }>(
      `insert into organizations (name) values ('Org A') returning id`,
    );
    const orgB = await pool.query<{ id: string }>(
      `insert into organizations (name) values ('Org B') returning id`,
    );

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role mdloop_app');
      await client.query("select set_config('app.org_id', $1, true)", [orgA.rows[0]?.id]);
      const visible = await client.query<{ id: string }>('select id from organizations');
      await client.query('commit');
      const ids = visible.rows.map((r) => r.id);
      expect(ids).toContain(orgA.rows[0]?.id);
      expect(ids).not.toContain(orgB.rows[0]?.id);
    } finally {
      client.release();
    }
  }, 60_000);

  /**
   * The shape `mdloop open` actually uses, and the one nothing tested until
   * this regressed: it spawns TWO processes (`@mdloop/api` and `@mdloop/mcp`
   * embedded composition roots) against ONE embedded instance, so two
   * independent clients must be able to hold connections at the same time.
   *
   * `PGLiteSocketServer` defaults to `maxConnections: 1`, which made the second
   * client fail with `read ECONNRESET` — the MCP child's `/readyz` then returned
   * 503 forever and `mdloop open` timed out on every run, from the day it
   * shipped. Two pools here rather than two processes: same invariant, a
   * fraction of the cost, and it fails for the same reason.
   */
  it('serves two independent clients at once — mdloop open spawns two processes', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mdloop-embedded-pg-'));
    embedded = await startEmbeddedPostgres(dataDir);

    pool = new Pool({ connectionString: embedded.connectionString, max: 1 });
    secondPool = new Pool({ connectionString: embedded.connectionString, max: 1 });

    const [first, second] = await Promise.all([
      pool.query<{ n: number }>('select 1 as n'),
      secondPool.query<{ n: number }>('select 1 as n'),
    ]);
    expect(first.rows[0]?.n).toBe(1);
    expect(second.rows[0]?.n).toBe(1);
  }, 30_000);

  it('stop() is idempotent', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mdloop-embedded-pg-'));
    embedded = await startEmbeddedPostgres(dataDir);
    await embedded.stop();
    await expect(embedded.stop()).resolves.toBeUndefined();
  }, 30_000);
});
