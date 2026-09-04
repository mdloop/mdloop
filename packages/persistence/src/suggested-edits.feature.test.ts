import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { Actor, SuggestionError } from '@mdloop/app';
import {
  acceptSuggestion,
  createComment,
  createUserGrant,
  listThreadsWithResolutions,
  rejectSuggestion,
  updateOrgSettings,
  uploadNewVersion,
} from '@mdloop/app';
import { createTextAnchor } from '@mdloop/domain';
import type { Comment, Document, Organization, User } from '@mdloop/domain';
import {
  PgAnchorResolutionRepository,
  PgCommentRepository,
  PgDirectoryRepository,
  PgDocumentRepository,
  PgShareGrantRepository,
  PgUploadUnitOfWork,
  PgVersionRepository,
} from './repositories/pg-repositories.js';
import { PgOrganizationRepository } from './repositories/pg-organization-repository.js';
import { FsStorage } from './storage/fs-storage.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

const feature = await loadFeature(
  fileURLToPath(new URL('../../../features/suggested-edits.feature', import.meta.url)),
);

const DOC = '# Spec\n\nThis is a draft ready for review.';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface World {
  db: TestDb;
  directory: PgDirectoryRepository;
  documents: PgDocumentRepository;
  grants: PgShareGrantRepository;
  comments: PgCommentRepository;
  versions: PgVersionRepository;
  resolutions: PgAnchorResolutionRepository;
  orgRepo: PgOrganizationRepository;
  uploadUow: PgUploadUnitOfWork;
  storage: FsStorage;
  storageDir: string;
  org: Organization;
  alice: Actor;
  users: Map<string, User>;
  actors: Map<string, Actor>;
  doc: Document;
  suggestion: Comment | undefined;
  content: string;
  acceptResult: Awaited<ReturnType<typeof acceptSuggestion>> | undefined;
  rejectResult: Awaited<ReturnType<typeof rejectSuggestion>> | undefined;
}

function acceptDeps(w: World) {
  return { documents: w.documents, comments: w.comments };
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

async function grantComment(w: World, name: string): Promise<void> {
  const user = w.users.get(name);
  if (!user) throw new Error(`actorFor must run before grantComment for "${name}"`);
  const r = await createUserGrant(
    w.documents,
    w.grants,
    w.orgRepo,
    w.alice,
    w.doc.id,
    user.id,
    'comment',
  );
  if (!r.ok) throw new Error(`grant failed: ${r.error.code}`);
}

/** `name` suggests replacing `from` with `to`, anchored in the current content. */
async function suggest(w: World, name: string, from: string, to: string): Promise<void> {
  const actor = w.actors.get(name) ?? w.alice;
  const start = w.content.indexOf(from);
  if (start < 0) throw new Error(`anchor text "${from}" not in content`);
  const anchor = createTextAnchor(w.content, start, start + from.length);
  const r = await createComment(w.documents, w.comments, w.orgRepo, w.grants, actor, {
    documentId: w.doc.id,
    body: `replace "${from}"`,
    anchor,
    proposedText: to,
  });
  if (!r.ok) throw new Error(`suggest failed: ${r.error.code}`);
  w.suggestion = r.value;
}

/**
 * Like `suggest`, but anchors the whole `sentence` containing `from` rather
 * than just the bare word. Needed for the lazy-materialization scenarios: a
 * single dissimilar word swap (e.g. "draft" -> "final") doesn't carry enough
 * shared text for the domain re-anchor pipeline's own confidence floor to
 * trust the diff-mapped location — it orphans rather than guess (Core
 * Principle 2), which would make materialization undetectable for it. A
 * wider anchor keeps most of the sentence in common across the edit, which
 * is realistic for how a suggestion's context normally looks anyway.
 */
async function suggestSentence(
  w: World,
  name: string,
  sentence: string,
  from: string,
  to: string,
): Promise<void> {
  const actor = w.actors.get(name) ?? w.alice;
  const start = w.content.indexOf(sentence);
  if (start < 0) throw new Error(`anchor text "${sentence}" not in content`);
  const anchor = createTextAnchor(w.content, start, start + sentence.length);
  const r = await createComment(w.documents, w.comments, w.orgRepo, w.grants, actor, {
    documentId: w.doc.id,
    body: `replace "${from}"`,
    anchor,
    proposedText: sentence.replace(from, to),
  });
  if (!r.ok) throw new Error(`suggest failed: ${r.error.code}`);
  w.suggestion = r.value;
}

async function doAccept(w: World, name: string): Promise<void> {
  const actor = w.actors.get(name) ?? w.alice;
  w.acceptResult = await acceptSuggestion(acceptDeps(w), actor, w.suggestion!.id, 'web');
  if (w.acceptResult.ok) {
    const refreshed = await w.documents.byId(w.alice.ctx, w.doc.id);
    if (refreshed) w.doc = refreshed;
  }
}

async function doReject(w: World, name: string): Promise<void> {
  const actor = w.actors.get(name) ?? w.alice;
  w.rejectResult = await rejectSuggestion(
    { documents: w.documents, comments: w.comments },
    actor,
    w.suggestion!.id,
  );
}

async function currentContent(w: World): Promise<string> {
  const doc = await w.documents.byId(w.alice.ctx, w.doc.id);
  const version = await w.versions.byId(w.alice.ctx, doc!.currentVersionId!);
  w.content = decoder.decode(
    await w.storage.get({ orgId: w.org.id, documentId: w.doc.id, seq: version!.seq }),
  );
  return w.content;
}

function expectAcceptRefused(w: World, code: SuggestionError['code']): void {
  expect(w.acceptResult?.ok).toBe(false);
  if (!w.acceptResult?.ok) expect(w.acceptResult?.error.code).toBe(code);
}

/** Re-fetches the suggestion fresh from the DB (ADR 0007: accept never sets
 *  `appliedVersionId` itself — only the lazy re-anchor pass does). */
async function freshSuggestion(w: World): Promise<Comment | undefined> {
  return w.comments.byId(w.alice.ctx, w.suggestion!.id);
}

async function assertNotYetApplied(w: World): Promise<void> {
  const fresh = await freshSuggestion(w);
  expect(fresh?.appliedVersionId).toBeNull();
}

/** Uploads a new version of "spec.md" via the given content and updates
 *  `w.doc`/`w.content` — shared by the two "real edit lands" steps. */
async function uploadVersion(w: World, content: string): Promise<void> {
  const up = await uploadNewVersion(w.uploadUow, w.storage, w.alice, {
    documentId: w.doc.id,
    content: encoder.encode(content),
    source: 'web',
  });
  if (!up.ok) throw new Error('re-upload failed');
  w.doc = up.value.document;
  w.content = content;
}

/** Triggers the lazy materialization check (ADR 0007) by reading threads —
 *  the side effect (markSuggestionApplied) is what scenarios assert on. */
async function readThreads(w: World): Promise<void> {
  const result = await listThreadsWithResolutions(
    w.documents,
    w.comments,
    w.versions,
    w.resolutions,
    w.storage,
    w.alice,
    w.doc.id,
  );
  if (!result.ok) throw new Error(`listThreadsWithResolutions failed: ${result.error.code}`);
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
        w.storageDir = await mkdtemp(path.join(tmpdir(), 'mdloop-suggest-blobs-'));
      }
      w.directory = new PgDirectoryRepository(w.db.pool);
      w.documents = new PgDocumentRepository(w.db.pool);
      w.grants = new PgShareGrantRepository(w.db.pool);
      w.comments = new PgCommentRepository(w.db.pool);
      w.versions = new PgVersionRepository(w.db.pool);
      w.resolutions = new PgAnchorResolutionRepository(w.db.pool);
      w.orgRepo = new PgOrganizationRepository(w.db.pool);
      w.uploadUow = new PgUploadUnitOfWork(w.db.pool);
      w.storage = new FsStorage(w.storageDir);
      w.users = new Map();
      w.actors = new Map();
      w.suggestion = undefined;
      w.acceptResult = undefined;
      w.rejectResult = undefined;
      w.content = DOC;

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
  });

  Scenario(
    'An owner accepts a suggestion — the outcome flips, the document is untouched',
    ({ When, And, Then }) => {
      When('"alice" suggests replacing "draft" with "final" on "spec.md"', async () => {
        await suggest(w, 'alice', 'draft', 'final');
      });
      And('"alice" accepts that suggestion', async () => {
        await doAccept(w, 'alice');
      });
      Then('the suggestion\'s outcome is "accepted"', () => {
        expect(w.acceptResult?.ok).toBe(true);
        if (w.acceptResult?.ok)
          expect(w.acceptResult.value.comment.suggestionOutcome).toBe('accepted');
      });
      And('the suggestion is not yet applied to any version', async () => {
        await assertNotYetApplied(w);
      });
      And('"spec.md"\'s current content still contains "draft"', async () => {
        expect(await currentContent(w)).toContain('draft');
      });
      And('"spec.md"\'s current content does not contain "final"', async () => {
        expect(await currentContent(w)).not.toContain('final');
      });
    },
  );

  Scenario('An org admin can accept a suggestion they do not own', ({ Given, And, When, Then }) => {
    Given('"alice" granted "bob" comment access to "spec.md"', async () => {
      await actorFor(w, 'bob', 'member');
      await grantComment(w, 'bob');
    });
    And('"bob" suggests replacing "draft" with "final" on "spec.md"', async () => {
      await suggest(w, 'bob', 'draft', 'final');
    });
    When('admin "alice" accepts that suggestion', async () => {
      await doAccept(w, 'alice');
    });
    Then('the suggestion\'s outcome is "accepted"', () => {
      expect(w.acceptResult?.ok).toBe(true);
      if (w.acceptResult?.ok)
        expect(w.acceptResult.value.comment.suggestionOutcome).toBe('accepted');
    });
  });

  Scenario('A guest can create a suggestion but cannot accept it', ({ Given, When, Then }) => {
    Given('"alice" granted guest "dana" comment access to "spec.md"', async () => {
      await actorFor(w, 'dana', 'guest');
      await grantComment(w, 'dana');
    });
    When('guest "dana" suggests replacing "draft" with "final" on "spec.md"', async () => {
      await suggest(w, 'dana', 'draft', 'final');
    });
    Then('the suggestion is created', () => {
      expect(w.suggestion?.kind).toBe('suggestion');
      expect(w.suggestion?.suggestionOutcome).toBe('open');
    });
    When('guest "dana" tries to accept that suggestion', async () => {
      await doAccept(w, 'dana');
    });
    Then('the accept is refused with "forbidden"', () => {
      expectAcceptRefused(w, 'forbidden');
    });
  });

  Scenario('A guest cannot reject a suggestion', ({ Given, And, When, Then }) => {
    Given('"alice" granted guest "dana" comment access to "spec.md"', async () => {
      await actorFor(w, 'dana', 'guest');
      await grantComment(w, 'dana');
    });
    And('"dana" suggests replacing "draft" with "final" on "spec.md"', async () => {
      await suggest(w, 'dana', 'draft', 'final');
    });
    When('guest "dana" tries to reject that suggestion', async () => {
      await doReject(w, 'dana');
    });
    Then('the reject is refused with "forbidden"', () => {
      expect(w.rejectResult?.ok).toBe(false);
      if (!w.rejectResult?.ok) expect(w.rejectResult?.error.code).toBe('forbidden');
    });
  });

  Scenario(
    'A plain member (not owner or admin) cannot accept a suggestion',
    ({ Given, And, When, Then }) => {
      Given('"alice" granted "bob" comment access to "spec.md"', async () => {
        await actorFor(w, 'bob', 'member');
        await grantComment(w, 'bob');
      });
      And('"bob" suggests replacing "draft" with "final" on "spec.md"', async () => {
        await suggest(w, 'bob', 'draft', 'final');
      });
      When('"bob" tries to accept that suggestion', async () => {
        await doAccept(w, 'bob');
      });
      Then('the accept is refused with "forbidden"', () => {
        expectAcceptRefused(w, 'forbidden');
      });
    },
  );

  Scenario(
    'Accepting succeeds even when the anchored text has since changed — nothing is spliced, so nothing can be guessed',
    ({ When, And, Then }) => {
      When('"alice" suggests replacing "draft" with "final" on "spec.md"', async () => {
        await suggest(w, 'alice', 'draft', 'final');
      });
      And('"alice" uploads a new version of "spec.md" that removes the anchored text', async () => {
        await uploadVersion(w, '# Spec\n\nCompletely rewritten notes about turtles and rivers.');
      });
      And('"alice" accepts that suggestion', async () => {
        await doAccept(w, 'alice');
      });
      Then('the suggestion\'s outcome is "accepted"', () => {
        expect(w.acceptResult?.ok).toBe(true);
        if (w.acceptResult?.ok)
          expect(w.acceptResult.value.comment.suggestionOutcome).toBe('accepted');
      });
      And('the suggestion is not yet applied to any version', async () => {
        await assertNotYetApplied(w);
      });
    },
  );

  Scenario('A suggestion cannot be accepted twice (double-resolve)', ({ When, And, Then }) => {
    When('"alice" suggests replacing "draft" with "final" on "spec.md"', async () => {
      await suggest(w, 'alice', 'draft', 'final');
    });
    And('"alice" accepts that suggestion', async () => {
      await doAccept(w, 'alice');
    });
    And('"alice" tries to accept that suggestion again', async () => {
      await doAccept(w, 'alice');
    });
    Then('the accept is refused with "suggestion_not_open"', () => {
      expectAcceptRefused(w, 'suggestion_not_open');
    });
  });

  Scenario(
    'A rejected suggestion is terminal and cannot then be accepted',
    ({ When, And, Then }) => {
      When('"alice" suggests replacing "draft" with "final" on "spec.md"', async () => {
        await suggest(w, 'alice', 'draft', 'final');
      });
      And('"alice" rejects that suggestion', async () => {
        await doReject(w, 'alice');
      });
      Then('the suggestion\'s outcome is "rejected"', () => {
        expect(w.rejectResult?.ok).toBe(true);
        if (w.rejectResult?.ok) expect(w.rejectResult.value.suggestionOutcome).toBe('rejected');
      });
      When('"alice" tries to accept that suggestion', async () => {
        await doAccept(w, 'alice');
      });
      Then('the accept is refused with "suggestion_not_open"', () => {
        expectAcceptRefused(w, 'suggestion_not_open');
      });
    },
  );

  Scenario('Tenant isolation on suggestions', ({ Given, Then }) => {
    Given('"alice" suggests replacing "draft" with "final" on "spec.md"', async () => {
      await suggest(w, 'alice', 'draft', 'final');
    });
    Then(
      'an actor in a different organization cannot accept or reject that suggestion',
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
        const accept = await acceptSuggestion(
          acceptDeps(w),
          strangerActor,
          w.suggestion!.id,
          'web',
        );
        expect(accept.ok).toBe(false);
        if (!accept.ok) expect(accept.error.code).toBe('comment_not_found');
        const reject = await rejectSuggestion(
          { documents: w.documents, comments: w.comments },
          strangerActor,
          w.suggestion!.id,
        );
        expect(reject.ok).toBe(false);
        if (!reject.ok) expect(reject.error.code).toBe('comment_not_found');
      },
    );
  });

  Scenario(
    'An accepted suggestion is marked applied once a matching real edit lands',
    ({ When, And, Then }) => {
      When('"alice" suggests replacing "draft" with "final" on "spec.md"', async () => {
        // Wide (whole-sentence) anchor — see suggestSentence's doc comment for
        // why the bare word alone isn't enough for the pipeline to trust here.
        await suggestSentence(w, 'alice', 'This is a draft ready for review.', 'draft', 'final');
      });
      And('"alice" accepts that suggestion', async () => {
        await doAccept(w, 'alice');
      });
      And(
        '"alice" uploads a new version of "spec.md" that replaces "draft" with "final"',
        async () => {
          await uploadVersion(w, DOC.replace('draft', 'final'));
        },
      );
      And("the document's threads are read", async () => {
        await readThreads(w);
      });
      Then('the suggestion\'s outcome is "accepted"', async () => {
        const fresh = await freshSuggestion(w);
        expect(fresh?.suggestionOutcome).toBe('accepted');
      });
      And('the suggestion is applied to that new version', async () => {
        const fresh = await freshSuggestion(w);
        expect(fresh?.appliedVersionId).toBe(w.doc.currentVersionId);
      });
    },
  );

  Scenario(
    "An accepted suggestion stays pending when a real edit doesn't match the proposal",
    ({ When, And, Then }) => {
      When('"alice" suggests replacing "draft" with "final" on "spec.md"', async () => {
        await suggest(w, 'alice', 'draft', 'final');
      });
      And('"alice" accepts that suggestion', async () => {
        await doAccept(w, 'alice');
      });
      And(
        '"alice" uploads a new version of "spec.md" that is unrelated to the suggestion',
        async () => {
          await uploadVersion(w, `${DOC}\n\nUnrelated addendum about deploy timing.`);
        },
      );
      And("the document's threads are read", async () => {
        await readThreads(w);
      });
      Then('the suggestion\'s outcome is "accepted"', async () => {
        const fresh = await freshSuggestion(w);
        expect(fresh?.suggestionOutcome).toBe('accepted');
      });
      And('the suggestion is not yet applied to any version', async () => {
        await assertNotYetApplied(w);
      });
    },
  );
});
