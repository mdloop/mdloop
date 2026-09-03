import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { Actor, PublicHubConfig, PublishError } from '@vorlyn/app';
import {
  getPublicDoc,
  publishToPublicHub,
  searchPublicDocs,
  unpublishPublicDoc,
  uploadNewVersion,
} from '@vorlyn/app';
import type { Document, Organization, User } from '@vorlyn/domain';
import type { Result } from '@vorlyn/shared';
import {
  PgDirectoryRepository,
  PgDocumentRepository,
  PgGuestUserRepository,
  PgPublicHubRepository,
  PgUploadUnitOfWork,
  PgVersionRepository,
} from './repositories/pg-repositories.js';
import { FsStorage } from './storage/fs-storage.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

const feature = await loadFeature(
  fileURLToPath(new URL('../../../features/public-hub.feature', import.meta.url)),
);

const encoder = new TextEncoder();

interface World {
  db: TestDb;
  directory: PgDirectoryRepository;
  documents: PgDocumentRepository;
  versions: PgVersionRepository;
  guests: PgGuestUserRepository;
  uploadUow: PgUploadUnitOfWork;
  storage: FsStorage;
  storageDir: string;
  publicHub: PgPublicHubRepository;
  org: Organization; // "Acme", the configured home org
  config: PublicHubConfig;
  alice: Actor;
  users: Map<string, User>;
  actors: Map<string, Actor>;
  doc: Document;
  publishResult: Result<{ id: string; slug: string; seq: number }, PublishError> | undefined;
  publicDocResult: Awaited<ReturnType<typeof getPublicDoc>> | undefined;
  searchHits: { slug: string }[];
}

async function actorFor(
  w: World,
  orgId: Organization['id'],
  name: string,
  role: 'admin' | 'member',
): Promise<Actor> {
  const existing = w.actors.get(name);
  if (existing) return existing;
  const user = await w.directory.createUser(orgId, {
    workosUserId: `wos_${name}_${String(Math.random())}`,
    email: `${name}@example.test`,
    displayName: name,
    role,
  });
  w.users.set(name, user);
  const actor: Actor = { ctx: { orgId, userId: user.id }, role };
  w.actors.set(name, actor);
  return actor;
}

async function publish(w: World, actor: Actor, slug: string): Promise<void> {
  const result = await publishToPublicHub(
    actor,
    w.config,
    { documents: w.documents, versions: w.versions, storage: w.storage, publicHub: w.publicHub },
    { documentId: w.doc.id, slug },
  );
  w.publishResult = result;
}

describeFeature(feature, ({ Background, Scenario, AfterAllScenarios }) => {
  const w = {} as World;

  AfterAllScenarios(async () => {
    await w.db.close();
    await rm(w.storageDir, { recursive: true, force: true });
  });

  Background(({ Given, And }) => {
    Given(
      'an organization "Acme" configured as the Public Docs Hub home org, with admin "alice"',
      async () => {
        if (!Object.hasOwn(w, 'db')) {
          w.db = await createTestDb();
          w.storageDir = await mkdtemp(path.join(tmpdir(), 'vorlyn-pubhub-blobs-'));
        }
        w.directory = new PgDirectoryRepository(w.db.pool);
        w.documents = new PgDocumentRepository(w.db.pool);
        w.versions = new PgVersionRepository(w.db.pool);
        w.guests = new PgGuestUserRepository(w.db.pool);
        w.uploadUow = new PgUploadUnitOfWork(w.db.pool);
        w.storage = new FsStorage(w.storageDir);
        w.publicHub = new PgPublicHubRepository(w.db.pool);
        w.users = new Map();
        w.actors = new Map();
        w.publishResult = undefined;
        w.publicDocResult = undefined;
        w.searchHits = [];

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
        w.config = { publicHubOrgId: w.org.id };
      },
    );
    And(
      '"alice" uploaded a document "runbook.md" with content "Contains a rollback procedure for production deploys."',
      async () => {
        const created = await w.documents.create(w.alice.ctx, {
          projectId: null,
          ownerId: w.users.get('alice')!.id,
          title: 'runbook.md',
        });
        const uploaded = await uploadNewVersion(w.uploadUow, w.storage, w.alice, {
          documentId: created.id,
          content: encoder.encode('Contains a rollback procedure for production deploys.'),
          source: 'web',
        });
        if (!uploaded.ok) throw new Error('setup upload failed');
        w.doc = uploaded.value.document;
      },
    );
  });

  Scenario('A home-org admin publishes a document to the public hub', ({ When, Then }) => {
    When('"alice" publishes "runbook.md" as slug "deploy-runbook"', async () => {
      await publish(w, w.alice, 'deploy-runbook');
    });
    Then('the public hub has a doc at slug "deploy-runbook"', () => {
      expect(w.publishResult?.ok).toBe(true);
      if (!w.publishResult?.ok) throw new Error('expected publish to succeed');
      expect(w.publishResult.value.slug).toBe('deploy-runbook');
    });
  });

  Scenario('A member of the home org cannot publish', ({ Given, When, Then }) => {
    Given('a member "carol" in "Acme"', async () => {
      await actorFor(w, w.org.id, 'carol', 'member');
    });
    When('"carol" publishes "runbook.md" as slug "deploy-runbook"', async () => {
      await publish(w, w.actors.get('carol')!, 'deploy-runbook');
    });
    Then('publishing is forbidden', () => {
      const result = w.publishResult;
      expect(result?.ok).toBe(false);
      if (!result || result.ok) throw new Error('expected forbidden');
      expect(result.error.code).toBe('forbidden');
    });
  });

  Scenario('An admin of a different org cannot publish', ({ Given, When, Then }) => {
    let globex: Organization;
    Given('an organization "Globex" with admin "dave"', async () => {
      globex = await w.directory.createOrganization('Globex');
      await actorFor(w, globex.id, 'dave', 'admin');
    });
    When('"dave" publishes "runbook.md" as slug "deploy-runbook"', async () => {
      await publish(w, w.actors.get('dave')!, 'deploy-runbook');
    });
    Then('publishing is forbidden', () => {
      const result = w.publishResult;
      expect(result?.ok).toBe(false);
      if (!result || result.ok) throw new Error('expected forbidden');
      expect(result.error.code).toBe('forbidden');
    });
  });

  Scenario('A guest cannot publish', ({ Given, When, Then }) => {
    Given('a guest "gina" in "Acme"', async () => {
      const guest = await w.guests.createGuest(w.alice.ctx, 'gina@guest.test');
      const actor: Actor = { ctx: { orgId: w.org.id, userId: guest.id }, role: 'guest' };
      w.actors.set('gina', actor);
    });
    When('"gina" publishes "runbook.md" as slug "deploy-runbook"', async () => {
      await publish(w, w.actors.get('gina')!, 'deploy-runbook');
    });
    Then('publishing is forbidden', () => {
      const result = w.publishResult;
      expect(result?.ok).toBe(false);
      if (!result || result.ok) throw new Error('expected forbidden');
      expect(result.error.code).toBe('forbidden');
    });
  });

  Scenario(
    'A published doc is publicly readable with no session at all',
    ({ Given, When, Then }) => {
      Given('"alice" published "runbook.md" as slug "deploy-runbook"', async () => {
        await publish(w, w.alice, 'deploy-runbook');
        expect(w.publishResult?.ok).toBe(true);
      });
      When('an anonymous reader fetches the public doc "deploy-runbook"', async () => {
        w.publicDocResult = await getPublicDoc(w.publicHub, 'deploy-runbook');
      });
      Then('the public doc "deploy-runbook" is returned', () => {
        expect(w.publicDocResult?.ok).toBe(true);
        if (!w.publicDocResult?.ok) throw new Error('expected a public doc');
        expect(w.publicDocResult.value.slug).toBe('deploy-runbook');
      });
    },
  );

  Scenario('A slug that was never published is not found', ({ When, Then }) => {
    When('an anonymous reader fetches the public doc "never-published"', async () => {
      w.publicDocResult = await getPublicDoc(w.publicHub, 'never-published');
    });
    Then('the public doc is not found', () => {
      expect(w.publicDocResult?.ok).toBe(false);
    });
  });

  Scenario('An unpublished slug is not found', ({ Given, And, When, Then }) => {
    Given('"alice" published "runbook.md" as slug "deploy-runbook"', async () => {
      await publish(w, w.alice, 'deploy-runbook');
      expect(w.publishResult?.ok).toBe(true);
    });
    And('"alice" unpublishes "deploy-runbook"', async () => {
      const r = await unpublishPublicDoc(w.alice, w.config, w.publicHub, 'deploy-runbook');
      expect(r.ok).toBe(true);
    });
    When('an anonymous reader fetches the public doc "deploy-runbook"', async () => {
      w.publicDocResult = await getPublicDoc(w.publicHub, 'deploy-runbook');
    });
    Then('the public doc is not found', () => {
      expect(w.publicDocResult?.ok).toBe(false);
    });
  });

  Scenario(
    'Re-publishing the same slug creates a new snapshot without changing the slug',
    ({ Given, When, Then }) => {
      let firstId: string;
      let firstSeq: number;
      Given('"alice" published "runbook.md" as slug "deploy-runbook"', async () => {
        await publish(w, w.alice, 'deploy-runbook');
        expect(w.publishResult?.ok).toBe(true);
        if (!w.publishResult?.ok) throw new Error('expected publish to succeed');
        firstId = w.publishResult.value.id;
        firstSeq = w.publishResult.value.seq;
      });
      When(
        '"alice" republishes "runbook.md" as slug "deploy-runbook" with new content "Now with a canary rollout section."',
        async () => {
          const uploaded = await uploadNewVersion(w.uploadUow, w.storage, w.alice, {
            documentId: w.doc.id,
            content: encoder.encode('Now with a canary rollout section.'),
            source: 'web',
          });
          if (!uploaded.ok) throw new Error('re-upload failed');
          await publish(w, w.alice, 'deploy-runbook');
        },
      );
      Then('the public doc "deploy-runbook" keeps its id but gets a new seq and content', () => {
        expect(w.publishResult?.ok).toBe(true);
        if (!w.publishResult?.ok) throw new Error('expected publish to succeed');
        expect(w.publishResult.value.slug).toBe('deploy-runbook');
        expect(w.publishResult.value.id).toBe(firstId);
        expect(w.publishResult.value.seq).toBeGreaterThan(firstSeq);
      });
    },
  );

  Scenario(
    'Unpublishing removes the doc from public read and public search',
    ({ Given, When, Then, And }) => {
      Given('"alice" published "runbook.md" as slug "deploy-runbook"', async () => {
        await publish(w, w.alice, 'deploy-runbook');
        expect(w.publishResult?.ok).toBe(true);
      });
      When('"alice" unpublishes "deploy-runbook"', async () => {
        const r = await unpublishPublicDoc(w.alice, w.config, w.publicHub, 'deploy-runbook');
        expect(r.ok).toBe(true);
      });
      Then(
        'an anonymous reader fetching the public doc "deploy-runbook" gets not-found',
        async () => {
          w.publicDocResult = await getPublicDoc(w.publicHub, 'deploy-runbook');
          expect(w.publicDocResult.ok).toBe(false);
        },
      );
      And('searching the public hub for "rollback" returns nothing', async () => {
        const r = await searchPublicDocs(w.publicHub, 'rollback');
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('expected search to succeed');
        w.searchHits = r.value;
        expect(w.searchHits).toHaveLength(0);
      });
    },
  );
});
