export { migrate } from './migrate.js';
export { startEmbeddedPostgres } from './embedded-postgres.js';
export type { EmbeddedPostgres } from './embedded-postgres.js';
export { syncLoginRolePassword } from './sync-login-role-password.js';
export { withTenant, withProvisioner, withPublicReader } from './db.js';
export { poolConfigFromEnv } from './pool-config.js';
export { pingPool } from './health.js';
export { logPoolFaults } from './pool-fault-logging.js';
export { assertNonSuperuserRole } from './role-assertions.js';
export type { RoleQueryable } from './role-assertions.js';
export * from './repositories/pg-repositories.js';
export * from './repositories/pg-organization-repository.js';
export * from './repositories/pg-review-repository.js';
export * from './storage/fs-storage.js';
export * from './storage/s3-storage.js';
export * from './storage/storage-from-env.js';
export * from './storage/api-proxy-blob-url.js';
export * from './storage/cloudfront-signed-blob-url.js';
export * from './repositories/pg-api-key-repository.js';
export * from './repositories/pg-erasure-log-repository.js';
export * from './repositories/pg-invite-repository.js';
/**
 * The `organizations` row mapper, exported as a deliberate extension seam.
 *
 * `row-mappers.ts` is otherwise internal, and stays that way: this is one
 * named pair, not `export *`. Anyone building a repository against the same
 * schema outside this package — a self-hoster adding a table, or a downstream
 * deployment's own layer — has to turn an `organizations` row into the core
 * `Organization`, and the only alternatives are worse. Re-declaring the mapper
 * downstream means a hand-maintained copy that must track this one field for
 * field, and silently returns a wrong `Organization` the moment the two drift;
 * re-reading through `PgOrganizationRepository` costs a second round trip and
 * still doesn't help a statement with a `returning *`.
 *
 * Further mappers get exported the same way, one at a time, when something
 * actually needs them.
 */
export { toOrganization } from './repositories/row-mappers.js';
export type { OrganizationRow } from './repositories/row-mappers.js';
export * from './telemetry/otel-telemetry.js';
export * from './telemetry/setup.js';
export * from './telemetry/optional-setup.js';
export * from './rate-limit/redis-rate-limiter.js';
