import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { Actor, FeedbackBundle, UploadResult } from '@vorlyn/app';
import {
  actorForApiKey,
  addReply,
  createApiKey,
  createComment,
  getFeedbackBundle,
  getReviewStatus,
  requestReview,
  resolveComment,
  submitReview,
  uploadNewDocument,
  uploadNewVersion,
} from '@vorlyn/app';
import type { Document, Organization } from '@vorlyn/domain';
import { createTextAnchor } from '@vorlyn/domain';
import type { CommentId } from '@vorlyn/shared';
import { PgApiKeyRepository } from './repositories/pg-api-key-repository.js';
import { PgOrganizationRepository } from './repositories/pg-organization-repository.js';
import { PgReviewRepository } from './repositories/pg-review-repository.js';
import {
  PgAnchorResolutionRepository,
  PgCommentRepository,
  PgDirectoryRepository,
  PgDocumentRepository,
  PgShareGrantRepository,
  PgUploadUnitOfWork,
  PgVersionRepository,
} from './repositories/pg-repositories.js';
import { FsStorage } from './storage/fs-storage.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

const feature = await loadFeature(
  fileURLToPath(new URL('../../../features/agent-publish-review.feature', import.meta.url)),
);

const DRAFT = `# Refund policy

Refunds are issued within 30 days of purchase.
`;

const REVISION = `# Refund policy

Refunds are issued within 14 days of purchase, minus processing fees.
`;

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

interface World {
  db: TestDb;
  directory: PgDirectoryRepository;
  documents: PgDocumentRepository;
  versions: PgVersionRepository;
  resolutions: PgAnchorResolutionRepository;
  grants: PgShareGrantRepository;
  comments: PgCommentRepository;
  reviews: PgReviewRepository;
  keys: PgApiKeyRepository;
  orgs: PgOrganizationRepository;
  uow: PgUploadUnitOfWork;
  storage: FsStorage;
  storageDir: string;
  org: Organization;
  /** The human reviewer — an ordinary org admin using the web app. */
  alice: Actor;
  /**
   * The agent. Deliberately resolved from an API key string and nothing else:
   * this actor is the whole of the agent's state, and there is no filesystem,
   * checkout or manifest behind it.
   */
  agent: Actor;
  doc: Document;
  secondDoc: Document;
  lastUpload: UploadResult;
  bundle: FeedbackBundle;
  commentId: CommentId;
}

function reviewDeps(w: World) {
  return {
    documents: w.documents,
    grants: w.grants,
    comments: w.comments,
    orgs: w.orgs,
    reviews: w.reviews,
  };
}

/** Publishes a brand-new document as the agent: no document id, no path. */
async function agentPublishes(w: World, title: string, content: string): Promise<UploadResult> {
  const result = await uploadNewDocument(w.uow, w.storage, w.agent, {
    title,
    projectId: null,
    content: bytes(content),
    source: 'mcp',
    changeNote: 'First draft from the support agent.',
  });
  if (!result.ok) throw new Error(`publish failed: ${result.error.code}`);
  return result.value;
}

async function statusFor(w: World, actor: Actor, documentId = w.doc.id): Promise<string> {
  const r = await getReviewStatus(reviewDeps(w), actor, documentId);
  if (!r.ok) throw new Error(`status read failed: ${r.error.code}`);
  return r.value.status;
}

/** Resolves an Actor the way the MCP transport does: from the key string alone. */
async function actorFromKeyOf(w: World, owner: Actor, name: string): Promise<Actor> {
  const created = await createApiKey(w.keys, owner, name);
  if (!created.ok) throw new Error(`key creation failed: ${created.error.code}`);
  const resolved = await actorForApiKey(w.keys, created.value.key);
  if (!resolved) throw new Error('api key did not resolve to an actor');
  return resolved;
}

describeFeature(feature, ({ Background, Scenario, AfterAllScenarios }) => {
  const w = {} as World;

  AfterAllScenarios(async () => {
    await w.db.close();
    await rm(w.storageDir, { recursive: true, force: true });
  });

  Background(({ Given, And }) => {
    Given('an organization "Acme" with human admin "alice" and agent user "atlas"', async () => {
      if (!Object.hasOwn(w, 'db')) {
        w.db = await createTestDb();
        w.storageDir = await mkdtemp(path.join(tmpdir(), 'vorlyn-agent-publish-blobs-'));
      }
      w.directory = new PgDirectoryRepository(w.db.pool);
      w.documents = new PgDocumentRepository(w.db.pool);
      w.versions = new PgVersionRepository(w.db.pool);
      w.resolutions = new PgAnchorResolutionRepository(w.db.pool);
      w.grants = new PgShareGrantRepository(w.db.pool);
      w.comments = new PgCommentRepository(w.db.pool);
      w.reviews = new PgReviewRepository(w.db.pool);
      w.keys = new PgApiKeyRepository(w.db.pool);
      w.orgs = new PgOrganizationRepository(w.db.pool);
      w.uow = new PgUploadUnitOfWork(w.db.pool);
      w.storage = new FsStorage(w.storageDir);

      w.org = await w.directory.createOrganization('Acme');
      const alice = await w.directory.createUser(w.org.id, {
        workosUserId: `wos_alice_${String(Math.random())}`,
        email: 'alice@acme.test',
        displayName: 'alice',
        role: 'admin',
      });
      w.alice = { ctx: { orgId: w.org.id, userId: alice.id }, role: 'admin' };
      const atlas = await w.directory.createUser(w.org.id, {
        workosUserId: `wos_atlas_${String(Math.random())}`,
        email: 'atlas@acme.test',
        displayName: 'atlas',
        role: 'member',
      });
      w.agent = { ctx: { orgId: w.org.id, userId: atlas.id }, role: 'member' };
    });

    And('the agent holds only "atlas"\'s API key — no repo, no checkout, no CLI', async () => {
      // Everything after this point runs as an Actor reconstructed from a key
      // string, exactly as `packages/mcp` does per request. No path, manifest
      // or working directory is available to any step in this feature.
      w.agent = await actorFromKeyOf(w, w.agent, 'atlas-agent');
      expect(w.agent.apiKeyId).toBeDefined();
    });
  });

  Scenario('An agent with no local state publishes a fresh document', ({ When, Then, And }) => {
    When('the agent uploads "policy.md" with no document id and no repo path', async () => {
      w.lastUpload = await agentPublishes(w, 'policy.md', DRAFT);
      w.doc = w.lastUpload.document;
    });
    Then('the document exists with source "mcp"', async () => {
      const stored = await w.documents.byId(w.agent.ctx, w.doc.id);
      expect(stored?.title).toBe('policy.md');
      expect(w.lastUpload.version.source).toBe('mcp');
    });
    And('the document carries no repo path', () => {
      expect(w.lastUpload.document.path).toBeNull();
    });
    And("the version is attributed to the agent's API key", () => {
      expect(w.lastUpload.version.viaApiKeyId).toBe(w.agent.apiKeyId);
    });
  });

  Scenario(
    'The agent drives publish, review, revision and sign-off over MCP alone',
    ({ Given, When, Then, And }) => {
      Given('the agent has published "policy.md"', async () => {
        w.lastUpload = await agentPublishes(w, 'policy.md', DRAFT);
        w.doc = w.lastUpload.document;
      });
      When('the agent requests "alice" as a reviewer on "policy.md"', async () => {
        const r = await requestReview(reviewDeps(w), w.agent, {
          documentId: w.doc.id,
          reviewerUserId: w.alice.ctx.userId,
        });
        if (!r.ok) throw new Error(`request failed: ${r.error.code}`);
      });
      Then('the review status the agent polls is "in_review"', async () => {
        expect(await statusFor(w, w.agent)).toBe('in_review');
      });
      When('"alice" comments on "policy.md" and submits verdict "changes_requested"', async () => {
        const quoteStart = DRAFT.indexOf('30 days');
        const c = await createComment(w.documents, w.comments, w.orgs, w.grants, w.alice, {
          documentId: w.doc.id,
          body: 'Legal says 14 days, not 30.',
          anchor: createTextAnchor(DRAFT, quoteStart, quoteStart + '30 days'.length),
        });
        if (!c.ok) throw new Error(`comment failed: ${c.error.code}`);
        w.commentId = c.value.id;
        const v = await submitReview(reviewDeps(w), w.alice, {
          documentId: w.doc.id,
          verdict: 'changes_requested',
        });
        if (!v.ok) throw new Error(`verdict failed: ${v.error.code}`);
      });
      Then(
        'the agent\'s feedback bundle carries "alice"\'s open comment and sign-off status "changes_requested"',
        async () => {
          const r = await getFeedbackBundle(
            w.documents,
            w.comments,
            w.versions,
            w.resolutions,
            w.storage,
            w.grants,
            w.reviews,
            w.orgs,
            w.agent,
            w.doc.id,
          );
          if (!r.ok) throw new Error(`bundle failed: ${r.error.code}`);
          w.bundle = r.value;
          expect(w.bundle.openCount).toBe(1);
          expect(w.bundle.items[0]?.body).toBe('Legal says 14 days, not 30.');
          expect(w.bundle.items[0]?.quote).toBe('30 days');
          expect(w.bundle.review.status).toBe('changes_requested');
        },
      );
      When('the agent uploads a revision of "policy.md" by document id alone', async () => {
        const r = await uploadNewVersion(w.uow, w.storage, w.agent, {
          documentId: w.doc.id,
          content: bytes(REVISION),
          source: 'mcp',
          changeNote: "Cut the refund window to 14 days per alice's comment.",
        });
        if (!r.ok) throw new Error(`revision failed: ${r.error.code}`);
        expect(r.value.deduplicated).toBe(false);
        w.lastUpload = r.value;
      });
      And('the agent replies to "alice"\'s comment and resolves the thread', async () => {
        const reply = await addReply(
          w.documents,
          w.comments,
          w.grants,
          w.agent,
          w.commentId,
          'Done — 14 days, with processing fees called out.',
        );
        if (!reply.ok) throw new Error(`reply failed: ${reply.error.code}`);
        const resolved = await resolveComment(w.documents, w.comments, w.agent, w.commentId);
        if (!resolved.ok) throw new Error(`resolve failed: ${resolved.error.code}`);
      });
      Then('the review status the agent polls is back to "in_review"', async () => {
        // The approval pinned the previous version, so a revision reopens the
        // question without touching the still-active request (ADR 0002).
        expect(await statusFor(w, w.agent)).toBe('in_review');
      });
      When('"alice" submits verdict "approved" on "policy.md"', async () => {
        const v = await submitReview(reviewDeps(w), w.alice, {
          documentId: w.doc.id,
          verdict: 'approved',
        });
        if (!v.ok) throw new Error(`verdict failed: ${v.error.code}`);
      });
      Then('the review status the agent polls is "approved"', async () => {
        expect(await statusFor(w, w.agent)).toBe('approved');
      });
      And(
        'every version of "policy.md" has source "mcp" and the document still has no repo path',
        async () => {
          const all = await w.versions.listForDocument(w.agent.ctx, w.doc.id);
          expect(all).toHaveLength(2);
          expect(all.every((v) => v.source === 'mcp')).toBe(true);
          expect(all.every((v) => v.viaApiKeyId === w.agent.apiKeyId)).toBe(true);
          const stored = await w.documents.byId(w.agent.ctx, w.doc.id);
          expect(stored?.path).toBeNull();
        },
      );
    },
  );

  Scenario('Document identity is the document id, never a path', ({ Given, When, Then, And }) => {
    Given('the agent has published "policy.md"', async () => {
      w.lastUpload = await agentPublishes(w, 'policy.md', DRAFT);
      w.doc = w.lastUpload.document;
    });
    When('the agent publishes a second document "runbook.md", also with no repo path', async () => {
      w.secondDoc = (
        await agentPublishes(w, 'runbook.md', '# Runbook\n\nRestart the worker.\n')
      ).document;
    });
    Then('both documents exist with distinct ids and no repo path', () => {
      expect(w.secondDoc.id).not.toBe(w.doc.id);
      expect(w.doc.path).toBeNull();
      expect(w.secondDoc.path).toBeNull();
    });
    And("the agent reads each document's review state by id alone", async () => {
      expect(await statusFor(w, w.agent, w.doc.id)).toBe('draft');
      expect(await statusFor(w, w.agent, w.secondDoc.id)).toBe('draft');
    });
  });

  Scenario(
    'Tenant isolation holds for an agent key from another organization',
    ({ Given, Then }) => {
      Given('the agent has published "policy.md"', async () => {
        w.lastUpload = await agentPublishes(w, 'policy.md', DRAFT);
        w.doc = w.lastUpload.document;
      });
      Then(
        'an agent key issued in a different organization cannot read or revise "policy.md"',
        async () => {
          const otherOrg = await w.directory.createOrganization('Globex');
          const mallory = await w.directory.createUser(otherOrg.id, {
            workosUserId: `wos_mallory_${String(Math.random())}`,
            email: 'mallory@globex.test',
            displayName: 'mallory',
            role: 'admin',
          });
          const outsider = await actorFromKeyOf(
            w,
            { ctx: { orgId: otherOrg.id, userId: mallory.id }, role: 'admin' },
            'globex-agent',
          );

          const read = await getFeedbackBundle(
            w.documents,
            w.comments,
            w.versions,
            w.resolutions,
            w.storage,
            w.grants,
            w.reviews,
            w.orgs,
            outsider,
            w.doc.id,
          );
          expect(read.ok).toBe(false);
          if (!read.ok) expect(read.error.code).toBe('document_not_found');

          const write = await uploadNewVersion(w.uow, w.storage, outsider, {
            documentId: w.doc.id,
            content: bytes(REVISION),
            source: 'mcp',
          });
          expect(write.ok).toBe(false);
          if (!write.ok) expect(write.error.code).toBe('document_not_found');
        },
      );
    },
  );
});
