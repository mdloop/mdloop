import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { Actor, OrgUsage, OrgUsageError } from '@vorlyn/app';
import { createGuestShare, orgUsage, updateOrgSettings, uploadNewDocument } from '@vorlyn/app';
import { FakeEmail } from '@vorlyn/app/test-support';
import { TIER_PROFILES } from '@vorlyn/domain';
import type { Organization } from '@vorlyn/domain';
import type { Result } from '@vorlyn/shared';
import { PgOrganizationRepository } from './repositories/pg-organization-repository.js';
import {
  PgDirectoryRepository,
  PgDocumentRepository,
  PgGuestUserRepository,
  PgShareGrantRepository,
  PgUploadUnitOfWork,
  PgVersionRepository,
} from './repositories/pg-repositories.js';
import { FsStorage } from './storage/fs-storage.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

const feature = await loadFeature(
  fileURLToPath(new URL('../../../features/org-usage.feature', import.meta.url)),
);

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

interface World {
  db: TestDb;
  directory: PgDirectoryRepository;
  orgRepo: PgOrganizationRepository;
  documents: PgDocumentRepository;
  versions: PgVersionRepository;
  grants: PgShareGrantRepository;
  guests: PgGuestUserRepository;
  uow: PgUploadUnitOfWork;
  storage: FsStorage;
  storageDir: string;
  email: FakeEmail;
  orgs: Record<string, Organization>;
  actors: Record<string, Actor>;
  uploadedBytes: Record<string, number>;
  result: Result<OrgUsage, OrgUsageError>;
}

describeFeature(feature, ({ Background, Scenario, AfterAllScenarios, AfterEachScenario }) => {
  const w = {} as World;

  AfterAllScenarios(async () => {
    await w.db.close();
  });

  // Background remints w.storage (and its temp dir) at the start of every
  // scenario — AfterAllScenarios only fires once at the very end, so without
  // this every scenario but the last leaks its blob-store temp directory
  // (mirrors upload-quota.feature.test.ts).
  AfterEachScenario(async () => {
    await rm(w.storageDir, { recursive: true, force: true });
  });

  async function createOrgWithAdmin(
    name: string,
    adminName: string,
    tier: 'free' | 'team',
  ): Promise<void> {
    const org = await w.directory.createOrganization(name, tier);
    w.orgs[name] = org;
    const admin = await w.directory.createUser(org.id, {
      workosUserId: `wos_${adminName}_${String(Math.random())}`,
      email: `${adminName}@${name.toLowerCase()}.test`,
      displayName: adminName,
      role: 'admin',
    });
    w.actors[adminName] = { ctx: { orgId: org.id, userId: admin.id }, role: 'admin' };
    w.uploadedBytes[adminName] = 0;
  }

  /** Uploads `count` real documents as `actorName`, tallying the exact bytes written. */
  async function uploadTracked(actorName: string, count: number): Promise<void> {
    const actor = w.actors[actorName]!;
    for (let i = 0; i < count; i++) {
      const content = bytes(
        `# Doc ${String(i)}\n\nsome body content for doc ${String(i)} by ${actorName}`,
      );
      const result = await uploadNewDocument(w.uow, w.storage, actor, {
        title: `doc-${actorName}-${String(i)}.md`,
        projectId: null,
        content,
        source: 'web',
      });
      if (!result.ok) throw new Error(`upload failed: ${result.error.code}`);
      w.uploadedBytes[actorName] =
        (w.uploadedBytes[actorName] ?? 0) + result.value.version.byteSize;
    }
  }

  Background(({ Given, And }) => {
    Given('a team-tier organization "Acme" with admin "alice"', async () => {
      if (!Object.hasOwn(w, 'db')) w.db = await createTestDb();
      w.directory = new PgDirectoryRepository(w.db.pool);
      w.orgRepo = new PgOrganizationRepository(w.db.pool);
      w.documents = new PgDocumentRepository(w.db.pool);
      w.versions = new PgVersionRepository(w.db.pool);
      w.grants = new PgShareGrantRepository(w.db.pool);
      w.guests = new PgGuestUserRepository(w.db.pool);
      w.uow = new PgUploadUnitOfWork(w.db.pool);
      w.email = new FakeEmail();
      w.orgs = {};
      w.actors = {};
      w.uploadedBytes = {};
      w.storageDir = await mkdtemp(path.join(tmpdir(), 'vorlyn-org-usage-'));
      w.storage = new FsStorage(w.storageDir);
      await createOrgWithAdmin('Acme', 'alice', 'team');
    });

    And('a team-tier organization "Globex" with admin "gina"', async () => {
      await createOrgWithAdmin('Globex', 'gina', 'team');
    });
  });

  Scenario(
    'Usage counts documents, seats, storage and guests for the calling org only',
    ({ Given, And, When, Then }) => {
      Given('"alice" has uploaded 2 documents to "Acme"', async () => {
        await uploadTracked('alice', 2);
      });

      And('"bob" has joined "Acme" as a member', async () => {
        const acme = w.orgs.Acme!;
        const bob = await w.directory.createUser(acme.id, {
          workosUserId: `wos_bob_${String(Math.random())}`,
          email: 'bob@acme.test',
          displayName: 'bob',
          role: 'member',
        });
        w.actors.bob = { ctx: { orgId: acme.id, userId: bob.id }, role: 'member' };
      });

      And('"alice" has shared a document with external guest "carol@ext.test"', async () => {
        const alice = w.actors.alice!;
        const enabled = await updateOrgSettings(w.orgRepo, alice, { externalSharing: true });
        expect(enabled.ok).toBe(true);
        const docs = await w.documents.list(alice.ctx);
        const doc = docs[0];
        if (!doc) throw new Error('no document to share');
        const shared = await createGuestShare(
          {
            documents: w.documents,
            grants: w.grants,
            orgs: w.orgRepo,
            guests: w.guests,
            email: w.email,
          },
          alice,
          {
            documentId: doc.id,
            email: 'carol@ext.test',
            permission: 'comment',
            days: 7,
            redeemUrlBase: 'https://app.test/g/',
          },
        );
        expect(shared.ok).toBe(true);
      });

      And('"gina" has uploaded 5 documents to "Globex"', async () => {
        await uploadTracked('gina', 5);
      });

      When('"alice" reads org usage', async () => {
        const alice = w.actors.alice!;
        w.result = await orgUsage(w.orgRepo, w.documents, w.versions, w.grants, alice);
      });

      Then('the usage shows 2 active documents against the team document ceiling', () => {
        expect(w.result.ok).toBe(true);
        if (!w.result.ok) return;
        expect(w.result.value.activeDocCount).toBe(2);
        expect(w.result.value.maxActiveDocs).toBe(TIER_PROFILES.team.ceilings.maxActiveDocs);
      });

      And('the usage shows 2 members against an unlimited seat ceiling', () => {
        if (!w.result.ok) return;
        expect(w.result.value.memberCount).toBe(2); // alice + bob
        expect(w.result.value.maxCollaborators).toBeNull();
      });

      And('the usage shows the exact bytes uploaded as storage used', () => {
        if (!w.result.ok) return;
        expect(w.result.value.storageBytes).toBe(w.uploadedBytes.alice);
        expect(w.result.value.storageBytes).toBeGreaterThan(0);
        // Globex's own 5 documents' bytes must never leak into Acme's total.
        expect(w.result.value.storageBytes).not.toBe(
          w.uploadedBytes.alice! + w.uploadedBytes.gina!,
        );
      });

      And('the usage shows 1 active external guest against the team guest ceiling', () => {
        if (!w.result.ok) return;
        expect(w.result.value.activeGuestCount).toBe(1);
        expect(w.result.value.maxExternalGuests).toBe(
          TIER_PROFILES.team.ceilings.maxExternalGuests,
        );
      });
    },
  );

  Scenario(
    'A free-tier organization reports finite, non-null ceilings',
    ({ Given, When, Then }) => {
      Given('a free-tier organization "Indie" with admin "sam"', async () => {
        await createOrgWithAdmin('Indie', 'sam', 'free');
      });

      When('"sam" reads org usage', async () => {
        const sam = w.actors.sam!;
        w.result = await orgUsage(w.orgRepo, w.documents, w.versions, w.grants, sam);
      });

      Then('the usage shows the free-tier document, seat and guest ceilings', () => {
        expect(w.result.ok).toBe(true);
        if (!w.result.ok) return;
        const ceilings = TIER_PROFILES.free.ceilings;
        expect(w.result.value).toEqual({
          tier: 'free',
          activeDocCount: 0,
          maxActiveDocs: ceilings.maxActiveDocs,
          memberCount: 1,
          maxCollaborators: ceilings.maxCollaborators,
          storageBytes: 0,
          activeGuestCount: 0,
          maxExternalGuests: ceilings.maxExternalGuests,
        });
        // Non-null, finite ceilings — the point of a free-tier scenario.
        expect(ceilings.maxActiveDocs).not.toBeNull();
        expect(ceilings.maxCollaborators).not.toBeNull();
        expect(ceilings.maxExternalGuests).not.toBeNull();
      });
    },
  );
});
