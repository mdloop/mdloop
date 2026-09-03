import { Redis } from 'ioredis';

/**
 * Real local Valkey for the rate limiter's CAS/concurrency-critical path
 * (`docs/adr/0010-rate-limiter-test-infrastructure.md`) — mirrors
 * `createTestDb`'s shape: `TEST_REDIS_URL` overrides the connection target
 * (unset ⇒ `redis://localhost:6379`, the Homebrew default), and each run is
 * isolated to one of Redis's numbered logical databases (1–15; 0 is
 * deliberately never used here, so an unconfigured client can never collide
 * with test data).
 *
 * Unlike `createTestDb`'s per-run randomly-*named* database (collision odds
 * effectively zero), there are only 15 numbered DBs to go around — two test
 * files running in concurrent vitest workers (a real scenario: this repo's
 * files run in parallel by default) picking the same number by chance is a
 * ~1-in-15 event per pair, not negligible, and one file's `flushdb()` in
 * `afterEach` would silently wipe another's in-progress state mid-test. A
 * lock key in db 0 (reserved, never used for test data) makes DB claiming a
 * real mutual exclusion instead of a bare random guess: `SET NX` a claim
 * marker per candidate DB number, retrying on a collision, until one claims
 * cleanly; `close()` releases it.
 */
export interface TestRedis {
  client: Redis;
  close(): Promise<void>;
}

const CLAIM_KEY_PREFIX = 'vorlyn:test-redis-db-claim:';
const CLAIM_TTL_SECONDS = 300;

export async function createTestRedis(): Promise<TestRedis> {
  const url = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
  const lockClient = new Redis(url, { db: 0, lazyConnect: true });
  await lockClient.connect();

  let db: number | undefined;
  try {
    // Bounded retries, not an infinite loop: with only 15 slots, a
    // pathologically unlucky run gets a clear failure instead of hanging.
    for (let attempt = 0; attempt < 30 && db === undefined; attempt++) {
      const candidate = 1 + Math.floor(Math.random() * 15);
      const claimed = await lockClient.set(
        CLAIM_KEY_PREFIX + String(candidate),
        '1',
        'EX',
        CLAIM_TTL_SECONDS,
        'NX',
      );
      if (claimed === 'OK') db = candidate;
    }
    if (db === undefined) {
      throw new Error(
        'createTestRedis: could not claim a free logical DB after 30 attempts — too much concurrent test-Redis usage for 15 slots',
      );
    }
  } finally {
    await lockClient.quit();
  }

  const client = new Redis(url, { db, lazyConnect: true });
  await client.connect();
  await client.flushdb();

  return {
    client,
    async close() {
      await client.flushdb();
      client.disconnect();
      const releaseClient = new Redis(url, { db: 0, lazyConnect: true });
      await releaseClient.connect();
      await releaseClient.del(CLAIM_KEY_PREFIX + String(db));
      await releaseClient.quit();
    },
  };
}
