import { describe, expect, it } from 'vitest';
import type { CommentId, OrgId, ReplyId, UserId } from '@mdloop/shared';
import type { CommentReply } from './entities.js';
import { MAX_REPLY_DEPTH, replyDepth } from './entities.js';

function reply(id: string, parentReplyId: string | null): CommentReply {
  return {
    id: id as ReplyId,
    orgId: 'org' as OrgId,
    commentId: 'c1' as CommentId,
    parentReplyId: parentReplyId as ReplyId | null,
    authorId: 'u1' as UserId,
    body: id,
    viaApiKeyId: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
  };
}

function chain(length: number): Map<ReplyId, CommentReply> {
  const replies = Array.from({ length }, (_, i) =>
    reply(`r${String(i + 1)}`, i === 0 ? null : `r${String(i)}`),
  );
  return new Map(replies.map((r) => [r.id, r]));
}

describe('replyDepth', () => {
  it('a direct reply is depth 1', () => {
    expect(replyDepth(null, new Map())).toBe(1);
  });

  it('walks the parent chain', () => {
    const byId = chain(3);
    expect(replyDepth('r3' as ReplyId, byId)).toBe(4);
    expect(replyDepth('r1' as ReplyId, byId)).toBe(2);
  });

  it('the cap boundary sits exactly at MAX_REPLY_DEPTH', () => {
    const byId = chain(MAX_REPLY_DEPTH);
    expect(replyDepth(`r${String(MAX_REPLY_DEPTH - 1)}` as ReplyId, byId)).toBe(MAX_REPLY_DEPTH);
    expect(replyDepth(`r${String(MAX_REPLY_DEPTH)}` as ReplyId, byId)).toBe(MAX_REPLY_DEPTH + 1);
  });

  it('returns undefined for a broken chain (unknown parent)', () => {
    expect(replyDepth('ghost' as ReplyId, chain(2))).toBeUndefined();
  });

  it('bails out on absurdly long chains instead of walking forever', () => {
    const byId = chain(1200);
    expect(replyDepth('r1200' as ReplyId, byId)).toBeUndefined();
  });
});
