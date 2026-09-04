import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { Actor } from '@mdloop/app';
import {
  createComment,
  createShareLink,
  createUserGrant,
  listAccessibleDocuments,
  redeemShareLink,
  requireDocumentAccess,
  resolveComment,
  revokeShareGrant,
  updateOrgSettings,
  uploadNewDocument,
} from '@mdloop/app';
import type { DocumentId, GrantId } from '@mdloop/shared';
import { withTenant } from './db.js';
import { PgOrganizationRepository } from './repositories/pg-organization-repository.js';
import {
  PgCommentRepository,
  PgDirectoryRepository,
  PgDocumentRepository,
  PgShareGrantRepository,
  PgUploadUnitOfWork,
} from './repositories/pg-repositories.js';
import { FsStorage } from './storage/fs-storage.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

const feature = await loadFeature(
  fileURLToPath(new URL('../../../features/sharing.feature', import.meta.url)),
);

interface World {
  db: TestDb;
  documents: PgDocumentRepository;
  comments: PgCommentRepository;
  grants: PgShareGrantRepository;
  orgs: PgOrganizationRepository;
  uow: PgUploadUnitOfWork;
  storage: FsStorage;
  storageDir: string;
  alice: Actor;
  mia: Actor;
  amir: Actor;
  bob: Actor;
  documentId: DocumentId;
  token: string;
  grantId: GrantId;
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

  async function canRead(actor: Actor): Promise<boolean> {
    const r = await requireDocumentAccess(w.documents, w.grants, actor, w.documentId, 'read');
    return r.ok;
  }

  async function canComment(actor: Actor): Promise<boolean> {
    const access = await requireDocumentAccess(
      w.documents,
      w.grants,
      actor,
      w.documentId,
      'comment',
    );
    if (!access.ok) return false;
    const c = await createComment(w.documents, w.comments, w.orgs, w.grants, actor, {
      documentId: w.documentId,
      body: 'check',
      anchor: { type: 'document' },
    });
    return c.ok;
  }

  async function canResolve(actor: Actor): Promise<boolean> {
    const c = await createComment(w.documents, w.comments, w.orgs, w.grants, w.alice, {
      documentId: w.documentId,
      body: 'to resolve',
      anchor: { type: 'document' },
    });
    if (!c.ok) throw new Error('setup comment');
    const r = await resolveComment(w.documents, w.comments, actor, c.value.id);
    return r.ok;
  }

  async function listsDocument(actor: Actor): Promise<boolean> {
    const docs = await listAccessibleDocuments(w.documents, w.grants, actor);
    return docs.some((d) => d.id === w.documentId);
  }

  Background(({ Given, And }) => {
    Given(
      'organization "Acme" in link mode with owner "alice", member "mia" and admin "amir"',
      async () => {
        if (!(w as Partial<World>).db) {
          w.db = await createTestDb();
          w.documents = new PgDocumentRepository(w.db.pool);
          w.comments = new PgCommentRepository(w.db.pool);
          w.grants = new PgShareGrantRepository(w.db.pool);
          w.orgs = new PgOrganizationRepository(w.db.pool);
          w.uow = new PgUploadUnitOfWork(w.db.pool);
        }
        w.storageDir = await mkdtemp(path.join(tmpdir(), 'mdloop-share-'));
        w.storage = new FsStorage(w.storageDir);
        const directory = new PgDirectoryRepository(w.db.pool);
        const acme = await directory.createOrganization('Acme');
        w.alice = await makeActor(directory, acme.id, 'alice', 'member');
        w.mia = await makeActor(directory, acme.id, 'mia', 'member');
        w.amir = await makeActor(directory, acme.id, 'amir', 'admin');
      },
    );
    And('organization "Globex" with user "bob"', async () => {
      const directory = new PgDirectoryRepository(w.db.pool);
      const globex = await directory.createOrganization('Globex');
      w.bob = await makeActor(directory, globex.id, 'bob', 'member');
    });
    And('"alice" owns a document "spec.md"', async () => {
      const result = await uploadNewDocument(w.uow, w.storage, w.alice, {
        title: 'spec.md',
        projectId: null,
        content: new TextEncoder().encode('# Spec\n\nDetails.'),
        source: 'web',
      });
      if (!result.ok) throw new Error('upload failed');
      w.documentId = result.value.document.id;
    });
  });

  Scenario('Without a grant, another member has no access at all', ({ Then }) => {
    Then('"mia" cannot read, comment on or list "spec.md"', async () => {
      expect(await canRead(w.mia)).toBe(false);
      expect(await canComment(w.mia)).toBe(false);
      expect(await listsDocument(w.mia)).toBe(false);
    });
  });

  Scenario('A read link grants reading and nothing more', ({ When, Then, But, And }) => {
    When('"alice" creates a read link and "mia" redeems it', async () => {
      const link = await createShareLink(
        w.documents,
        w.grants,
        w.orgs,
        w.alice,
        w.documentId,
        'read',
      );
      if (!link.ok) throw new Error('link failed');
      const redeemed = await redeemShareLink(w.grants, w.mia, link.value.token);
      expect(redeemed.ok).toBe(true);
    });
    Then('"mia" can read "spec.md"', async () => {
      expect(await canRead(w.mia)).toBe(true);
      expect(await listsDocument(w.mia)).toBe(true);
    });
    But('"mia" cannot comment on "spec.md"', async () => {
      expect(await canComment(w.mia)).toBe(false);
    });
    And('"mia" cannot upload a new version of "spec.md"', async () => {
      const access = await requireDocumentAccess(
        w.documents,
        w.grants,
        w.mia,
        w.documentId,
        'edit',
      );
      expect(access.ok).toBe(false);
    });
  });

  Scenario('A comment link grants commenting but never resolving', ({ When, Then, But }) => {
    When('"alice" creates a comment link and "mia" redeems it', async () => {
      const link = await createShareLink(
        w.documents,
        w.grants,
        w.orgs,
        w.alice,
        w.documentId,
        'comment',
      );
      if (!link.ok) throw new Error('link failed');
      await redeemShareLink(w.grants, w.mia, link.value.token);
    });
    Then('"mia" can comment on "spec.md"', async () => {
      expect(await canComment(w.mia)).toBe(true);
    });
    But('"mia" cannot resolve comments on "spec.md"', async () => {
      expect(await canResolve(w.mia)).toBe(false);
    });
  });

  Scenario('The org admin holds edit without any grant', ({ Then, And }) => {
    Then('"amir" can read and comment on "spec.md"', async () => {
      expect(await canRead(w.amir)).toBe(true);
      expect(await canComment(w.amir)).toBe(true);
    });
    And('"amir" can resolve comments on "spec.md"', async () => {
      expect(await canResolve(w.amir)).toBe(true);
    });
  });

  Scenario('Directory mode grants a chosen member directly', ({ Given, When, Then, And }) => {
    Given('the organization switches to directory mode', async () => {
      const r = await updateOrgSettings(w.orgs, w.amir, { sharingMode: 'directory' });
      expect(r.ok).toBe(true);
    });
    When('"alice" grants "mia" comment access', async () => {
      const granted = await createUserGrant(
        w.documents,
        w.grants,
        w.orgs,
        w.alice,
        w.documentId,
        w.mia.ctx.userId,
        'comment',
      );
      expect(granted.ok).toBe(true);
    });
    Then('"mia" can comment on "spec.md"', async () => {
      expect(await canComment(w.mia)).toBe(true);
    });
    And('creating share links is refused', async () => {
      const link = await createShareLink(
        w.documents,
        w.grants,
        w.orgs,
        w.alice,
        w.documentId,
        'read',
      );
      expect(!link.ok && link.error.code).toBe('wrong_sharing_mode');
    });
  });

  Scenario('A link from Acme is useless inside Globex', ({ When, Then, And }) => {
    When('"alice" creates a comment link', async () => {
      const link = await createShareLink(
        w.documents,
        w.grants,
        w.orgs,
        w.alice,
        w.documentId,
        'comment',
      );
      if (!link.ok) throw new Error('link failed');
      w.token = link.value.token;
    });
    Then('"bob" cannot redeem the token', async () => {
      const r = await redeemShareLink(w.grants, w.bob, w.token);
      expect(!r.ok && r.error.code).toBe('invalid_token');
    });
    And('"bob" cannot read "spec.md"', async () => {
      expect(await canRead(w.bob)).toBe(false);
    });
  });

  Scenario('Revocation cuts access immediately', ({ Given, And, When, Then }) => {
    Given('the organization switches to directory mode', async () => {
      await updateOrgSettings(w.orgs, w.amir, { sharingMode: 'directory' });
    });
    And('"alice" granted "mia" comment access', async () => {
      const granted = await createUserGrant(
        w.documents,
        w.grants,
        w.orgs,
        w.alice,
        w.documentId,
        w.mia.ctx.userId,
        'comment',
      );
      if (!granted.ok) throw new Error('grant failed');
      w.grantId = granted.value.id;
    });
    When('"alice" revokes the grant', async () => {
      const r = await revokeShareGrant(w.documents, w.grants, w.alice, w.documentId, w.grantId);
      expect(r.ok).toBe(true);
    });
    Then('"mia" cannot read, comment on or list "spec.md"', async () => {
      expect(await canRead(w.mia)).toBe(false);
      expect(await canComment(w.mia)).toBe(false);
      expect(await listsDocument(w.mia)).toBe(false);
    });
  });

  Scenario('A free-tier org cannot create a share link at all', ({ Given, Then }) => {
    // Self-contained: doesn't reuse the Background's "Acme" org, since that
    // one has to stay team-tier (default) for every other scenario in this
    // file to keep testing link-sharing mechanics rather than the free-tier
    // gate. This scenario needs its own dedicated free-tier org instead.
    let frugalActor: Actor;
    let frugalDocumentId: DocumentId;
    Given(
      'a free-tier organization "Frugal" in link mode with owner "owner" and a document "notes.md"',
      async () => {
        const directory = new PgDirectoryRepository(w.db.pool);
        const frugal = await directory.createOrganization('Frugal', 'free');
        frugalActor = await makeActor(directory, frugal.id, 'owner', 'admin');
        const result = await uploadNewDocument(w.uow, w.storage, frugalActor, {
          title: 'notes.md',
          projectId: null,
          content: new TextEncoder().encode('# Notes'),
          source: 'web',
        });
        if (!result.ok) throw new Error('upload failed');
        frugalDocumentId = result.value.document.id;
      },
    );
    Then('creating a read link is refused with "sharing_requires_paid_tier"', async () => {
      const link = await createShareLink(
        w.documents,
        w.grants,
        w.orgs,
        frugalActor,
        frugalDocumentId,
        'read',
      );
      expect(link.ok).toBe(false);
      expect(!link.ok && link.error).toEqual({ code: 'sharing_requires_paid_tier' });
    });
  });

  Scenario('The schema itself refuses an edit grant to an external guest', ({ Then }) => {
    Then(
      'inserting a share grant with permission "edit" and a guest email fails at the database',
      async () => {
        // ADR 0008 widened the permission enum, so `edit` on an internal user
        // grant is now legal. The part that is still schema-true — and the
        // part that matters most — is that no row carrying a `grantee_email`
        // (which every guest grant does, by construction) may hold `edit`.
        await expect(
          withTenant(w.db.pool, w.alice.ctx, (c) =>
            c.query(
              `insert into share_grants
                 (org_id, subject_type, subject_id, grantee_type, grantee_user_id, permission,
                  token_hash, grantee_email, created_by)
               values ($1, 'document', $2, 'user', $3, 'edit', 'tok', 'ext@partner.test', $4)`,
              [w.alice.ctx.orgId, w.documentId, w.mia.ctx.userId, w.alice.ctx.userId],
            ),
          ),
        ).rejects.toThrow(/share_grants_no_guest_edit|check constraint/i);
      },
    );
  });
});
