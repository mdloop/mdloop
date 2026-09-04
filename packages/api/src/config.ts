import { z } from 'zod';

/** Runtime configuration; secrets arrive via env (never in git — CONSTITUTION.md §4). */
export interface ApiConfig {
  readonly baseUrl: string;
  readonly webAppUrl: string;
  readonly sessionSecret: string;
  /**
   * In-flight `SESSION_SECRET` rotation only (P0.7); normally unset. Session
   * tokens/CSRF pairs signed with this secret still verify — never used for
   * signing new tokens. Rotation: set this to the old
   * `SESSION_SECRET`, roll `SESSION_SECRET` to the new value, redeploy; drop
   * this var in a later deploy once old sessions have expired/refreshed.
   */
  readonly sessionSecretPrevious?: string;
  readonly secureCookies: boolean;
  /**
   * The single browser origin the SPA is served from (CSRF Origin allowlist,
   * Phase 24). A mutating request whose `Origin` header is present must match
   * this exactly; a request with no `Origin` is allowed (the double-submit
   * token still guards it).
   */
  readonly webOrigin: string;
  readonly workos?: {
    readonly apiKey: string;
    readonly clientId: string;
  };
  /** Home org allowed to publish to the Public Docs Hub (ADR 0004); unset disables publishing entirely. */
  readonly publicHubOrgId?: string;
  /**
   * ElastiCache/Valkey connection string for the shared-store rate limiter
   * (ADR 0010). Unset falls back to the in-process `UserRateLimiter` — the
   * safe single-node/dev default; a malformed value fails loud at boot via
   * the schema below rather than silently degrading.
   */
  readonly redisUrl?: string;
}

/** True for any string `new URL()` can parse with a `postgres(ql):` scheme — good enough to catch a typo without re-implementing libpq's connection-string grammar. */
function isPostgresConnectionString(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  } catch {
    return false;
  }
}

/** True for any string `new URL()` can parse with a `redis(s):` scheme — same fail-loud-at-boot shape as `isPostgresConnectionString`. */
function isRedisConnectionString(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'redis:' || url.protocol === 'rediss:';
  } catch {
    return false;
  }
}

/**
 * The "not configured yet" sentinel for `PUBLIC_HUB_ORG_ID` — some deployment
 * config stores (e.g. AWS SSM `String` parameters) reject an empty value
 * outright, so a deployment using one needs a non-empty placeholder rather
 * than unset; checked directly here since this var has no comparable shape
 * (like an email) to filter on instead.
 */
const UNCONFIGURED_SSM_SENTINEL = 'unset';

const WORKOS_VARS = ['WORKOS_API_KEY', 'WORKOS_CLIENT_ID'] as const;

/**
 * Every var the API entrypoint (main.ts) reads, directly or via
 * `poolConfigFromEnv`/persistence. `DB_POOL_*` are deliberately absent here —
 * `poolConfigFromEnv` (packages/persistence) validates those itself so every
 * caller gets the same fail-fast behavior without repeating the fields in
 * every entrypoint's schema.
 */
const envSchema = z
  .object({
    SESSION_SECRET: z.string().min(32, 'must be set (>= 32 chars)'),
    SESSION_SECRET_PREVIOUS: z.string().min(32, 'must be >= 32 chars if set').optional(),
    DATABASE_URL: z
      .string()
      .min(1, 'must be set')
      .refine(
        isPostgresConnectionString,
        'must be a postgres connection string, e.g. postgres://user:pass@host:5432/db',
      ),
    API_BASE_URL: z.url('must be a valid URL').optional(),
    WEB_APP_URL: z.url('must be a valid URL').optional(),
    WEB_ORIGIN: z.url('must be a valid URL').optional(),
    NODE_ENV: z.enum(['development', 'production', 'test']).optional(),
    PORT: z.coerce
      .number('must be a positive integer')
      .int('must be a positive integer')
      .positive('must be a positive integer')
      .optional(),
    BLOB_STORAGE_DIR: z.string().min(1, 'must not be empty if set').optional(),
    /** Set by a deployment to select `S3Storage` over `FsStorage` (see
     * `storageFromEnv`, packages/persistence).
     * Not read directly by config.ts/ApiConfig; `main.ts` reads it via
     * `process.env` in `storageFromEnv()`. Declared here only so a typo'd/blank
     * value fails loud at boot like every other var in this schema. */
    MDLOOP_BLOBS_BUCKET: z.string().min(1, 'must not be empty if set').optional(),
    DB_STATEMENT_TIMEOUT_MS: z.coerce
      .number('must be a positive integer')
      .int('must be a positive integer')
      .positive('must be a positive integer')
      .optional(),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url('must be a valid URL').optional(),
    OTEL_SDK_DISABLED: z
      .enum(['true', 'false'], 'must be exactly "true" or "false" if set')
      .optional(),
    PUBLIC_HUB_ORG_ID: z.string().min(1, 'must not be empty if set').optional(),
    REDIS_URL: z
      .string()
      .min(1, 'must be set if present')
      .refine(isRedisConnectionString, 'must be a redis connection string, e.g. redis://host:6379')
      .optional(),
    WORKOS_API_KEY: z.string().min(1).optional(),
    WORKOS_CLIENT_ID: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    // WorkOS is an all-or-nothing group (ADR-free convention predating this
    // file): a deploy either has the provider fully configured or not
    // configured at all — a half-set group is always a typo/missing-secret,
    // never intentional.
    const workosSetCount = WORKOS_VARS.filter((key) => v[key] !== undefined).length;
    if (workosSetCount !== 0 && workosSetCount !== WORKOS_VARS.length) {
      for (const key of WORKOS_VARS) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${WORKOS_VARS.join(' and ')} must both be set or both unset`,
        });
      }
    }
  });

/** One line per failing field — this is what a real deploy sees in its boot logs, so name every offender instead of a generic "invalid config". */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Every optional field below is `.optional()`, which only accepts a truly
 * absent key — but `KEY=` (blank, no value) in a `.env` file loaded via
 * Node's `--env-file` sets `process.env.KEY` to `''`, not absent (same gap
 * fixed in packages/mcp/src/env-config.ts, found the same session). Blank
 * is unambiguously "not configured," same intent as omitting the key
 * entirely — treated as such before validation.
 */
function withBlankAsUnset(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const result = envSchema.safeParse(withBlankAsUnset(env));
  if (!result.success) {
    throw new Error(`Invalid environment configuration — ${formatIssues(result.error)}`);
  }
  const parsed = result.data;

  const workos =
    parsed.WORKOS_API_KEY && parsed.WORKOS_CLIENT_ID
      ? { apiKey: parsed.WORKOS_API_KEY, clientId: parsed.WORKOS_CLIENT_ID }
      : undefined;

  return {
    baseUrl: parsed.API_BASE_URL ?? 'http://localhost:3000',
    webAppUrl: parsed.WEB_APP_URL ?? 'http://localhost:5173',
    sessionSecret: parsed.SESSION_SECRET,
    secureCookies: parsed.NODE_ENV === 'production',
    webOrigin: parsed.WEB_ORIGIN ?? 'http://localhost:5173',
    ...(parsed.SESSION_SECRET_PREVIOUS
      ? { sessionSecretPrevious: parsed.SESSION_SECRET_PREVIOUS }
      : {}),
    ...(workos ? { workos } : {}),
    ...(parsed.PUBLIC_HUB_ORG_ID && parsed.PUBLIC_HUB_ORG_ID !== UNCONFIGURED_SSM_SENTINEL
      ? { publicHubOrgId: parsed.PUBLIC_HUB_ORG_ID }
      : {}),
    ...(parsed.REDIS_URL ? { redisUrl: parsed.REDIS_URL } : {}),
  };
}
