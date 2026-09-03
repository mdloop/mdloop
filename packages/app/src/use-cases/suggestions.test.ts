import { beforeEach, describe, expect, it } from 'vitest';
import type { Comment, Document, Organization, User } from '@vorlyn/domain';
import { createTextAnchor } from '@vorlyn/domain';
import type { CommentId } from '@vorlyn/shared';
import {
  FakeCommentRepository,
  FakeDocumentRepository,
  FakeOrganizationRepository,
  FakeShareGrantRepository,
  FakeStorage,
  FakeUploadUnitOfWork,
  FakeWorld,
} from '../test-support/fakes.js';
import type { Actor } from './org-settings.js';
import { createComment } from './comments.js';
import type { AcceptSuggestionDeps } from './suggestions.js';
import { acceptSuggestion, rejectSuggestion } from './suggestions.js';
import { uploadNewDocument } from './upload.js';

/**
 * Accept/reject authority + honesty matrix over the fakes (ADR 0007: accept
 * is metadata-only — no storage, no versions, no upload dep at all). The real
 * Postgres suite (features/suggested-edits.feature) re-proves the same gates
 * plus the lazy materialization behavior, which lives in reanchor-threads.ts.
 */
const encoder = new TextEncoder();
const BASE = '# Doc\n\nThe quick brown fox.';

function setup(orgOverrides: Partial<Organization> = {}) {
  const world = new FakeWorld();
  const org = world.org(orgOverrides);
  const storage = new FakeStorage();
  const uploadUow = new FakeUploadUnitOfWork(world);
  const documents = new FakeDocumentRepository(world);
  const comments = new FakeCommentRepository(world);
  const orgs = new FakeOrganizationRepository(world);
  const grants = new FakeShareGrantRepository(world);
  const deps: AcceptSuggestionDeps = { documents, comments };

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
  const admin = addUser('admin', 'admin@acme.test');
  const stranger = addUser('member', 'stranger@acme.test');

  return {
    world,
    org,
    deps,
    storage,
    uploadUow,
    documents,
    comments,
    orgs,
    grants,
    actorFor,
    owner,
    admin,
    stranger,
  };
}

type Ctx = ReturnType<typeof setup>;

/** Seeds a document (first version = BASE) owned by `owner`. */
async function seedDoc(s: Ctx, content = BASE): Promise<Document> {
  const r = await uploadNewDocument(s.uploadUow, s.storage, s.actorFor(s.owner), {
    title: 'doc.md',
    projectId: null,
    content: encoder.encode(content),
    source: 'web',
  });
  if (!r.ok) throw new Error(`seed failed: ${r.error.code}`);
  return r.value.document;
}

/** Creates a suggestion by `owner` anchored to `quote` in `source`, proposing `replacement`. */
async function suggest(
  s: Ctx,
  doc: Document,
  quote: string,
  replacement: string,
  source = BASE,
): Promise<Comment> {
  const start = source.indexOf(quote);
  const anchor = createTextAnchor(source, start, start + quote.length);
  const r = await createComment(s.documents, s.comments, s.orgs, s.grants, s.actorFor(s.owner), {
    documentId: doc.id,
    body: `replace "${quote}"`,
    anchor,
    proposedText: replacement,
  });
  if (!r.ok) throw new Error(`suggest failed: ${r.error.code}`);
  return r.value;
}

describe('acceptSuggestion', () => {
  let s: Ctx;
  beforeEach(() => {
    s = setup();
  });

  it('flips the outcome to accepted and leaves appliedVersionId null — no document mutation', async () => {
    const doc = await seedDoc(s);
    const suggestion = await suggest(s, doc, 'quick', 'slow');
    const r = await acceptSuggestion(s.deps, s.actorFor(s.owner), suggestion.id, 'web');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.comment.suggestionOutcome).toBe('accepted');
    expect(r.value.comment.appliedVersionId).toBeNull();
    // The result is metadata-only: no version/deduplicated field exists anymore.
    expect(Object.keys(r.value)).toEqual(['comment']);
    // The document's stored content is byte-for-byte untouched.
    const fresh = await s.documents.byId(s.actorFor(s.owner).ctx, doc.id);
    const bytes = await s.storage.get({
      orgId: s.org.id,
      documentId: doc.id,
      seq: 1,
    });
    expect(new TextDecoder().decode(bytes)).toBe(BASE);
    expect(fresh?.currentVersionId).toBe(doc.currentVersionId);
  });

  it('an org admin (not the owner) can accept', async () => {
    const doc = await seedDoc(s);
    const suggestion = await suggest(s, doc, 'quick', 'nimble');
    const r = await acceptSuggestion(s.deps, s.actorFor(s.admin), suggestion.id, 'web');
    expect(r.ok).toBe(true);
  });

  it('refuses a non-owner, non-admin member with forbidden', async () => {
    const doc = await seedDoc(s);
    const suggestion = await suggest(s, doc, 'quick', 'slow');
    const r = await acceptSuggestion(s.deps, s.actorFor(s.stranger), suggestion.id, 'web');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
    // The suggestion stays open — a refused accept never resolves it.
    const fresh = await s.comments.byId(s.actorFor(s.owner).ctx, suggestion.id);
    expect(fresh?.suggestionOutcome).toBe('open');
  });

  it('succeeds even when the anchored text no longer exists in the current version — nothing is spliced, so nothing can be guessed', async () => {
    const doc = await seedDoc(s);
    const suggestion = await suggest(s, doc, 'quick', 'slow');
    // Old behavior refused this with suggestion_unanchored (accept used to
    // re-anchor and splice). New behavior: accept never reads document
    // content, so an unresolvable anchor is simply irrelevant to it.
    const r = await acceptSuggestion(s.deps, s.actorFor(s.owner), suggestion.id, 'web');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.comment.suggestionOutcome).toBe('accepted');
    expect(r.value.comment.appliedVersionId).toBeNull();
  });

  it('rejects a second accept on an already-resolved suggestion (double-resolve)', async () => {
    const doc = await seedDoc(s);
    const suggestion = await suggest(s, doc, 'quick', 'slow');
    const first = await acceptSuggestion(s.deps, s.actorFor(s.owner), suggestion.id, 'web');
    expect(first.ok).toBe(true);
    const second = await acceptSuggestion(s.deps, s.actorFor(s.owner), suggestion.id, 'web');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('suggestion_not_open');
  });

  it('refuses to accept a plain comment', async () => {
    const doc = await seedDoc(s);
    const plain = await createComment(
      s.documents,
      s.comments,
      s.orgs,
      s.grants,
      s.actorFor(s.owner),
      {
        documentId: doc.id,
        body: 'just a note',
        anchor: { type: 'document' },
      },
    );
    if (!plain.ok) throw new Error('comment failed');
    const r = await acceptSuggestion(s.deps, s.actorFor(s.owner), plain.value.id, 'web');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_a_suggestion');
  });

  it('returns comment_not_found for a missing or soft-deleted comment', async () => {
    await seedDoc(s);
    const r = await acceptSuggestion(s.deps, s.actorFor(s.owner), 'nope' as CommentId, 'web');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('comment_not_found');
  });
});

describe('rejectSuggestion', () => {
  let s: Ctx;
  beforeEach(() => {
    s = setup();
  });

  it('marks an open suggestion rejected (owner)', async () => {
    const doc = await seedDoc(s);
    const suggestion = await suggest(s, doc, 'quick', 'slow');
    const r = await rejectSuggestion(
      { documents: s.documents, comments: s.comments },
      s.actorFor(s.owner),
      suggestion.id,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.suggestionOutcome).toBe('rejected');
    expect(r.value.appliedVersionId).toBeNull();
  });

  it('an admin can reject', async () => {
    const doc = await seedDoc(s);
    const suggestion = await suggest(s, doc, 'quick', 'slow');
    const r = await rejectSuggestion(
      { documents: s.documents, comments: s.comments },
      s.actorFor(s.admin),
      suggestion.id,
    );
    expect(r.ok).toBe(true);
  });

  it('refuses a non-owner member with forbidden', async () => {
    const doc = await seedDoc(s);
    const suggestion = await suggest(s, doc, 'quick', 'slow');
    const r = await rejectSuggestion(
      { documents: s.documents, comments: s.comments },
      s.actorFor(s.stranger),
      suggestion.id,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('refuses to reject a plain comment', async () => {
    const doc = await seedDoc(s);
    const plain = await createComment(
      s.documents,
      s.comments,
      s.orgs,
      s.grants,
      s.actorFor(s.owner),
      {
        documentId: doc.id,
        body: 'note',
        anchor: { type: 'document' },
      },
    );
    if (!plain.ok) throw new Error('comment failed');
    const r = await rejectSuggestion(
      { documents: s.documents, comments: s.comments },
      s.actorFor(s.owner),
      plain.value.id,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_a_suggestion');
  });

  it('rejects a double-resolve (already accepted)', async () => {
    const doc = await seedDoc(s);
    const suggestion = await suggest(s, doc, 'quick', 'slow');
    await acceptSuggestion(s.deps, s.actorFor(s.owner), suggestion.id, 'web');
    const r = await rejectSuggestion(
      { documents: s.documents, comments: s.comments },
      s.actorFor(s.owner),
      suggestion.id,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('suggestion_not_open');
  });

  it('returns comment_not_found for a missing comment', async () => {
    await seedDoc(s);
    const r = await rejectSuggestion(
      { documents: s.documents, comments: s.comments },
      s.actorFor(s.owner),
      'nope' as CommentId,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('comment_not_found');
  });
});

// A guest can never accept/reject (structurally — the owner/admin gate),
// deliberately unloosened by ADR 0007 (decision 4).
describe('suggestion authority for guests', () => {
  it('a guest is refused accept with forbidden', async () => {
    const s = setup();
    const guest = s.world.addUser(s.org.id, {
      workosUserId: 'guest:g@ext.test',
      email: 'g@ext.test',
      displayName: 'g',
      role: 'guest',
    });
    const doc = await seedDoc(s);
    const suggestion = await suggest(s, doc, 'quick', 'slow');
    const guestActor: Actor = { ctx: { orgId: s.org.id, userId: guest.id }, role: 'guest' };
    const r = await acceptSuggestion(s.deps, guestActor, suggestion.id, 'web');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });
});
