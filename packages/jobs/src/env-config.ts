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

const positiveIntField = () =>
  z.coerce
    .number('must be a positive integer')
    .int('must be a positive integer')
    .positive('must be a positive integer')
    .optional();

/**
 * Every var the compliance-scheduler entrypoint (main.ts) reads directly or
 * via `poolConfigFromEnv`/`setupTelemetry`. `DB_POOL_*` are deliberately
 * absent: `poolConfigFromEnv` (packages/persistence) validates those itself.
 * `JOB_INTERVAL_MS` replaces the local `positiveIntEnv` helper this file used
 * to have — same duplicate-parser cleanup as `pool-config.ts`/`db.ts`.
 */
const jobsEnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'must be set')
    .refine(
      isPostgresConnectionString,
      'must be a postgres connection string, e.g. postgres://user:pass@host:5432/db',
    ),
  BLOB_STORAGE_DIR: z.string().min(1, 'must not be empty if set').optional(),
  /** Selects `S3Storage` over `FsStorage` in `storageFromEnv`
   * (packages/persistence) — validated here only so a typo'd/blank value
   * fails loud at boot, same as `BLOB_STORAGE_DIR` above. */
  MDLOOP_BLOBS_BUCKET: z.string().min(1, 'must not be empty if set').optional(),
  JOB_INTERVAL_MS: positiveIntField(),
  DB_STATEMENT_TIMEOUT_MS: positiveIntField(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url('must be a valid URL').optional(),
  OTEL_SDK_DISABLED: z
    .enum(['true', 'false'], 'must be exactly "true" or "false" if set')
    .optional(),
});

export interface JobsEnv {
  readonly DATABASE_URL: string;
  readonly BLOB_STORAGE_DIR?: string | undefined;
  readonly MDLOOP_BLOBS_BUCKET?: string | undefined;
  readonly JOB_INTERVAL_MS?: number | undefined;
  readonly DB_STATEMENT_TIMEOUT_MS?: number | undefined;
  readonly OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined;
  readonly OTEL_SDK_DISABLED?: 'true' | 'false' | undefined;
}

/** One line per failing field — this is what a real deploy sees in its boot logs, so name every offender instead of a generic "invalid config". */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

export function jobsEnvFromEnv(env: NodeJS.ProcessEnv = process.env): JobsEnv {
  const result = jobsEnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid jobs environment configuration — ${formatIssues(result.error)}`);
  }
  return result.data;
}
