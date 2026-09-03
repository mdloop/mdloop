import { describe, expect, it } from 'vitest';
import type { PurgeCandidateVersion } from './retention.js';
import {
  isPurgeDue,
  isValidRetentionDays,
  purgeAfter,
  selectVersionsToPurge,
} from './retention.js';

describe('retention policy', () => {
  const deletedAt = new Date('2026-07-01T00:00:00Z');

  it('defaults to 30 days after delete', () => {
    const at = purgeAfter(deletedAt, { retentionDays: 30, purgeImmediately: false });
    expect(at.toISOString()).toBe('2026-07-31T00:00:00.000Z');
  });

  it('purges immediately when the org opts in', () => {
    const at = purgeAfter(deletedAt, { retentionDays: 30, purgeImmediately: true });
    expect(at.getTime()).toBe(deletedAt.getTime());
  });

  it('isPurgeDue is inclusive of the boundary instant', () => {
    const at = new Date('2026-07-31T00:00:00Z');
    expect(isPurgeDue(at, new Date('2026-07-30T23:59:59Z'))).toBe(false);
    expect(isPurgeDue(at, at)).toBe(true);
    expect(isPurgeDue(at, new Date('2026-08-01T00:00:00Z'))).toBe(true);
  });

  it('validates admin-configurable retention range', () => {
    expect(isValidRetentionDays(0)).toBe(true);
    expect(isValidRetentionDays(30)).toBe(true);
    expect(isValidRetentionDays(365)).toBe(true);
    expect(isValidRetentionDays(-1)).toBe(false);
    expect(isValidRetentionDays(366)).toBe(false);
    expect(isValidRetentionDays(1.5)).toBe(false);
  });
});

describe('selectVersionsToPurge (ADR 0001)', () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
  const v = (
    seq: number,
    ageDays: number,
    purgedAt: Date | null = null,
  ): PurgeCandidateVersion => ({
    id: `v${String(seq)}`,
    seq,
    createdAt: daysAgo(ageDays),
    purgedAt,
  });
  const base = {
    keepLastN: 2,
    keepDays: 30 as number | null,
    currentVersionId: null as string | null,
    openCommentVersionIds: new Set<string>(),
  };

  it('purges only versions older than T AND outside the last N', () => {
    // v4,v3 recent by N; v2 old but... outside N and older than 30d → purge; v1 same.
    const versions = [v(1, 100), v(2, 60), v(3, 40), v(4, 1)];
    expect(selectVersionsToPurge({ ...base, versions }, now)).toEqual(['v1', 'v2']);
  });

  it('keeps old versions inside the last N', () => {
    const versions = [v(1, 100), v(2, 60)];
    expect(selectVersionsToPurge({ ...base, versions }, now)).toEqual([]);
  });

  it('keeps young versions outside the last N', () => {
    const versions = [v(1, 5), v(2, 4), v(3, 3), v(4, 2)];
    expect(selectVersionsToPurge({ ...base, versions }, now)).toEqual([]);
  });

  it('never purges the current version', () => {
    const versions = [v(1, 100), v(2, 60), v(3, 1), v(4, 1)];
    expect(selectVersionsToPurge({ ...base, versions, currentVersionId: 'v1' }, now)).toEqual([
      'v2',
    ]);
  });

  it('never purges a version pinned by an open comment', () => {
    const versions = [v(1, 100), v(2, 60), v(3, 1), v(4, 1)];
    expect(
      selectVersionsToPurge({ ...base, versions, openCommentVersionIds: new Set(['v2']) }, now),
    ).toEqual(['v1']);
  });

  it('never re-selects tombstones', () => {
    const versions = [v(1, 100, daysAgo(10)), v(2, 60), v(3, 1), v(4, 1)];
    expect(selectVersionsToPurge({ ...base, versions }, now)).toEqual(['v2']);
  });

  it('keepDays null means nothing purges by time', () => {
    const versions = [v(1, 1000), v(2, 900), v(3, 800)];
    expect(selectVersionsToPurge({ ...base, versions, keepDays: null }, now)).toEqual([]);
  });

  it('boundary: exactly T days old is still kept (younger-than is inclusive)', () => {
    const versions = [v(1, 30), v(2, 1), v(3, 1)];
    expect(selectVersionsToPurge({ ...base, versions }, now)).toEqual([]);
  });

  it('returns oldest first', () => {
    const versions = [v(3, 70), v(1, 100), v(2, 90), v(4, 1), v(5, 1)];
    expect(selectVersionsToPurge({ ...base, versions }, now)).toEqual(['v1', 'v2', 'v3']);
  });
});
