import { describe, expect, it } from 'vitest';
import {
  createTextAnchor,
  diffVersions,
  mapOffset,
  resolveTextAnchor,
  similarity,
} from './reanchor.js';
import type { TextAnchor } from './anchor.js';

/* Spike 01 fixture documents, ported verbatim. */

const v1 = `# Payment Service Design

## Overview

The payment service handles all card transactions for the platform. It exposes a REST API consumed by the checkout frontend and the subscription billing worker.

## Architecture

We use a hexagonal architecture. The core domain has no framework dependencies. Adapters wrap Stripe, the Postgres ledger, and the Kafka event bus.

Retries are handled with exponential backoff and a dead letter queue.

## Data Model

The ledger table is append-only. Every mutation writes a new row with a monotonic sequence number. Balances are computed as materialized views refreshed every minute.

## Error Handling

All errors map to RFC 7807 problem details. Client errors never retry. Server errors retry up to three times.

Retries are handled with exponential backoff and a dead letter queue.

## Open Questions

Should we support partial refunds in v1? The Stripe adapter makes this easy but the ledger model needs a refund row type.
`;

const v2 = `# Payment Service Design

## Overview

The payment service handles all card transactions and refunds for the platform. It exposes a REST API consumed by the checkout frontend and the subscription billing worker.

## Architecture

We use a hexagonal architecture. The core domain has no framework dependencies. Adapters wrap Stripe, the Postgres ledger, and the Kafka event bus.

Retries are handled with exponential backoff and a dead letter queue.

## Error Handling

All errors map to RFC 7807 problem details. Client errors never retry. Server errors retry up to three times.

Retries are handled with exponential backoff and a dead letter queue.

## Data Model

The ledger table is strictly append-only. Every mutation inserts a new row with a monotonically increasing sequence number. Balances are computed as materialized views refreshed every minute.
`;

function anchorFor(doc: string, quote: string): TextAnchor {
  const start = doc.indexOf(quote);
  if (start === -1) throw new Error(`quote not in doc: ${quote}`);
  return createTextAnchor(doc, start, start + quote.length);
}

const diffs = diffVersions(v1, v2);

describe('resolveTextAnchor (spike 01 cases)', () => {
  it('finds an unchanged paragraph exactly, even when its section moved', () => {
    const anchor = anchorFor(
      v1,
      'All errors map to RFC 7807 problem details. Client errors never retry.',
    );
    const r = resolveTextAnchor(anchor, v2, diffs);
    expect(r.method).toBe('exact');
    expect(r.confidence).toBe(1);
  });

  it('fuzzy-matches a lightly edited sentence', () => {
    const anchor = anchorFor(
      v1,
      'The ledger table is append-only. Every mutation writes a new row with a monotonic sequence number.',
    );
    const r = resolveTextAnchor(anchor, v2, diffs);
    expect(r.method).toBe('fuzzy');
    if (r.method !== 'orphan') {
      expect(v2.slice(r.start, r.end)).toContain('ledger table');
    }
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('orphans a comment on a deleted section', () => {
    const anchor = anchorFor(v1, 'Should we support partial refunds in v1?');
    const r = resolveTextAnchor(anchor, v2, diffs);
    expect(r.method).toBe('orphan');
    expect(r.confidence).toBeLessThan(0.6);
  });

  it('falls through to fuzzy on a duplicated line when context score is below the floor', () => {
    // Both v1 occurrences' surrounding sections got reworded enough in v2 that
    // context-similarity lands under REANCHOR_CONFIDENCE_FLOOR: the context
    // branch must not report a low-confidence guess as method 'context' (that
    // would violate Core Principle 2 — see reanchor.ts). It falls through to
    // diff/fuzzy resolution, which still lands on the correct occurrence.
    const quote = 'Retries are handled with exponential backoff and a dead letter queue.';
    const second = v1.indexOf(quote, v1.indexOf(quote) + 1);
    const anchor = createTextAnchor(v1, second, second + quote.length);
    const r = resolveTextAnchor(anchor, v2, diffs);
    expect(r.method).toBe('fuzzy');
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
    if (r.method !== 'orphan') {
      expect(v2.slice(r.start, r.end)).toBe(quote);
    }
  });

  it('disambiguates a duplicated line by context, favoring the first occurrence', () => {
    // Same fixture as below but the anchor is captured at the *first*
    // occurrence, so the max-scoring reduce must pick the earlier hit over
    // a later one, not just "whichever comes later" (both comparison
    // directions of the reduce need exercising).
    const dup = `A. Same intro line here for context.

Repeated marker sentence for the test.

B. Same intro line here for context, second copy.

Repeated marker sentence for the test.

C. Trailer.`;
    const quote = 'Repeated marker sentence for the test.';
    const first = dup.indexOf(quote);
    const anchor = createTextAnchor(dup, first, first + quote.length);
    const noopDiffs = diffVersions(dup, dup);
    const r = resolveTextAnchor(anchor, dup, noopDiffs);
    expect(r.method).toBe('context');
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
    if (r.method !== 'orphan') {
      expect(r.start).toBe(first);
    }
  });

  it('disambiguates a duplicated line by context when surrounding text is unchanged', () => {
    // A duplicate quote whose context genuinely matches above the floor
    // should resolve via the context branch, not fall through.
    const dup = `A. Same intro line here for context.

Repeated marker sentence for the test.

B. Same intro line here for context, second copy.

Repeated marker sentence for the test.

C. Trailer.`;
    const quote = 'Repeated marker sentence for the test.';
    const first = dup.indexOf(quote);
    const second = dup.indexOf(quote, first + 1);
    const anchor = createTextAnchor(dup, second, second + quote.length);
    const noopDiffs = diffVersions(dup, dup);
    const r = resolveTextAnchor(anchor, dup, noopDiffs);
    expect(r.method).toBe('context');
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
    if (r.method !== 'orphan') {
      expect(dup.slice(r.start, r.end)).toBe(quote);
    }
  });

  it('fuzzy-matches the edited overview sentence', () => {
    const anchor = anchorFor(
      v1,
      'The payment service handles all card transactions for the platform.',
    );
    const r = resolveTextAnchor(anchor, v2, diffs);
    expect(r.method).toBe('fuzzy');
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
  });
});

describe('resolveTextAnchor (context sanity-floor gate, spike 10 regression)', () => {
  it('never resolves a reworded anchor to a coincidental decoy elsewhere in the document', () => {
    // The bug (spike 10 FINDINGS.md): before the fix, stage 1's unique-hit
    // path and stage 4's bitap fallback trusted text similarity alone, with
    // ZERO surrounding-context verification. If the anchored phrase gets
    // reworded away from its original spot, and a decoy elsewhere in the doc
    // happens to contain the same literal phrase, the comment resolved
    // *confidently* to the decoy — a real Core Principle 2 violation. This
    // reproduces exactly that shape: "five steps" is reworded in place
    // (breaking the exact match at its true location) while a decoy sentence
    // elsewhere retains the literal original phrase, positioned so it alone
    // would win stage 1's old context-blind unique-hit check.
    const before =
      '## Retry policy\n\n' +
      'Background context about the retry policy goes here for realism.\n\n' +
      'The scheduler retries five steps before giving up on the job.\n\n' +
      '## Next section\n\n' +
      'Unrelated trailing content about a different topic entirely.';
    const anchor = anchorFor(before, 'five steps');

    const after =
      '## Retry policy\n\n' +
      'Background context about the retry policy goes here for realism.\n\n' +
      'The scheduler retries five separate discrete steps before giving up on the job.\n\n' +
      '## Next section\n\n' +
      'Unrelated trailing content about a different topic, noting the old audit log ' +
      'said five steps were required for compliance sign-off.';
    const decoyStart = after.indexOf('five steps', after.indexOf('## Next section'));
    expect(decoyStart).toBeGreaterThan(-1);

    const r = resolveTextAnchor(anchor, after, diffVersions(before, after));

    // Must never land on the decoy. Either an honest orphan, or (if some
    // other stage legitimately recovers the true reworded location) a
    // resolution that does NOT overlap the decoy's range.
    if (r.method === 'orphan') {
      expect(r.confidence).toBeLessThan(0.6);
    } else {
      expect(r.start).not.toBe(decoyStart);
      const resolvedText = after.slice(r.start, r.end);
      expect(resolvedText).not.toBe('five steps');
    }
  });

  it('still fuzzy-resolves a reworded sentence when its surrounding context has moderately drifted (no decoy present)', () => {
    // The sanity floor must NOT over-correct: a legitimate lone match whose
    // nearby sentences were also edited in the same session (context
    // similarity dips, but doesn't vanish) should still resolve — this is
    // exactly the over-correction the first (rejected) hard-gate design
    // caused, at 44% orphan rate. 0.15 is deliberately low enough to clear.
    const before =
      '## Section\n\n' +
      'Original lead-in sentence about the topic.\n\n' +
      'The payment retries occur up to three times before failing permanently.\n\n' +
      'Original trailing sentence about the topic.';
    const anchor = anchorFor(
      before,
      'The payment retries occur up to three times before failing permanently.',
    );

    const after =
      '## Section\n\n' +
      'Revised lead-in wording about this same topic area now.\n\n' +
      'The payment retries happen up to three separate times before it fails permanently.\n\n' +
      'Revised trailing wording about this same topic area now.';

    const r = resolveTextAnchor(anchor, after, diffVersions(before, after));
    expect(r.method).toBe('fuzzy');
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
    if (r.method !== 'orphan') {
      expect(after.slice(r.start, r.end)).toContain('payment retries');
    }
  });

  it('exact-matches despite an anchor with no captured context, even when the match sits amid real surrounding text', () => {
    // "No context captured" (empty prefix AND suffix — the existing
    // convention for e.g. an anchor at the very start/end of a document)
    // must not be penalized by the sanity floor. Constructed like the
    // existing stretched-bitap-window edge case: the anchor's prefix/suffix
    // are deliberately empty even though the real match location has
    // substantial real surrounding text, so a naive (non-shortcut) context
    // score there would compute near 0 and wrongly reject the unique hit.
    const exact = 'The scheduled job archives orphaned rows nightly.';
    const anchor: TextAnchor = {
      type: 'text',
      exact,
      prefix: '',
      suffix: '',
      start: 0,
      end: exact.length,
    };
    const newDoc = `Some real preceding paragraph text here.\n\n${exact}\n\nSome real trailing paragraph text here.`;
    const r = resolveTextAnchor(anchor, newDoc, diffVersions(newDoc, newDoc));
    expect(r).toMatchObject({ method: 'exact', confidence: 1 });
  });
});

describe('resolveTextAnchor (edge cases)', () => {
  it('resolves exactly on an unchanged document', () => {
    const anchor = anchorFor(v1, 'hexagonal architecture');
    const r = resolveTextAnchor(anchor, v1, diffVersions(v1, v1));
    expect(r).toMatchObject({ method: 'exact', confidence: 1 });
  });

  it('finds a block that moved and changed via fuzzy quote search', () => {
    const a = 'The quick brown fox jumps over the lazy dog near the river bank today.';
    const before = `intro paragraph here\n\n${a}\n\nclosing words`;
    const after = `closing words moved up\n\nsomething entirely new\n\nThe quick brown fox leaps over the lazy dog near the river bank today.`;
    const anchor = anchorFor(before, a);
    const r = resolveTextAnchor(anchor, after, diffVersions(before, after));
    expect(r.method).toBe('fuzzy');
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('orphans when the document is replaced wholesale', () => {
    const before = 'alpha beta gamma delta';
    const after = 'completely unrelated content with zero overlap whatsoever';
    const anchor = anchorFor(before, 'beta gamma');
    const r = resolveTextAnchor(anchor, after, diffVersions(before, after));
    expect(r.method).toBe('orphan');
  });
});

describe('createTextAnchor', () => {
  it('captures exact, clamped context and offsets', () => {
    const doc = 'abcdef selected ghijkl';
    const start = doc.indexOf('selected');
    const anchor = createTextAnchor(doc, start, start + 'selected'.length);
    expect(anchor).toMatchObject({
      type: 'text',
      exact: 'selected',
      prefix: 'abcdef ',
      suffix: ' ghijkl',
      start,
      end: start + 8,
    });
  });

  it('caps context at 32 characters each side', () => {
    const doc = `${'p'.repeat(100)}X${'s'.repeat(100)}`;
    const anchor = createTextAnchor(doc, 100, 101);
    expect(anchor.prefix).toHaveLength(32);
    expect(anchor.suffix).toHaveLength(32);
  });
});

describe('similarity', () => {
  it('is 1 for identical strings and for two empties', () => {
    expect(similarity('same', 'same')).toBe(1);
    expect(similarity('', '')).toBe(1);
  });

  it('is 0 for disjoint strings', () => {
    expect(similarity('aaaa', 'bbbb')).toBe(0);
  });

  it('is in between for partial overlap', () => {
    const s = similarity('the quick brown fox', 'the quick red fox');
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThan(1);
  });
});

describe('mapOffset', () => {
  it('maps through equal, deleted and inserted regions', () => {
    const before = 'aaa bbb ccc';
    const after = 'aaa XY ccc';
    const d = diffVersions(before, after);
    expect(mapOffset(d, 0)).toBe(0); // inside leading equality
    expect(mapOffset(d, before.indexOf('ccc'))).toBe(after.indexOf('ccc'));
    // offset inside the deleted "bbb" clamps to the replacement start
    const inDeleted = before.indexOf('bbb') + 1;
    expect(mapOffset(d, inDeleted)).toBeLessThanOrEqual(after.indexOf('ccc'));
  });

  it('clamps past-the-end offsets to the new length', () => {
    const d = diffVersions('short', 'short and longer');
    expect(mapOffset(d, 999)).toBe('short and longer'.length);
  });
});

describe('resolveTextAnchor (stretched bitap window)', () => {
  it('recovers via the 1.2x stretched window when the exact-length window misses the tail', () => {
    const exact = 'The scheduled job archives orphaned rows nightly using batches of one thousand.';
    const filler = 'x'.repeat(200);
    // Padding inserted mid-block pushes the matching tail past the
    // fixed-length bitap window (line ~136) but within the 1.2x stretch
    // (line ~139) — the only path that reaches it.
    const altered =
      'The scheduled job archives orphaned extra padding inserted here, rows nightly using batches of one thousand.';
    const newDoc = `${filler}\n\n${altered}\n\ntrailer`;
    // Anchor offsets deliberately point into the filler, not the real block,
    // forcing an identity diff's offset-mapping step (step 3) to fail so
    // resolution falls through to the bitap search.
    const anchor: TextAnchor = {
      type: 'text',
      exact,
      prefix: '',
      suffix: '',
      start: 0,
      end: exact.length,
    };
    const diffs = diffVersions(newDoc, newDoc);
    const r = resolveTextAnchor(anchor, newDoc, diffs);
    expect(r.method).toBe('fuzzy');
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
    if (r.method !== 'orphan') {
      // The 1.2x window (line ~139) is narrower than the full altered block;
      // it captures a leading slice of it, not the whole thing.
      expect(r.end - r.start).toBe(Math.ceil(exact.length * 1.2));
      expect(altered.startsWith(newDoc.slice(r.start, r.end))).toBe(true);
    }
  });
});
