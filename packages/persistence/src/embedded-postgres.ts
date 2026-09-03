import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const HOST = '127.0.0.1';

export interface EmbeddedPostgres {
  /**
   * A `postgres://` URL pointed at the local socket server, usable directly
   * by this codebase's existing `Pool`/`poolConfigFromEnv`/`migrate()`
   * machinery — the unmodified `pg` driver works against
   * `PGLiteSocketServer` with zero code changes.
   *
   * Connects as `postgres`/`postgres` — PGlite's default superuser identity,
   * not this codebase's `vorlyn_login` role (migration 0024). See the
   * module doc comment below for why that's a deliberate, safe difference
   * in trust model rather than a gap.
   */
  readonly connectionString: string;
  stop(): Promise<void>;
}

/**
 * Starts a real Postgres wire-protocol server backed by an embedded PGlite
 * instance, persisted to `<dataDir>/pgdata`. This is the local-database
 * engine for the self-host / `vorlyn open` composition root (not wired here —
 * that's a later task): the unmodified `pg` driver, and therefore this
 * codebase's entire persistence layer, works against it unchanged.
 *
 * ## RLS / role-switching trust model (read before touching this file)
 *
 * A real production deployment enforces CONSTITUTION §4 by connecting over the wire as
 * `vorlyn_login` — a dedicated NOSUPERUSER/NOBYPASSRLS login role (migration
 * 0024) — so that even a compromised `DATABASE_URL` cannot bypass RLS.
 * `assertNonSuperuserRole` is the runtime backstop checking exactly that.
 *
 * Against PGlite that literal posture cannot apply: PGlite's only login
 * identity is `postgres`, its built-in superuser — there is no separate
 * `vorlyn_login` role machinery reachable "over the wire" the way a real
 * Postgres server's `pg_hba.conf` would gate it. **This does not mean RLS
 * itself is bypassed.** Migrations 0001+0024 create `vorlyn_app` /
 * `vorlyn_provisioner` / `vorlyn_public_reader` as real roles regardless of
 * which engine runs the SQL, and Postgres's `SET ROLE` semantics mean a
 * superuser session that does `set local role vorlyn_app` genuinely drops to
 * that role's (non-superuser, non-bypassrls) privileges for the rest of the
 * transaction — RLS is enforced exactly as it is in production. This is the
 * same `withTenant()`/`withProvisioner()`/`withPublicReader()` code path
 * (`packages/persistence/src/db.ts`) unchanged; it was proven end-to-end
 * (read isolation, write isolation) by the spike's own harness and needs no
 * new code here.
 *
 * What genuinely differs is *who is allowed to reach that `SET ROLE` in the
 * first place*: in prod, only `vorlyn_login` (a non-superuser) can connect at
 * all, so `assertNonSuperuserRole` has something meaningful to check. Here,
 * the connecting identity is unconditionally `postgres`, a superuser —
 * `assertNonSuperuserRole` would (correctly) refuse to run against this
 * connection string, because there is no lesser role to demand. A self-host
 * composition root wiring PGlite must not call it. This is safe, not a
 * downgrade: there is no network-reachable credential to leak (the socket
 * server binds to `127.0.0.1` only) and exactly one local user ever holds
 * it, so the multi-tenant threat model this posture defends against (an
 * attacker with only `DATABASE_URL` trying to read another tenant's rows over
 * the open internet) doesn't exist in a single-user embedded deployment.
 *
 * ## Concurrent connections
 *
 * `PGLiteSocketServer` defaults to **`maxConnections: 1`** — its own README:
 * "PGlite is a single-connection database", and concurrency is provided by a
 * multiplexer the server only enables when you ask for it. Every connection
 * beyond the cap is dropped, which the `pg` driver surfaces as
 * `read ECONNRESET`.
 *
 * That default is why this must be set explicitly: `vorlyn open` runs TWO
 * processes (`@vorlyn/api` and `@vorlyn/mcp`'s `selfhost-embedded-main`s)
 * against one instance, so the second one to connect was refused outright —
 * its `/readyz` returned 503 forever and `vorlyn open` timed out on every
 * run. See `embedded-postgres.test.ts`'s two-client case, which pins it.
 *
 * Worth stating plainly, since the symptom invites the wrong fix: seeing this
 * `ECONNRESET` does NOT mean callers need `max: 1` pools. The cap is
 * server-side and global, not per-pool — a `max: 1` pool would only appear to
 * fix it in a single-process setup, where one pool of one connection happens
 * to fit under the cap, and is in fact hazardous in general, since any
 * request needing a second client concurrently (a transaction plus a query)
 * would deadlock.
 */

/**
 * Ceiling, not a target: connections are created lazily, so a real local
 * instance holds only a handful. Sized to exceed the worst case two embedded
 * children can reach at `poolConfigFromEnv()`'s default `max: 10` each, plus
 * slack — so this cap is never the binding constraint, while still keeping
 * the server's multiplexer within a range its README describes as supported.
 */
const EMBEDDED_MAX_CONNECTIONS = 24;

export async function startEmbeddedPostgres(dataDir: string, port = 0): Promise<EmbeddedPostgres> {
  const pgDataDir = path.join(dataDir, 'pgdata');
  const db = new PGlite(pgDataDir, { extensions: { pgcrypto } });
  const server = new PGLiteSocketServer({
    db,
    port,
    host: HOST,
    maxConnections: EMBEDDED_MAX_CONNECTIONS,
  });
  await server.start();

  // PGLiteSocketServer has no dedicated port getter — `port: 0` binds an
  // OS-assigned ephemeral port, and the only public API surfacing the real
  // bound port afterward is getServerConn(), which returns "host:port".
  // (Confirmed from the installed package's own dist/index.d.ts: `start():
  // Promise<void>`, `getServerConn(): string`, no `port` accessor.)
  const boundPort = Number(server.getServerConn().split(':').at(-1));
  const connectionString = `postgres://postgres:postgres@${HOST}:${String(boundPort)}/postgres`;

  let stopped = false;
  return {
    connectionString,
    async stop() {
      if (stopped) return;
      stopped = true;
      await server.stop();
      await db.close();
    },
  };
}
