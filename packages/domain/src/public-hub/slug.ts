const MAX_SLUG_LENGTH = 80;

/**
 * Normalizes a candidate Public Docs Hub slug (ADR 0004): lower-cased, runs of
 * anything that isn't a letter/digit collapsed to a single `-`, leading and
 * trailing `-` stripped, capped at 80 chars. Pure text transform, zero I/O —
 * `null` means "no usable slug came out of this input" (empty, or entirely
 * punctuation/whitespace/non-alphanumeric), which the caller treats as a
 * validation error rather than persisting a meaningless slug.
 */
export function normalizePublicSlug(input: string): string | null {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');

  return normalized.length > 0 ? normalized : null;
}
