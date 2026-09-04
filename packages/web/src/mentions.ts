/**
 * Web-side @mention parsing (ADR 0003 §D). `web` cannot import `@mdloop/domain`
 * (.dependency-cruiser `web-frontend-only`), so this is a deliberate mirror of
 * `packages/domain/src/mentions.ts` — the same token grammar and the same slug
 * rule, kept in lockstep. This module only powers the composer picker and the
 * quiet in-rail highlight; the server re-resolves mentions authoritatively on
 * store, so a drift here can never mis-store a mention, only mis-hint one.
 */

/** `@` opening a token boundary, then a run of name characters — the same
 *  grammar as the domain regex so what highlights is exactly what stores. */
const MENTION_RE = /(?<![\p{L}\p{N}_])@([\p{L}\p{N}_.-]+)/gu;

/** Lower-cased, whitespace-stripped: "Jane Doe" and "@janedoe" both → "janedoe".
 *  A picked candidate must be inserted whitespace-free to survive this. */
export function mentionSlug(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

export interface MentionOption {
  readonly userId: string;
  readonly displayName: string;
}

/**
 * The @token being typed immediately before `caret`, or null when the caret is
 * not inside one. Returns the partial (may be empty, right after "@") and the
 * index of the "@" so a pick can splice the display name in over it.
 */
export function activeMentionQuery(
  body: string,
  caret: number,
): { start: number; query: string } | null {
  const upto = body.slice(0, caret);
  const m = /(?:^|[^\p{L}\p{N}_])@([\p{L}\p{N}_.-]*)$/u.exec(upto);
  if (!m) return null;
  const query = m[1] ?? '';
  return { start: caret - query.length - 1, query };
}

/** Candidates whose display-name slug contains the typed partial, capped for a
 *  tidy dropdown. An empty partial (just "@") offers everyone on the document. */
export function filterMentionCandidates(
  candidates: readonly MentionOption[],
  query: string,
): MentionOption[] {
  const q = mentionSlug(query);
  return candidates.filter((c) => mentionSlug(c.displayName).includes(q)).slice(0, 6);
}

/** The token text to splice in when a candidate is picked: "@" + the display
 *  name with whitespace removed, so it slugs back to the candidate (a spaced
 *  "@Jane Doe" would parse as just "@Jane" and never resolve). */
export function mentionInsertText(displayName: string): string {
  return `@${displayName.replace(/\s+/g, '')}`;
}

export interface BodySegment {
  readonly text: string;
  /** True when this run is an @token that resolved to a stored mention. */
  readonly mention: boolean;
}

/**
 * Splits a comment body into runs, marking the @tokens that correspond to a
 * stored mention (`mentionedSlugs`). Only real, stored mentions are marked —
 * an @word that resolved to nobody stays plain text, so the highlight never
 * lies about who was actually notified-of-record.
 */
export function segmentMentions(body: string, mentionedSlugs: ReadonlySet<string>): BodySegment[] {
  const out: BodySegment[] = [];
  let last = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    const idx = m.index;
    const token = m[0];
    if (!mentionedSlugs.has(mentionSlug(m[1] ?? ''))) continue;
    if (idx > last) out.push({ text: body.slice(last, idx), mention: false });
    out.push({ text: token, mention: true });
    last = idx + token.length;
  }
  if (last < body.length) out.push({ text: body.slice(last), mention: false });
  return out;
}

/**
 * {@link segmentMentions} that cannot throw — what `CommentBody` renders with.
 *
 * Segmenting runs a unicode regex and index arithmetic over a comment body
 * written by anyone (including an agent) against a slug set built from display
 * names, i.e. over two pieces of arbitrary-shaped input, inside a render. A
 * throw there would take out the comment rail — every thread, not just the one
 * bad body. The highlight is decoration; the words are the point, so an
 * unsegmented body is the honest degradation. It under-marks (no mention gets
 * a highlight) and never over-marks, so it cannot imply someone was mentioned
 * who wasn't.
 */
export function segmentMentionsSafe(
  body: string,
  mentionedSlugs: ReadonlySet<string>,
): BodySegment[] {
  try {
    return segmentMentions(body, mentionedSlugs);
  } catch {
    return [{ text: body, mention: false }];
  }
}
