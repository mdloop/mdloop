import type { Result } from '@vorlyn/shared';
import { err, ok } from '@vorlyn/shared';

/**
 * Ingest-time file policy (CONSTITUTION.md §4). Enforced in the domain layer.
 *
 * 500KB, dropped from 2MB by ADR 0011: ~100 pages of markdown is roughly
 * 300KB, so this clears the stated worst case with headroom while cutting the
 * blast radius of a hostile or accidental oversized upload 4x. Ingest-only —
 * version rows are immutable, so anything already stored above it stays
 * (ADR 0001). Size is one half of the ingest gate; content policy is the
 * other (`validateMarkdownContent`, `markdown-content.ts`).
 *
 * Upload *velocity* (how many uploads per week/month) used to be a separate
 * count-based quota here, checked against `upload_ledger` rows. Retired in
 * the rate-limiting redesign (2026-08-11): that job is now
 * covered by the general per-user request budget (`RateLimitProfile`'s
 * minute/day/month windows, tier.ts) plus the standing per-org/per-doc stock
 * ceilings (`maxActiveDocs`, `maxLiveVersionsPerDoc`), which cap the actual
 * outcome rather than a velocity proxy. `upload_ledger` itself is unaffected
 * — still written per upload as an audit trail, just no longer read to gate
 * anything.
 */
export const MAX_UPLOAD_BYTES = 500 * 1024;

export type QuotaError =
  | { readonly code: 'file_too_large'; readonly maxBytes: number; readonly actualBytes: number }
  | { readonly code: 'empty_file' };

/** Decides whether an upload of `byteSize` is allowed, on size alone. */
export function checkUploadAllowed(byteSize: number): Result<void, QuotaError> {
  if (byteSize <= 0) return err({ code: 'empty_file' });
  if (byteSize > MAX_UPLOAD_BYTES) {
    return err({ code: 'file_too_large', maxBytes: MAX_UPLOAD_BYTES, actualBytes: byteSize });
  }
  return ok(undefined);
}
