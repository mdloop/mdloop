import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { Actor, ReviewError } from '@mdloop/app';
import {
  createComment,
  createUserGrant,
  getReviewStatus,
  requestReview,
  resolveComment,
  revokeReviewRequest,
  submitReview,
  updateOrgSettings,
  uploadNewVersion,
} from '@mdloop/app';
import type { Approval, ApprovalVerdict, Document, Organization, User } from '@mdloop/domain';
import type { CommentId, ReviewRequestId } from '@mdloop/shared';
import { PgOrganizationRepository } from './repositories/pg-organization-repository.js';
import { PgReviewRepository } from './repositories/pg-review-repository.js';
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
  fileURLToPath(new URL('../../../features/review-signoff.feature', import.meta.url)),
);

interface World {
  db: TestDb;
  directory: PgDirectoryRepository;
  documents: PgDocumentRepository;
  grants: PgShareGrantRepository;
  comments: PgCommentRepository;
  reviews: PgReviewRepository;
  orgRepo: PgOrganizationRepository;
  uploadUow: PgUploadUnitOfWork;
  storage: FsStorage;
  storageDir: string;
  org: Organization;
  alice: Actor; // owner / admin
  users: Map<string, User>;
  actors: Map<string, Actor>;
  doc: Document;
  requestIds: Map<string, ReviewRequestId>;
  openCommentId: CommentId | undefined;
  lastResult: { ok: boolean; error?: ReviewError } | undefined;
  lastVerdictResult: Awaited<ReturnType<typeof submitReview>> | undefined;
  previousVersionId: string | undefined;
}

function reviewDeps(w: World) {
  return {
    documents: w.documents,
    grants: w.grants,
    comments: w.comments,
    orgs: w.orgRepo,
    reviews: w.reviews,
  };
}

async function actorFor(
  w: World,
  name: string,
  role: 'admin' | 'member' | 'guest',
): Promise<Actor> {
  const existing = w.actors.get(name);
  if (existing) return existing;
  const user = await w.directory.createUser(w.org.id, {
    workosUserId: `${role === 'guest' ? 'guest:' : 'wos_'}${name}_${String(Math.random())}`,
    email: `${name}@acme.test`,
    displayName: name,
    role,
  });
  w.users.set(name, user);
  const actor: Actor = { ctx: { orgId: w.org.id, userId: user.id }, role };
  w.actors.set(name, actor);
  return actor;
}

/** Grants `reviewerName` (already created via actorFor) comment access, the
 * minimum a reviewer needs before they can be requested. */
async function grantComment(w: World, reviewerName: string): Promise<void> {
  const reviewer = w.users.get(reviewerName);
  if (!reviewer) throw new Error(`actorFor must run before grantComment for "${reviewerName}"`);
  const r = await createUserGrant(
    w.documents,
    w.grants,
    w.orgRepo,
    w.alice,
    w.doc.id,
    reviewer.id,
    'comment',
  );
  if (!r.ok) throw new Error(`grant failed: ${r.error.code}`);
}

async function requestReviewer(w: World, reviewerName: string, by: Actor = w.alice): Promise<void> {
  const reviewer = w.actors.get(reviewerName)!;
  const r = await requestReview(reviewDeps(w), by, {
    documentId: w.doc.id,
    reviewerUserId: reviewer.ctx.userId,
  });
  w.lastResult = r.ok ? { ok: true } : { ok: false, error: r.error };
  if (r.ok) w.requestIds.set(reviewerName, r.value.id);
}

async function statusOf(w: World): Promise<string> {
  const r = await getReviewStatus(reviewDeps(w), w.alice, w.doc.id);
  if (!r.ok) throw new Error(`status read failed: ${r.error.code}`);
  return r.value.status;
}

async function submitVerdict(
  w: World,
  reviewerName: string,
  verdict: ApprovalVerdict,
): Promise<void> {
  const reviewer = w.actors.get(reviewerName)!;
  w.lastVerdictResult = await submitReview(reviewDeps(w), reviewer, {
    documentId: w.doc.id,
    verdict,
  });
}

describeFeature(feature, ({ Background, Scenario, AfterAllScenarios }) => {
  const w = {} as World;

  AfterAllScenarios(async () => {
    await w.db.close();
    await rm(w.storageDir, { recursive: true, force: true });
  });

  Background(({ Given }) => {
    Given('an organization "Acme" with owner "alice" and a document "spec.md"', async () => {
      if (!Object.hasOwn(w, 'db')) {
        w.db = await createTestDb();
        w.storageDir = await mkdtemp(path.join(tmpdir(), 'mdloop-review-blobs-'));
      }
      w.directory = new PgDirectoryRepository(w.db.pool);
      w.documents = new PgDocumentRepository(w.db.pool);
      w.grants = new PgShareGrantRepository(w.db.pool);
      w.comments = new PgCommentRepository(w.db.pool);
      w.reviews = new PgReviewRepository(w.db.pool);
      w.orgRepo = new PgOrganizationRepository(w.db.pool);
      w.uploadUow = new PgUploadUnitOfWork(w.db.pool);
      w.storage = new FsStorage(w.storageDir);
      w.users = new Map();
      w.actors = new Map();
      w.requestIds = new Map();
      w.openCommentId = undefined;
      w.lastResult = undefined;
      w.lastVerdictResult = undefined;
      w.previousVersionId = undefined;

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

      // Directory-mode grants (used throughout to give a reviewer access)
      // require the org's sharing mode to be 'directory'.
      const modeR = await updateOrgSettings(w.orgRepo, w.alice, { sharingMode: 'directory' });
      if (!modeR.ok) throw new Error('sharing mode setup failed');

      const created = await w.documents.create(w.alice.ctx, {
        projectId: null,
        ownerId: alice.id,
        title: 'spec.md',
      });
      const uploaded = await uploadNewVersion(w.uploadUow, w.storage, w.alice, {
        documentId: created.id,
        content: new TextEncoder().encode('# Spec\n\nReady for sign-off.'),
        source: 'web',
      });
      if (!uploaded.ok) throw new Error('setup upload failed');
      w.doc = uploaded.value.document;
    });
  });

  Scenario(
    'Owner requests a reviewer who has access, reviewer approves',
    ({ Given, When, Then }) => {
      Given('"alice" granted "bob" comment access to "spec.md"', async () => {
        await actorFor(w, 'bob', 'member');
        await grantComment(w, 'bob');
      });
      When('"alice" requests "bob" as a reviewer on "spec.md"', async () => {
        await requestReviewer(w, 'bob');
      });
      Then('the document\'s review status is "in_review"', async () => {
        expect(await statusOf(w)).toBe('in_review');
      });
      When('"bob" submits verdict "approved" on "spec.md"', async () => {
        await submitVerdict(w, 'bob', 'approved');
      });
      Then('the document\'s review status is "approved"', async () => {
        expect(await statusOf(w)).toBe('approved');
      });
    },
  );

  Scenario('A member without access cannot be requested', ({ When, Then }) => {
    When(
      '"alice" requests "carol" as a reviewer on "spec.md" without granting access',
      async () => {
        await actorFor(w, 'carol', 'member');
        await requestReviewer(w, 'carol');
      },
    );
    Then('the request is refused with "reviewer_has_no_access"', () => {
      expect(w.lastResult?.ok).toBe(false);
      expect(w.lastResult?.error?.code).toBe('reviewer_has_no_access');
    });
  });

  Scenario('A plain member cannot request a reviewer', ({ Given, When, Then }) => {
    Given('"alice" granted "bob" comment access to "spec.md"', async () => {
      await actorFor(w, 'bob', 'member');
      await grantComment(w, 'bob');
    });
    When(
      '"bob" (a member, not owner or admin) requests "bob" as a reviewer on "spec.md"',
      async () => {
        await requestReviewer(w, 'bob', w.actors.get('bob') ?? w.alice);
      },
    );
    Then('the request is refused with "forbidden"', () => {
      expect(w.lastResult?.ok).toBe(false);
      expect(w.lastResult?.error?.code).toBe('forbidden');
    });
  });

  Scenario('A guest cannot request a reviewer', ({ When, Then }) => {
    When('a guest "dana" requests a reviewer on "spec.md"', async () => {
      const dana = await actorFor(w, 'dana', 'guest');
      const r = await requestReview(reviewDeps(w), dana, {
        documentId: w.doc.id,
        reviewerUserId: dana.ctx.userId,
      });
      w.lastResult = r.ok ? { ok: true } : { ok: false, error: r.error };
    });
    Then('the request is refused with "forbidden"', () => {
      expect(w.lastResult?.ok).toBe(false);
      expect(w.lastResult?.error?.code).toBe('forbidden');
    });
  });

  Scenario(
    'A guest with a comment grant can be a requested reviewer',
    ({ Given, When, And, Then }) => {
      Given('"alice" granted guest "dana" comment access to "spec.md"', async () => {
        await actorFor(w, 'dana', 'guest');
        await grantComment(w, 'dana');
      });
      When('"alice" requests guest "dana" as a reviewer on "spec.md"', async () => {
        await requestReviewer(w, 'dana');
      });
      And('"dana" submits verdict "changes_requested" on "spec.md"', async () => {
        await submitVerdict(w, 'dana', 'changes_requested');
      });
      Then('the document\'s review status is "changes_requested"', async () => {
        expect(await statusOf(w)).toBe('changes_requested');
      });
    },
  );

  Scenario('Submitting a verdict without an active request is refused', ({ When, Then }) => {
    When('"alice" submits verdict "approved" on "spec.md" without being requested', async () => {
      await submitVerdict(w, 'alice', 'approved');
    });
    Then('the verdict is refused with "not_a_reviewer"', () => {
      expect(w.lastVerdictResult?.ok).toBe(false);
      if (!w.lastVerdictResult?.ok) expect(w.lastVerdictResult?.error.code).toBe('not_a_reviewer');
    });
  });

  Scenario('A revoked request can no longer submit a verdict', ({ Given, And, When, Then }) => {
    Given('"alice" granted "bob" comment access to "spec.md"', async () => {
      await actorFor(w, 'bob', 'member');
      await grantComment(w, 'bob');
    });
    And('"alice" requests "bob" as a reviewer on "spec.md"', async () => {
      await requestReviewer(w, 'bob');
    });
    When('"alice" revokes "bob"\'s review request on "spec.md"', async () => {
      const requestId = w.requestIds.get('bob')!;
      const r = await revokeReviewRequest(reviewDeps(w), w.alice, w.doc.id, requestId);
      if (!r.ok) throw new Error(`revoke failed: ${r.error.code}`);
    });
    Then('"bob" submitting a verdict on "spec.md" is refused with "not_a_reviewer"', async () => {
      await submitVerdict(w, 'bob', 'approved');
      expect(w.lastVerdictResult?.ok).toBe(false);
      if (!w.lastVerdictResult?.ok) expect(w.lastVerdictResult?.error.code).toBe('not_a_reviewer');
    });
  });

  Scenario(
    'The hard gate blocks approval while comments are open',
    ({ Given, And, When, Then }) => {
      Given('the org\'s approval gate is "hard"', async () => {
        const r = await updateOrgSettings(w.orgRepo, w.alice, { approvalGate: 'hard' });
        if (!r.ok) throw new Error('gate update failed');
      });
      And('"alice" granted "bob" comment access to "spec.md"', async () => {
        await actorFor(w, 'bob', 'member');
        await grantComment(w, 'bob');
      });
      And('"alice" requests "bob" as a reviewer on "spec.md"', async () => {
        await requestReviewer(w, 'bob');
      });
      And('"spec.md" has an open comment', async () => {
        const c = await createComment(w.documents, w.comments, w.orgRepo, w.grants, w.alice, {
          documentId: w.doc.id,
          body: 'please clarify',
          anchor: { type: 'document' },
        });
        if (!c.ok) throw new Error(`comment failed: ${c.error.code}`);
        w.openCommentId = c.value.id;
      });
      When('"bob" submits verdict "approved" on "spec.md"', async () => {
        await submitVerdict(w, 'bob', 'approved');
      });
      Then('the verdict is refused with "open_comments_block_approval"', () => {
        expect(w.lastVerdictResult?.ok).toBe(false);
        if (!w.lastVerdictResult?.ok) {
          expect(w.lastVerdictResult?.error.code).toBe('open_comments_block_approval');
        }
      });
      When('the open comment on "spec.md" is resolved', async () => {
        const r = await resolveComment(w.documents, w.comments, w.alice, w.openCommentId!);
        if (!r.ok) throw new Error(`resolve failed: ${r.error.code}`);
      });
      And('"bob" submits verdict "approved" on "spec.md"', async () => {
        await submitVerdict(w, 'bob', 'approved');
      });
      Then('the document\'s review status is "approved"', async () => {
        expect(await statusOf(w)).toBe('approved');
      });
    },
  );

  Scenario('The soft gate allows approval with open comments', ({ Given, And, When, Then }) => {
    Given('the org\'s approval gate is "soft"', async () => {
      const r = await updateOrgSettings(w.orgRepo, w.alice, { approvalGate: 'soft' });
      if (!r.ok) throw new Error('gate update failed');
    });
    And('"alice" granted "bob" comment access to "spec.md"', async () => {
      await actorFor(w, 'bob', 'member');
      await grantComment(w, 'bob');
    });
    And('"alice" requests "bob" as a reviewer on "spec.md"', async () => {
      await requestReviewer(w, 'bob');
    });
    And('"spec.md" has an open comment', async () => {
      const c = await createComment(w.documents, w.comments, w.orgRepo, w.grants, w.alice, {
        documentId: w.doc.id,
        body: 'minor note',
        anchor: { type: 'document' },
      });
      if (!c.ok) throw new Error(`comment failed: ${c.error.code}`);
    });
    When('"bob" submits verdict "approved" on "spec.md"', async () => {
      await submitVerdict(w, 'bob', 'approved');
    });
    Then('the document\'s review status is "approved"', async () => {
      expect(await statusOf(w)).toBe('approved');
    });
  });

  Scenario(
    'A new version drops the status back to in_review; approvals survive',
    ({ Given, And, When, Then }) => {
      Given('"alice" granted "bob" comment access to "spec.md"', async () => {
        await actorFor(w, 'bob', 'member');
        await grantComment(w, 'bob');
      });
      And('"alice" requests "bob" as a reviewer on "spec.md"', async () => {
        await requestReviewer(w, 'bob');
      });
      And('"bob" submits verdict "approved" on "spec.md"', async () => {
        await submitVerdict(w, 'bob', 'approved');
        w.previousVersionId = w.lastVerdictResult?.ok
          ? w.lastVerdictResult.value.approval.versionId
          : undefined;
      });
      When('"alice" uploads a new version of "spec.md"', async () => {
        const uploaded = await uploadNewVersion(w.uploadUow, w.storage, w.alice, {
          documentId: w.doc.id,
          content: new TextEncoder().encode('# Spec\n\nRevised after sign-off.'),
          source: 'web',
        });
        if (!uploaded.ok) throw new Error('re-upload failed');
        w.doc = uploaded.value.document;
      });
      Then('the document\'s review status is "in_review"', async () => {
        expect(await statusOf(w)).toBe('in_review');
      });
      And('"bob"\'s approval on the previous version still exists', async () => {
        const r = await getReviewStatus(reviewDeps(w), w.alice, w.doc.id);
        if (!r.ok) throw new Error('status read failed');
        const survives = r.value.approvals.some(
          (a: Approval) => a.versionId === w.previousVersionId && a.verdict === 'approved',
        );
        expect(survives).toBe(true);
      });
    },
  );

  Scenario(
    "Changes requested dominates over another reviewer's approval",
    ({ Given, And, When, Then }) => {
      Given('"alice" granted "bob" comment access to "spec.md"', async () => {
        await actorFor(w, 'bob', 'member');
        await grantComment(w, 'bob');
      });
      And('"alice" granted "carol" comment access to "spec.md"', async () => {
        await actorFor(w, 'carol', 'member');
        await grantComment(w, 'carol');
      });
      And('"alice" requests "bob" and "carol" as reviewers on "spec.md"', async () => {
        await requestReviewer(w, 'bob');
        await requestReviewer(w, 'carol');
      });
      And('"bob" submits verdict "approved" on "spec.md"', async () => {
        await submitVerdict(w, 'bob', 'approved');
      });
      When('"carol" submits verdict "changes_requested" on "spec.md"', async () => {
        await submitVerdict(w, 'carol', 'changes_requested');
      });
      Then('the document\'s review status is "changes_requested"', async () => {
        expect(await statusOf(w)).toBe('changes_requested');
      });
    },
  );

  Scenario('Tenant isolation on review state', ({ Given, And, Then }) => {
    Given('"alice" granted "bob" comment access to "spec.md"', async () => {
      await actorFor(w, 'bob', 'member');
      await grantComment(w, 'bob');
    });
    And('"alice" requests "bob" as a reviewer on "spec.md"', async () => {
      await requestReviewer(w, 'bob');
    });
    Then(
      'an actor in a different organization cannot read or write "spec.md"\'s review state',
      async () => {
        const otherOrg = await w.directory.createOrganization('Globex');
        const stranger = await w.directory.createUser(otherOrg.id, {
          workosUserId: `wos_stranger_${String(Math.random())}`,
          email: 'stranger@globex.test',
          displayName: 'stranger',
          role: 'admin',
        });
        const strangerActor: Actor = {
          ctx: { orgId: otherOrg.id, userId: stranger.id },
          role: 'admin',
        };
        const readResult = await getReviewStatus(reviewDeps(w), strangerActor, w.doc.id);
        expect(readResult.ok).toBe(false);
        if (!readResult.ok) expect(readResult.error.code).toBe('document_not_found');

        const writeResult = await submitReview(reviewDeps(w), strangerActor, {
          documentId: w.doc.id,
          verdict: 'approved',
        });
        expect(writeResult.ok).toBe(false);
        if (!writeResult.ok) expect(writeResult.error.code).toBe('document_not_found');
      },
    );
  });
});
