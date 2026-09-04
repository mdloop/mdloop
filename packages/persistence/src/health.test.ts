import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { pingPool } from './health.js';

/** Deferred so a test can control exactly when the fake `pool.query` settles. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakePool(query: (...args: unknown[]) => Promise<unknown>): Pool {
  return { query } as unknown as Pool;
}

describe('pingPool concurrency', () => {
  it('shares one in-flight query across overlapping callers (no probe stacking)', async () => {
    const gate = deferred<unknown>();
    const query = vi.fn().mockReturnValue(gate.promise);
    const pool = fakePool(query);

    const first = pingPool(pool);
    const second = pingPool(pool);
    // Give the microtask queue a turn so both calls have started before the
    // underlying query resolves.
    await Promise.resolve();
    gate.resolve(undefined);

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('shares a single in-flight failure too, not one query per caller', async () => {
    const gate = deferred<unknown>();
    const query = vi.fn().mockReturnValue(gate.promise);
    const pool = fakePool(query);

    const first = pingPool(pool);
    const second = pingPool(pool);
    await Promise.resolve();
    gate.reject(new Error('connection refused'));

    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not stack a probe past its own timeout: a caller can resolve false while the query is still outstanding', async () => {
    const gate = deferred<unknown>();
    const query = vi.fn().mockReturnValue(gate.promise);
    const pool = fakePool(query);

    // Timeout shorter than how long the fake query takes to settle.
    const result = pingPool(pool, 5);
    expect(await result).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);

    gate.resolve(undefined);
  });

  it('issues a fresh query for the next ping once the prior one has settled (no permanent stale cache)', async () => {
    const query = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    const pool = fakePool(query);

    expect(await pingPool(pool)).toBe(true);
    expect(await pingPool(pool)).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
