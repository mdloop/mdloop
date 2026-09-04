import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { Actor, UploadResult } from '@mdloop/app';
import { uploadNewDocument, uploadNewVersion } from '@mdloop/app';
import type { UploadError } from '@mdloop/app';
import type { Result } from '@mdloop/shared';
import type { DocumentId } from '@mdloop/shared';
import { withTenant } from './db.js';
import { PgDirectoryRepository, PgUploadUnitOfWork } from './repositories/pg-repositories.js';
import { FsStorage } from './storage/fs-storage.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

const feature = await loadFeature(
  fileURLToPath(new URL('../../../features/upload-quota.feature', import.meta.url)),
);

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

interface World {
  db: TestDb;
  uow: PgUploadUnitOfWork;
  storage: FsStorage;
  storageDir: string;
  alice: Actor;
  documentId: DocumentId;
  result: Result<UploadResult, UploadError>;
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

  async function counts(): Promise<{ versions: number; ledger: number }> {
    return withTenant(w.db.pool, w.alice.ctx, async (c) => {
      const versions = await c.query<{ n: string }>('select count(*) as n from document_versions');
      const ledger = await c.query<{ n: string }>('select count(*) as n from upload_ledger');
      return { versions: Number(versions.rows[0]!.n), ledger: Number(ledger.rows[0]!.n) };
    });
  }

  function upload(
    content: Uint8Array,
    title = 'doc.md',
  ): Promise<Result<UploadResult, UploadError>> {
    return uploadNewDocument(w.uow, w.storage, w.alice, {
      title,
      projectId: null,
      content,
      source: 'web',
    });
  }

  Background(({ Given }) => {
    Given('organization "Acme" with user "alice"', async () => {
      if (!(w as Partial<World>).db) {
        w.db = await createTestDb();
        w.uow = new PgUploadUnitOfWork(w.db.pool);
      }
      w.storageDir = await mkdtemp(path.join(tmpdir(), 'mdloop-quota-'));
      w.storage = new FsStorage(w.storageDir);
      const directory = new PgDirectoryRepository(w.db.pool);
      // Explicit free tier: the remaining scenarios here (size, content
      // policy) don't vary by tier — pinned only to keep the org
      // deterministic rather than relying on `createOrganization`'s default
      // ('team'). Tier-scoped request-budget behavior (the mechanism that
      // replaced the old per-tier upload-count quota) is covered by
      // features/rate-limit-parity.feature instead.
      const org = await directory.createOrganization('Acme', 'free');
      const alice = await directory.createUser(org.id, {
        workosUserId: `wos_alice_${String(Math.random())}`,
        email: `alice_${String(Math.random())}@acme.test`,
        displayName: 'Alice',
        role: 'member',
      });
      w.alice = { ctx: { orgId: org.id, userId: alice.id }, role: 'member' };
    });
  });

  Scenario('A file over 500KB is rejected', ({ When, Then, And }) => {
    When('"alice" uploads a document of 512001 bytes', async () => {
      // Filled with 'x', not left zeroed: content policy (ADR 0011) runs
      // ahead of the size check, so a buffer of NULs would be refused as a
      // binary before the cap ever got a say — and this scenario is about
      // the cap.
      w.result = await upload(new Uint8Array(500 * 1024 + 1).fill(0x78));
    });
    Then('the upload is rejected as too large', () => {
      expect(!w.result.ok && w.result.error.code).toBe('file_too_large');
    });
    And('no version and no ledger entry exist', async () => {
      expect(await counts()).toEqual({ versions: 0, ledger: 0 });
    });
  });

  Scenario('An empty file is rejected', ({ When, Then, And }) => {
    When('"alice" uploads an empty document', async () => {
      w.result = await upload(new Uint8Array(0));
    });
    Then('the upload is rejected as empty', () => {
      expect(!w.result.ok && w.result.error.code).toBe('empty_file');
    });
    And('no version and no ledger entry exist', async () => {
      expect(await counts()).toEqual({ versions: 0, ledger: 0 });
    });
  });

  // ADR 0011: the ingest gate is size AND content policy. Both refusals have
  // to leave the ledger untouched for the same reason — they run before any
  // transaction opens, so there is nothing to roll back.
  Scenario('Content containing control bytes is rejected', ({ When, Then, And }) => {
    When('"alice" uploads a document containing a control byte', async () => {
      // What a renamed binary actually looks like after a browser's lossy
      // client-side decode: readable text with control bytes surviving in it.
      w.result = await upload(new Uint8Array([...bytes('# Notes'), 0x00, ...bytes('binary')]));
    });
    Then('the upload is rejected as not markdown', () => {
      expect(!w.result.ok && w.result.error.code).toBe('control_byte_detected');
    });
    And('no version and no ledger entry exist', async () => {
      expect(await counts()).toEqual({ versions: 0, ledger: 0 });
    });
  });

  Scenario('A renamed binary is rejected by its signature', ({ When, Then, And }) => {
    When('"alice" uploads a document starting with a PDF signature', async () => {
      w.result = await upload(bytes('%PDF-1.7 and then some bytes'), 'report.md');
    });
    Then('the upload is rejected as a binary file', () => {
      expect(!w.result.ok && w.result.error.code).toBe('binary_signature_detected');
    });
    And('no version and no ledger entry exist', async () => {
      expect(await counts()).toEqual({ versions: 0, ledger: 0 });
    });
  });

  Scenario('A successful upload consumes exactly one ledger entry', ({ When, Then, And }) => {
    When('"alice" uploads a document', async () => {
      w.result = await upload(bytes('# hi'));
    });
    Then('the upload succeeds', () => {
      expect(w.result.ok).toBe(true);
    });
    And('the ledger records exactly 1 upload for "alice"', async () => {
      expect((await counts()).ledger).toBe(1);
    });
  });

  Scenario('Re-pushing identical content is idempotent and free', ({ Given, When, Then, And }) => {
    Given('"alice" has uploaded a document with content "same bytes"', async () => {
      const first = await upload(bytes('same bytes'));
      expect(first.ok).toBe(true);
      if (first.ok) w.documentId = first.value.document.id;
    });
    When('"alice" uploads content "same bytes" to the same document again', async () => {
      w.result = await uploadNewVersion(w.uow, w.storage, w.alice, {
        documentId: w.documentId,
        content: bytes('same bytes'),
        source: 'mcp',
      });
    });
    Then('no new version is created', async () => {
      expect(w.result.ok && w.result.value.deduplicated).toBe(true);
      expect((await counts()).versions).toBe(1);
    });
    And('the ledger still records exactly 1 upload for "alice"', async () => {
      expect((await counts()).ledger).toBe(1);
    });
  });
});
