import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { Actor } from '@vorlyn/app';
import {
  createComment,
  createUserGrant,
  redeemShareLink,
  resolveComment,
  revokeShareGrant,
  updateOrgSettings,
  uploadNewDocument,
  uploadNewVersion,
  hashShareToken,
} from '@vorlyn/app';
import type { Permission } from '@vorlyn/domain';
import type { DocumentId, GrantId, UserId } from '@vorlyn/shared';
import { withTenant } from './db.js';
import { PgOrganizationRepository } from './repositories/pg-organization-repository.js';
import {
  PgCommentRepository,
  PgDirectoryRepository,
  PgDocumentRepository,
  PgGuestUserRepository,
  PgShareGrantRepository,
  PgUploadUnitOfWork,
} from './repositories/pg-repositories.js';
import { FsStorage } from './storage/fs-storage.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

const feature = await loadFeature(
  fileURLToPath(new URL('../../../features/share-grants.feature', import.meta.url)),
);

interface World {
  db: TestDb;
  documents: PgDocumentRepository;
  comments: PgCommentRepository;
  grants: PgShareGrantRepository;
  guests: PgGuestUserRepository;
  orgs: PgOrganizationRepository;
  uow: PgUploadUnitOfWork;
  storage: FsStorage;
  storageDir: string;
  alice: Actor;
  dev: Actor;
  amir: Actor;
  documentId: DocumentId;
  linkToken: string;
  pushCounter: number;
  lastGrantId: GrantId | undefined;
  lastGrantError: string | undefined;
  lastRevoke: { ok: boolean; error: string | undefined } | undefined;
  devsGrantToAmir: GrantId | undefined;
  alicesGrantToAmir: GrantId | undefined;
}

describeFeature(feature, ({ Background, Scenario, AfterAllScenarios, AfterEachScenario }) => {
  const w = {} as World;

  AfterAllScenarios(async () => {
    await w.db.close();
  });

  AfterEachScenario(async () => {
    await rm(w.storageDir, { recursive: true, force: true });
  });

  /** Every push must carry fresh bytes, or upload dedups into a false pass. */
  async function pushes(actor: Actor): Promise<boolean> {
    w.pushCounter += 1;
    const result = await uploadNewVersion(w.uow, w.storage, actor, {
      documentId: w.documentId,
      content: new TextEncoder().encode(`# Spec\n\nRevision ${String(w.pushCounter)}.`),
      source: 'mcp',
    });
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      return false;
    }
    expect(result.value.deduplicated).toBe(false);
    return true;
  }

  async function grant(granter: Actor, grantee: UserId, permission: Permission) {
    return createUserGrant(
      w.documents,
      w.grants,
      w.orgs,
      granter,
      w.documentId,
      grantee,
      permission,
    );
  }

  Background(({ Given, And }) => {
    Given(
      'organization "Acme" in directory mode with owner "alice", member "dev" and admin "amir"',
      async () => {
        if (!(w as Partial<World>).db) {
          w.db = await createTestDb();
          w.documents = new PgDocumentRepository(w.db.pool);
          w.comments = new PgCommentRepository(w.db.pool);
          w.grants = new PgShareGrantRepository(w.db.pool);
          w.guests = new PgGuestUserRepository(w.db.pool);
          w.orgs = new PgOrganizationRepository(w.db.pool);
          w.uow = new PgUploadUnitOfWork(w.db.pool);
        }
        w.pushCounter = 0;
        w.storageDir = await mkdtemp(path.join(tmpdir(), 'vorlyn-share-grants-'));
        w.storage = new FsStorage(w.storageDir);
        const directory = new PgDirectoryRepository(w.db.pool);
        const acme = await directory.createOrganization('Acme');
        const make = async (name: string, role: 'admin' | 'member'): Promise<Actor> => {
          const user = await directory.createUser(acme.id, {
            workosUserId: `wos_${name}_${String(Math.random())}`,
            email: `${name}_${String(Math.random())}@test.test`,
            displayName: name,
            role,
          });
          return { ctx: { orgId: acme.id, userId: user.id }, role };
        };
        w.alice = await make('alice', 'member');
        w.dev = await make('dev', 'member');
        w.amir = await make('amir', 'admin');
        const switched = await updateOrgSettings(w.orgs, w.amir, { sharingMode: 'directory' });
        expect(switched.ok).toBe(true);
      },
    );
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

  Scenario(
    'A share holder can grant read, comment, and share to others',
    ({ Given, Then, And }) => {
      Given('"alice" granted "dev" share access', async () => {
        const granted = await grant(w.alice, w.dev.ctx.userId, 'share');
        expect(granted.ok).toBe(true);
      });
      Then('"dev" can grant "amir" read access to "spec.md"', async () => {
        const result = await grant(w.dev, w.amir.ctx.userId, 'read');
        expect(result.ok && result.value.permission).toBe('read');
      });
      And('"dev" can grant "amir" comment access to "spec.md"', async () => {
        const result = await grant(w.dev, w.amir.ctx.userId, 'comment');
        expect(result.ok && result.value.permission).toBe('comment');
      });
      And('"dev" can grant "amir" share access to "spec.md"', async () => {
        const result = await grant(w.dev, w.amir.ctx.userId, 'share');
        expect(result.ok && result.value.permission).toBe('share');
      });
    },
  );

  Scenario(
    "A share holder cannot grant edit — delegation is capped at the grantor's own level",
    ({ Given, Then, And }) => {
      Given('"alice" granted "dev" share access', async () => {
        const granted = await grant(w.alice, w.dev.ctx.userId, 'share');
        expect(granted.ok).toBe(true);
      });
      Then('"dev" cannot grant "amir" edit access to "spec.md"', async () => {
        const result = await grant(w.dev, w.amir.ctx.userId, 'edit');
        w.lastGrantError = !result.ok ? result.error.code : undefined;
        expect(result.ok).toBe(false);
      });
      And('the refusal is "grant_exceeds_own_permission"', () => {
        expect(w.lastGrantError).toBe('grant_exceeds_own_permission');
      });
    },
  );

  Scenario(
    'An edit holder can grant share and can grant edit — edit inherits share and is uncapped',
    ({ Given, Then, And }) => {
      Given('"alice" granted "dev" edit access', async () => {
        const granted = await grant(w.alice, w.dev.ctx.userId, 'edit');
        expect(granted.ok).toBe(true);
      });
      Then('"dev" can grant "amir" share access to "spec.md"', async () => {
        const result = await grant(w.dev, w.amir.ctx.userId, 'share');
        expect(result.ok && result.value.permission).toBe('share');
      });
      And('"dev" can grant "amir" edit access to "spec.md"', async () => {
        const result = await grant(w.dev, w.amir.ctx.userId, 'edit');
        expect(result.ok && result.value.permission).toBe('edit');
      });
    },
  );

  Scenario(
    'A share holder can revoke a grant they themselves created',
    ({ Given, And, When, Then }) => {
      Given('"alice" granted "dev" share access', async () => {
        const granted = await grant(w.alice, w.dev.ctx.userId, 'share');
        expect(granted.ok).toBe(true);
      });
      And('"dev" granted "amir" read access to "spec.md"', async () => {
        const granted = await grant(w.dev, w.amir.ctx.userId, 'read');
        if (!granted.ok) throw new Error('setup');
        w.devsGrantToAmir = granted.value.id;
      });
      When('"dev" revokes the grant they created', async () => {
        const revoked = await revokeShareGrant(
          w.documents,
          w.grants,
          w.dev,
          w.documentId,
          w.devsGrantToAmir!,
        );
        w.lastRevoke = { ok: revoked.ok, error: !revoked.ok ? revoked.error.code : undefined };
      });
      Then('the revoke succeeds', () => {
        expect(w.lastRevoke?.ok).toBe(true);
      });
    },
  );

  Scenario(
    "A share holder cannot revoke a grant someone else created, including the owner's own grant to a third party",
    ({ Given, And, When, Then }) => {
      Given('"alice" granted "dev" share access', async () => {
        const granted = await grant(w.alice, w.dev.ctx.userId, 'share');
        expect(granted.ok).toBe(true);
      });
      And('"alice" granted "amir" read access to "spec.md"', async () => {
        const granted = await grant(w.alice, w.amir.ctx.userId, 'read');
        if (!granted.ok) throw new Error('setup');
        w.alicesGrantToAmir = granted.value.id;
      });
      When('"dev" attempts to revoke "alice"\'s grant to "amir"', async () => {
        const revoked = await revokeShareGrant(
          w.documents,
          w.grants,
          w.dev,
          w.documentId,
          w.alicesGrantToAmir!,
        );
        w.lastRevoke = { ok: revoked.ok, error: !revoked.ok ? revoked.error.code : undefined };
      });
      Then('the revoke is refused as forbidden', () => {
        expect(w.lastRevoke?.ok).toBe(false);
        expect(w.lastRevoke?.error).toBe('forbidden');
      });
    },
  );

  Scenario('Share buys no upload', ({ Given, Then }) => {
    Given('"alice" granted "dev" share access', async () => {
      const granted = await grant(w.alice, w.dev.ctx.userId, 'share');
      expect(granted.ok).toBe(true);
    });
    Then('"dev" cannot upload a new version of "spec.md"', async () => {
      expect(await pushes(w.dev)).toBe(false);
    });
  });

  Scenario(
    'Share stops at grant management — resolving comments stays with the owner',
    ({ Given, Then }) => {
      Given('"alice" granted "dev" share access', async () => {
        const granted = await grant(w.alice, w.dev.ctx.userId, 'share');
        expect(granted.ok).toBe(true);
      });
      Then('"dev" cannot resolve comments on "spec.md"', async () => {
        const created = await createComment(w.documents, w.comments, w.orgs, w.grants, w.alice, {
          documentId: w.documentId,
          body: 'needs work',
          anchor: { type: 'document' },
        });
        if (!created.ok) throw new Error('comment failed');
        const resolved = await resolveComment(w.documents, w.comments, w.dev, created.value.id);
        expect(!resolved.ok && resolved.error.code).toBe('forbidden');
      });
    },
  );

  Scenario('The database refuses a share grant carrying a guest email', ({ Then }) => {
    Then(
      'inserting a share grant with permission "share" and a grantee email fails at the database',
      async () => {
        const guestUser = await w.guests.createGuest(w.alice.ctx, 'ext@partner.test');
        await expect(
          withTenant(w.db.pool, w.alice.ctx, (c) =>
            c.query(
              `insert into share_grants
                 (org_id, subject_type, subject_id, grantee_type, grantee_user_id, permission,
                  token_hash, grantee_email, created_by)
               values ($1, 'document', $2, 'user', $3, 'share', $4, 'ext@partner.test', $5)`,
              [
                w.alice.ctx.orgId,
                w.documentId,
                guestUser.id,
                hashShareToken('forged'),
                w.alice.ctx.userId,
              ],
            ),
          ),
        ).rejects.toThrow(/share_grants_guest_read_comment_only|check constraint/i);
      },
    );
  });

  Scenario(
    'A link never confers share, even when the row says so',
    ({ Given, When, Then, And }) => {
      let redeemed: string | undefined;
      Given('a link grant on "spec.md" carrying permission "share"', async () => {
        w.linkToken = 'forged-share-link-token';
        await withTenant(w.db.pool, w.alice.ctx, (c) =>
          c.query(
            `insert into share_grants
               (org_id, subject_type, subject_id, grantee_type, permission, token_hash, created_by)
             values ($1, 'document', $2, 'link', 'share', $3, $4)`,
            [w.alice.ctx.orgId, w.documentId, hashShareToken(w.linkToken), w.alice.ctx.userId],
          ),
        );
      });
      When('"dev" redeems that link', async () => {
        const result = await redeemShareLink(w.grants, w.dev, w.linkToken);
        redeemed = result.ok ? 'ok' : result.error.code;
      });
      Then('the redemption is refused', () => {
        expect(redeemed).toBe('invalid_token');
      });
      And('"dev" cannot upload a new version of "spec.md"', async () => {
        expect(await pushes(w.dev)).toBe(false);
      });
    },
  );
});
