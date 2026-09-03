import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { Actor } from '@vorlyn/app';
import {
  createComment,
  createProject,
  createProjectGrant,
  deleteProject,
  listAccessibleDocuments,
  listProjectGrants,
  listShareGrants,
  moveDocument,
  requireDocumentAccess,
  revokeProjectGrant,
  uploadNewDocument,
} from '@vorlyn/app';
import type { DocumentId, GrantId, ProjectId } from '@vorlyn/shared';
import { withTenant } from './db.js';
import { PgOrganizationRepository } from './repositories/pg-organization-repository.js';
import {
  PgCommentRepository,
  PgDirectoryRepository,
  PgDocumentRepository,
  PgGuestUserRepository,
  PgProjectRepository,
  PgShareGrantRepository,
  PgUploadUnitOfWork,
} from './repositories/pg-repositories.js';
import { FsStorage } from './storage/fs-storage.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

const feature = await loadFeature(
  fileURLToPath(new URL('../../../features/project-sharing.feature', import.meta.url)),
);

interface World {
  db: TestDb;
  documents: PgDocumentRepository;
  comments: PgCommentRepository;
  grants: PgShareGrantRepository;
  guests: PgGuestUserRepository;
  projects: PgProjectRepository;
  orgs: PgOrganizationRepository;
  uow: PgUploadUnitOfWork;
  storage: FsStorage;
  storageDir: string;
  amir: Actor;
  dev: Actor;
  kim: Actor;
  projectId: ProjectId;
  documentId: DocumentId; // spec.md
  notesDocumentId: DocumentId;
  projectGrantId: GrantId | undefined;
  lastError: string | undefined;
  lastOk: boolean | undefined;
}

describeFeature(feature, ({ Background, Scenario, AfterAllScenarios, AfterEachScenario }) => {
  const w = {} as World;

  AfterAllScenarios(async () => {
    await w.db.close();
  });

  AfterEachScenario(async () => {
    await rm(w.storageDir, { recursive: true, force: true });
  });

  async function makeActor(
    directory: PgDirectoryRepository,
    orgId: Actor['ctx']['orgId'],
    name: string,
    role: 'admin' | 'member',
  ): Promise<Actor> {
    const user = await directory.createUser(orgId, {
      workosUserId: `wos_${name}_${String(Math.random())}`,
      email: `${name}_${String(Math.random())}@test.test`,
      displayName: name,
      role,
    });
    return { ctx: { orgId, userId: user.id }, role };
  }

  async function canComment(actor: Actor, documentId: DocumentId): Promise<boolean> {
    const access = await requireDocumentAccess(w.documents, w.grants, actor, documentId, 'comment');
    if (!access.ok) return false;
    const c = await createComment(w.documents, w.comments, w.orgs, w.grants, actor, {
      documentId,
      body: 'check',
      anchor: { type: 'document' },
    });
    return c.ok;
  }

  async function canRead(actor: Actor, documentId: DocumentId): Promise<boolean> {
    const r = await requireDocumentAccess(w.documents, w.grants, actor, documentId, 'read');
    return r.ok;
  }

  async function listsDocument(actor: Actor, documentId: DocumentId): Promise<boolean> {
    const docs = await listAccessibleDocuments(w.documents, w.grants, actor);
    return docs.some((d) => d.id === documentId);
  }

  async function grantProjectComment(): Promise<void> {
    const granted = await createProjectGrant(
      w.projects,
      w.grants,
      w.orgs,
      w.amir,
      w.projectId,
      w.kim.ctx.userId,
      'comment',
    );
    if (!granted.ok) throw new Error('setup: project grant failed');
    w.projectGrantId = granted.value.id;
  }

  Background(({ Given, And }) => {
    Given('organization "Acme" with admin "amir", member "dev" and member "kim"', async () => {
      if (!(w as Partial<World>).db) {
        w.db = await createTestDb();
        w.documents = new PgDocumentRepository(w.db.pool);
        w.comments = new PgCommentRepository(w.db.pool);
        w.grants = new PgShareGrantRepository(w.db.pool);
        w.guests = new PgGuestUserRepository(w.db.pool);
        w.projects = new PgProjectRepository(w.db.pool);
        w.orgs = new PgOrganizationRepository(w.db.pool);
        w.uow = new PgUploadUnitOfWork(w.db.pool);
      }
      w.storageDir = await mkdtemp(path.join(tmpdir(), 'vorlyn-project-sharing-'));
      w.storage = new FsStorage(w.storageDir);
      const directory = new PgDirectoryRepository(w.db.pool);
      const acme = await directory.createOrganization('Acme');
      w.amir = await makeActor(directory, acme.id, 'amir', 'admin');
      w.dev = await makeActor(directory, acme.id, 'dev', 'member');
      w.kim = await makeActor(directory, acme.id, 'kim', 'member');
    });
    And('"dev" created a project "Runbooks"', async () => {
      const created = await createProject(w.projects, w.dev, { name: 'Runbooks' });
      if (!created.ok) throw new Error('project creation failed');
      w.projectId = created.value.id;
    });
    And('"dev" filed a document "spec.md" in "Runbooks"', async () => {
      const result = await uploadNewDocument(w.uow, w.storage, w.dev, {
        title: 'spec.md',
        projectId: w.projectId,
        content: new TextEncoder().encode('# Spec\n\nDetails.'),
        source: 'web',
      });
      if (!result.ok) throw new Error('upload failed');
      w.documentId = result.value.document.id;
    });
  });

  Scenario(
    'A project grant confers its permission on every document currently in the project',
    ({ When, Then }) => {
      When('"amir" grants "kim" comment access to project "Runbooks"', grantProjectComment);
      Then('"kim" can comment on "spec.md"', async () => {
        expect(await canComment(w.kim, w.documentId)).toBe(true);
      });
    },
  );

  Scenario(
    'Moving a document out of the project drops the access the project grant was providing',
    ({ Given, When, Then }) => {
      Given('"amir" granted "kim" comment access to project "Runbooks"', grantProjectComment);
      When('"dev" moves "spec.md" out of "Runbooks"', async () => {
        const moved = await moveDocument(w.documents, w.projects, w.dev, w.documentId, null);
        expect(moved.ok).toBe(true);
      });
      Then('"kim" cannot read, comment on or list "spec.md"', async () => {
        expect(await canRead(w.kim, w.documentId)).toBe(false);
        expect(await canComment(w.kim, w.documentId)).toBe(false);
        expect(await listsDocument(w.kim, w.documentId)).toBe(false);
      });
    },
  );

  Scenario(
    'A document added to the project after the grant was created still picks it up',
    ({ Given, When, Then }) => {
      Given('"amir" granted "kim" comment access to project "Runbooks"', grantProjectComment);
      When('"dev" files a new document "notes.md" in "Runbooks"', async () => {
        const result = await uploadNewDocument(w.uow, w.storage, w.dev, {
          title: 'notes.md',
          projectId: w.projectId,
          content: new TextEncoder().encode('# Notes\n\nMore.'),
          source: 'web',
        });
        if (!result.ok) throw new Error('upload failed');
        w.notesDocumentId = result.value.document.id;
      });
      Then('"kim" can comment on "notes.md"', async () => {
        expect(await canComment(w.kim, w.notesDocumentId)).toBe(true);
      });
    },
  );

  Scenario('Deleting the project removes the grant — no dangling row', ({ Given, When, Then }) => {
    Given('"amir" granted "kim" comment access to project "Runbooks"', grantProjectComment);
    When('"amir" deletes the project "Runbooks"', async () => {
      const deleted = await deleteProject(w.projects, w.amir, w.projectId);
      expect(deleted.ok).toBe(true);
    });
    Then('the project grant no longer exists in the database', async () => {
      const { rows } = await withTenant(w.db.pool, w.amir.ctx, (c) =>
        c.query(
          `select count(*)::int as n from share_grants
             where subject_type = 'project' and subject_id = $1`,
          [w.projectId],
        ),
      );
      expect((rows[0] as { n: number }).n).toBe(0);
    });
  });

  Scenario(
    "A non-admin org member cannot create, list, or revoke a project grant, not even the project's own creator",
    ({ Then, And }) => {
      Then('"dev" cannot grant "kim" access to project "Runbooks"', async () => {
        const result = await createProjectGrant(
          w.projects,
          w.grants,
          w.orgs,
          w.dev,
          w.projectId,
          w.kim.ctx.userId,
          'read',
        );
        expect(!result.ok && result.error.code).toBe('forbidden');
      });
      And('"dev" cannot list the grants on project "Runbooks"', async () => {
        const result = await listProjectGrants(w.projects, w.grants, w.dev, w.projectId);
        expect(!result.ok && result.error.code).toBe('forbidden');
      });
      And('"dev" cannot revoke a grant on project "Runbooks"', async () => {
        const result = await revokeProjectGrant(
          w.projects,
          w.grants,
          w.dev,
          w.projectId,
          'nope' as GrantId,
        );
        expect(!result.ok && result.error.code).toBe('forbidden');
      });
    },
  );

  Scenario(
    'A guest cannot receive a share or edit project grant; read and comment are still fine',
    ({ Then, And }) => {
      Then(
        'granting a guest edit access to project "Runbooks" is refused as guest edit forbidden',
        async () => {
          const guestUser = await w.guests.createGuest(w.amir.ctx, 'ext-project@partner.test');
          const result = await createProjectGrant(
            w.projects,
            w.grants,
            w.orgs,
            w.amir,
            w.projectId,
            guestUser.id,
            'edit',
          );
          w.lastError = !result.ok ? result.error.code : undefined;
          expect(w.lastError).toBe('guest_edit_forbidden');
        },
      );
      And(
        'granting a guest share access to project "Runbooks" is refused as guest edit forbidden',
        async () => {
          const guestUser = await w.guests.createGuest(w.amir.ctx, 'ext-project2@partner.test');
          const result = await createProjectGrant(
            w.projects,
            w.grants,
            w.orgs,
            w.amir,
            w.projectId,
            guestUser.id,
            'share',
          );
          w.lastError = !result.ok ? result.error.code : undefined;
          expect(w.lastError).toBe('guest_edit_forbidden');
        },
      );
      And('granting a guest read access to project "Runbooks" succeeds', async () => {
        const guestUser = await w.guests.createGuest(w.amir.ctx, 'ext-project3@partner.test');
        const result = await createProjectGrant(
          w.projects,
          w.grants,
          w.orgs,
          w.amir,
          w.projectId,
          guestUser.id,
          'read',
        );
        w.lastOk = result.ok;
        expect(w.lastOk).toBe(true);
      });
    },
  );

  Scenario("A project grant never appears on a document's own share list", ({ Given, Then }) => {
    Given('"amir" granted "kim" comment access to project "Runbooks"', grantProjectComment);
    Then('"spec.md"\'s own share list is empty', async () => {
      // "dev" is spec.md's owner — entitled to see its own grant list.
      const listed = await listShareGrants(w.documents, w.grants, w.dev, w.documentId);
      expect(listed.ok && listed.value).toEqual([]);
    });
  });
});
