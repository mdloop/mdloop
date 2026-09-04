import { describe, expect, it } from 'vitest';
import type { Organization, User } from '@mdloop/domain';
import type { DocumentId } from '@mdloop/shared';
import {
  FakeDocumentRepository,
  FakePublicHubRepository,
  FakeStorage,
  FakeUploadUnitOfWork,
  FakeVersionRepository,
  FakeWorld,
} from '../test-support/fakes.js';
import type { Actor } from './org-settings.js';
import type { PublicHubConfig, PublicHubDeps } from './public-hub.js';
import {
  getPublicDoc,
  listPublicDocs,
  publishToPublicHub,
  searchPublicDocs,
  unpublishPublicDoc,
} from './public-hub.js';
import { uploadNewDocument } from './upload.js';

/**
 * Public Docs Hub use-cases (ADR 0004): the publish gate (admin + home org
 * only), snapshot semantics (re-publish bumps seq, blob round-trips through
 * the public keyspace), and the anonymous read path taking no actor at all.
 * Isolation of `mdloop_public_reader` from tenant tables is proven against
 * real Postgres in the persistence integration suite, not here.
 */
const encoder = new TextEncoder();

function setup(orgOverrides: Partial<Organization> = {}) {
  const world = new FakeWorld();
  const homeOrg = world.org(orgOverrides);
  const otherOrg = world.org({ name: 'Other Org' });
  const storage = new FakeStorage();
  const uploadUow = new FakeUploadUnitOfWork(world);
  const documents = new FakeDocumentRepository(world);
  const versions = new FakeVersionRepository(world);
  const publicHub = new FakePublicHubRepository();

  const deps: PublicHubDeps = { documents, versions, storage, publicHub };
  const config: PublicHubConfig = { publicHubOrgId: homeOrg.id };

  const actorFor = (user: User): Actor => ({
    ctx: { orgId: user.orgId, userId: user.id },
    role: user.role,
  });
  const addUser = (orgId: typeof homeOrg.id, role: User['role'], email: string): User =>
    world.addUser(orgId, {
      workosUserId: role === 'guest' ? `guest:${email}` : `workos:${email}`,
      email,
      displayName: email.split('@')[0] ?? email,
      role,
    });

  const admin = addUser(homeOrg.id, 'admin', 'admin@home.test');
  const member = addUser(homeOrg.id, 'member', 'member@home.test');
  const guest = addUser(homeOrg.id, 'guest', 'guest@home.test');
  const otherOrgAdmin = addUser(otherOrg.id, 'admin', 'admin@other.test');

  return {
    world,
    homeOrg,
    otherOrg,
    deps,
    config,
    storage,
    uploadUow,
    documents,
    versions,
    publicHub,
    actorFor,
    admin,
    member,
    guest,
    otherOrgAdmin,
  };
}

type Ctx = ReturnType<typeof setup>;

async function seedDocument(s: Ctx, content: string, title = 'runbook.md') {
  const r = await uploadNewDocument(s.uploadUow, s.storage, s.actorFor(s.admin), {
    title,
    projectId: null,
    content: encoder.encode(content),
    source: 'web',
  });
  if (!r.ok) throw new Error(`seed failed: ${r.error.code}`);
  return r.value.document;
}

describe('publishToPublicHub', () => {
  it('publishes the current version as a snapshot readable via getPublic', async () => {
    const s = setup();
    const doc = await seedDocument(s, '# Runbook\n\nContent here.');

    const result = await publishToPublicHub(s.actorFor(s.admin), s.config, s.deps, {
      documentId: doc.id,
      slug: 'My Runbook!',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slug).toBe('my-runbook');
    expect(result.value.title).toBe('runbook.md');
    expect(result.value.seq).toBe(1);

    const blob = await s.storage.getPublic({ publicDocId: result.value.id, seq: result.value.seq });
    expect(new TextDecoder().decode(blob)).toBe('# Runbook\n\nContent here.');

    const stored = await s.publicHub.getBySlug('my-runbook');
    expect(stored?.id).toBe(result.value.id);
  });

  it('falls back to the document title when no title override is given, and honors an override', async () => {
    const s = setup();
    const doc = await seedDocument(s, 'content', 'Onboarding Guide');

    const withOverride = await publishToPublicHub(s.actorFor(s.admin), s.config, s.deps, {
      documentId: doc.id,
      slug: 'onboarding',
      title: 'Custom Title',
    });
    expect(withOverride.ok).toBe(true);
    if (withOverride.ok) expect(withOverride.value.title).toBe('Custom Title');

    const withoutOverride = await publishToPublicHub(s.actorFor(s.admin), s.config, s.deps, {
      documentId: doc.id,
      slug: 'onboarding-2',
    });
    expect(withoutOverride.ok).toBe(true);
    if (withoutOverride.ok) expect(withoutOverride.value.title).toBe('Onboarding Guide');
  });

  it('re-publishing the same slug bumps seq and overwrites title/content', async () => {
    const s = setup();
    const doc = await seedDocument(s, 'v1 content');

    const first = await publishToPublicHub(s.actorFor(s.admin), s.config, s.deps, {
      documentId: doc.id,
      slug: 'guide',
      title: 'Guide v1',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.seq).toBe(1);

    const second = await publishToPublicHub(s.actorFor(s.admin), s.config, s.deps, {
      documentId: doc.id,
      slug: 'guide',
      title: 'Guide v2',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.seq).toBe(2);
    expect(second.value.id).toBe(first.value.id);
    expect(second.value.title).toBe('Guide v2');

    // Only one row for the slug — an upsert, never a second row.
    expect(await s.publicHub.list()).toHaveLength(1);
  });

  it('forbidden: non-admin in the home org cannot publish', async () => {
    const s = setup();
    const doc = await seedDocument(s, 'content');
    const result = await publishToPublicHub(s.actorFor(s.member), s.config, s.deps, {
      documentId: doc.id,
      slug: 'x',
    });
    expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
  });

  it('forbidden: guest in the home org cannot publish', async () => {
    const s = setup();
    const doc = await seedDocument(s, 'content');
    const result = await publishToPublicHub(s.actorFor(s.guest), s.config, s.deps, {
      documentId: doc.id,
      slug: 'x',
    });
    expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
  });

  it('forbidden: an admin of a different org cannot publish', async () => {
    const s = setup();
    const doc = await seedDocument(s, 'content');
    const result = await publishToPublicHub(s.actorFor(s.otherOrgAdmin), s.config, s.deps, {
      documentId: doc.id,
      slug: 'x',
    });
    expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
  });

  it('forbidden: publishing is off entirely when publicHubOrgId is unset', async () => {
    const s = setup();
    const doc = await seedDocument(s, 'content');
    const result = await publishToPublicHub(s.actorFor(s.admin), {}, s.deps, {
      documentId: doc.id,
      slug: 'x',
    });
    expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
  });

  it('document_not_found: missing document', async () => {
    const s = setup();
    const result = await publishToPublicHub(s.actorFor(s.admin), s.config, s.deps, {
      documentId: 'not-a-real-id' as DocumentId,
      slug: 'x',
    });
    expect(result).toEqual({ ok: false, error: { code: 'document_not_found' } });
  });

  it('document_not_found: soft-deleted document', async () => {
    const s = setup();
    const doc = await seedDocument(s, 'content');
    await s.documents.softDelete(s.actorFor(s.admin).ctx, doc.id, new Date());
    const result = await publishToPublicHub(s.actorFor(s.admin), s.config, s.deps, {
      documentId: doc.id,
      slug: 'x',
    });
    expect(result).toEqual({ ok: false, error: { code: 'document_not_found' } });
  });

  it('document_not_found: currentVersionId points at a version that no longer exists (defensive)', async () => {
    const s = setup();
    const doc = await seedDocument(s, 'content');
    // Corrupt the pointer directly — a data-consistency edge case the
    // use-case guards against defensively even though it shouldn't happen
    // through the normal upload path.
    s.world.documents.set(doc.id, {
      ...s.world.documents.get(doc.id)!,
      currentVersionId: 'not-a-real-version-id' as never,
    });
    const result = await publishToPublicHub(s.actorFor(s.admin), s.config, s.deps, {
      documentId: doc.id,
      slug: 'x',
    });
    expect(result).toEqual({ ok: false, error: { code: 'document_not_found' } });
  });

  it('version_purged: current version has been tombstoned', async () => {
    const s = setup();
    const doc = await seedDocument(s, 'content');
    const current = await s.versions.byId(s.actorFor(s.admin).ctx, doc.currentVersionId!);
    await s.versions.tombstone(s.actorFor(s.admin).ctx, current!.id);
    const result = await publishToPublicHub(s.actorFor(s.admin), s.config, s.deps, {
      documentId: doc.id,
      slug: 'x',
    });
    expect(result).toEqual({ ok: false, error: { code: 'version_purged' } });
  });

  it('invalid_slug: a slug that normalizes to nothing', async () => {
    const s = setup();
    const doc = await seedDocument(s, 'content');
    const result = await publishToPublicHub(s.actorFor(s.admin), s.config, s.deps, {
      documentId: doc.id,
      slug: '!!!---___',
    });
    expect(result).toEqual({ ok: false, error: { code: 'invalid_slug' } });
  });
});

describe('unpublishPublicDoc', () => {
  it('removes the row so it no longer resolves by slug', async () => {
    const s = setup();
    const doc = await seedDocument(s, 'content');
    await publishToPublicHub(s.actorFor(s.admin), s.config, s.deps, {
      documentId: doc.id,
      slug: 'gone-soon',
    });
    expect(await s.publicHub.getBySlug('gone-soon')).not.toBeNull();

    const result = await unpublishPublicDoc(
      s.actorFor(s.admin),
      s.config,
      s.publicHub,
      'gone-soon',
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(await s.publicHub.getBySlug('gone-soon')).toBeNull();
  });

  it('forbidden: same gate as publish — non-admin cannot unpublish', async () => {
    const s = setup();
    const result = await unpublishPublicDoc(
      s.actorFor(s.member),
      s.config,
      s.publicHub,
      'whatever',
    );
    expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
  });
});

describe('anonymous read path', () => {
  it('getPublicDoc returns not_found for an unknown slug, ok for a published one', async () => {
    const s = setup();
    const doc = await seedDocument(s, 'content');
    expect(await getPublicDoc(s.publicHub, 'nope')).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });

    await publishToPublicHub(s.actorFor(s.admin), s.config, s.deps, {
      documentId: doc.id,
      slug: 'found',
    });
    const result = await getPublicDoc(s.publicHub, 'found');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.slug).toBe('found');
  });

  it('listPublicDocs lists every published doc with no actor involved', async () => {
    const s = setup();
    const docA = await seedDocument(s, 'a', 'A');
    const docB = await seedDocument(s, 'b', 'B');
    await publishToPublicHub(s.actorFor(s.admin), s.config, s.deps, {
      documentId: docA.id,
      slug: 'a',
    });
    await publishToPublicHub(s.actorFor(s.admin), s.config, s.deps, {
      documentId: docB.id,
      slug: 'b',
    });
    const list = await listPublicDocs(s.publicHub);
    expect(list.docs.map((d) => d.slug).sort()).toEqual(['a', 'b']);
    expect(list.nextCursor).toBeNull();
  });

  it('listPublicDocs keyset-pages with a cursor that walks the whole set (Phase 24.F)', async () => {
    const s = setup();
    const slugs = ['p1', 'p2', 'p3', 'p4', 'p5'];
    for (const slug of slugs) {
      const doc = await seedDocument(s, slug, slug.toUpperCase());
      await publishToPublicHub(s.actorFor(s.admin), s.config, s.deps, { documentId: doc.id, slug });
    }

    // Walk one row at a time; the (publishedAt desc, id desc) keyset covers the
    // full set with no duplicates or gaps even when timestamps collide.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await listPublicDocs(s.publicHub, cursor, 1);
      expect(page.docs.length).toBeLessThanOrEqual(1);
      seen.push(...page.docs.map((d) => d.slug));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen.slice().sort()).toEqual([...slugs].sort());
    expect(new Set(seen).size).toBe(slugs.length);
  });

  it('searchPublicDocs rejects an empty query and finds matches by title', async () => {
    const s = setup();
    const doc = await seedDocument(s, 'content', 'Deploy Runbook');
    await publishToPublicHub(s.actorFor(s.admin), s.config, s.deps, {
      documentId: doc.id,
      slug: 'deploy-runbook',
    });

    expect(await searchPublicDocs(s.publicHub, '   ')).toEqual({
      ok: false,
      error: { code: 'empty_query' },
    });

    const found = await searchPublicDocs(s.publicHub, 'runbook');
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.value.map((d) => d.slug)).toEqual(['deploy-runbook']);
  });
});
