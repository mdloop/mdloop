import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { Actor, CommentSearchHit } from '@vorlyn/app';
import {
  createComment,
  createUserGrant,
  searchComments,
  updateOrgSettings,
  uploadNewVersion,
} from '@vorlyn/app';
import type { Comment, Document, Organization, User } from '@vorlyn/domain';
import {
  PgCommentRepository,
  PgDirectoryRepository,
  PgDocumentRepository,
  PgSearchRepository,
  PgShareGrantRepository,
  PgUploadUnitOfWork,
} from './repositories/pg-repositories.js';
import { PgOrganizationRepository } from './repositories/pg-organization-repository.js';
import { FsStorage } from './storage/fs-storage.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

const feature = await loadFeature(
  fileURLToPath(new URL('../../../features/comment-search.feature', import.meta.url)),
);

const DOC = '# Spec\n\nThis is a draft ready for review.';
const encoder = new TextEncoder();

interface World {
  db: TestDb;
  directory: PgDirectoryRepository;
  documents: PgDocumentRepository;
  grants: PgShareGrantRepository;
  comments: PgCommentRepository;
  search: PgSearchRepository;
  orgRepo: PgOrganizationRepository;
  uploadUow: PgUploadUnitOfWork;
  storage: FsStorage;
  storageDir: string;
  org: Organization;
  alice: Actor;
  users: Map<string, User>;
  actors: Map<string, Actor>;
  doc: Document;
  comment: Comment | undefined;
  results: CommentSearchHit[];
}

async function actorFor(w: World, name: string, role: 'admin' | 'member'): Promise<Actor> {
  const existing = w.actors.get(name);
  if (existing) return existing;
  const user = await w.directory.createUser(w.org.id, {
    workosUserId: `wos_${name}_${String(Math.random())}`,
    email: `${name}@acme.test`,
    displayName: name,
    role,
  });
  w.users.set(name, user);
  const actor: Actor = { ctx: { orgId: w.org.id, userId: user.id }, role };
  w.actors.set(name, actor);
  return actor;
}

async function runSearch(w: World, actor: Actor, query: string): Promise<void> {
  const r = await searchComments(w.search, actor, query);
  if (!r.ok) throw new Error(`search failed: ${r.error.code}`);
  w.results = r.value;
}

describeFeature(feature, ({ Background, Scenario, AfterAllScenarios }) => {
  const w = {} as World;

  AfterAllScenarios(async () => {
    await w.db.close();
    await rm(w.storageDir, { recursive: true, force: true });
  });

  Background(({ Given, And }) => {
    Given('an organization "Acme" with owner "alice" and a document "spec.md"', async () => {
      if (!Object.hasOwn(w, 'db')) {
        w.db = await createTestDb();
        w.storageDir = await mkdtemp(path.join(tmpdir(), 'vorlyn-csearch-blobs-'));
      }
      w.directory = new PgDirectoryRepository(w.db.pool);
      w.documents = new PgDocumentRepository(w.db.pool);
      w.grants = new PgShareGrantRepository(w.db.pool);
      w.comments = new PgCommentRepository(w.db.pool);
      w.search = new PgSearchRepository(w.db.pool);
      w.orgRepo = new PgOrganizationRepository(w.db.pool);
      w.uploadUow = new PgUploadUnitOfWork(w.db.pool);
      w.storage = new FsStorage(w.storageDir);
      w.users = new Map();
      w.actors = new Map();
      w.comment = undefined;
      w.results = [];

      w.org = await w.directory.createOrganization('Acme');
      const alice = await w.directory.createUser(w.org.id, {
        workosUserId: `wos_alice_${String(Math.random())}`,
        email: 'alice@acme.test',
        displayName: 'alice',
        role: 'admin',
      });
      w.alice = { ctx: { orgId: w.org.id, userId: alice.id }, role: 'admin' };
      w.users.set('alice', alice);
      w.actors.set('alice', w.alice);

      const modeR = await updateOrgSettings(w.orgRepo, w.alice, { sharingMode: 'directory' });
      if (!modeR.ok) throw new Error('sharing mode setup failed');

      const created = await w.documents.create(w.alice.ctx, {
        projectId: null,
        ownerId: alice.id,
        title: 'spec.md',
      });
      const uploaded = await uploadNewVersion(w.uploadUow, w.storage, w.alice, {
        documentId: created.id,
        content: encoder.encode(DOC),
        source: 'web',
      });
      if (!uploaded.ok) throw new Error('setup upload failed');
      w.doc = uploaded.value.document;
    });
    And('"alice" left a comment "the rollback path is unclear" on "spec.md"', async () => {
      const r = await createComment(w.documents, w.comments, w.orgRepo, w.grants, w.alice, {
        documentId: w.doc.id,
        body: 'the rollback path is unclear',
        anchor: { type: 'document' },
      });
      if (!r.ok) throw new Error(`comment failed: ${r.error.code}`);
      w.comment = r.value;
    });
  });

  Scenario('The owner finds their own comment by its body', ({ When, Then }) => {
    When('"alice" searches comments for "rollback"', async () => {
      await runSearch(w, w.alice, 'rollback');
    });
    Then('the comment on "spec.md" is in the results', () => {
      expect(w.results.map((h) => h.commentId)).toContain(w.comment!.id);
    });
  });

  Scenario('A comment never leaks to another organization', ({ When, Then }) => {
    When('a searcher in a different organization searches comments for "rollback"', async () => {
      const other = await w.directory.createOrganization('Globex');
      const stranger = await w.directory.createUser(other.id, {
        workosUserId: `wos_stranger_${String(Math.random())}`,
        email: 'stranger@globex.test',
        displayName: 'stranger',
        role: 'admin',
      });
      await runSearch(
        w,
        { ctx: { orgId: other.id, userId: stranger.id }, role: 'admin' },
        'rollback',
      );
    });
    Then('the search returns nothing', () => {
      expect(w.results).toHaveLength(0);
    });
  });

  Scenario(
    'A same-org member without a grant cannot find the comment, but an admin can',
    ({ Given, When, Then }) => {
      Given('a member "carol" in "Acme" with no grant on "spec.md"', async () => {
        await actorFor(w, 'carol', 'member');
      });
      When('"carol" searches comments for "rollback"', async () => {
        await runSearch(w, w.actors.get('carol')!, 'rollback');
      });
      Then('the search returns nothing', () => {
        expect(w.results).toHaveLength(0);
      });
      When('admin "dave" searches comments for "rollback"', async () => {
        const dave = await actorFor(w, 'dave', 'admin');
        await runSearch(w, dave, 'rollback');
      });
      Then('admin "dave" sees the comment on "spec.md"', () => {
        expect(w.results.map((h) => h.commentId)).toContain(w.comment!.id);
      });
      When('"alice" grants "carol" comment access to "spec.md"', async () => {
        const carol = w.users.get('carol')!;
        const r = await createUserGrant(
          w.documents,
          w.grants,
          w.orgRepo,
          w.alice,
          w.doc.id,
          carol.id,
          'comment',
        );
        if (!r.ok) throw new Error(`grant failed: ${r.error.code}`);
      });
      Then('"carol" can now find the comment on "spec.md"', async () => {
        await runSearch(w, w.actors.get('carol')!, 'rollback');
        expect(w.results.map((h) => h.commentId)).toContain(w.comment!.id);
      });
    },
  );

  Scenario('A soft-deleted comment drops out of search', ({ When, And, Then }) => {
    When('"alice" deletes that comment', async () => {
      const ok = await w.comments.delete(w.alice.ctx, w.comment!.id);
      expect(ok).toBe(true);
    });
    And('"alice" searches comments for "rollback"', async () => {
      await runSearch(w, w.alice, 'rollback');
    });
    Then('the search returns nothing', () => {
      expect(w.results).toHaveLength(0);
    });
  });
});
