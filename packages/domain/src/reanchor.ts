import DiffMatchPatch from 'diff-match-patch';
import {
  ANCHOR_CONTEXT_CHARS,
  REANCHOR_CONFIDENCE_FLOOR,
  REANCHOR_CONTEXT_SANITY_FLOOR,
} from './anchor.js';
import type { TextAnchor } from './anchor.js';

/**
 * Text re-anchoring across document versions (Core Principle 2, spike 01).
 * Pipeline: exact quote → context disambiguation → diff offset mapping with
 * similarity check → fuzzy quote search → honest orphan. Never guesses:
 * anything below REANCHOR_CONFIDENCE_FLOOR is an orphan.
 *
 * Stage 1's unique-hit path and stage 4's bitap match are additionally gated
 * by a low context "sanity floor" (spike 10 addendum) before either is
 * allowed to trust text similarity alone: a match whose surrounding text is
 * nowhere near the anchor's captured prefix/suffix is almost certainly a
 * coincidental decoy elsewhere in the document, not the real (possibly
 * reworded) location. See `contextPlausible` below.
 */

export type ReanchorMethod = 'exact' | 'context' | 'fuzzy' | 'orphan';

export type ReanchorResult =
  | { method: Exclude<ReanchorMethod, 'orphan'>; start: number; end: number; confidence: number }
  | { method: 'orphan'; confidence: number };

/** Bitap pattern limit in diff-match-patch. */
const MATCH_PATTERN_LIMIT = 32;

/**
 * Per-leg byte ceiling for a re-anchor diff (Phase 24.F). Mirrors doc-diff.ts's
 * `DIFF_MAX_BYTES` — the same 2 MB × 2 MB `diff_main` blow-up the rendered leg
 * diff already caps — but kept as its own constant here: doc-diff imports
 * `similarity` from this module, so importing back the other way would cycle.
 * A pair over this cap degrades to an honest orphan at the call site
 * (reanchor-threads), never a guessed anchor (Core Principle 2).
 */
export const REANCHOR_MAX_DIFF_BYTES = 200_000;

const dmp = new DiffMatchPatch();
// Hard wall-clock bound on every diff_main call (Phase 24.F): the library
// default is 1.0s, long enough to stall the single Node event loop on a
// pathological pair even under the byte cap. 0.5s caps the worst case; a
// timed-out diff is still a valid (if less optimal) alignment, and the
// similarity floor below rejects anything it can't verify.
dmp.Diff_Timeout = 0.5;

/** Builds a TextAnchor for a selection in `source` (capture-side helper). */
export function createTextAnchor(source: string, start: number, end: number): TextAnchor {
  return {
    type: 'text',
    exact: source.slice(start, end),
    prefix: source.slice(Math.max(0, start - ANCHOR_CONTEXT_CHARS), start),
    suffix: source.slice(end, end + ANCHOR_CONTEXT_CHARS),
    start,
    end,
  };
}

/** Dice-style similarity in [0,1] from a semantic diff of the two strings. */
export function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const diffs = dmp.diff_main(a, b);
  dmp.diff_cleanupSemantic(diffs);
  let same = 0;
  for (const [op, text] of diffs) if (op === 0) same += text.length;
  return (2 * same) / (a.length + b.length);
}

function findAll(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

/** Semantic diff between two versions, reusable across many anchors. */
export function diffVersions(oldSource: string, newSource: string): DiffMatchPatch.Diff[] {
  const diffs = dmp.diff_main(oldSource, newSource);
  dmp.diff_cleanupSemantic(diffs);
  return diffs;
}

/** Maps an offset in the old source to an offset in the new one via the diff. */
export function mapOffset(diffs: readonly DiffMatchPatch.Diff[], offset: number): number {
  let oldPos = 0;
  let newPos = 0;
  for (const [op, text] of diffs) {
    if (op === 0) {
      if (oldPos + text.length > offset) return newPos + (offset - oldPos);
      oldPos += text.length;
      newPos += text.length;
    } else if (op === -1) {
      if (oldPos + text.length > offset) return newPos; // offset inside a deletion
      oldPos += text.length;
    } else {
      newPos += text.length;
    }
  }
  return newPos;
}

function contextScore(anchor: TextAnchor, doc: string, at: number): number {
  const prefix = doc.slice(Math.max(0, at - ANCHOR_CONTEXT_CHARS), at);
  const suffix = doc.slice(
    at + anchor.exact.length,
    at + anchor.exact.length + ANCHOR_CONTEXT_CHARS,
  );
  return similarity(prefix, anchor.prefix) + similarity(suffix, anchor.suffix);
}

/**
 * Low-bar sanity gate on context, distinct from the confidence floor: "is
 * this match even in the plausible neighborhood?" rather than "how confident
 * are we in it?" (see REANCHOR_CONTEXT_SANITY_FLOOR doc comment). An anchor
 * with no captured context (empty prefix AND suffix — e.g. captured at the
 * very start/end of a document) has no signal to check against, so it is not
 * penalized, matching the codebase's existing "no signal, don't penalize"
 * convention.
 */
function contextPlausible(anchor: TextAnchor, doc: string, at: number): boolean {
  if (anchor.prefix.length === 0 && anchor.suffix.length === 0) return true;
  return contextScore(anchor, doc, at) / 2 >= REANCHOR_CONTEXT_SANITY_FLOOR;
}

/**
 * Resolves `anchor` (captured against the source that produced `diffs`)
 * inside `newDoc`.
 */
export function resolveTextAnchor(
  anchor: TextAnchor,
  newDoc: string,
  diffs: readonly DiffMatchPatch.Diff[],
): ReanchorResult {
  // 1. Exact quote search. A unique hit still must be in a plausible
  // neighborhood (sanity floor) before being trusted at confidence 1 — a
  // unique hit is not necessarily the RIGHT hit if the real location was
  // reworded away and a decoy happens to match verbatim elsewhere (spike 10).
  // An implausible unique hit falls all the way through the rest of the
  // pipeline (not treated as a duplicate-hit case — stage 2 below is for
  // hits.length > 1 only).
  const hits = findAll(newDoc, anchor.exact);
  const [firstHit] = hits;
  if (hits.length === 1 && firstHit !== undefined && contextPlausible(anchor, newDoc, firstHit)) {
    return { method: 'exact', start: firstHit, end: firstHit + anchor.exact.length, confidence: 1 };
  }
  if (hits.length > 1) {
    // 2. Disambiguate duplicates by surrounding context.
    // reduce with no seed requires a non-empty array (hits.length > 1) but
    // then types the result as non-optional, unlike an indexed/seeded loop.
    const best = hits
      .map((at) => ({ at, score: contextScore(anchor, newDoc, at) }))
      .reduce((a, b) => (b.score > a.score ? b : a));
    const confidence = best.score / 2;
    // Every other branch below the exact-match case enforces the floor before
    // returning a location; this one must too, or a duplicated quote with
    // unrecognizable surrounding context would land silently instead of
    // honestly orphaning (Core Principle 2).
    if (confidence >= REANCHOR_CONFIDENCE_FLOOR) {
      return { method: 'context', start: best.at, end: best.at + anchor.exact.length, confidence };
    }
  }

  // 3. Diff-based offset mapping, verified against what is actually there.
  const start = mapOffset(diffs, anchor.start);
  const end = Math.max(start, mapOffset(diffs, anchor.end));
  const mappedSim = similarity(anchor.exact, newDoc.slice(start, end));
  if (end > start && mappedSim >= REANCHOR_CONFIDENCE_FLOOR) {
    return { method: 'fuzzy', start, end, confidence: mappedSim };
  }

  // 4. Fuzzy quote search (bitap) — blocks that moved AND changed. Same
  // sanity-floor gate as stage 1: a bitap match at an implausible location is
  // skipped straight to the honest orphan below, including the stretched-
  // window fallback (still anchored at the same implausible `loc`, so no
  // point retrying it).
  dmp.Match_Distance = 1e9; // no distance penalty from the hint position
  dmp.Match_Threshold = 0.5;
  const loc = dmp.match_main(newDoc, anchor.exact.slice(0, MATCH_PATTERN_LIMIT), start);
  if (loc !== -1 && contextPlausible(anchor, newDoc, loc)) {
    const windowSim = similarity(anchor.exact, newDoc.slice(loc, loc + anchor.exact.length));
    if (windowSim >= REANCHOR_CONFIDENCE_FLOOR) {
      return { method: 'fuzzy', start: loc, end: loc + anchor.exact.length, confidence: windowSim };
    }
    const stretched = newDoc.slice(loc, loc + Math.ceil(anchor.exact.length * 1.2));
    const stretchedSim = similarity(anchor.exact, stretched);
    if (stretchedSim >= REANCHOR_CONFIDENCE_FLOOR) {
      return { method: 'fuzzy', start: loc, end: loc + stretched.length, confidence: stretchedSim };
    }
  }

  // 5. Honest orphan.
  return { method: 'orphan', confidence: mappedSim };
}
