import { describe, expect, it } from 'vitest';
import type { UserId } from '@mdloop/shared';
import { type MentionCandidate, matchMentions, parseMentionTokens } from './mentions.js';

function candidate(id: string, displayName: string): MentionCandidate {
  return { id: id as UserId, displayName };
}

describe('parseMentionTokens', () => {
  it('extracts the slugged tokens of @mentions', () => {
    expect(parseMentionTokens('hey @jane and @Bob-Smith')).toEqual(['jane', 'bob-smith']);
  });

  it('slugs case out so @JaneDoe and @janedoe collapse', () => {
    expect(parseMentionTokens('@JaneDoe and @janedoe')).toEqual(['janedoe']);
  });

  it('keeps first-seen order and de-duplicates', () => {
    expect(parseMentionTokens('@a @b @a @c @b')).toEqual(['a', 'b', 'c']);
  });

  it('does not read an email address as a mention', () => {
    expect(parseMentionTokens('mail me at jane@acme.test please')).toEqual([]);
  });

  it('reads a mention that opens a token boundary mid-punctuation', () => {
    expect(parseMentionTokens('(cc @jane)')).toEqual(['jane']);
  });

  it('matches unicode names', () => {
    expect(parseMentionTokens('thanks @José')).toEqual(['josé']);
  });

  it('ignores a bare @ with no name', () => {
    expect(parseMentionTokens('what @ even @')).toEqual([]);
  });

  it('returns nothing for a body with no mentions', () => {
    expect(parseMentionTokens('plain prose, no mentions here')).toEqual([]);
  });
});

describe('matchMentions', () => {
  const jane = candidate('u-jane', 'Jane Doe');
  const bob = candidate('u-bob', 'Bob');
  const candidates = [jane, bob];

  it('resolves @tokens to matching candidate ids, slug-insensitive', () => {
    expect(matchMentions('ping @JaneDoe now', candidates)).toEqual(['u-jane']);
  });

  it('drops tokens that match no candidate', () => {
    expect(matchMentions('@nobody around', candidates)).toEqual([]);
  });

  it('returns [] for a body with no mentions without scanning candidates', () => {
    expect(matchMentions('no mentions', candidates)).toEqual([]);
  });

  it('resolves several distinct mentions in candidate order', () => {
    expect(matchMentions('@Bob and @janedoe', candidates)).toEqual(['u-jane', 'u-bob']);
  });

  it('matches a candidate at most once even when two collide on a slug', () => {
    const twin = candidate('u-jane2', 'JaneDoe');
    // "Jane Doe" and "JaneDoe" both slug to "janedoe"; @janedoe still yields
    // one id per candidate, but only the ones whose slug matches — here both.
    const ids = matchMentions('@janedoe', [jane, twin]);
    expect(ids).toEqual(['u-jane', 'u-jane2']);
  });

  it('matches on the exact display-name slug, not a fuzzy contains', () => {
    // "Jane_Doe" slugs to "jane_doe" (underscore kept), which is NOT "janedoe",
    // so on its own it resolves to no one.
    expect(matchMentions('@Jane_Doe alone', [jane])).toEqual([]);
  });

  it('does not repeat a candidate when several tokens resolve to it', () => {
    expect(matchMentions('@janedoe @JaneDoe', [jane])).toEqual(['u-jane']);
  });
});
