import { fileURLToPath } from 'node:url';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { Actor, GuestShareResult, OAuthTokenVerifierPort } from '@mdloop/app';
import {
  actorForApiKey,
  actorForOAuthToken,
  createApiKey,
  createGuestShare,
  documentPermissionFor,
  listAccessibleDocuments,
  redeemGuestShare,
  updateOrgSettings,
} from '@mdloop/app';
import { FakeEmail } from '@mdloop/app/test-support';
import type { Document, Organization } from '@mdloop/domain';
import { PgApiKeyRepository } from './repositories/pg-api-key-repository.js';
import { PgOrganizationRepository } from './repositories/pg-organization-repository.js';
import {
  PgDirectoryRepository,
  PgDocumentRepository,
  PgGuestUserRepository,
  PgShareGrantRepository,
} from './repositories/pg-repositories.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

const feature = await loadFeature(
  fileURLToPath(new URL('../../../features/guest-sharing.feature', import.meta.url)),
);

interface World {
  db: TestDb;
  directory: PgDirectoryRepository;
  documents: PgDocumentRepository;
  grants: PgShareGrantRepository;
  guests: PgGuestUserRepository;
  orgRepo: PgOrganizationRepository;
  email: FakeEmail;
  org: Organization;
  alice: Actor;
  admin: Actor;
  doc: Document;
  secondDoc: Document | undefined;
  firstGuestEmail: string | undefined;
  lastShare: Awaited<ReturnType<typeof createGuestShare>> | undefined;
  liveShare: GuestShareResult | undefined;
}

function deps(w: World) {
  return {
    documents: w.documents,
    grants: w.grants,
    orgs: w.orgRepo,
    guests: w.guests,
    email: w.email,
  };
}

function shareWith(w: World, email: string, days = 7) {
  return createGuestShare(deps(w), w.alice, {
    documentId: w.doc.id,
    email,
    permission: 'comment',
    days,
    redeemUrlBase: 'https://app.test/g/',
  });
}

async function guestActorFor(w: World, email: string): Promise<Actor> {
  const guest = await w.guests.guestByEmail(w.alice.ctx, email);
  if (!guest) throw new Error(`guest missing: ${email}`);
  return { ctx: { orgId: w.org.id, userId: guest.id }, role: 'guest' };
}

describeFeature(feature, ({ Background, Scenario, AfterAllScenarios }) => {
  const w = {} as World;

  AfterAllScenarios(async () => {
    await w.db.close();
  });

  Background(({ Given }) => {
    Given(
      'a team-tier organization "Acme" with owner "alice" and a document "design.md"',
      async () => {
        // One ephemeral DB across scenarios; Background reruns per scenario.
        // Team tier gives plenty of guest-cap headroom (25) so scenarios
        // about guest-sharing mechanics (expiry, permission, isolation,
        // re-share) aren't tripped up by the free-tier guest cap, which is
        // now 0 (Phase 33) — the cap itself is proven on a dedicated
        // free-tier org in its own scenario below.
        if (!Object.hasOwn(w, 'db')) w.db = await createTestDb();
        w.directory = new PgDirectoryRepository(w.db.pool);
        w.documents = new PgDocumentRepository(w.db.pool);
        w.grants = new PgShareGrantRepository(w.db.pool);
        w.guests = new PgGuestUserRepository(w.db.pool);
        w.orgRepo = new PgOrganizationRepository(w.db.pool);
        w.email = new FakeEmail();
        w.org = await w.directory.createOrganization('Acme', 'team');
        const alice = await w.directory.createUser(w.org.id, {
          workosUserId: `wos_alice_${String(Math.random())}`,
          email: `alice_${String(Math.random())}@acme.test`,
          displayName: 'alice',
          role: 'member',
        });
        w.alice = { ctx: { orgId: w.org.id, userId: alice.id }, role: 'member' };
        w.admin = { ctx: w.alice.ctx, role: 'admin' };
        w.doc = await w.documents.create(w.alice.ctx, {
          projectId: null,
          ownerId: alice.id,
          title: 'design.md',
        });
        w.secondDoc = undefined;
        w.firstGuestEmail = undefined;
        w.lastShare = undefined;
        w.liveShare = undefined;
      },
    );
  });

  Scenario('A guest share grants access until it expires', ({ When, Then, And }) => {
    When('"alice" shares "design.md" with guest "ext@client.test" for 7 days', async () => {
      const r = await shareWith(w, 'ext@client.test');
      if (!r.ok) throw new Error(`share failed: ${r.error.code}`);
      w.liveShare = r.value;
    });
    Then('the guest token redeems to a guest identity for "design.md"', async () => {
      const redeemed = await redeemGuestShare(w.directory, w.liveShare!.token);
      expect(redeemed.ok).toBe(true);
      if (!redeemed.ok) return;
      expect(redeemed.value.documentId).toBe(w.doc.id);
      expect(redeemed.value.orgId).toBe(w.org.id);
    });
    And('after the expiry passes the guest grant no longer grants access', async () => {
      const after = new Date(w.liveShare!.expiresAt.getTime() + 1);
      const redeemed = await redeemGuestShare(w.directory, w.liveShare!.token, after);
      expect(!redeemed.ok && redeemed.error.code).toBe('expired');
    });
  });

  Scenario(
    'Turning external sharing off blocks creating and redeeming',
    ({ Given, When, Then, And }) => {
      Given('"alice" shared "design.md" with guest "ext@client.test" for 7 days', async () => {
        const r = await shareWith(w, 'ext@client.test');
        if (!r.ok) throw new Error(`share failed: ${r.error.code}`);
        w.liveShare = r.value;
      });
      When('the org turns external sharing off', async () => {
        const r = await updateOrgSettings(w.orgRepo, w.admin, { externalSharing: false });
        if (!r.ok) throw new Error('settings update failed');
      });
      Then('sharing to another guest is refused with "external_sharing_disabled"', async () => {
        const r = await shareWith(w, 'other@client.test');
        expect(!r.ok && r.error.code).toBe('external_sharing_disabled');
      });
      And('redeeming the existing guest token is refused', async () => {
        const redeemed = await redeemGuestShare(w.directory, w.liveShare!.token);
        expect(!redeemed.ok && redeemed.error.code).toBe('external_sharing_disabled');
      });
    },
  );

  Scenario('Free tier refuses guest sharing outright', ({ Given, When, Then }) => {
    // Phase 33 dropped free tier's guest ceiling to 0 (from 3), so the
    // meaningful cap proof is no longer "3 succeed, a 4th is refused" — it's
    // that the very first guest-share attempt on a free-tier org is refused.
    // This needs its own org, independent of the Background's now team-tier
    // "Acme", to actually exercise the free-tier ceiling.
    Given(
      'a free-tier organization "Frugal" with owner "owner" and a document "notes.md"',
      async () => {
        const org = await w.directory.createOrganization('Frugal', 'free');
        const owner = await w.directory.createUser(org.id, {
          workosUserId: `wos_owner_${String(Math.random())}`,
          email: `owner_${String(Math.random())}@frugal.test`,
          displayName: 'owner',
          role: 'member',
        });
        w.org = org;
        w.alice = { ctx: { orgId: org.id, userId: owner.id }, role: 'member' };
        w.doc = await w.documents.create(w.alice.ctx, {
          projectId: null,
          ownerId: owner.id,
          title: 'notes.md',
        });
      },
    );
    When('"owner" shares "notes.md" with guest "first@client.test" for 7 days', async () => {
      w.lastShare = await shareWith(w, 'first@client.test');
    });
    Then('guest sharing is refused with "guest_cap_exceeded"', () => {
      expect(!w.lastShare!.ok && w.lastShare!.error.code).toBe('guest_cap_exceeded');
    });
  });

  Scenario(
    'Re-sharing to the same email extends expiry instead of erroring',
    ({ Given, When, Then }) => {
      Given('"alice" shared "design.md" with 3 distinct guests', async () => {
        w.firstGuestEmail = 'g1@client.test';
        for (const email of ['g1@client.test', 'g2@client.test', 'g3@client.test']) {
          const r = await shareWith(w, email);
          if (!r.ok) throw new Error(`share failed: ${r.error.code}`);
        }
      });
      When('"alice" re-shares "design.md" with the first guest for 7 days', async () => {
        w.lastShare = await shareWith(w, w.firstGuestEmail!);
      });
      Then('the share succeeds and the guest count stays 3', async () => {
        expect(w.lastShare!.ok).toBe(true);
        expect(await w.grants.activeGuestEmails(w.alice.ctx)).toHaveLength(3);
      });
    },
  );

  Scenario('A guest sees only the granted document', ({ Given, And, Then }) => {
    Given('a second document "secret.md" in "Acme"', async () => {
      w.secondDoc = await w.documents.create(w.alice.ctx, {
        projectId: null,
        ownerId: w.alice.ctx.userId,
        title: 'secret.md',
      });
    });
    And('"alice" shared "design.md" with guest "ext@client.test" for 7 days', async () => {
      const r = await shareWith(w, 'ext@client.test');
      if (!r.ok) throw new Error(`share failed: ${r.error.code}`);
    });
    Then('the guest can list exactly one document, "design.md"', async () => {
      const guest = await guestActorFor(w, 'ext@client.test');
      const docs = await listAccessibleDocuments(w.documents, w.grants, guest);
      expect(docs.map((d) => d.id)).toEqual([w.doc.id]);
    });
  });

  Scenario('A guest can never hold more than comment permission', ({ Given, Then }) => {
    Given('"alice" shared "design.md" with guest "ext@client.test" for 7 days', async () => {
      const r = await shareWith(w, 'ext@client.test');
      if (!r.ok) throw new Error(`share failed: ${r.error.code}`);
    });
    Then('the guest\'s effective permission on "design.md" is "comment"', async () => {
      const guest = await guestActorFor(w, 'ext@client.test');
      const doc = await w.documents.byId(guest.ctx, w.doc.id);
      if (!doc) throw new Error('guest cannot read granted doc');
      expect(await documentPermissionFor(w.grants, guest, doc)).toBe('comment');
    });
  });

  Scenario('A guest can never hold an agent surface', ({ Given, Then, And }) => {
    Given('"alice" shared "design.md" with guest "ext@client.test" for 7 days', async () => {
      const r = await shareWith(w, 'ext@client.test');
      if (!r.ok) throw new Error(`share failed: ${r.error.code}`);
    });
    Then('the guest cannot create an API key', async () => {
      const keys = new PgApiKeyRepository(w.db.pool);
      const guest = await guestActorFor(w, 'ext@client.test');
      const result = await createApiKey(keys, guest, 'sneaky');
      expect(!result.ok && result.error.code).toBe('forbidden');
    });
    And('a key whose owner became a guest resolves to no MCP actor', async () => {
      // Mint a key as a member, then demote the member to guest: the key row
      // survives un-revoked, but the MCP chokepoint refuses to build an actor.
      const keys = new PgApiKeyRepository(w.db.pool);
      const created = await createApiKey(keys, w.alice, 'ci bot');
      if (!created.ok) throw new Error('setup');
      await w.db.pool.query(`update users set role = 'guest' where id = $1`, [w.alice.ctx.userId]);
      expect(await actorForApiKey(keys, created.value.key)).toBeUndefined();
    });
    And('a guest identity cannot resolve via an OAuth token either', async () => {
      // ADR 0013: the OAuth path into MCP is a second door into the same
      // room as the API-key path above — a token that verifies cleanly still
      // dies at actorForOAuthToken's guest-containment check (shared with
      // actorForApiKey via isAgentSurfaceRole), because the resolved user's
      // role is 'guest'.
      const guestUser = await w.guests.guestByEmail(w.alice.ctx, 'ext@client.test');
      if (!guestUser) throw new Error('guest missing');
      const verifier: OAuthTokenVerifierPort = {
        verify: (token) =>
          Promise.resolve(token === 'guest-token' ? { sub: guestUser.workosUserId } : undefined),
      };
      expect(await actorForOAuthToken(w.directory, verifier, 'guest-token')).toBeUndefined();
    });
  });
});
