/**
 * The narrow, published-facing subpath `packages/cli/src/local-instance.ts`
 * imports instead of the full `@mdloop/persistence` barrel.
 *
 * Re-exports directly from `migrate.ts`/`embedded-postgres.ts` — never
 * `export * from './index.js'` — so this module's own reachable graph never
 * touches the barrel's other ~40 exports (repositories, S3/CloudFront
 * storage, OTel telemetry, the Redis rate limiter). The CLI's bundled
 * `dist/cli/main.js` (esbuild inlines every `@mdloop/*` module it reaches)
 * therefore only ever pulls in what `mdloop open`/`mdloop serve` actually
 * need to run an embedded Postgres — `pg`, `@electric-sql/pglite`,
 * `@electric-sql/pglite-socket` — never `@aws-sdk/client-s3`,
 * `@workos-inc/node`, `ioredis`, or the OpenTelemetry SDK packages, all of
 * which are `optionalDependencies` (or entirely absent) in the published
 * `mdloop` package.
 *
 * This is a belt-and-suspenders guarantee, not a substitute for
 * `s3-storage.ts`'s and `telemetry/optional-setup.ts`'s own lazy-import
 * fixes — those two make the *barrel itself* safe to statically import from
 * anywhere. This subpath additionally keeps the CLI's own reachable graph
 * small and explicit, rather than depending on esbuild's tree-shaking to
 * prune ~40 barrel exports the CLI never uses.
 */
export { migrate } from './migrate.js';
export { startEmbeddedPostgres } from './embedded-postgres.js';
export type { EmbeddedPostgres } from './embedded-postgres.js';
