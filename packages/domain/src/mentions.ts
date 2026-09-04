import type { UserId } from '@mdloop/shared';

/**
 * A person who can be @mentioned in a comment (ADR 0003 §D). The candidate set
 * is always DOC-SCOPED — doc owner + thread participants + requested reviewers
 * — never the org directory, so a guest can neither enumerate nor mention org
 * users they cannot already see on the document.
 */
export interface MentionCandidate {
  readonly id: UserId;
  readonly displayName: string;
}

/**
 * A mention @token is `@` followed by a run of letters/digits and the joining
 * punctuation that survives name-slugging (`_`, `.`, `-`) — no whitespace, so
 * a display name is matched by its slug, not by trailing prose. Unicode-aware
 * so non-ASCII names match. The `@` must open a token boundary (start of
 * string or a non-word char before it) so an email's `@` never reads as a
 * mention.
 */
const MENTION_RE = /(?<![\p{L}\p{N}_])@([\p{L}\p{N}_.-]+)/gu;

/** Slug used on both sides of the match: lower-cased, whitespace removed. So
 *  "@JaneDoe" and "@janedoe" both resolve to display name "Jane Doe". */
function slug(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

/**
 * Distinct @token slugs written in a comment body, in first-seen order. Pure
 * text parse — resolution to real users is the caller's job (matchMentions),
 * because who is mentionable depends on the document, not the text.
 */
export function parseMentionTokens(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    const token = slug(m[1] ?? '');
    if (token.length > 0 && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/**
 * Resolves the @tokens in `body` to the ids of doc-scoped candidates whose
 * display-name slug matches. Non-matching tokens are dropped silently (ADR
 * §D) — a typo'd name is not an error. A candidate is matched at most once
 * even if several tokens or several candidates collide on a slug; the returned
 * ids are distinct, in candidate order.
 */
export function matchMentions(body: string, candidates: readonly MentionCandidate[]): UserId[] {
  const tokens = new Set(parseMentionTokens(body));
  if (tokens.size === 0) return [];
  const out: UserId[] = [];
  const taken = new Set<UserId>();
  for (const candidate of candidates) {
    if (tokens.has(slug(candidate.displayName)) && !taken.has(candidate.id)) {
      taken.add(candidate.id);
      out.push(candidate.id);
    }
  }
  return out;
}
