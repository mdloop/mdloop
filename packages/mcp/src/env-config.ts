import { z } from 'zod';

/** True for any string `new URL()` can parse with a `postgres(ql):` scheme — good enough to catch a typo without re-implementing libpq's connection-string grammar. */
function isPostgresConnectionString(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  } catch {
    return false;
  }
}

const databaseUrlField = z
  .string()
  .min(1, 'must be set')
  .refine(
    isPostgresConnectionString,
    'must be a postgres connection string, e.g. postgres://user:pass@host:5432/db',
  );

/** True for any string `new URL()` can parse with a `redis(s):` scheme. */
function isRedisConnectionString(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'redis:' || url.protocol === 'rediss:';
  } catch {
    return false;
  }
}

/**
 * Redis/Valkey connection string for the shared-store rate limiter
 * (ADR 0010). Unset falls back to the in-process `UserRateLimiter`.
 */
const redisUrlField = z
  .string()
  .min(1, 'must be set if present')
  .refine(isRedisConnectionString, 'must be a redis connection string, e.g. redis://host:6379')
  .optional();

const positiveIntField = () =>
  z.coerce
    .number('must be a positive integer')
    .int('must be a positive integer')
    .positive('must be a positive integer')
    .optional();

/** One line per failing field — this is what a real deploy sees in its boot logs, so name every offender instead of a generic "invalid config". */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Every optional field below is `.optional()`, which only accepts a truly
 * absent key — but `KEY=` (blank, no value) in a `.env` file loaded via
 * Node's `--env-file` sets `process.env.KEY` to `''`, not absent. Without
 * this, a blank optional line in `.env` fails the same as a garbage value
 * (found the hard way: `make dev`'s Makefile fix to actually load `.env`
 * turned every blank `KEY=` template line in `.env.example` into a boot
 * crash). Blank is unambiguously "not configured," same intent as omitting
 * the key entirely — treated as such before validation, not silently
 * accepted as a valid empty value for any field.
 */
function withBlankAsUnset(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
}

/**
 * MCP OAuth (ADR 0013): WorkOS AuthKit is the whole authorization server —
 * this schema only ever validates the protected-resource side. All four
 * vars are optional as a group: unset means MCP OAuth is simply off and only
 * the API-key path works, same degrade-gracefully convention as unset
 * `REDIS_URL` above. `WORKOS_JWKS_URL` alone stays independently optional
 * even once the group is "on" — it has a computed default
 * (`${WORKOS_AUTHKIT_ISSUER}/oauth2/jwks`) applied in `mcpHttpEnvFromEnv`
 * below, so it is excluded from the "required together" set even though
 * setting it counts toward the group being configured at all.
 *
 * That default is NOT `https://api.workos.com/sso/jwks/${WORKOS_CLIENT_ID}`
 * (the WorkOS SDK's `getJwksUrl(clientId)` helper, ADR 0013's "Alternatives
 * considered") even though that was this file's original assumption — that
 * endpoint verifies AuthKit *session* tokens (regular hosted login).
 * AuthKit-for-MCP issues OAuth/Connect access tokens instead, verified
 * against a JWKS scoped to the AuthKit domain itself
 * (`https://<authkit_domain>/oauth2/jwks`, confirmed against WorkOS's own
 * MCP docs) — a different endpoint on a different host, found while setting
 * up local MCP OAuth testing (2026-08-11).
 */
const WORKOS_MCP_OAUTH_REQUIRED_VARS = [
  'WORKOS_CLIENT_ID',
  'WORKOS_AUTHKIT_ISSUER',
  'MCP_RESOURCE_INDICATOR',
] as const;
const WORKOS_MCP_OAUTH_ALL_VARS = [...WORKOS_MCP_OAUTH_REQUIRED_VARS, 'WORKOS_JWKS_URL'] as const;

/**
 * Streamable-HTTP MCP entrypoint (main.ts) — every var it reads directly or
 * via `poolConfigFromEnv`/`setupTelemetry`. `DB_POOL_*` are deliberately
 * absent: `poolConfigFromEnv` (packages/persistence) validates those itself.
 */
const mcpHttpEnvSchema = z
  .object({
    DATABASE_URL: databaseUrlField,
    MCP_PORT: positiveIntField(),
    BLOB_STORAGE_DIR: z.string().min(1, 'must not be empty if set').optional(),
    /** Selects `S3Storage` over `FsStorage` in `storageFromEnv`
     * (packages/persistence) — validated here only so a typo'd/blank value
     * fails loud at boot, same as `BLOB_STORAGE_DIR` above. */
    MDLOOP_BLOBS_BUCKET: z.string().min(1, 'must not be empty if set').optional(),
    DB_STATEMENT_TIMEOUT_MS: positiveIntField(),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url('must be a valid URL').optional(),
    OTEL_SDK_DISABLED: z
      .enum(['true', 'false'], 'must be exactly "true" or "false" if set')
      .optional(),
    REDIS_URL: redisUrlField,
    // Not secret — WorkOS client ids are public (they appear in browser-side
    // OAuth redirects too).
    WORKOS_CLIENT_ID: z.string().min(1, 'must be set if present').optional(),
    WORKOS_AUTHKIT_ISSUER: z.url('must be a valid URL').optional(),
    WORKOS_JWKS_URL: z.url('must be a valid URL').optional(),
    MCP_RESOURCE_INDICATOR: z.url('must be a valid URL').optional(),
    /** Same value as `packages/api/src/config.ts`'s `webAppUrl` — this is a
     * separate process, so it can't read that config directly. Unset means
     * `upload_document`/`request_review` simply omit the `url` field rather
     * than guess a wrong one. */
    WEB_APP_URL: z.url('must be a valid URL').optional(),
  })
  .superRefine((v, ctx) => {
    // Mirrors packages/api/src/config.ts:117-131's all-or-nothing
    // WORKOS_API_KEY/WORKOS_CLIENT_ID pattern, new to mcp's env-config but a
    // direct copy of the shape: a half-set group is always a typo/missing
    // var, never intentional.
    const anyConfigured = WORKOS_MCP_OAUTH_ALL_VARS.some((key) => v[key] !== undefined);
    const requiredSetCount = WORKOS_MCP_OAUTH_REQUIRED_VARS.filter(
      (key) => v[key] !== undefined,
    ).length;
    if (anyConfigured && requiredSetCount !== WORKOS_MCP_OAUTH_REQUIRED_VARS.length) {
      for (const key of WORKOS_MCP_OAUTH_ALL_VARS) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${WORKOS_MCP_OAUTH_REQUIRED_VARS.join(', ')} must all be set together to enable MCP OAuth (WORKOS_JWKS_URL is optional even then — it defaults from WORKOS_AUTHKIT_ISSUER)`,
        });
      }
    }
  });

export interface McpHttpEnv {
  readonly DATABASE_URL: string;
  readonly MCP_PORT?: number | undefined;
  readonly BLOB_STORAGE_DIR?: string | undefined;
  readonly MDLOOP_BLOBS_BUCKET?: string | undefined;
  readonly DB_STATEMENT_TIMEOUT_MS?: number | undefined;
  readonly OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined;
  readonly OTEL_SDK_DISABLED?: 'true' | 'false' | undefined;
  readonly REDIS_URL?: string | undefined;
  readonly WORKOS_CLIENT_ID?: string | undefined;
  readonly WORKOS_AUTHKIT_ISSUER?: string | undefined;
  /** Always present once WORKOS_AUTHKIT_ISSUER is set — explicit value or the
   * computed `${WORKOS_AUTHKIT_ISSUER}/oauth2/jwks` default. */
  readonly WORKOS_JWKS_URL?: string | undefined;
  readonly MCP_RESOURCE_INDICATOR?: string | undefined;
  readonly WEB_APP_URL?: string | undefined;
}

export function mcpHttpEnvFromEnv(env: NodeJS.ProcessEnv = process.env): McpHttpEnv {
  const result = mcpHttpEnvSchema.safeParse(withBlankAsUnset(env));
  if (!result.success) {
    throw new Error(`Invalid mcp environment configuration — ${formatIssues(result.error)}`);
  }
  const parsed = result.data;
  const jwksUrl =
    parsed.WORKOS_JWKS_URL ??
    (parsed.WORKOS_AUTHKIT_ISSUER ? `${parsed.WORKOS_AUTHKIT_ISSUER}/oauth2/jwks` : undefined);
  return {
    ...parsed,
    ...(jwksUrl !== undefined ? { WORKOS_JWKS_URL: jwksUrl } : {}),
  };
}

/**
 * Stdio MCP entrypoint (stdio-main.ts) — a local-agent process, one var
 * short of the HTTP entrypoint's set (no MCP_PORT, no OTEL — it skips
 * `setupTelemetry()` entirely since stdout is reserved for JSON-RPC) plus
 * one var the HTTP entrypoint doesn't need (`MDLOOP_API_KEY`, since a stdio
 * process serves exactly one identity for its whole lifetime).
 */
const mcpStdioEnvSchema = z.object({
  MDLOOP_API_KEY: z.string().min(1, 'must be set'),
  DATABASE_URL: databaseUrlField,
  BLOB_STORAGE_DIR: z.string().min(1, 'must not be empty if set').optional(),
  DB_STATEMENT_TIMEOUT_MS: positiveIntField(),
  /** See the HTTP schema's field of the same name above. */
  WEB_APP_URL: z.url('must be a valid URL').optional(),
});

export interface McpStdioEnv {
  readonly MDLOOP_API_KEY: string;
  readonly DATABASE_URL: string;
  readonly BLOB_STORAGE_DIR?: string | undefined;
  readonly DB_STATEMENT_TIMEOUT_MS?: number | undefined;
  readonly WEB_APP_URL?: string | undefined;
}

export function mcpStdioEnvFromEnv(env: NodeJS.ProcessEnv = process.env): McpStdioEnv {
  const result = mcpStdioEnvSchema.safeParse(withBlankAsUnset(env));
  if (!result.success) {
    throw new Error(`Invalid mcp environment configuration — ${formatIssues(result.error)}`);
  }
  return result.data;
}
