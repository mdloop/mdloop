import type { Pool } from 'pg';

const DEFAULT_PING_TIMEOUT_MS = 2_000;

/**
 * A caller races each ping against `timeoutMs` and moves on, but the
 * underlying `pool.query('select 1')` isn't cancelled by that — it stays
 * queued on the pool (up to `connectionTimeoutMillis`) and will eventually
 * take a connection. A load balancer polling `/readyz` every 1-2s during a
 * real pool-saturation incident would otherwise stack up one abandoned probe
 * per poll, each competing with real traffic for the same limited
 * connections — worsening the exact condition readiness checks exist to
 * detect. Sharing one in-flight probe per pool across overlapping callers
 * closes that: at most one `select 1` is ever outstanding per pool.
 */
const inFlightPings = new WeakMap<Pool, Promise<boolean>>();

/**
 * Cheap DB reachability check for `GET /readyz` (Phase 24.E): a `select 1`
 * raced against a short timeout. Resolves `true` only on a successful round
 * trip; `false` on any error (pool exhausted, connection refused, query error)
 * or if the ping outruns `timeoutMs`. Never throws and never surfaces the
 * underlying error — readiness is a boolean signal, not a leak surface.
 */
export async function pingPool(
  pool: Pool,
  timeoutMs: number = DEFAULT_PING_TIMEOUT_MS,
): Promise<boolean> {
  let probe = inFlightPings.get(pool);
  if (!probe) {
    probe = pool
      .query('select 1')
      .then(() => true)
      .catch(() => false)
      .finally(() => {
        if (inFlightPings.get(pool) === probe) inFlightPings.delete(pool);
      });
    inFlightPings.set(pool, probe);
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
