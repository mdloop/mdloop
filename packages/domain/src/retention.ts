/**
 * Retention policy (CONSTITUTION.md §6): soft-deleted documents are kept
 * `retentionDays` (default 30) before purge; an org may purge immediately.
 */
export const DEFAULT_RETENTION_DAYS = 30;

export interface RetentionSettings {
  readonly retentionDays: number;
  readonly purgeImmediately: boolean;
}

export const DEFAULT_RETENTION: RetentionSettings = {
  retentionDays: DEFAULT_RETENTION_DAYS,
  purgeImmediately: false,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Instant at which a document deleted at `deletedAt` becomes purgeable. */
export function purgeAfter(deletedAt: Date, settings: RetentionSettings): Date {
  if (settings.purgeImmediately) return deletedAt;
  return new Date(deletedAt.getTime() + settings.retentionDays * MS_PER_DAY);
}

/** True when a soft-deleted document is due for permanent purge. */
export function isPurgeDue(purgeAfterAt: Date, now: Date): boolean {
  return now.getTime() >= purgeAfterAt.getTime();
}

/** Valid admin-configurable retention range: 0 (immediate on delete) to 365 days. */
export function isValidRetentionDays(days: number): boolean {
  return Number.isInteger(days) && days >= 0 && days <= 365;
}

/** Minimal view of a version as the purge rule needs it. */
export interface PurgeCandidateVersion {
  readonly id: string;
  readonly seq: number;
  readonly createdAt: Date;
  readonly purgedAt: Date | null;
}

export interface VersionPurgeInput {
  readonly versions: readonly PurgeCandidateVersion[];
  /** Keep the last N versions regardless of age. */
  readonly keepLastN: number;
  /** Keep versions younger than this many days; null = unlimited age, nothing purges by time. */
  readonly keepDays: number | null;
  readonly currentVersionId: string | null;
  /** Versions referenced by open comments — an active discussion never loses its source. */
  readonly openCommentVersionIds: ReadonlySet<string>;
}

/**
 * Version auto-purge rule (ADR 0001): a version's blob is purged once it is
 * older than `keepDays` AND outside the last `keepLastN` versions — unless it
 * is the current version or pinned by an open comment. Tombstones (already
 * purged) are never selected again. Returns ids to purge, oldest first.
 */
export function selectVersionsToPurge(input: VersionPurgeInput, now: Date): string[] {
  const live = input.versions.filter((v) => v.purgedAt === null);
  const bySeqDesc = [...live].sort((a, b) => b.seq - a.seq);
  const recent = new Set(bySeqDesc.slice(0, Math.max(0, input.keepLastN)).map((v) => v.id));
  const youngerThan =
    input.keepDays === null ? null : new Date(now.getTime() - input.keepDays * MS_PER_DAY);

  return bySeqDesc
    .filter((v) => {
      if (recent.has(v.id)) return false;
      if (youngerThan === null || v.createdAt.getTime() >= youngerThan.getTime()) return false;
      if (v.id === input.currentVersionId) return false;
      return !input.openCommentVersionIds.has(v.id);
    })
    .sort((a, b) => a.seq - b.seq)
    .map((v) => v.id);
}
