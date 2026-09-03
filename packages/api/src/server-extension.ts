import type { FastifyInstance } from 'fastify';
import type {
  CommentRepository,
  DocumentRepository,
  ErasureLogPort,
  EmailPort,
  OrganizationRepository,
  OrgInviteRepository,
  OrgLifecyclePort,
  RoleDirectory,
  StoragePort,
  TelemetryPort,
  VersionRepository,
} from '@vorlyn/app';
import type { ApiConfig } from './config.js';

/**
 * What an extension may reach from the host server.
 *
 * Deliberately an enumerated subset of `ServerDeps` rather than `ServerDeps`
 * itself: adding a dependency the core happens to need must not silently widen
 * a public contract that deployments build against. Growing this interface is
 * a considered change, not a side effect.
 */
export interface ExtensionContext {
  readonly config: ApiConfig;
  readonly telemetry: TelemetryPort;
  readonly organizations: OrganizationRepository & RoleDirectory;
  readonly orgLifecycle: OrgLifecyclePort;
  readonly documents: DocumentRepository;
  readonly versions: VersionRepository;
  readonly comments: CommentRepository;
  readonly invites: OrgInviteRepository;
  readonly erasures: ErasureLogPort;
  readonly storage: StoragePort;
  readonly email: EmailPort;
}

/**
 * A bundle of routes a deployment mounts alongside the core ones.
 *
 * This exists because a deployment routinely needs surfaces the core has no
 * opinion about — an internal metrics endpoint, an org-provisioning API driven
 * by the operator's own IdP, a payment provider's webhook receiver, an internal
 * support console, a company-specific integration. Without a seam, the only
 * ways to add them are to fork the core or to mutate the Fastify instance after
 * `buildServer` returns; both are worse than saying plainly where extra routes
 * may attach and under which guards.
 *
 * The three positions are the three that actually differ in what has already
 * run by the time a request reaches the handler. The core keeps ownership of
 * that placement, so an extension cannot accidentally register outside the
 * session guard when it meant to be inside it, or inside when it meant to be
 * outside:
 *
 * - `registerPublic` — inside `/api`, no session. A sibling of `/api/auth/*`.
 *   For anything authenticated by something other than a customer session:
 *   provider webhooks (signature-verified), alternate login flows.
 * - `registerAuthenticated` — inside the customer session scope, so the Origin
 *   allowlist, session guard, CSRF, guest allowlist and per-user rate budget
 *   have all already run and `req.actor` is populated. For ordinary product
 *   routes a deployment adds for its own users.
 * - `registerIsolated` — its own encapsulated scope under `/api` with none of
 *   the core guards attached. For a surface that authenticates itself end to
 *   end against a different identity (staff/operator tooling, machine
 *   integrations). Fastify's encapsulation means hooks added here cannot leak
 *   back onto core routes.
 *
 * Each extension's `registerIsolated` gets a scope of its own, so two
 * extensions cannot see each other's hooks either.
 */
export interface ServerExtension {
  /** Identifies the extension in errors and logs. */
  readonly name: string;
  readonly registerPublic?: (scope: FastifyInstance, ctx: ExtensionContext) => void | Promise<void>;
  readonly registerAuthenticated?: (
    scope: FastifyInstance,
    ctx: ExtensionContext,
  ) => void | Promise<void>;
  readonly registerIsolated?: (
    scope: FastifyInstance,
    ctx: ExtensionContext,
  ) => void | Promise<void>;
}
