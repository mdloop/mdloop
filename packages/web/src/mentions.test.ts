import { describe, expect, it } from 'vitest';
import {
  activeMentionQuery,
  filterMentionCandidates,
  mentionInsertText,
  mentionSlug,
  segmentMentions,
  segmentMentionsSafe,
} from './mentions.js';

const candidates = [
  { userId: 'u-jane', displayName: 'Jane Doe' },
  { userId: 'u-bob', displayName: 'Bob' },
];

describe('mentionSlug', () => {
  it('lower-cases and strips whitespace', () => {
    expect(mentionSlug('Jane Doe')).toBe('janedoe');
    expect(mentionSlug('@BOB')).toBe('@bob');
  });
});

describe('activeMentionQuery', () => {
  it('detects the @token the caret is inside', () => {
    const body = 'hey @ja';
    expect(activeMentionQuery(body, body.length)).toEqual({ start: 4, query: 'ja' });
  });

  it('detects a bare @ with an empty partial', () => {
    const body = 'ping @';
    expect(activeMentionQuery(body, body.length)).toEqual({ start: 5, query: '' });
  });

  it('is null when the caret is not in a token', () => {
    expect(activeMentionQuery('all done', 8)).toBeNull();
  });

  it('does not fire on an email address', () => {
    const body = 'mail jane@acme';
    expect(activeMentionQuery(body, body.length)).toBeNull();
  });

  it('tracks only the token at the caret, not an earlier one', () => {
    const body = '@jane then @bo';
    expect(activeMentionQuery(body, body.length)).toEqual({ start: 11, query: 'bo' });
  });
});

describe('filterMentionCandidates', () => {
  it('matches on the slugged display name, capped', () => {
    expect(filterMentionCandidates(candidates, 'jan').map((c) => c.userId)).toEqual(['u-jane']);
  });

  it('offers everyone on an empty partial', () => {
    expect(filterMentionCandidates(candidates, '')).toHaveLength(2);
  });
});

describe('mentionInsertText', () => {
  it('strips whitespace so the inserted token resolves back to the name', () => {
    const inserted = mentionInsertText('Jane Doe');
    expect(inserted).toBe('@JaneDoe');
    // Round-trips through the slug used on both the picker and the server.
    expect(mentionSlug(inserted.slice(1))).toBe(mentionSlug('Jane Doe'));
  });
});

describe('segmentMentions', () => {
  it('marks only tokens that resolved to a stored mention', () => {
    const segments = segmentMentions('cc @JaneDoe not @ghost', new Set(['janedoe']));
    expect(segments).toEqual([
      { text: 'cc ', mention: false },
      { text: '@JaneDoe', mention: true },
      { text: ' not @ghost', mention: false },
    ]);
  });

  it('returns the whole body as one plain run when nothing is mentioned', () => {
    const segments = segmentMentions('no mentions here', new Set());
    expect(segments).toEqual([{ text: 'no mentions here', mention: false }]);
  });
});

describe('segmentMentionsSafe', () => {
  it('segments exactly like segmentMentions when nothing goes wrong', () => {
    const slugs = new Set(['janedoe']);
    expect(segmentMentionsSafe('cc @JaneDoe', slugs)).toEqual(
      segmentMentions('cc @JaneDoe', slugs),
    );
  });

  it('returns the body as one plain run rather than throwing out of the rail', () => {
    // The one thing segmenting calls on its input: a slug set whose `has`
    // misbehaves stands in for any malformed-input throw from inside the walk.
    const hostile = {
      has(): boolean {
        throw new TypeError('not a real set');
      },
    } as unknown as ReadonlySet<string>;

    const segments = segmentMentionsSafe('cc @JaneDoe about the migration', hostile);
    // Every word survived — only the highlight was lost, and it under-marks
    // rather than over-marks, so it can never imply a mention that isn't there.
    expect(segments).toEqual([{ text: 'cc @JaneDoe about the migration', mention: false }]);
  });
});
