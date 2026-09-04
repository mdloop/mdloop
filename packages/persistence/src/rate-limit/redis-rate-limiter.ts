import type { Redis } from 'ioredis';
import type { RateLimitState, Tier } from '@mdloop/domain';
import { TIER_PROFILES, consumeRequest, initialRateLimitState } from '@mdloop/domain';
import type { RateLimiterPort, RateLimitError } from '@mdloop/app';
import type { Result, UserId } from '@mdloop/shared';
import { err, ok } from '@mdloop/shared';

const KEY_PREFIX = 'mdloop:rate_limit:';
const MAX_CAS_RETRIES = 10;

/**
 * Mirrors `packages/app/src/user-rate-limit.ts`'s `RATE_LIMIT_IDLE_TTL_MS`
 * reasoning: past this age a state has certainly refilled to cap and its
 * daily window has certainly rolled, so expiring the key is lossless — the
 * next request rebuilds the identical fresh state via `initialRateLimitState`.
 * A Redis-side TTL is the shared-store equivalent of the in-process sweep,
 * with no app-side sweeper needed.
 */
const KEY_TTL_SECONDS = 25 * 60 * 60;

/**
 * A tiny round-robin pool of dedicated connections, grown lazily up to
 * `size`. WATCH/MULTI/EXEC accumulate state **per physical connection**, not
 * per logical caller — if two concurrent `check()` calls shared one ioredis
 * connection, one call's MULTI would silently swallow the other's commands
 * into its own transaction (Redis has no concept of "this MULTI belongs to
 * caller A"). Every in-flight CAS loop needs its own connection for the
 * duration of its watch→read→write cycle; `ioredis`'s `duplicate()` gives a
 * cheap way to mint more from the same connection options (host, port, db,
 * TLS, …) without repeating them.
 */
class ConnectionPool {
  private readonly conns: Redis[] = [];
  private readonly free: Redis[] = [];
  private readonly waiters: ((conn: Redis) => void)[] = [];

  constructor(
    private readonly base: Redis,
    private readonly size: number,
  ) {
    this.conns.push(base);
    this.free.push(base);
  }

  acquire(): Promise<Redis> {
    const conn = this.free.pop();
    if (conn) return Promise.resolve(conn);
    if (this.conns.length < this.size) {
      const conn = this.base.duplicate();
      this.conns.push(conn);
      return Promise.resolve(conn);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(conn: Redis): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(conn);
      return;
    }
    this.free.push(conn);
  }

  async quit(): Promise<void> {
    await Promise.all(this.conns.map((c) => c.quit()));
  }
}

/**
 * ElastiCache/Valkey-backed `RateLimiterPort`:
 * the shared-store implementation behind `UserRateLimiter`'s interface,
 * giving per-user tier budgets that hold correctly across N stateless
 * api/mcp replicas (a user's budget stops being N× the tier ceiling).
 *
 * `consumeRequest`/`initialRateLimitState` (`packages/domain/src/rate-limit.ts`)
 * stay the single implementation of the budget math — this adapter is only
 * the storage/concurrency shell around them. A `WATCH`/`MULTI`/`EXEC`
 * optimistic-concurrency loop reads the current state, runs the pure
 * transition, and writes the result back, retrying the whole read-decide-
 * write cycle if another connection wrote the key first (Redis aborts the
 * transaction — `exec()` resolves `null` — rather than silently overwriting).
 * The alternative, a Lua script computing the transition server-side, would
 * be more strongly atomic but requires re-implementing `consumeRequest`'s
 * math in Lua, duplicating the one place business math is supposed to live
 * — rejected for architectural consistency; see
 * `docs/adr/0010-rate-limiter-test-infrastructure.md`.
 *
 * Clock: each app node's wall clock, not `TIME` from Redis — the domain
 * layer never reads a clock internally (callers supply `nowMs`), and minor
 * cross-replica clock skew is within stage-1 tolerances; avoids an extra
 * round trip per check.
 *
 * On retry exhaustion (`MAX_CAS_RETRIES`, pathological contention or a
 * flaky store) this throws rather than silently allowing or wrongly
 * denying — the caller's fault handler turns it into a 500, same as any
 * other unexpected backend fault.
 */
export class RedisRateLimiter implements RateLimiterPort {
  private readonly pool: ConnectionPool;

  constructor(
    redis: Redis,
    private readonly clock: () => number = Date.now,
    private readonly onCasConflict?: () => void,
    poolSize = 10,
  ) {
    this.pool = new ConnectionPool(redis, poolSize);
  }

  async check(userId: UserId, tier: Tier): Promise<Result<void, RateLimitError>> {
    const profile = TIER_PROFILES[tier].ceilings.rateLimit;
    const nowMs = this.clock();
    const key = KEY_PREFIX + userId;
    const conn = await this.pool.acquire();
    try {
      for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
        await conn.watch(key);
        const raw = await conn.get(key);
        const state: RateLimitState =
          raw != null ? (JSON.parse(raw) as RateLimitState) : initialRateLimitState(profile, nowMs);
        const decision = consumeRequest(state, profile, nowMs);

        const result = await conn
          .multi()
          .set(key, JSON.stringify(decision.state), 'EX', KEY_TTL_SECONDS)
          .exec();

        if (result !== null) {
          // Transaction committed — nobody wrote `key` between WATCH and
          // EXEC. Every branch of consumeRequest (including a refusal) must
          // persist, or refill bookkeeping never advances (domain doc
          // comment) — so the write always happens, only the returned
          // Result differs.
          return decision.allowed
            ? ok(undefined)
            : err({ code: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds });
        }
        // CAS conflict: another connection wrote `key` first. Retry the
        // whole read-decide-write cycle against the now-current value —
        // never just re-send the write, since the decision itself depends
        // on the value that changed under us.
        this.onCasConflict?.();
      }
      throw new Error('rate_limiter_cas_exhausted');
    } finally {
      this.pool.release(conn);
    }
  }

  /** Graceful shutdown (mirrors `pool.end()` for the Postgres pools in main.ts). */
  async close(): Promise<void> {
    await this.pool.quit();
  }
}
