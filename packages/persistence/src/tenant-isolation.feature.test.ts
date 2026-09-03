import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadFeature, describeFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { TenantContext } from '@vorlyn/app';
import { uploadNewVersion } from '@vorlyn/app';
import type { Document } from '@vorlyn/domain';
import type { ProjectId } from '@vorlyn/shared';
import { withTenant } from './db.js';
import { PgOrganizationRepository } from './repositories/pg-organization-repository.js';
import {
  PgCommentRepository,
  PgDirectoryRepository,
  PgDocumentRepository,
  PgProjectRepository,
  PgShareGrantRepository,
  PgUploadUnitOfWork,
  PgVersionRepository,
} from './repositories/pg-repositories.js';
import { FsStorage } from './storage/fs-storage.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

import { fileURLToPath } from 'node:url';

const feature = await loadFeature(
  fileURLToPath(new URL('../../../features/tenant-isolation.feature', import.meta.url)),
);

interface World {
  db: TestDb;
  documents: PgDocumentRepository;
  versions: PgVersionRepository;
  comments: PgCommentRepository;
  projects: PgProjectRepository;
  ctx: Record<string, TenantContext>;
  doc: Document;
  fetched: Document | undefined;
  listed: Document[];
  deleteResult: boolean;
  thrown: unknown;
  uow: PgUploadUnitOfWork;
  storage: FsStorage;
  storageDir: string;
}

describeFeature(feature, ({ Background, Scenario, AfterAllScenarios }) => {
  const w = {} as World;

  AfterAllScenarios(async () => {
    await w.db.close();
  });

  Background(({ Given, And }) => {
    Given('organization "Acme" with user "alice"', async () => {
      w.db = await createTestDb();
      w.documents = new PgDocumentRepository(w.db.pool);
      w.versions = new PgVersionRepository(w.db.pool);
      w.comments = new PgCommentRepository(w.db.pool);
      w.projects = new PgProjectRepository(w.db.pool);
      w.ctx = {};
      const directory = new PgDirectoryRepository(w.db.pool);
      const acme = await directory.createOrganization('Acme');
      const alice = await directory.createUser(acme.id, {
        workosUserId: `wos_alice_${String(Math.random())}`,
        email: 'alice@acme.test',
        displayName: 'Alice',
        role: 'admin',
      });
      w.ctx.alice = { orgId: acme.id, userId: alice.id };
    });

    And('organization "Globex" with user "bob"', async () => {
      const directory = new PgDirectoryRepository(w.db.pool);
      const globex = await directory.createOrganization('Globex');
      const bob = await directory.createUser(globex.id, {
        workosUserId: `wos_bob_${String(Math.random())}`,
        email: 'bob@globex.test',
        displayName: 'Bob',
        role: 'admin',
      });
      w.ctx.bob = { orgId: globex.id, userId: bob.id };
    });

    And('"alice" has uploaded a document "runbook.md"', async () => {
      w.doc = await w.documents.create(w.ctx.alice!, {
        projectId: null,
        ownerId: w.ctx.alice!.userId,
        title: 'runbook.md',
      });
      await w.versions.append(w.ctx.alice!, {
        documentId: w.doc.id,
        contentHash: 'h1',
        byteSize: 42,
        createdBy: w.ctx.alice!.userId,
        source: 'web',
      });
    });
  });

  Scenario('A user cannot read a document belonging to another organization', ({ When, Then }) => {
    When('"bob" requests the document "runbook.md" by its id', async () => {
      w.fetched = await w.documents.byId(w.ctx.bob!, w.doc.id);
    });
    Then('the document is not found', () => {
      expect(w.fetched).toBeUndefined();
    });
  });

  Scenario('Listing documents never crosses the organization boundary', ({ When, Then }) => {
    When('"bob" lists all documents', async () => {
      w.listed = await w.documents.list(w.ctx.bob!);
    });
    Then('the list does not contain "runbook.md"', () => {
      expect(w.listed.map((d) => d.id)).not.toContain(w.doc.id);
    });
  });

  Scenario(
    'A user cannot delete a document belonging to another organization',
    ({ When, Then, And }) => {
      When('"bob" attempts to delete the document "runbook.md"', async () => {
        w.deleteResult = await w.documents.softDelete(w.ctx.bob!, w.doc.id, new Date());
      });
      Then('the deletion is refused', () => {
        expect(w.deleteResult).toBe(false);
      });
      And('"alice" still sees "runbook.md" intact', async () => {
        const doc = await w.documents.byId(w.ctx.alice!, w.doc.id);
        expect(doc?.deletedAt).toBeNull();
      });
    },
  );

  Scenario("A user cannot attach comments to another organization's document", ({ When, Then }) => {
    When('"bob" attempts to comment on the document "runbook.md"', async () => {
      w.thrown = undefined;
      try {
        const versionA = (await w.versions.listForDocument(w.ctx.alice!, w.doc.id))[0]!;
        await w.comments.create(w.ctx.bob!, {
          documentId: w.doc.id,
          versionId: versionA.id,
          authorId: w.ctx.bob!.userId,
          body: 'sneaky',
          anchor: { type: 'document' },
        });
      } catch (e) {
        w.thrown = e;
      }
    });
    Then('the comment is rejected by the database', () => {
      expect(w.thrown).toBeInstanceOf(Error);
      expect(String(w.thrown)).toMatch(/foreign key/i);
    });
  });

  Scenario('A query without a tenant context fails closed', ({ When, Then }) => {
    When('a query runs with no organization bound to the session', async () => {
      w.thrown = undefined;
      const client = await w.db.pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role vorlyn_app');
        await client.query('select * from documents');
      } catch (e) {
        w.thrown = e;
      } finally {
        await client.query('rollback');
        client.release();
      }
    });
    Then('the database returns an error instead of any rows', () => {
      expect(w.thrown).toBeInstanceOf(Error);
    });
  });

  Scenario("A user cannot tombstone another organization's version", ({ When, Then, And }) => {
    let tombstoned: unknown;
    When('"bob" attempts to purge the version of "runbook.md"', async () => {
      const versionA = (await w.versions.listForDocument(w.ctx.alice!, w.doc.id))[0]!;
      tombstoned = await w.versions.tombstone(w.ctx.bob!, versionA.id);
    });
    Then('the tombstone is refused', () => {
      expect(tombstoned).toBeUndefined();
    });
    And('"alice" still sees the version live', async () => {
      const versionA = (await w.versions.listForDocument(w.ctx.alice!, w.doc.id))[0]!;
      expect(versionA.purgedAt).toBeNull();
    });
  });

  /**
   * ADR 0008 added a new way to be allowed to write a document. This proves
   * the new right stops at the org boundary like every other one: the grant is
   * an ordinary RLS-scoped `share_grants` row, so a legitimate editor in
   * Globex is still nobody in Acme — and a grant row forged to name Acme's
   * document changes nothing, because RLS never lets the document be found in
   * the first place. Repository surface; the API and MCP twins live in
   * `packages/api/src/documents-api.test.ts` and `packages/mcp/src/server.test.ts`.
   */
  Scenario(
    "An edit grantee cannot reach another organization's document",
    ({ Given, When, Then, And }) => {
      let refused: string | undefined;
      Given('"bob" holds an edit grant on a document in his own organization', async () => {
        w.storageDir = await mkdtemp(path.join(tmpdir(), 'vorlyn-isolation-'));
        w.storage = new FsStorage(w.storageDir);
        w.uow = new PgUploadUnitOfWork(w.db.pool);
        const grants = new PgShareGrantRepository(w.db.pool);
        const directory = new PgDirectoryRepository(w.db.pool);
        const owner = await directory.createUser(w.ctx.bob!.orgId, {
          workosUserId: `wos_gowner_${String(Math.random())}`,
          email: 'gowner@globex.test',
          displayName: 'Globex owner',
          role: 'member',
        });
        const own = await w.documents.create(
          { orgId: w.ctx.bob!.orgId, userId: owner.id },
          { projectId: null, ownerId: owner.id, title: 'globex.md' },
        );
        await grants.create(w.ctx.bob!, {
          subject: { type: 'document', id: own.id },
          grantee: { type: 'user', userId: w.ctx.bob!.userId },
          permission: 'edit',
          tokenHash: null,
          createdBy: owner.id,
        });
      });
      When('"bob" attempts to upload a new version of "runbook.md"', async () => {
        const result = await uploadNewVersion(
          w.uow,
          w.storage,
          { ctx: w.ctx.bob!, role: 'member' },
          {
            documentId: w.doc.id,
            content: new TextEncoder().encode('# Tampered'),
            source: 'mcp',
          },
        );
        refused = result.ok ? 'ok' : result.error.code;
      });
      Then('the upload is refused as if the document did not exist', () => {
        expect(refused).toBe('document_not_found');
      });
      And('a forged edit grant naming "runbook.md" still gives "bob" nothing', async () => {
        // The row lands in Globex (RLS stamps bob's org), naming a subject id
        // from Acme. It buys nothing: the document is still unreadable.
        await withTenant(w.db.pool, w.ctx.bob!, (c) =>
          c.query(
            `insert into share_grants
               (org_id, subject_type, subject_id, grantee_type, grantee_user_id, permission, created_by)
             values ($1, 'document', $2, 'user', $3, 'edit', $3)`,
            [w.ctx.bob!.orgId, w.doc.id, w.ctx.bob!.userId],
          ),
        );
        const result = await uploadNewVersion(
          w.uow,
          w.storage,
          { ctx: w.ctx.bob!, role: 'member' },
          {
            documentId: w.doc.id,
            content: new TextEncoder().encode('# Tampered again'),
            source: 'mcp',
          },
        );
        expect(!result.ok && result.error.code).toBe('document_not_found');
        expect(await w.documents.byId(w.ctx.bob!, w.doc.id)).toBeUndefined();
        await rm(w.storageDir, { recursive: true, force: true });
      });
    },
  );

  /**
   * ADR 0014 added a second way to be allowed to write a document: a grant on
   * the PROJECT the document lives in, not just the document itself. This
   * proves that new right stops at the org boundary exactly like the
   * document-subject one above — a legitimate project-edit grantee in Globex
   * is still nobody in Acme, and a project grant forged to name Acme's
   * project changes nothing, because RLS never lets the document be found in
   * the first place. Repository surface; the API and MCP twins live in
   * `packages/api/src/documents-api.test.ts` and `packages/mcp/src/server.test.ts`.
   */
  Scenario(
    "A project grantee cannot reach another organization's document",
    ({ Given, When, Then, And }) => {
      let refused: string | undefined;
      let aliceProjectId: ProjectId;
      Given('"alice" filed "runbook.md" into a project of her own', async () => {
        const aliceProject = await w.projects.create(w.ctx.alice!, {
          name: 'Alice project',
          color: '#123456',
        });
        aliceProjectId = aliceProject.id;
        await w.documents.moveToProject(w.ctx.alice!, w.doc.id, aliceProjectId);
      });
      And('"bob" holds an edit grant on a project in his own organization', async () => {
        w.storageDir = await mkdtemp(path.join(tmpdir(), 'vorlyn-isolation-project-'));
        w.storage = new FsStorage(w.storageDir);
        w.uow = new PgUploadUnitOfWork(w.db.pool);
        const grants = new PgShareGrantRepository(w.db.pool);
        const globexProject = await w.projects.create(w.ctx.bob!, {
          name: 'Globex project',
          color: '#654321',
        });
        await grants.create(w.ctx.bob!, {
          subject: { type: 'project', id: globexProject.id },
          grantee: { type: 'user', userId: w.ctx.bob!.userId },
          permission: 'edit',
          tokenHash: null,
          createdBy: w.ctx.bob!.userId,
        });
      });
      When('"bob" attempts to upload a new version of "runbook.md"', async () => {
        const result = await uploadNewVersion(
          w.uow,
          w.storage,
          { ctx: w.ctx.bob!, role: 'member' },
          {
            documentId: w.doc.id,
            content: new TextEncoder().encode('# Tampered via project grant'),
            source: 'mcp',
          },
        );
        refused = result.ok ? 'ok' : result.error.code;
      });
      Then('the upload is refused as if the document did not exist', () => {
        expect(refused).toBe('document_not_found');
      });
      And('a forged project grant naming alice\'s project still gives "bob" nothing', async () => {
        // The row lands in Globex (RLS stamps bob's org), naming a project id
        // that belongs to Acme. It buys nothing: the document is still
        // unreadable, so `highestGrantFor`'s project-aware join never matches.
        const grants = new PgShareGrantRepository(w.db.pool);
        await grants.create(w.ctx.bob!, {
          subject: { type: 'project', id: aliceProjectId },
          grantee: { type: 'user', userId: w.ctx.bob!.userId },
          permission: 'edit',
          tokenHash: null,
          createdBy: w.ctx.bob!.userId,
        });
        const result = await uploadNewVersion(
          w.uow,
          w.storage,
          { ctx: w.ctx.bob!, role: 'member' },
          {
            documentId: w.doc.id,
            content: new TextEncoder().encode('# Tampered again via forged project grant'),
            source: 'mcp',
          },
        );
        expect(!result.ok && result.error.code).toBe('document_not_found');
        expect(await w.documents.byId(w.ctx.bob!, w.doc.id)).toBeUndefined();
        await rm(w.storageDir, { recursive: true, force: true });
      });
    },
  );

  Scenario("A user cannot change another organization's retention settings", ({ When, Then }) => {
    const orgs = () => new PgOrganizationRepository(w.db.pool);
    When('"bob" attempts to set his organization\'s version retention', async () => {
      // RLS scopes the UPDATE to bob's own org row; Acme is unreachable.
      await orgs().updateSettings(w.ctx.bob!, {
        versionRetention: { keepLastN: 1, keepDays: 1 },
      });
    });
    Then('"Acme" retention settings are untouched', async () => {
      const acme = await orgs().current(w.ctx.alice!);
      expect(acme?.versionRetention).toBeNull();
      const globex = await orgs().current(w.ctx.bob!);
      expect(globex?.versionRetention).toEqual({ keepLastN: 1, keepDays: 1 });
    });
  });
});
