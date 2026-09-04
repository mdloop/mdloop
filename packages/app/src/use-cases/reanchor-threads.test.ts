import { describe, expect, it } from 'vitest';
import { createTextAnchor } from '@mdloop/domain';
import type { Anchor } from '@mdloop/domain';
import type { DocumentId, UserId } from '@mdloop/shared';
import {
  FakeAnchorResolutionRepository,
  FakeCommentRepository,
  FakeDocumentRepository,
  FakeOrganizationRepository,
  FakeShareGrantRepository,
  FakeStorage,
  FakeUploadUnitOfWork,
  FakeVersionRepository,
  FakeWorld,
} from '../test-support/fakes.js';
import type { Actor } from './org-settings.js';
import { createComment } from './comments.js';
import { uploadNewDocument, uploadNewVersion } from './upload.js';
import { listThreadsWithResolutions } from './reanchor-threads.js';

const V1 = `# Doc

The payment flow retries twice before failing.

Balances refresh every minute.
`;

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

async function setup() {
  const world = new FakeWorld();
  const org = world.org();
  const actor: Actor = { ctx: { orgId: org.id, userId: 'u1' as UserId }, role: 'member' };
  const documents = new FakeDocumentRepository(world);
  const comments = new FakeCommentRepository(world);
  const orgs = new FakeOrganizationRepository(world);
  const grants = new FakeShareGrantRepository(world);
  const versions = new FakeVersionRepository(world);
  const resolutions = new FakeAnchorResolutionRepository();
  const storage = new FakeStorage();
  const uow = new FakeUploadUnitOfWork(world);
  const first = await uploadNewDocument(uow, storage, actor, {
    title: 'doc.md',
    projectId: null,
    content: bytes(V1),
    source: 'web',
  });
  if (!first.ok) throw new Error('setup upload');
  return {
    world,
    actor,
    documents,
    comments,
    versions,
    resolutions,
    storage,
    uow,
    orgs,
    grants,
    documentId: first.value.document.id,
  };
}

function textAnchor(quote: string): Anchor {
  const start = V1.indexOf(quote);
  return createTextAnchor(V1, start, start + quote.length);
}

async function commentOn(s: Awaited<ReturnType<typeof setup>>, anchor: Anchor) {
  const c = await createComment(s.documents, s.comments, s.orgs, s.grants, s.actor, {
    documentId: s.documentId,
    body: 'note',
    anchor,
  });
  if (!c.ok) throw new Error('setup comment');
  return c.value;
}

/** Creates a suggestion anchored at `anchor`, proposing `proposedText`, and
 *  immediately flips it to `accepted` (bypassing acceptSuggestion — the
 *  use-case itself has its own unit tests; here we only need the metadata
 *  state ADR 0007's lazy materialization reacts to). */
async function acceptedSuggestionOn(
  s: Awaited<ReturnType<typeof setup>>,
  anchor: Anchor,
  proposedText: string,
) {
  const c = await createComment(s.documents, s.comments, s.orgs, s.grants, s.actor, {
    documentId: s.documentId,
    body: 'replace it',
    anchor,
    proposedText,
  });
  if (!c.ok) throw new Error('setup suggestion');
  const accepted = await s.comments.setSuggestionOutcome(s.actor.ctx, c.value.id, 'accepted', null);
  if (!accepted) throw new Error('setup accept');
  return accepted;
}

async function newVersion(s: Awaited<ReturnType<typeof setup>>, content: string) {
  const r = await uploadNewVersion(s.uow, s.storage, s.actor, {
    documentId: s.documentId,
    content: bytes(content),
    source: 'web',
  });
  if (!r.ok) throw new Error('setup version');
}

function list(s: Awaited<ReturnType<typeof setup>>) {
  return listThreadsWithResolutions(
    s.documents,
    s.comments,
    s.versions,
    s.resolutions,
    s.storage,
    s.actor,
    s.documentId,
  );
}

describe('listThreadsWithResolutions', () => {
  it('comments on the current version resolve exactly from their own anchor', async () => {
    const s = await setup();
    const anchor = textAnchor('retries twice');
    await commentOn(s, anchor);
    const result = await list(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.threads[0]?.resolution).toMatchObject({
      method: 'exact',
      confidence: 1,
      start: (anchor as { start: number }).start,
    });
    expect(s.resolutions.upserts).toBe(0); // nothing to cache
  });

  it('re-anchors a comment across an edit and caches the result', async () => {
    const s = await setup();
    await commentOn(s, textAnchor('The payment flow retries twice before failing.'));
    await newVersion(s, V1.replace('retries twice', 'retries three times'));

    const result = await list(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const resolution = result.value.threads[0]?.resolution;
    expect(resolution?.method).toBe('fuzzy');
    expect(resolution?.confidence).toBeGreaterThanOrEqual(0.6);
    expect(resolution?.confidence).toBeLessThan(1);
    expect(s.resolutions.upserts).toBe(1);

    // Second listing hits the cache: no recompute.
    await list(s);
    expect(s.resolutions.upserts).toBe(1);
  });

  it('orphans a comment whose text was deleted', async () => {
    const s = await setup();
    await commentOn(s, textAnchor('Balances refresh every minute.'));
    await newVersion(s, '# Doc\n\nEntirely different content now.\n');

    const result = await list(s);
    if (!result.ok) throw new Error('list failed');
    expect(result.value.threads[0]?.resolution).toMatchObject({
      method: 'orphan',
      start: null,
      end: null,
    });
    expect(result.value.threads[0]?.resolution.confidence).toBeLessThan(0.6);
  });

  it('orphans honestly when a leg exceeds the re-anchor byte cap, without diffing', async () => {
    const s = await setup();
    // Same edit that re-anchors fuzzily in the test above — but here the pinned
    // leg is marked oversized (byteSize only; no giant blob), so the diff never
    // runs and the comment orphans honestly instead of being guessed.
    const comment = await commentOn(
      s,
      textAnchor('The payment flow retries twice before failing.'),
    );
    await newVersion(s, V1.replace('retries twice', 'retries three times'));
    const pinned = s.world.versions.get(comment.versionId)!;
    s.world.versions.set(pinned.id, { ...pinned, byteSize: 300_000 });

    const result = await list(s);
    if (!result.ok) throw new Error('list failed');
    expect(result.value.threads[0]?.resolution).toMatchObject({
      method: 'orphan',
      confidence: 0,
      start: null,
      end: null,
    });
  });

  it('document anchors always hold; diagram anchors orphan when the part is gone', async () => {
    const s = await setup();
    await commentOn(s, { type: 'document' });
    await commentOn(s, { type: 'diagram', blockIndex: 0, kind: 'node', stableId: 'B' });
    await newVersion(s, '# Doc\n\nNo diagram anymore, no letter that matches.\n');

    const result = await list(s);
    if (!result.ok) throw new Error('list failed');
    const [docThread, diagramThread] = result.value.threads;
    expect(docThread?.resolution.method).toBe('exact');
    // 'B' still appears in the text ("No... B"? it does not — uppercase B absent)
    expect(diagramThread?.resolution.method).toBe('orphan');
  });

  it('a diagram anchor still holds when its stable id survives a version bump', async () => {
    const s = await setup();
    await commentOn(s, { type: 'diagram', blockIndex: 0, kind: 'node', stableId: 'B' });
    await newVersion(s, '# Doc\n\nDiagram node B is still referenced here.\n');

    const result = await list(s);
    if (!result.ok) throw new Error('list failed');
    expect(result.value.threads[0]?.resolution).toMatchObject({ method: 'exact', confidence: 1 });
  });

  it('re-anchors against a tombstoned pinned version using the anchor alone', async () => {
    const s = await setup();
    await commentOn(s, textAnchor('The payment flow retries twice before failing.'));
    const [pinned] = await s.versions.listForDocument(s.actor.ctx, s.documentId);
    if (!pinned) throw new Error('setup version');
    await newVersion(s, V1.replace('retries twice', 'retries three times'));
    await s.versions.tombstone(s.actor.ctx, pinned.id);

    const result = await list(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const resolution = result.value.threads[0]?.resolution;
    expect(resolution?.method).toBe('fuzzy');
    expect(resolution?.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('throws on corrupted state: the current version row is gone', async () => {
    // Version rows are never deleted (ADR 0001 tombstones) — this simulates
    // the impossible case to prove the defensive assertion actually guards.
    // (The comment must pin an older version so resolution actually needs to
    // fetch the current version's source, rather than using its own anchor.)
    const s = await setup();
    await commentOn(s, textAnchor('retries twice'));
    await newVersion(s, V1.replace('retries twice', 'retries three times'));
    const document = s.world.documents.get(s.documentId)!;
    s.world.versions.delete(document.currentVersionId!);
    await expect(list(s)).rejects.toThrow('version row missing for current version');
  });

  it('throws on corrupted state: an older pinned version row is gone', async () => {
    const s = await setup();
    const comment = await commentOn(s, textAnchor('retries twice'));
    await newVersion(s, V1.replace('retries twice', 'retries three times'));
    s.world.versions.delete(comment.versionId);
    await expect(list(s)).rejects.toThrow('version row missing for comment');
  });

  it('404s a missing document', async () => {
    const s = await setup();
    const result = await listThreadsWithResolutions(
      s.documents,
      s.comments,
      s.versions,
      s.resolutions,
      s.storage,
      s.actor,
      'nope' as DocumentId,
    );
    expect(!result.ok && result.error.code).toBe('document_not_found');
  });

  it('errors when the document has no version', async () => {
    const s = await setup();
    const bare = s.world.addDocument(s.actor.ctx.orgId, {
      title: 'bare.md',
      projectId: null,
      ownerId: s.actor.ctx.userId,
    });
    const result = await listThreadsWithResolutions(
      s.documents,
      s.comments,
      s.versions,
      s.resolutions,
      s.storage,
      s.actor,
      bare.id,
    );
    expect(!result.ok && result.error.code).toBe('no_version');
  });
});

/**
 * Lazy suggestion materialization (ADR 0007): an accepted-but-unapplied
 * suggestion is marked applied only when the resolved range reads EXACTLY as
 * `proposedText` — never fuzzy, never guessed (Core Principle 2) — and the
 * cost is paid only by suggestion comments in exactly that pending state.
 */
describe('listThreadsWithResolutions — suggestion materialization', () => {
  it('marks an accepted suggestion applied when the resolved range exactly matches the proposal', async () => {
    const s = await setup();
    const suggestion = await acceptedSuggestionOn(s, textAnchor('retries twice'), 'retries thrice');
    await newVersion(s, V1.replace('retries twice', 'retries thrice'));

    const result = await list(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const thread = result.value.threads.find((t) => t.comment.id === suggestion.id);
    expect(thread?.comment.appliedVersionId).not.toBeNull();

    // Persisted, not just reflected in the response.
    const fresh = await s.comments.byId(s.actor.ctx, suggestion.id);
    expect(fresh?.appliedVersionId).toBe(thread?.comment.appliedVersionId);
  });

  it('marks an accepted suggestion applied when it was never re-pinned (same version fast path)', async () => {
    const s = await setup();
    // Accept the suggestion on the SAME version the current content already
    // matches the proposal on — no intervening upload — still must be caught,
    // since the resolved range already reads as the proposal.
    const suggestion = await acceptedSuggestionOn(s, textAnchor('retries twice'), 'retries twice');
    const result = await list(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const thread = result.value.threads.find((t) => t.comment.id === suggestion.id);
    expect(thread?.comment.appliedVersionId).not.toBeNull();
  });

  it('leaves an accepted suggestion pending when the resolved text does not match the proposal', async () => {
    const s = await setup();
    const suggestion = await acceptedSuggestionOn(s, textAnchor('retries twice'), 'retries thrice');
    // Nobody applied the suggestion — the text still reads as it always did.
    await newVersion(s, V1.replace('retries twice', 'retries three times'));

    const result = await list(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const thread = result.value.threads.find((t) => t.comment.id === suggestion.id);
    expect(thread?.comment.appliedVersionId).toBeNull();
    const fresh = await s.comments.byId(s.actor.ctx, suggestion.id);
    expect(fresh?.appliedVersionId).toBeNull();
  });

  it('leaves an accepted suggestion pending when its anchor orphans', async () => {
    const s = await setup();
    const suggestion = await acceptedSuggestionOn(
      s,
      textAnchor('Balances refresh every minute.'),
      'Balances refresh hourly.',
    );
    await newVersion(s, '# Doc\n\nEntirely different content now.\n');

    const result = await list(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const thread = result.value.threads.find((t) => t.comment.id === suggestion.id);
    expect(thread?.resolution.method).toBe('orphan');
    expect(thread?.comment.appliedVersionId).toBeNull();
  });

  it('never touches appliedVersionId for a plain (non-suggestion) comment', async () => {
    const s = await setup();
    const comment = await commentOn(s, textAnchor('retries twice'));
    await newVersion(s, V1.replace('retries twice', 'retries three times'));

    const result = await list(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const thread = result.value.threads.find((t) => t.comment.id === comment.id);
    expect(thread?.comment.appliedVersionId).toBeNull();
    expect(thread?.comment.kind).toBe('comment');
  });

  it('does not re-check an already-applied suggestion', async () => {
    const s = await setup();
    const suggestion = await acceptedSuggestionOn(s, textAnchor('retries twice'), 'retries thrice');
    await newVersion(s, V1.replace('retries twice', 'retries thrice'));
    const first = await list(s);
    if (!first.ok) throw new Error('list failed');
    const appliedVersionId = first.value.threads.find((t) => t.comment.id === suggestion.id)
      ?.comment.appliedVersionId;
    expect(appliedVersionId).not.toBeNull();

    // A further edit that no longer matches must not un-apply it — applied is
    // terminal, and the guard is conditional on appliedVersionId IS NULL.
    await newVersion(s, V1.replace('retries twice', 'gives up immediately'));
    const second = await list(s);
    if (!second.ok) throw new Error('list failed');
    const thread = second.value.threads.find((t) => t.comment.id === suggestion.id);
    expect(thread?.comment.appliedVersionId).toBe(appliedVersionId);
  });
});
