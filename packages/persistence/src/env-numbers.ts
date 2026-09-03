import { z } from 'zod';

const positiveIntSchema = z.coerce.number().int().positive();

/**
 * Parses a positive-integer env var shared by `pool-config.ts` and `db.ts`
 * (previously two near-identical `positiveInt` helpers, plus a third copy in
 * `jobs/main.ts`, unified here). Absence (unset or empty
 * string) is a deliberate, documented fallback to `fallback` — that's not a
 * failure. A *present* value that isn't a positive integer (non-numeric,
 * zero, negative, `NaN`) throws instead of silently reverting to the
 * default — a typo'd override should never be indistinguishable from "not
 * set".
 */
export function positiveIntFromEnv(
  raw: string | undefined,
  fallback: number,
  varName: string,
): number {
  if (raw === undefined || raw === '') return fallback;
  const result = positiveIntSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`${varName} must be a positive integer if set (got ${JSON.stringify(raw)})`);
  }
  return result.data;
}
