export { buildServer } from './server.js';
export type { ServerDeps } from './server.js';
// The extension seam is public API: a deployment composing its own routes onto
// the core server needs these types (see server-extension.ts).
export type { ExtensionContext, ServerExtension } from './server-extension.js';
export type { ApiConfig } from './config.js';
/**
 * The two request helpers an extension's own routes actually need.
 *
 * `registerAuthenticated` hands an extension a scope where the session guard
 * has already run and `req.actor` is populated — but reading that actor, and
 * gating a route on org-admin, are the first two things any real route does.
 * Without these an extension either re-derives the actor shape by hand or
 * re-implements the admin check, and a re-implemented authorization check is
 * strictly worse than a shared one.
 *
 * Deliberately these two only: the rest of `auth/guards.ts` is placement the
 * core already owns (origin allowlist, CSRF, guest allowlist, rate budget),
 * applied by `buildServer` before an extension's handler is ever reached.
 */
export { requireAdmin } from './auth/guards.js';
export { actorOf } from './auth/actor.js';

/**
 * Adapter choices a composition root makes. A deployment assembling its own
 * ServerDeps — rather than using one of the bundled entrypoints — picks these
 * the same way the bundled ones do, so they are part of the seam, not
 * internals.
 */
export { configFromEnv } from './config.js';
export { WorkosAuthAdapter } from './auth/workos.adapter.js';
export { LoggingEmailAdapter } from './email/logging-email.adapter.js';
