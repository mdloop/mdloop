import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { Actor, ErasureLogPort } from '@vorlyn/app';
import { deleteDocument, sweepDuePurges, uploadNewDocument } from '@vorlyn/app';
import type { DocumentId } from '@vorlyn/shared';
import { withTenant } from './db.js';
import { PgErasureLogRepository } from './repositories/pg-erasure-log-repository.js';
import { PgOrganizationRepository } from './repositories/pg-organization-repository.js';
import {
  PgDirectoryRepository,
  PgDocumentRepository,
  PgRetentionSweepRepository,
  PgUploadUnitOfWork,
} from './repositories/pg-repositories.js';
import { FsStorage } from './storage/fs-storage.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

const feature = await loadFeature(
  fileURLToPath(new URL('../../../features/retention.feature', import.meta.url)),
);

interface World {
  db: TestDb;
  documents: PgDocumentRepository;
  orgs: PgOrganizationRepository;
  sweep: PgRetentionSweepRepository;
  erasures: ErasureLogPort;
  uow: PgUploadUnitOfWork;
  storage: FsStorage;
  storageDir: string;
  alice: Actor;
  docs: Map<string, DocumentId>;
  deleteResult: { purged: boolean };
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

  async function uploadDoc(title: string): Promise<DocumentId> {
    const result = await uploadNewDocument(w.uow, w.storage, w.alice, {
      title,
      projectId: null,
      content: new TextEncoder().encode(`# ${title}`),
      source: 'web',
    });
    if (!result.ok) throw new Error(`upload failed: ${result.error.code}`);
    w.docs.set(title, result.value.document.id);
    return result.value.document.id;
  }

  async function rowCounts(id: DocumentId): Promise<{ documents: number; versions: number }> {
    return withTenant(w.db.pool, w.alice.ctx, async (c) => {
      const documents = await c.query<{ n: string }>(
        'select count(*) as n from documents where id = $1',
        [id],
      );
      const versions = await c.query<{ n: string }>(
        'select count(*) as n from document_versions where document_id = $1',
        [id],
      );
      return { documents: Number(documents.rows[0]!.n), versions: Number(versions.rows[0]!.n) };
    });
  }

  async function blobExists(id: DocumentId): Promise<boolean> {
    return w.storage
      .get({ orgId: w.alice.ctx.orgId, documentId: id, seq: 1 })
      .then(() => true)
      .catch(() => false);
  }

  async function ledgerCount(): Promise<number> {
    return withTenant(w.db.pool, w.alice.ctx, async (c) => {
      const { rows } = await c.query<{ n: string }>('select count(*) as n from upload_ledger');
      return Number(rows[0]!.n);
    });
  }

  Background(({ Given }) => {
    Given('organization "Acme" with user "alice" and retention of 10 days', async () => {
      if (!(w as Partial<World>).db) {
        w.db = await createTestDb();
        w.documents = new PgDocumentRepository(w.db.pool);
        w.orgs = new PgOrganizationRepository(w.db.pool);
        w.sweep = new PgRetentionSweepRepository(w.db.pool);
        w.erasures = new PgErasureLogRepository(w.db.pool);
        w.uow = new PgUploadUnitOfWork(w.db.pool);
      }
      w.storageDir = await mkdtemp(path.join(tmpdir(), 'vorlyn-retention-'));
      w.storage = new FsStorage(w.storageDir);
      w.docs = new Map();
      const directory = new PgDirectoryRepository(w.db.pool);
      const org = await directory.createOrganization('Acme');
      const alice = await directory.createUser(org.id, {
        workosUserId: `wos_alice_${String(Math.random())}`,
        email: `alice_${String(Math.random())}@acme.test`,
        displayName: 'Alice',
        role: 'member',
      });
      w.alice = { ctx: { orgId: org.id, userId: alice.id }, role: 'member' };
      await w.orgs.updateSettings(w.alice.ctx, { retentionDays: 10 });
    });
  });

  Scenario(
    'Soft delete stamps the purge deadline from org retention',
    ({ Given, When, Then, And }) => {
      Given('"alice" has uploaded a document "notes.md"', async () => {
        await uploadDoc('notes.md');
      });
      When('"alice" deletes the document on "2026-07-10"', async () => {
        const result = await deleteDocument(
          w.documents,
          w.orgs,
          w.storage,
          w.erasures,
          w.alice,
          w.docs.get('notes.md')!,
          new Date('2026-07-10T00:00:00Z'),
        );
        expect(result.ok).toBe(true);
        if (result.ok) w.deleteResult = result.value;
      });
      Then('the document is soft-deleted with purge date "2026-07-20"', async () => {
        expect(w.deleteResult.purged).toBe(false);
        const doc = await w.documents.byId(w.alice.ctx, w.docs.get('notes.md')!);
        expect(doc?.deletedAt).not.toBeNull();
        expect(doc?.purgeAfter).toEqual(new Date('2026-07-20T00:00:00Z'));
      });
      And('the document no longer appears in any listing', async () => {
        for (const view of ['all', 'unfiled', 'archived'] as const) {
          const listed = await w.documents.list(w.alice.ctx, { view });
          expect(listed.map((d) => d.id)).not.toContain(w.docs.get('notes.md'));
        }
      });
      And('the blob is still stored', async () => {
        expect(await blobExists(w.docs.get('notes.md')!)).toBe(true);
      });
    },
  );

  Scenario('Immediate purge removes rows and blobs at once', ({ Given, And, When, Then }) => {
    Given('the organization purges immediately', async () => {
      await w.orgs.updateSettings(w.alice.ctx, { purgeImmediately: true });
    });
    And('"alice" has uploaded a document "burn.md"', async () => {
      await uploadDoc('burn.md');
    });
    When('"alice" deletes the document', async () => {
      const result = await deleteDocument(
        w.documents,
        w.orgs,
        w.storage,
        w.erasures,
        w.alice,
        w.docs.get('burn.md')!,
      );
      expect(result.ok && result.value.purged).toBe(true);
    });
    Then('the document row, its versions and its blobs are gone', async () => {
      const id = w.docs.get('burn.md')!;
      expect(await rowCounts(id)).toEqual({ documents: 0, versions: 0 });
      expect(await blobExists(id)).toBe(false);
    });
    And('the ledger still records the upload', async () => {
      expect(await ledgerCount()).toBe(1);
    });
  });

  Scenario(
    'The retention sweep purges only documents past their deadline',
    ({ Given, And, When, Then }) => {
      Given('"alice" has uploaded documents "old.md" and "fresh.md"', async () => {
        await uploadDoc('old.md');
        await uploadDoc('fresh.md');
      });
      And('"old.md" was deleted with purge date "2026-07-01"', async () => {
        await w.documents.softDelete(
          w.alice.ctx,
          w.docs.get('old.md')!,
          new Date('2026-07-01T00:00:00Z'),
        );
      });
      And('"fresh.md" was deleted with purge date "2026-08-01"', async () => {
        await w.documents.softDelete(
          w.alice.ctx,
          w.docs.get('fresh.md')!,
          new Date('2026-08-01T00:00:00Z'),
        );
      });
      When('the retention sweep runs on "2026-07-10"', async () => {
        const purged = await sweepDuePurges(
          w.sweep,
          w.storage,
          w.erasures,
          new Date('2026-07-10T00:00:00Z'),
        );
        expect(purged).toBeGreaterThanOrEqual(1);
      });
      Then('"old.md" is fully purged, blobs included', async () => {
        const id = w.docs.get('old.md')!;
        expect(await rowCounts(id)).toEqual({ documents: 0, versions: 0 });
        expect(await blobExists(id)).toBe(false);
      });
      And('"fresh.md" is still retained', async () => {
        const id = w.docs.get('fresh.md')!;
        expect((await rowCounts(id)).documents).toBe(1);
        expect(await blobExists(id)).toBe(true);
      });
    },
  );
});
