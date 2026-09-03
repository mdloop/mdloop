import { describe, expect, it } from 'vitest';
import type { OrgId, UserId } from '@vorlyn/shared';
import {
  FakeCommentRepository,
  FakeDocumentRepository,
  FakeErasureLog,
  FakeOrganizationRepository,
  FakeShareGrantRepository,
  FakeStorage,
  FakeUploadUnitOfWork,
  FakeVersionRepository,
  FakeWorld,
} from '../test-support/fakes.js';
import type { Actor } from './org-settings.js';
import { uploadNewDocument, uploadNewVersion } from './upload.js';
import { createComment, resolveComment } from './comments.js';
import type { VersionPurgeDeps } from './purge-versions.js';
import { sweepVersionPurge } from './purge-versions.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const DAY = 86_400_000;

async function setup(orgOverrides: Parameters<FakeWorld['org']>[0] = {}) {
  const world = new FakeWorld();
  const org = world.org(orgOverrides);
  const actor: Actor = { ctx: { orgId: org.id, userId: 'u1' as UserId }, role: 'member' };
  const storage = new FakeStorage();
  const uow = new FakeUploadUnitOfWork(world);
  const deps: VersionPurgeDeps = {
    sweep: { listOrgIds: () => Promise.resolve([...world.orgs.keys()] as OrgId[]) },
    orgs: new FakeOrganizationRepository(world),
    documents: new FakeDocumentRepository(world),
    versions: new FakeVersionRepository(world),
    comments: new FakeCommentRepository(world),
    storage,
    erasures: new FakeErasureLog(),
  };
  const grants = new FakeShareGrantRepository(world);
  return { world, org, actor, storage, uow, deps, grants };
}

/** Uploads `n` versions dated `ageDays` ago, returns the document id. */
async function docWithVersions(
  s: Awaited<ReturnType<typeof setup>>,
  n: number,
  ageDays: number,
  now: Date,
) {
  s.uow.now = new Date(now.getTime() - ageDays * DAY);
  const first = await uploadNewDocument(s.uow, s.storage, s.actor, {
    title: 'doc.md',
    projectId: null,
    content: bytes('v1'),
    source: 'web',
  });
  if (!first.ok) throw new Error('setup upload');
  const documentId = first.value.document.id;
  for (let i = 2; i <= n; i++) {
    const r = await uploadNewVersion(s.uow, s.storage, s.actor, {
      documentId,
      content: bytes(`v${String(i)}`),
      source: 'web',
    });
    if (!r.ok) throw new Error('setup version');
  }
  return documentId;
}

describe('sweepVersionPurge', () => {
  const now = new Date('2026-07-13T00:00:00Z');

  it('tombstones rows and deletes blobs for versions past the rule', async () => {
    const s = await setup({ versionRetention: { keepLastN: 2, keepDays: 30 } });
    const documentId = await docWithVersions(s, 5, 60, now);

    const report = await sweepVersionPurge(s.deps, now);

    // 5 versions, all 60d old: keep last 2 (incl. current), purge 3.
    expect(report).toEqual({ orgsSwept: 1, versionsPurged: 3 });
    const versions = await s.deps.versions.listForDocument(s.actor.ctx, documentId);
    expect(versions.filter((v) => v.purgedAt !== null).map((v) => v.seq)).toEqual([1, 2, 3]);
    // Rows all survive; purged blobs are gone, kept blobs remain.
    expect(versions).toHaveLength(5);
    expect(s.storage.objects.size).toBe(2);
  });

  it('never purges versions pinned by open comments; resolved ones are fair game', async () => {
    const s = await setup({ versionRetention: { keepLastN: 1, keepDays: 30 } });
    const documentId = await docWithVersions(s, 1, 60, now);
    const pinned = await createComment(
      s.deps.documents,
      s.deps.comments,
      s.deps.orgs,
      s.grants,
      s.actor,
      {
        documentId,
        body: 'still discussing',
        anchor: { type: 'document' },
      },
    );
    if (!pinned.ok) throw new Error('setup comment');
    // Three more old versions; the comment stays pinned to seq 1.
    for (let i = 2; i <= 4; i++) {
      s.uow.now = new Date(now.getTime() - 50 * DAY);
      const r = await uploadNewVersion(s.uow, s.storage, s.actor, {
        documentId,
        content: bytes(`v${String(i)}`),
        source: 'web',
      });
      if (!r.ok) throw new Error('setup version');
    }

    let report = await sweepVersionPurge(s.deps, now);
    expect(report.versionsPurged).toBe(2); // seq 2 and 3; seq 1 pinned, seq 4 current

    // Resolving the comment unpins seq 1: next sweep may purge it.
    const resolved = await resolveComment(
      s.deps.documents,
      s.deps.comments,
      s.actor,
      pinned.value.id,
    );
    if (!resolved.ok) throw new Error('resolve failed');
    report = await sweepVersionPurge(s.deps, now);
    expect(report.versionsPurged).toBe(1);
  });

  it('keeps young versions and the last N regardless of age', async () => {
    const s = await setup({ versionRetention: { keepLastN: 3, keepDays: 30 } });
    await docWithVersions(s, 3, 100, now); // old but within last N
    const s2 = await setup({ versionRetention: { keepLastN: 1, keepDays: 30 } });
    await docWithVersions(s2, 4, 5, now); // outside N but young

    expect((await sweepVersionPurge(s.deps, now)).versionsPurged).toBe(0);
    expect((await sweepVersionPurge(s2.deps, now)).versionsPurged).toBe(0);
  });

  it('applies the tier default when the org has no config, clamped on downgrade', async () => {
    // Free tier, no org config: default N=20/T=90 — 25 versions aged 100 days → purge 5.
    const s = await setup({ tier: 'free' });
    await docWithVersions(s, 25, 100, now);
    expect((await sweepVersionPurge(s.deps, now)).versionsPurged).toBe(5);

    // Org config looser than free ceiling (kept from a team days): clamped to N=20/T=90.
    const s2 = await setup({ tier: 'free', versionRetention: { keepLastN: 500, keepDays: null } });
    await docWithVersions(s2, 25, 100, now);
    expect((await sweepVersionPurge(s2.deps, now)).versionsPurged).toBe(5);
  });

  it('skips orgs whose row is unreadable and versions a racer tombstoned mid-sweep', async () => {
    const s = await setup({ versionRetention: { keepLastN: 1, keepDays: 30 } });
    await docWithVersions(s, 3, 60, now);
    const real = s.deps.versions;
    let raced = false;
    const deps: VersionPurgeDeps = {
      ...s.deps,
      // A ghost org id in the sweep list must not break the run.
      sweep: { listOrgIds: () => Promise.resolve(['ghost-org', s.org.id] as OrgId[]) },
      versions: {
        append: real.append.bind(real),
        byId: real.byId.bind(real),
        listForDocument: real.listForDocument.bind(real),
        // First candidate lost to a concurrent sweep: tombstone returns
        // undefined and the worker must move on without a blob delete.
        tombstone: (ctx, id) => {
          if (raced) return real.tombstone(ctx, id);
          raced = true;
          return Promise.resolve(undefined);
        },
        storageBytesUsed: real.storageBytesUsed.bind(real),
      },
    };

    const report = await sweepVersionPurge(deps, now);
    expect(report).toEqual({ orgsSwept: 2, versionsPurged: 1 });
  });

  it('is idempotent: a second sweep finds nothing to purge', async () => {
    const s = await setup({ versionRetention: { keepLastN: 1, keepDays: 30 } });
    await docWithVersions(s, 4, 60, now);
    expect((await sweepVersionPurge(s.deps, now)).versionsPurged).toBe(3);
    expect((await sweepVersionPurge(s.deps, now)).versionsPurged).toBe(0);
  });

  it('frees version-cap headroom: tombstones do not count as live blobs', async () => {
    const s = await setup({ tier: 'free', versionRetention: { keepLastN: 1, keepDays: 1 } });
    const documentId = await docWithVersions(s, 100, 10, now); // at the free cap of 100

    s.uow.now = now;
    const blocked = await uploadNewVersion(s.uow, s.storage, s.actor, {
      documentId,
      content: bytes('one more'),
      source: 'web',
    });
    expect(!blocked.ok && blocked.error.code).toBe('version_cap_exceeded');

    await sweepVersionPurge(s.deps, now);
    const allowed = await uploadNewVersion(s.uow, s.storage, s.actor, {
      documentId,
      content: bytes('one more'),
      source: 'web',
    });
    expect(allowed.ok).toBe(true);
  });
});
