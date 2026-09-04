import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Document, Organization, User } from '@mdloop/domain';
import { DIFF_MAX_BYTES } from '@mdloop/domain';
import {
  FakeDocumentRepository,
  FakeShareGrantRepository,
  FakeStorage,
  FakeUploadUnitOfWork,
  FakeVersionRepository,
  FakeWorld,
} from '../test-support/fakes.js';
import type { DocDiffDeps } from './doc-diff.js';
import { computeDocDiffFromMeta, documentDiff, resolveDocDiffMeta } from './doc-diff.js';
import type { Actor } from './org-settings.js';
import { uploadNewDocument, uploadNewVersion } from './upload.js';

/**
 * Rendered leg diff (ADR 0003 §A): access gate, version resolution, purged
 * honesty, byte-cap fallback signal, the happy path, and version-note
 * round-trip — all over the fakes. The tenant-isolation and ETag proofs live
 * in the API integration suite.
 */
const encoder = new TextEncoder();

function setup(orgOverrides: Partial<Organization> = {}) {
  const world = new FakeWorld();
  const org = world.org(orgOverrides);
  const storage = new FakeStorage();
  const uploadUow = new FakeUploadUnitOfWork(world);
  const documents = new FakeDocumentRepository(world);
  const grants = new FakeShareGrantRepository(world);
  const versions = new FakeVersionRepository(world);
  const deps: DocDiffDeps = { documents, grants, versions, storage };

  const actorFor = (user: User): Actor => ({
    ctx: { orgId: org.id, userId: user.id },
    role: user.role,
  });
  const addUser = (role: User['role'], email: string): User =>
    world.addUser(org.id, {
      workosUserId: role === 'guest' ? `guest:${email}` : `workos:${email}`,
      email,
      displayName: email.split('@')[0] ?? email,
      role,
    });

  const owner = addUser('member', 'owner@acme.test');
  const stranger = addUser('member', 'stranger@acme.test');

  return { world, org, deps, storage, uploadUow, documents, versions, actorFor, owner, stranger };
}

type Ctx = ReturnType<typeof setup>;

async function seed(s: Ctx, content: string, changeNote?: string): Promise<Document> {
  const r = await uploadNewDocument(s.uploadUow, s.storage, s.actorFor(s.owner), {
    title: 'doc.md',
    projectId: null,
    content: encoder.encode(content),
    source: 'web',
    ...(changeNote !== undefined ? { changeNote } : {}),
  });
  if (!r.ok) throw new Error(`seed failed: ${r.error.code}`);
  return r.value.document;
}

async function addVersion(
  s: Ctx,
  doc: Document,
  content: string,
  changeNote?: string,
): Promise<void> {
  const r = await uploadNewVersion(s.uploadUow, s.storage, s.actorFor(s.owner), {
    documentId: doc.id,
    content: encoder.encode(content),
    source: 'web',
    ...(changeNote !== undefined ? { changeNote } : {}),
  });
  if (!r.ok) throw new Error(`version failed: ${r.error.code}`);
}

describe('documentDiff', () => {
  let s: Ctx;
  beforeEach(() => {
    s = setup();
  });

  it('diffs two legs of a document the actor can read', async () => {
    const doc = await seed(s, '# Title\n\nOriginal paragraph.');
    await addVersion(s, doc, '# Title\n\nRewritten paragraph entirely.');
    const r = await documentDiff(s.deps, s.actorFor(s.owner), {
      documentId: doc.id,
      fromSeq: 1,
      toSeq: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.from.seq).toBe(1);
    expect(r.value.to.seq).toBe(2);
    const kinds = r.value.diff.blocks.map((b) => b.type);
    expect(kinds).toContain('unchanged'); // the heading
    expect(kinds.some((k) => k === 'modified' || k === 'added' || k === 'removed')).toBe(true);
  });

  it('returns both legs contentHash and changeNote for the ETag and surfacing', async () => {
    const doc = await seed(s, 'v1 body', 'first cut');
    await addVersion(s, doc, 'v2 body', 'reworked intro');
    const r = await documentDiff(s.deps, s.actorFor(s.owner), {
      documentId: doc.id,
      fromSeq: 1,
      toSeq: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.from.changeNote).toBe('first cut');
    expect(r.value.to.changeNote).toBe('reworked intro');
    expect(r.value.from.contentHash).not.toBe(r.value.to.contentHash);
    expect(r.value.from.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('denies a stranger with no grant as not-found (no oracle)', async () => {
    const doc = await seed(s, 'secret v1');
    await addVersion(s, doc, 'secret v2');
    const r = await documentDiff(s.deps, s.actorFor(s.stranger), {
      documentId: doc.id,
      fromSeq: 1,
      toSeq: 2,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('document_not_found');
  });

  it('reports version_not_found for a seq that does not exist', async () => {
    const doc = await seed(s, 'only one leg');
    const r = await documentDiff(s.deps, s.actorFor(s.owner), {
      documentId: doc.id,
      fromSeq: 1,
      toSeq: 9,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('version_not_found');
  });

  it('degrades honestly to version_purged against a tombstoned leg (ADR A.5)', async () => {
    const doc = await seed(s, 'leg one');
    await addVersion(s, doc, 'leg two');
    const [v1] = await s.versions.listForDocument(s.actorFor(s.owner).ctx, doc.id);
    if (!v1) throw new Error('no v1');
    await s.versions.tombstone(s.actorFor(s.owner).ctx, v1.id);
    const r = await documentDiff(s.deps, s.actorFor(s.owner), {
      documentId: doc.id,
      fromSeq: 1,
      toSeq: 2,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('version_purged');
  });

  it('signals diff_too_large from metadata, without reading the blob', async () => {
    const doc = await seed(s, 'small first leg');
    await addVersion(s, doc, 'x'.repeat(DIFF_MAX_BYTES + 1));
    const r = await documentDiff(s.deps, s.actorFor(s.owner), {
      documentId: doc.id,
      fromSeq: 1,
      toSeq: 2,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('diff_too_large');
  });

  it("resolves metadata (for the route's ETag) without reading either blob", async () => {
    const doc = await seed(s, '# Title\n\nOriginal paragraph.');
    await addVersion(s, doc, '# Title\n\nRewritten paragraph entirely.');
    const getSpy = vi.spyOn(s.storage, 'get');
    const meta = await resolveDocDiffMeta(s.deps, s.actorFor(s.owner), {
      documentId: doc.id,
      fromSeq: 1,
      toSeq: 2,
    });
    expect(meta.ok).toBe(true);
    expect(getSpy).not.toHaveBeenCalled();
    if (!meta.ok) return;
    expect(meta.value.from.contentHash).not.toBe(meta.value.to.contentHash);

    // The post-304 path: computing off the already-resolved meta reads both
    // blobs exactly once each, and lands the same result documentDiff would.
    const result = await computeDocDiffFromMeta(s.deps, s.actorFor(s.owner).ctx.orgId, meta.value);
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const kinds = result.value.diff.blocks.map((b) => b.type);
    expect(kinds).toContain('unchanged');
  });

  it('diffs a version against itself as all-unchanged', async () => {
    const doc = await seed(s, '# H\n\nBody.');
    const r = await documentDiff(s.deps, s.actorFor(s.owner), {
      documentId: doc.id,
      fromSeq: 1,
      toSeq: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.diff.blocks.every((b) => b.type === 'unchanged')).toBe(true);
  });
});
