import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { Actor, ThreadWithResolution, VersionPurgeDeps } from '@vorlyn/app';
import {
  createComment,
  listThreadsWithResolutions,
  resolveComment,
  sweepVersionPurge,
  updateOrgSettings,
  uploadNewDocument,
  uploadNewVersion,
} from '@vorlyn/app';
import { createTextAnchor } from '@vorlyn/domain';
import type { CommentId, DocumentId } from '@vorlyn/shared';
import { PgErasureLogRepository } from './repositories/pg-erasure-log-repository.js';
import { PgOrganizationRepository } from './repositories/pg-organization-repository.js';
import {
  PgCommentRepository,
  PgDirectoryRepository,
  PgDocumentRepository,
  PgShareGrantRepository,
  PgUploadUnitOfWork,
  PgVersionPurgeSweepRepository,
  PgVersionRepository,
  PgAnchorResolutionRepository,
} from './repositories/pg-repositories.js';
import { FsStorage } from './storage/fs-storage.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

const feature = await loadFeature(
  fileURLToPath(new URL('../../../features/version-retention.feature', import.meta.url)),
);

const PARAGRAPH = 'The retry loop backs off exponentially with jitter.';
const V1 = `# Spec\n\n${PARAGRAPH}\n`;
const V2 = `# Spec (edited)\n\nIntro added.\n\n${PARAGRAPH}\n`;

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

interface World {
  db: TestDb;
  documents: PgDocumentRepository;
  grants: PgShareGrantRepository;
  versions: PgVersionRepository;
  comments: PgCommentRepository;
  resolutions: PgAnchorResolutionRepository;
  orgs: PgOrganizationRepository;
  uow: PgUploadUnitOfWork;
  storage: FsStorage;
  storageDir: string;
  purgeDeps: VersionPurgeDeps;
  alice: Actor;
  documentId: DocumentId;
  commentId: CommentId;
  threads: ThreadWithResolution[];
}

describeFeature(feature, ({ Background, Scenario, AfterAllScenarios, AfterEachScenario }) => {
  const w = {} as World;

  AfterAllScenarios(async () => {
    await w.db.close();
  });

  // Background remints w.storage (and its temp dir) at the start of every
  // scenario — AfterAllScenarios only fires once at the very end, so without
  // this every scenario but the last leaks its blob-store temp directory.
  AfterEachScenario(async () => {
    await rm(w.storageDir, { recursive: true, force: true });
  });

  /** Backdates every version of the document; the immutability trigger is
   * bypassed deliberately — tests own the clock, production never does this. */
  async function ageVersions(days: number): Promise<void> {
    await w.db.pool.query(
      'alter table document_versions disable trigger document_versions_immutable',
    );
    await w.db.pool.query(
      `update document_versions set created_at = now() - make_interval(days => $1)
       where document_id = $2 and created_at > now() - make_interval(days => $1)`,
      [days, w.documentId],
    );
    await w.db.pool.query(
      'alter table document_versions enable trigger document_versions_immutable',
    );
    // Age the ledger with the versions: aged uploads must not trip the
    // weekly upload quota and shadow the cap under test.
    await w.db.pool.query(
      `update upload_ledger set created_at = now() - make_interval(days => $1)
       where version_id in (select id from document_versions where document_id = $2)
         and created_at > now() - make_interval(days => $1)`,
      [days, w.documentId],
    );
  }

  async function upload(content: string): Promise<void> {
    const r = await uploadNewVersion(w.uow, w.storage, w.alice, {
      documentId: w.documentId,
      content: bytes(content),
      source: 'web',
    });
    if (!r.ok) throw new Error(`upload failed: ${r.error.code}`);
  }

  async function uploadDocWithVersions(n: number, ageDays: number): Promise<void> {
    const first = await uploadNewDocument(w.uow, w.storage, w.alice, {
      title: 'spec.md',
      projectId: null,
      content: bytes('version 1'),
      source: 'web',
    });
    if (!first.ok) throw new Error(`upload failed: ${first.error.code}`);
    w.documentId = first.value.document.id;
    for (let i = 2; i <= n; i++) await upload(`version ${String(i)}`);
    await ageVersions(ageDays);
  }

  async function sweep(): Promise<number> {
    return (await sweepVersionPurge(w.purgeDeps)).versionsPurged;
  }

  async function versionState(): Promise<{ seq: number; purged: boolean; blob: boolean }[]> {
    const versions = await w.versions.listForDocument(w.alice.ctx, w.documentId);
    return Promise.all(
      versions.map(async (v) => ({
        seq: v.seq,
        purged: v.purgedAt !== null,
        blob: await w.storage
          .get({ orgId: w.alice.ctx.orgId, documentId: w.documentId, seq: v.seq })
          .then(() => true)
          .catch(() => false),
      })),
    );
  }

  async function setTier(tier: string): Promise<void> {
    await w.db.pool.query('update organizations set tier = $1 where id = $2', [
      tier,
      w.alice.ctx.orgId,
    ]);
  }

  async function commentOnCurrent(anchorText?: string): Promise<void> {
    const source = anchorText === undefined ? undefined : V1;
    const anchor =
      source === undefined
        ? ({ type: 'document' } as const)
        : createTextAnchor(
            source,
            source.indexOf(anchorText ?? ''),
            source.indexOf(anchorText ?? '') + (anchorText ?? '').length,
          );
    const r = await createComment(w.documents, w.comments, w.orgs, w.grants, w.alice, {
      documentId: w.documentId,
      body: 'please check',
      anchor,
    });
    if (!r.ok) throw new Error(`comment failed: ${r.error.code}`);
    w.commentId = r.value.id;
  }

  Background(({ Given }) => {
    Given(
      'organization "Acme" with user "alice" and version retention of last 2 versions or 30 days',
      async () => {
        if (!(w as Partial<World>).db) {
          w.db = await createTestDb();
          w.documents = new PgDocumentRepository(w.db.pool);
          w.grants = new PgShareGrantRepository(w.db.pool);
          w.versions = new PgVersionRepository(w.db.pool);
          w.comments = new PgCommentRepository(w.db.pool);
          w.resolutions = new PgAnchorResolutionRepository(w.db.pool);
          w.orgs = new PgOrganizationRepository(w.db.pool);
          w.uow = new PgUploadUnitOfWork(w.db.pool);
        }
        w.storageDir = await mkdtemp(path.join(tmpdir(), 'vorlyn-vp-'));
        w.storage = new FsStorage(w.storageDir);
        w.purgeDeps = {
          sweep: new PgVersionPurgeSweepRepository(w.db.pool),
          orgs: w.orgs,
          documents: w.documents,
          versions: w.versions,
          comments: w.comments,
          storage: w.storage,
          erasures: new PgErasureLogRepository(w.db.pool),
        };
        const directory = new PgDirectoryRepository(w.db.pool);
        const org = await directory.createOrganization('Acme');
        const alice = await directory.createUser(org.id, {
          workosUserId: `wos_alice_${String(Math.random())}`,
          email: `alice_${String(Math.random())}@acme.test`,
          displayName: 'Alice',
          role: 'admin',
        });
        w.alice = { ctx: { orgId: org.id, userId: alice.id }, role: 'admin' };
        // The background org is only ever this scenario's org: purge sweeps
        // iterate all orgs, but each scenario gets a fresh storage dir, so
        // cross-scenario orgs simply no-op (their blobs are already gone).
        const set = await updateOrgSettings(w.orgs, w.alice, {
          versionRetention: { keepLastN: 2, keepDays: 30 },
        });
        if (!set.ok) throw new Error(`settings failed: ${set.error.code}`);
      },
    );
  });

  Scenario(
    'The sweep tombstones rows and deletes blobs past the rule',
    ({ Given, When, Then, And }) => {
      Given('"alice" has uploaded "spec.md" with 5 versions, all 60 days old', async () => {
        await uploadDocWithVersions(5, 60);
      });
      When('the version purge sweep runs today', async () => {
        await sweep();
      });
      Then('versions 1 to 3 are tombstones with their rows intact', async () => {
        const state = await versionState();
        expect(state).toHaveLength(5);
        expect(state.filter((v) => v.purged).map((v) => v.seq)).toEqual([1, 2, 3]);
      });
      And('the blobs of versions 1 to 3 are deleted', async () => {
        const state = await versionState();
        expect(state.filter((v) => !v.blob).map((v) => v.seq)).toEqual([1, 2, 3]);
      });
      And('versions 4 and 5 keep their blobs', async () => {
        const state = await versionState();
        expect(state.filter((v) => v.blob).map((v) => v.seq)).toEqual([4, 5]);
      });
    },
  );

  Scenario('A version pinned by an open comment is never purged', ({ Given, And, When, Then }) => {
    Given('"alice" has uploaded "spec.md" with 1 version, 60 days old', async () => {
      await uploadDocWithVersions(1, 60);
    });
    And('"alice" commented on version 1', async () => {
      await commentOnCurrent();
    });
    And('"alice" uploaded 3 more versions, all 50 days old', async () => {
      for (let i = 2; i <= 4; i++) await upload(`version ${String(i)}`);
      await ageVersions(50);
    });
    When('the version purge sweep runs today', async () => {
      await sweep();
    });
    Then('version 1 keeps its blob', async () => {
      const state = await versionState();
      expect(state.find((v) => v.seq === 1)).toEqual({ seq: 1, purged: false, blob: true });
    });
    And('version 2 is a tombstone while versions 3 and 4 are kept as the last two', async () => {
      const state = await versionState();
      expect(state.filter((v) => v.purged).map((v) => v.seq)).toEqual([2]);
      expect(state.filter((v) => v.blob).map((v) => v.seq)).toEqual([1, 3, 4]);
    });
  });

  Scenario(
    'Resolving the pinning comment makes the version purgeable',
    ({ Given, And, When, Then }) => {
      Given('"alice" has uploaded "spec.md" with 1 version, 60 days old', async () => {
        await uploadDocWithVersions(1, 60);
      });
      And('"alice" commented on version 1', async () => {
        await commentOnCurrent();
      });
      And('"alice" uploaded 3 more versions, all 50 days old', async () => {
        for (let i = 2; i <= 4; i++) await upload(`version ${String(i)}`);
        await ageVersions(50);
      });
      And('the comment is resolved', async () => {
        const r = await resolveComment(w.documents, w.comments, w.alice, w.commentId);
        if (!r.ok) throw new Error(`resolve failed: ${r.error.code}`);
      });
      When('the version purge sweep runs today', async () => {
        await sweep();
      });
      Then('version 1 is a tombstone', async () => {
        const state = await versionState();
        expect(state.find((v) => v.seq === 1)).toEqual({ seq: 1, purged: true, blob: false });
      });
    },
  );

  Scenario(
    'A comment pinned to a purged version keeps its quote and is not orphaned',
    ({ Given, And, When, Then }) => {
      Given(
        '"alice" has uploaded "spec.md" with a paragraph that survives to the current version',
        async () => {
          const first = await uploadNewDocument(w.uow, w.storage, w.alice, {
            title: 'spec.md',
            projectId: null,
            content: bytes(V1),
            source: 'web',
          });
          if (!first.ok) throw new Error(`upload failed: ${first.error.code}`);
          w.documentId = first.value.document.id;
        },
      );
      And('"alice" commented on that paragraph', async () => {
        await commentOnCurrent(PARAGRAPH);
      });
      And('the comment was resolved, unpinning its version', async () => {
        const r = await resolveComment(w.documents, w.comments, w.alice, w.commentId);
        if (!r.ok) throw new Error(`resolve failed: ${r.error.code}`);
      });
      And('the pinned version was purged by the sweep', async () => {
        await upload(V2);
        await ageVersions(60);
        // v2 is current + within last 2; shrink the window so v1 goes.
        const set = await updateOrgSettings(w.orgs, w.alice, {
          versionRetention: { keepLastN: 1, keepDays: 30 },
        });
        if (!set.ok) throw new Error(`settings failed: ${set.error.code}`);
        expect(await sweep()).toBeGreaterThanOrEqual(1);
        const state = await versionState();
        expect(state.find((v) => v.seq === 1)?.purged).toBe(true);
      });
      When('"alice" lists the comment threads', async () => {
        const r = await listThreadsWithResolutions(
          w.documents,
          w.comments,
          w.versions,
          w.resolutions,
          w.storage,
          w.alice,
          w.documentId,
        );
        if (!r.ok) throw new Error(`list failed: ${r.error.code}`);
        w.threads = r.value.threads;
      });
      Then('the comment still carries its quoted text', () => {
        const thread = w.threads[0];
        if (!thread) throw new Error('no threads');
        const anchor = thread.comment.anchor;
        expect(anchor.type === 'text' && anchor.exact).toBe(PARAGRAPH);
      });
      And('the comment re-anchors to the current version instead of orphaning', () => {
        const thread = w.threads[0];
        if (!thread) throw new Error('no threads');
        expect(thread.resolution.method).not.toBe('orphan');
        expect(thread.resolution.confidence).toBeGreaterThan(0.6);
      });
    },
  );

  Scenario('Young versions and the last N never purge', ({ Given, When, Then }) => {
    Given('"alice" has uploaded "spec.md" with 5 versions, all 5 days old', async () => {
      await uploadDocWithVersions(5, 5);
    });
    When('the version purge sweep runs today', async () => {
      await sweep();
    });
    Then('no version is purged', async () => {
      const state = await versionState();
      expect(state.every((v) => !v.purged && v.blob)).toBe(true);
    });
  });

  Scenario(
    'The version cap counts live blobs, so purge frees headroom',
    ({ Given, And, Then, When }) => {
      Given(
        'the organization is on the free tier with version retention of last 1 version or 1 day',
        async () => {
          // Config first (team ceiling check), then downgrade: the effective
          // rule re-clamps to the free ceiling automatically (ADR 0001).
          const set = await updateOrgSettings(w.orgs, w.alice, {
            versionRetention: { keepLastN: 1, keepDays: 1 },
          });
          if (!set.ok) throw new Error(`settings failed: ${set.error.code}`);
          await setTier('free');
        },
      );
      And('"alice" has uploaded "spec.md" with 100 versions, all 10 days old', async () => {
        await uploadDocWithVersions(100, 10);
      });
      Then('uploading another version is rejected with "version_cap_exceeded"', async () => {
        const r = await uploadNewVersion(w.uow, w.storage, w.alice, {
          documentId: w.documentId,
          content: bytes('version 101'),
          source: 'web',
        });
        expect(!r.ok && r.error.code).toBe('version_cap_exceeded');
      });
      When('the version purge sweep runs today', async () => {
        expect(await sweep()).toBe(99);
      });
      Then('uploading another version succeeds', async () => {
        const r = await uploadNewVersion(w.uow, w.storage, w.alice, {
          documentId: w.documentId,
          content: bytes('version 101'),
          source: 'web',
        });
        expect(r.ok).toBe(true);
      });
    },
  );

  Scenario('Org retention config cannot exceed the tier ceiling', ({ Given, Then, And }) => {
    Given('the organization is on the free tier', async () => {
      await setTier('free');
    });
    Then(
      'setting version retention to last 500 versions is rejected with "version_retention_exceeds_tier_ceiling"',
      async () => {
        const r = await updateOrgSettings(w.orgs, w.alice, {
          versionRetention: { keepLastN: 500, keepDays: 30 },
        });
        expect(!r.ok && r.error.code).toBe('version_retention_exceeds_tier_ceiling');
      },
    );
    And('setting version retention to last 5 versions or 7 days is accepted', async () => {
      const r = await updateOrgSettings(w.orgs, w.alice, {
        versionRetention: { keepLastN: 5, keepDays: 7 },
      });
      expect(r.ok && r.value.versionRetention).toEqual({ keepLastN: 5, keepDays: 7 });
    });
  });
});
