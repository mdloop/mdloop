import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { Actor, ThreadWithResolution } from '@vorlyn/app';
import {
  createComment,
  listThreadsWithResolutions,
  uploadNewDocument,
  uploadNewVersion,
} from '@vorlyn/app';
import { createTextAnchor } from '@vorlyn/domain';
import type { DocumentId } from '@vorlyn/shared';
import { withTenant } from './db.js';
import { PgOrganizationRepository } from './repositories/pg-organization-repository.js';
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
  fileURLToPath(new URL('../../../features/comments-never-lie.feature', import.meta.url)),
);

const RETRY = 'The payment flow retries twice before failing with an error.';
const BALANCES = 'Balances are computed as materialized views refreshed every minute.';
const BACKOFF = 'Backoff uses exponential delay with jitter.';

const V1 = `# Design

## Retries

${RETRY}

${BACKOFF}

## Balances

${BALANCES}

${BACKOFF}
`;

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

interface World {
  db: TestDb;
  documents: PgDocumentRepository;
  grants: PgShareGrantRepository;
  comments: PgCommentRepository;
  versions: PgVersionRepository;
  resolutions: PgAnchorResolutionRepository;
  storage: FsStorage;
  storageDir: string;
  uow: PgUploadUnitOfWork;
  orgs: PgOrganizationRepository;
  alice: Actor;
  documentId: DocumentId;
  currentSource: string;
  threads: ThreadWithResolution[];
  firstComputedAt: Date;
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

  async function comment(quote: string, occurrence = 0): Promise<void> {
    let start = V1.indexOf(quote);
    for (let i = 0; i < occurrence; i++) start = V1.indexOf(quote, start + 1);
    const result = await createComment(w.documents, w.comments, w.orgs, w.grants, w.alice, {
      documentId: w.documentId,
      body: 'please check',
      anchor: createTextAnchor(V1, start, start + quote.length),
    });
    if (!result.ok) throw new Error(`comment failed: ${result.error.code}`);
  }

  async function newVersion(content: string): Promise<void> {
    const result = await uploadNewVersion(w.uow, w.storage, w.alice, {
      documentId: w.documentId,
      content: bytes(content),
      source: 'web',
    });
    if (!result.ok) throw new Error(`version failed: ${result.error.code}`);
    w.currentSource = content;
  }

  async function list(): Promise<ThreadWithResolution[]> {
    const result = await listThreadsWithResolutions(
      w.documents,
      w.comments,
      w.versions,
      w.resolutions,
      w.storage,
      w.alice,
      w.documentId,
    );
    if (!result.ok) throw new Error(`list failed: ${result.error.code}`);
    w.threads = result.value.threads;
    return result.value.threads;
  }

  function resolution() {
    const first = w.threads[0];
    if (!first) throw new Error('no threads');
    return first.resolution;
  }

  Background(({ Given, And }) => {
    Given('organization "Acme" with user "alice"', async () => {
      if (!(w as Partial<World>).db) {
        w.db = await createTestDb();
        w.documents = new PgDocumentRepository(w.db.pool);
        w.grants = new PgShareGrantRepository(w.db.pool);
        w.comments = new PgCommentRepository(w.db.pool);
        w.versions = new PgVersionRepository(w.db.pool);
        w.resolutions = new PgAnchorResolutionRepository(w.db.pool);
        w.uow = new PgUploadUnitOfWork(w.db.pool);
        w.orgs = new PgOrganizationRepository(w.db.pool);
      }
      w.storageDir = await mkdtemp(path.join(tmpdir(), 'vorlyn-cnl-'));
      w.storage = new FsStorage(w.storageDir);
      const directory = new PgDirectoryRepository(w.db.pool);
      const org = await directory.createOrganization('Acme');
      const alice = await directory.createUser(org.id, {
        workosUserId: `wos_alice_${String(Math.random())}`,
        email: `alice_${String(Math.random())}@acme.test`,
        displayName: 'Alice',
        role: 'member',
      });
      w.alice = { ctx: { orgId: org.id, userId: alice.id }, role: 'member' };
    });
    And(
      '"alice" has uploaded "design.md" containing a retry paragraph, a balances paragraph and a duplicated backoff line',
      async () => {
        const result = await uploadNewDocument(w.uow, w.storage, w.alice, {
          title: 'design.md',
          projectId: null,
          content: bytes(V1),
          source: 'web',
        });
        if (!result.ok) throw new Error('upload failed');
        w.documentId = result.value.document.id;
        w.currentSource = V1;
      },
    );
  });

  Scenario(
    'A comment on unchanged text that moved sections re-anchors exactly',
    ({ Given, When, Then }) => {
      Given('"alice" commented on the balances paragraph', async () => {
        await comment(BALANCES);
      });
      When('a new version moves the balances paragraph to the top', async () => {
        await newVersion(`# Design

## Balances

${BALANCES}

## Retries

${RETRY}

${BACKOFF}
`);
      });
      Then('the comment re-anchors with method "exact" and confidence 1', async () => {
        await list();
        expect(resolution()).toMatchObject({ method: 'exact', confidence: 1 });
        const r = resolution();
        expect(w.currentSource.slice(r.start ?? 0, r.end ?? 0)).toBe(BALANCES);
      });
    },
  );

  Scenario(
    'A comment on lightly edited text re-anchors fuzzily with honest confidence',
    ({ Given, When, Then, And }) => {
      Given('"alice" commented on the retry paragraph', async () => {
        await comment(RETRY);
      });
      When('a new version rewords the retry paragraph', async () => {
        await newVersion(
          V1.replace(RETRY, 'The payment flow retries three times before failing with a warning.'),
        );
      });
      Then('the comment re-anchors with method "fuzzy"', async () => {
        await list();
        expect(resolution().method).toBe('fuzzy');
      });
      And('the confidence is at least 0.6 and below 1', () => {
        expect(resolution().confidence).toBeGreaterThanOrEqual(0.6);
        expect(resolution().confidence).toBeLessThan(1);
      });
      And('the resolved range covers the reworded paragraph', () => {
        const r = resolution();
        expect(w.currentSource.slice(r.start ?? 0, r.end ?? 0)).toContain('retries three times');
      });
    },
  );

  Scenario(
    'A comment on deleted text becomes an orphan, never a guess',
    ({ Given, When, Then, And }) => {
      Given('"alice" commented on the retry paragraph', async () => {
        await comment(RETRY);
      });
      When('a new version deletes the retry paragraph entirely', async () => {
        await newVersion(`# Design

## Balances

${BALANCES}
`);
      });
      Then('the comment resolves as an orphan with confidence below 0.6', async () => {
        await list();
        expect(resolution().method).toBe('orphan');
        expect(resolution().confidence).toBeLessThan(0.6);
      });
      And('the orphan has no resolved range', () => {
        expect(resolution().start).toBeNull();
        expect(resolution().end).toBeNull();
      });
    },
  );

  Scenario(
    'A comment on the second copy of a duplicated line re-anchors by context',
    ({ Given, When, Then, And }) => {
      Given('"alice" commented on the second backoff line', async () => {
        await comment(BACKOFF, 1);
      });
      When('a new version keeps both backoff lines but edits around them', async () => {
        await newVersion(V1.replace(BALANCES, `${BALANCES} They refresh on a schedule.`));
      });
      Then('the comment re-anchors with method "context"', async () => {
        await list();
        expect(resolution().method).toBe('context');
      });
      And('the resolved range is the second backoff line', () => {
        const r = resolution();
        expect(w.currentSource.slice(r.start ?? 0, r.end ?? 0)).toBe(BACKOFF);
        expect(r.start).toBe(w.currentSource.lastIndexOf(BACKOFF));
      });
    },
  );

  Scenario(
    'Resolutions are computed once and served from the cache',
    ({ Given, And, When, Then }) => {
      Given('"alice" commented on the retry paragraph', async () => {
        await comment(RETRY);
      });
      And('a new version rewords the retry paragraph', async () => {
        await newVersion(V1.replace('retries twice', 'retries thrice'));
      });
      When('the threads are listed twice', async () => {
        await list();
        w.firstComputedAt = await withTenant(w.db.pool, w.alice.ctx, async (c) => {
          const { rows } = await c.query<{ computed_at: Date }>(
            'select computed_at from comment_anchor_resolutions',
          );
          expect(rows).toHaveLength(1);
          return rows[0]!.computed_at;
        });
        await list();
      });
      Then('the resolution is cached in comment_anchor_resolutions after the first listing', () => {
        expect(w.firstComputedAt).toBeInstanceOf(Date);
      });
      And('the second listing does not recompute it', async () => {
        await withTenant(w.db.pool, w.alice.ctx, async (c) => {
          const { rows } = await c.query<{ computed_at: Date }>(
            'select computed_at from comment_anchor_resolutions',
          );
          expect(rows).toHaveLength(1);
          expect(rows[0]!.computed_at).toEqual(w.firstComputedAt);
        });
      });
    },
  );
});
