/**
 * Suggested edits (Phase C, ADR 0002). A suggestion is a comment SUBTYPE — a
 * comment that additionally carries proposed replacement text for its anchored
 * range. Accepting one re-anchors against the current version (the same
 * confidence-floored pipeline `resolveTextAnchor` uses for display), splices
 * the replacement over the located range, and uploads a new version through
 * the existing owner/admin-gated path. This module holds only the pure pieces:
 * the two enums and the splice. Everything honesty- and permission-shaped
 * lives in the app layer (accept/reject use-cases), reusing existing gates.
 */

/** Discriminates a plain comment from a suggestion. */
export type CommentKind = 'comment' | 'suggestion';

/**
 * A suggestion's lifecycle. `open` until an owner/admin resolves it; `accepted`
 * mints a new version (and sets `appliedVersionId`); `rejected` is terminal.
 * Null on a plain comment.
 */
export type SuggestionOutcome = 'open' | 'accepted' | 'rejected';

/**
 * Longest a suggestion's proposed replacement text may be, in characters.
 * Mirrors the DB check. The per-document comment tier cap already bounds how
 * many suggestions can exist; this bounds how large each one's payload is, so
 * neither a flood nor a single giant paste can bloat the comments table.
 */
export const MAX_PROPOSED_TEXT_LENGTH = 20_000;

/**
 * Splices `replacement` over the half-open range [start, end) of `source`.
 * Pure and offset-based — the caller (acceptSuggestion) supplies the range the
 * re-anchoring pipeline located in the CURRENT version, never the offsets the
 * anchor was originally captured against. An empty `replacement` deletes the
 * range; an empty range (start === end) is a pure insertion.
 */
export function spliceText(
  source: string,
  start: number,
  end: number,
  replacement: string,
): string {
  return source.slice(0, start) + replacement + source.slice(end);
}
