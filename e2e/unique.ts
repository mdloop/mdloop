/**
 * Per-execution-unique fixture names/emails/slugs.
 *
 * `playwright.config.ts` runs `desktop` (everything) plus `phone`/`tablet`
 * (a named subset, RESPONSIVE_SPECS) at `workers: 1, fullyParallel: false`,
 * against ONE Postgres-backed e2e server and ONE shared org for the whole
 * run — so a spec in that subset can execute up to three times in a single
 * `pnpm test:e2e` run against state a previous execution already left
 * behind. Any hardcoded identifier a spec *creates* (invite email, project
 * name, public-hub slug, ...) needs a fresh value per execution, or the
 * second/third pass collides with the first — either a server-side unique-
 * constraint conflict (e.g. one live invite per email per org) or a client-
 * side ambiguous-selector match against a leftover row from the earlier
 * pass. Prefer this over cleanup: a value that's never reused can't collide,
 * whether or not an earlier execution's own cleanup ran to completion.
 */
export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** e.g. uniqueName('Ops') -> 'Ops-m0y1z2-ab12cd' */
export function uniqueName(prefix: string): string {
  return `${prefix}-${uniqueSuffix()}`;
}

/** e.g. uniqueEmail('friend') -> 'friend+m0y1z2-ab12cd@example.com' (a valid,
 *  distinct address — this codebase's own isValidEmail accepts +-tags). */
export function uniqueEmail(local: string): string {
  return `${local}+${uniqueSuffix()}@example.com`;
}

/** e.g. uniqueSlug('e2e-public-hub-doc') -> 'e2e-public-hub-doc-m0y1z2-ab12cd' */
export function uniqueSlug(prefix: string): string {
  return `${prefix}-${uniqueSuffix()}`;
}
