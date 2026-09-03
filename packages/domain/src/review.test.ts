import { describe, expect, it } from 'vitest';
import type { UserId } from '@vorlyn/shared';
import type { ApprovalVerdict, DerivationVerdict } from './review.js';
import { deriveReviewStatus } from './review.js';

const u = (n: string): UserId => n as UserId;

function verdict(reviewerUserId: string, v: ApprovalVerdict, atMs: number): DerivationVerdict {
  return { reviewerUserId: u(reviewerUserId), verdict: v, createdAt: new Date(atMs) };
}

describe('deriveReviewStatus', () => {
  it('is draft with no active reviewers, even if stale approvals exist', () => {
    expect(
      deriveReviewStatus({
        activeReviewerIds: [],
        approvalsOnLatestVersion: [verdict('a', 'approved', 1)],
      }),
    ).toBe('draft');
  });

  it('is in_review when a reviewer is requested but has not verdicted', () => {
    expect(
      deriveReviewStatus({
        activeReviewerIds: [u('a')],
        approvalsOnLatestVersion: [],
      }),
    ).toBe('in_review');
  });

  it('is approved when the sole active reviewer approved', () => {
    expect(
      deriveReviewStatus({
        activeReviewerIds: [u('a')],
        approvalsOnLatestVersion: [verdict('a', 'approved', 1)],
      }),
    ).toBe('approved');
  });

  it('is approved only when every active reviewer approved', () => {
    expect(
      deriveReviewStatus({
        activeReviewerIds: [u('a'), u('b')],
        approvalsOnLatestVersion: [verdict('a', 'approved', 1)],
      }),
    ).toBe('in_review');
  });

  it('is approved when all of several reviewers approved', () => {
    expect(
      deriveReviewStatus({
        activeReviewerIds: [u('a'), u('b')],
        approvalsOnLatestVersion: [verdict('a', 'approved', 1), verdict('b', 'approved', 2)],
      }),
    ).toBe('approved');
  });

  it('changes_requested dominates even when another reviewer approved', () => {
    expect(
      deriveReviewStatus({
        activeReviewerIds: [u('a'), u('b')],
        approvalsOnLatestVersion: [
          verdict('a', 'approved', 1),
          verdict('b', 'changes_requested', 2),
        ],
      }),
    ).toBe('changes_requested');
  });

  it('uses the latest verdict per reviewer (approve supersedes older changes)', () => {
    expect(
      deriveReviewStatus({
        activeReviewerIds: [u('a')],
        approvalsOnLatestVersion: [
          verdict('a', 'changes_requested', 1),
          verdict('a', 'approved', 2),
        ],
      }),
    ).toBe('approved');
  });

  it('uses the latest verdict per reviewer (changes supersedes older approve)', () => {
    expect(
      deriveReviewStatus({
        activeReviewerIds: [u('a')],
        approvalsOnLatestVersion: [
          verdict('a', 'approved', 1),
          verdict('a', 'changes_requested', 2),
        ],
      }),
    ).toBe('changes_requested');
  });

  it('ignores verdicts from reviewers no longer active', () => {
    expect(
      deriveReviewStatus({
        activeReviewerIds: [u('a')],
        approvalsOnLatestVersion: [
          verdict('a', 'approved', 1),
          // b was revoked; its changes_requested must not count.
          verdict('b', 'changes_requested', 2),
        ],
      }),
    ).toBe('approved');
  });

  it('breaks equal-timestamp ties toward the last row seen', () => {
    // Same createdAt: the >= comparison keeps the later-iterated row.
    expect(
      deriveReviewStatus({
        activeReviewerIds: [u('a')],
        approvalsOnLatestVersion: [
          verdict('a', 'approved', 5),
          verdict('a', 'changes_requested', 5),
        ],
      }),
    ).toBe('changes_requested');
  });
});
