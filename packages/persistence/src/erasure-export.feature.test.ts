import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { Actor, ErasureReplayReport, OrgExport, VersionPurgeDeps } from '@mdloop/app';
import {
  createComment,
  deleteDocument,
  exportOrg,
  replayErasures,
  sweepVersionPurge,
  uploadNewDocument,
  uploadNewVersion,
} from '@mdloop/app';
import type { DocumentId } from '@mdloop/shared';
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
} from './repositories/pg-repositories.js';
import { FsStorage } from './storage/fs-storage.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

const feature = await loadFeature(
  fileURLToPath(new URL('../../../features/erasure-export.feature', import.meta.url)),
);

const MARKDOWN = '# Spec\n\nThe retry loop backs off exponentially.\n';
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

interface World {
  db: TestDb;
  documents: PgDocumentRepository;
  grants: PgShareGrantRepository;
  versions: PgVersionRepository;
  comments: PgCommentRepository;
  orgs: PgOrganizationRepository;
  erasures: PgErasureLogRepository;
  uow: PgUploadUnitOfWork;
  storage: FsStorage;
  storageDir: string;
  alice: Actor;
  documentId: DocumentId;
  export: OrgExport;
  replayReports: ErasureReplayReport[];
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

  function replayDeps() {
    return {
      erasures: w.erasures,
      orgs: w.orgs,
      documents: w.documents,
      versions: w.versions,
      storage: w.storage,
    };
  }

  function versionPurgeDeps(): VersionPurgeDeps {
    return {
      sweep: new PgVersionPurgeSweepRepository(w.db.pool),
      orgs: w.orgs,
      documents: w.documents,
      versions: w.versions,
      comments: w.comments,
      storage: w.storage,
      erasures: w.erasures,
    };
  }

  async function blobExists(documentId: DocumentId, seq: number): Promise<boolean> {
    return w.storage
      .get({ orgId: w.alice.ctx.orgId, documentId, seq })
      .then(() => true)
      .catch(() => false);
  }

  async function logRows(): Promise<
    { kind: string; org_id: string; document_id: string | null; version_seq: number | null }[]
  > {
    const { rows } = await w.db.pool.query<{
      kind: string;
      org_id: string;
      document_id: string | null;
      version_seq: number | null;
    }>('select kind, org_id, document_id, version_seq from erasure_log where org_id = $1', [
      w.alice.ctx.orgId,
    ]);
    return rows;
  }

  /** Snapshots the org's rows + blobs so a scenario can "restore a backup". */
  async function snapshotAndPurgeThenRestore(): Promise<void> {
    // "Backup": read the rows we care about before the purge.
    const versions = await w.versions.listForDocument(w.alice.ctx, w.documentId);
    const doc = await w.documents.byId(w.alice.ctx, w.documentId);
    if (!doc) throw new Error('setup: doc missing');

    const purge = await deleteDocument(
      w.documents,
      w.orgs,
      w.storage,
      w.erasures,
      w.alice,
      w.documentId,
    );
    if (!purge.ok || !purge.value.purged) throw new Error('setup: purge failed');

    // "Restore": put rows and blobs back verbatim, as PITR would.
    await w.db.pool.query(
      `insert into documents (id, org_id, project_id, owner_id, title, created_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [doc.id, doc.orgId, doc.projectId, doc.ownerId, doc.title, doc.createdAt],
    );
    await w.db.pool.query(
      'alter table document_versions disable trigger document_versions_immutable',
    );
    for (const v of versions) {
      await w.db.pool.query(
        `insert into document_versions (id, org_id, document_id, seq, content_hash, byte_size, created_by, source, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          v.id,
          v.orgId,
          v.documentId,
          v.seq,
          v.contentHash,
          v.byteSize,
          v.createdBy,
          v.source,
          v.createdAt,
        ],
      );
      await w.storage.put(
        { orgId: v.orgId, documentId: v.documentId, seq: v.seq },
        bytes(MARKDOWN),
      );
    }
    await w.db.pool.query(
      'alter table document_versions enable trigger document_versions_immutable',
    );
  }

  Background(({ Given }) => {
    Given('organization "Acme" with admin "alice" and a document with a comment', async () => {
      if (!(w as Partial<World>).db) {
        w.db = await createTestDb();
        w.documents = new PgDocumentRepository(w.db.pool);
        w.grants = new PgShareGrantRepository(w.db.pool);
        w.versions = new PgVersionRepository(w.db.pool);
        w.comments = new PgCommentRepository(w.db.pool);
        w.orgs = new PgOrganizationRepository(w.db.pool);
        w.erasures = new PgErasureLogRepository(w.db.pool);
        w.uow = new PgUploadUnitOfWork(w.db.pool);
      }
      w.storageDir = await mkdtemp(path.join(tmpdir(), 'mdloop-erasure-'));
      w.storage = new FsStorage(w.storageDir);
      const directory = new PgDirectoryRepository(w.db.pool);
      const org = await directory.createOrganization('Acme');
      const alice = await directory.createUser(org.id, {
        workosUserId: `wos_alice_${String(Math.random())}`,
        email: `alice_${String(Math.random())}@acme.test`,
        displayName: 'Alice',
        role: 'admin',
      });
      w.alice = { ctx: { orgId: org.id, userId: alice.id }, role: 'admin' };
      const uploaded = await uploadNewDocument(w.uow, w.storage, w.alice, {
        title: 'spec.md',
        projectId: null,
        content: bytes(MARKDOWN),
        source: 'web',
      });
      if (!uploaded.ok) throw new Error('setup upload');
      w.documentId = uploaded.value.document.id;
      const comment = await createComment(w.documents, w.comments, w.orgs, w.grants, w.alice, {
        documentId: w.documentId,
        body: 'please check',
        anchor: { type: 'document' },
      });
      if (!comment.ok) throw new Error('setup comment');
      const reply = await w.comments.addReply(w.alice.ctx, {
        parentReplyId: null,
        commentId: comment.value.id,
        body: 'on it',
        authorId: w.alice.ctx.userId,
      });
      if (!reply.id) throw new Error('setup reply');
    });
  });

  Scenario(
    'Every purge kind lands in the erasure log with opaque ids only',
    ({ When, And, Then }) => {
      When('the document is purged immediately by the admin', async () => {
        await w.orgs.updateSettings(w.alice.ctx, { purgeImmediately: true });
        const r = await deleteDocument(
          w.documents,
          w.orgs,
          w.storage,
          w.erasures,
          w.alice,
          w.documentId,
        );
        expect(r.ok && r.value.purged).toBe(true);
      });
      And('an old version of another document is purged by the retention sweep', async () => {
        const second = await uploadNewDocument(w.uow, w.storage, w.alice, {
          title: 'other.md',
          projectId: null,
          content: bytes('v1'),
          source: 'web',
        });
        if (!second.ok) throw new Error('setup');
        const next = await uploadNewVersion(w.uow, w.storage, w.alice, {
          documentId: second.value.document.id,
          content: bytes('v2'),
          source: 'web',
        });
        if (!next.ok) throw new Error('setup');
        await w.db.pool.query(
          'alter table document_versions disable trigger document_versions_immutable',
        );
        await w.db.pool.query(
          `update document_versions set created_at = now() - interval '400 days' where document_id = $1`,
          [second.value.document.id],
        );
        await w.db.pool.query(
          'alter table document_versions enable trigger document_versions_immutable',
        );
        await w.orgs.updateSettings(w.alice.ctx, {
          versionRetention: { keepLastN: 1, keepDays: 30 },
        });
        const report = await sweepVersionPurge(versionPurgeDeps());
        expect(report.versionsPurged).toBeGreaterThanOrEqual(1);
      });
      Then('the erasure log records a "document_purge" and a "version_purge"', async () => {
        const kinds = (await logRows()).map((r) => r.kind);
        expect(kinds).toContain('document_purge');
        expect(kinds).toContain('version_purge');
      });
      And('log entries carry only ids, kinds and timestamps', async () => {
        const { rows } = await w.db.pool.query<{ column_name: string }>(
          `select column_name from information_schema.columns where table_name = 'erasure_log'`,
        );
        expect(rows.map((r) => r.column_name).sort()).toEqual([
          'document_id',
          'id',
          'kind',
          'occurred_at',
          'org_id',
          'version_seq',
        ]);
      });
    },
  );

  Scenario('The erasure log survives the org it describes', ({ Given, When, Then, And }) => {
    // billing_events (migration 0006) is a kept-but-vestigial table post
    // billing-removal (S4): still present, still FK'd to organizations
    // (`on delete set null`). This proves PgOrganizationRepository.
    // purgeOrganization can drop the old privileged unlink step it inherited
    // from PgBillingRepository and still leave the org purge-able — the FK's
    // own ON DELETE SET NULL clause does that unlink now, without a separate
    // provisioner-privileged statement.
    const providerEventId = `evt_${String(Math.random())}`;
    Given('a billing_events row references the organization', async () => {
      await w.db.pool.query(
        `insert into billing_events (provider_event_id, org_id, event_type) values ($1, $2, $3)`,
        [providerEventId, w.alice.ctx.orgId, 'test.event'],
      );
    });
    When('the organization is purged', async () => {
      // Same three-call sequence every org-purge trigger uses (was the org
      // purge branch of the now-removed billing lifecycle sweep; still the
      // shape `operator-offboarding.ts`'s immediate purge uses): blobs first,
      // rows last, then the erasure log records it.
      await w.storage.deleteOrg(w.alice.ctx.orgId);
      await w.orgs.purgeOrganization(w.alice.ctx.orgId);
      await w.erasures.record({ kind: 'org_purge', orgId: w.alice.ctx.orgId });
    });
    Then('the erasure log records an "org_purge" for it', async () => {
      expect((await logRows()).map((r) => r.kind)).toContain('org_purge');
    });
    And('the log entry remains readable after the organization row is gone', async () => {
      const { rows } = await w.db.pool.query('select 1 from organizations where id = $1', [
        w.alice.ctx.orgId,
      ]);
      expect(rows).toHaveLength(0);
      expect((await logRows()).length).toBeGreaterThanOrEqual(1);
    });
    And('the billing_events row survives with its org pointer nulled by the FK', async () => {
      const { rows } = await w.db.pool.query<{ org_id: string | null }>(
        'select org_id from billing_events where provider_event_id = $1',
        [providerEventId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.org_id).toBeNull();
    });
  });

  Scenario(
    'Replay re-applies purges that a backup restore resurrected',
    ({ Given, And, When, Then }) => {
      Given('the document was purged and the purge was logged', async () => {
        await w.orgs.updateSettings(w.alice.ctx, { purgeImmediately: true });
      });
      And('a backup restore resurrected the document rows and blobs', async () => {
        await snapshotAndPurgeThenRestore();
        expect(await w.documents.byId(w.alice.ctx, w.documentId)).toBeDefined();
        expect(await blobExists(w.documentId, 1)).toBe(true);
      });
      When('the erasure replay runs', async () => {
        const report = await replayErasures(replayDeps());
        expect(report.documentsPurged).toBeGreaterThanOrEqual(1);
      });
      Then('the document rows and blobs are gone again', async () => {
        expect(await w.documents.byId(w.alice.ctx, w.documentId)).toBeUndefined();
        expect(await blobExists(w.documentId, 1)).toBe(false);
      });
    },
  );

  Scenario('Replay re-tombstones resurrected versions', ({ Given, And, When, Then }) => {
    let purgedSeq: number;
    Given('a version was tombstoned by the retention sweep and logged', async () => {
      const next = await uploadNewVersion(w.uow, w.storage, w.alice, {
        documentId: w.documentId,
        content: bytes('v2'),
        source: 'web',
      });
      if (!next.ok) throw new Error('setup');
      await w.db.pool.query(
        'alter table document_versions disable trigger document_versions_immutable',
      );
      await w.db.pool.query(
        `update document_versions set created_at = now() - interval '400 days' where document_id = $1 and seq = 1`,
        [w.documentId],
      );
      await w.db.pool.query(
        'alter table document_versions enable trigger document_versions_immutable',
      );
      await w.orgs.updateSettings(w.alice.ctx, {
        versionRetention: { keepLastN: 1, keepDays: 30 },
      });
      // The background comment pins seq 1: resolve it so the sweep may purge.
      const comments = await w.comments.listForDocument(w.alice.ctx, w.documentId);
      for (const c of comments) await w.comments.resolve(w.alice.ctx, c.id, w.alice.ctx.userId);
      const report = await sweepVersionPurge(versionPurgeDeps());
      expect(report.versionsPurged).toBe(1);
      purgedSeq = 1;
    });
    And('a backup restore resurrected the version row and blob', async () => {
      // PITR would bring back the pre-purge row: simulate by clearing purged_at.
      await w.db.pool.query(
        'alter table document_versions disable trigger document_versions_immutable',
      );
      await w.db.pool.query(
        'update document_versions set purged_at = null where document_id = $1 and seq = $2',
        [w.documentId, purgedSeq],
      );
      await w.db.pool.query(
        'alter table document_versions enable trigger document_versions_immutable',
      );
      await w.storage.put(
        { orgId: w.alice.ctx.orgId, documentId: w.documentId, seq: purgedSeq },
        bytes(MARKDOWN),
      );
    });
    When('the erasure replay runs', async () => {
      const report = await replayErasures(replayDeps());
      expect(report.versionsPurged).toBe(1);
    });
    Then('the version is a tombstone again and its blob is gone', async () => {
      const versions = await w.versions.listForDocument(w.alice.ctx, w.documentId);
      expect(versions.find((v) => v.seq === purgedSeq)?.purgedAt).not.toBeNull();
      expect(await blobExists(w.documentId, purgedSeq)).toBe(false);
    });
  });

  Scenario('Replay is idempotent', ({ Given, When, Then }) => {
    Given('the document was purged and the purge was logged', async () => {
      await w.orgs.updateSettings(w.alice.ctx, { purgeImmediately: true });
      const r = await deleteDocument(
        w.documents,
        w.orgs,
        w.storage,
        w.erasures,
        w.alice,
        w.documentId,
      );
      expect(r.ok && r.value.purged).toBe(true);
    });
    When('the erasure replay runs twice', async () => {
      w.replayReports = [await replayErasures(replayDeps()), await replayErasures(replayDeps())];
    });
    Then('the second run reports the same events with nothing new purged', () => {
      const [first, second] = w.replayReports;
      if (!first || !second) throw new Error('missing reports');
      expect(second.eventsReplayed).toBe(first.eventsReplayed);
      expect(second.documentsPurged).toBe(0);
      expect(second.versionsPurged).toBe(0);
      expect(second.orgsPurged).toBe(0);
    });
  });

  Scenario('Admin exports the org as markdown plus comments JSON', ({ When, Then, And }) => {
    When('"alice" requests the org export', async () => {
      const result = await exportOrg(
        w.orgs,
        w.documents,
        w.versions,
        w.comments,
        w.storage,
        w.alice,
      );
      if (!result.ok) throw new Error(`export failed: ${result.error.code}`);
      w.export = result.value;
    });
    Then("the export contains the document's markdown and its comment with replies", () => {
      const doc = w.export.documents.find((d) => d.id === w.documentId);
      if (!doc) throw new Error('document missing from export');
      expect(doc.markdown).toBe(MARKDOWN);
      // Version metadata rides the (real Pg keyset) export completely.
      expect(doc.versions).toEqual([expect.objectContaining({ seq: 1, purged: false })]);
      expect(w.export.nextCursor).toBeNull();
      expect(doc.comments).toHaveLength(1);
      expect(doc.comments[0]).toMatchObject({
        body: 'please check',
        status: 'open',
        replies: [{ body: 'on it', authorId: w.alice.ctx.userId }],
      });
    });
    And('a member requesting the export is refused', async () => {
      const member: Actor = { ctx: w.alice.ctx, role: 'member' };
      const denied = await exportOrg(
        w.orgs,
        w.documents,
        w.versions,
        w.comments,
        w.storage,
        member,
      );
      expect(!denied.ok && denied.error.code).toBe('forbidden');
    });
  });
});
