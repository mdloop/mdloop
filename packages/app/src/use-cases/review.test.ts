import { beforeEach, describe, expect, it } from 'vitest';
import type { Document, Organization, User } from '@vorlyn/domain';
import type { ReviewRequestId, UserId } from '@vorlyn/shared';
import {
  FakeCommentRepository,
  FakeDocumentRepository,
  FakeOrganizationRepository,
  FakeReviewRepository,
  FakeShareGrantRepository,
  FakeWorld,
} from '../test-support/fakes.js';
import type { Actor } from './org-settings.js';
import type { ReviewDeps } from './review.js';
import { getReviewStatus, requestReview, revokeReviewRequest, submitReview } from './review.js';

/**
 * Authority matrix for the sign-off workflow over the fakes — who may request,
 * revoke, and verdict, plus the hard-gate block. Real Postgres re-proves the
 * grant-enforced append-only rule and tenant isolation in the Gherkin suite.
 */
function setup(orgOverrides: Partial<Organization> = {}) {
  const world = new FakeWorld();
  const org = world.org(orgOverrides);
  const deps: ReviewDeps = {
    documents: new FakeDocumentRepository(world),
    grants: new FakeShareGrantRepository(world),
    comments: new FakeCommentRepository(world),
    orgs: new FakeOrganizationRepository(world),
    reviews: new FakeReviewRepository(world),
  };

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
  const member = addUser('member', 'member@acme.test');

  const document = world.addDocument(org.id, {
    projectId: null,
    ownerId: owner.id,
    title: 'plan.md',
  });
  const version = world.addVersion(org.id, {
    documentId: document.id,
    contentHash: 'h1',
    byteSize: 10,
    source: 'web',
    createdBy: owner.id,
  });

  const grantAccess = async (user: User, permission: 'read' | 'comment'): Promise<void> => {
    await deps.grants.create(actorFor(owner).ctx, {
      subject: { type: 'document', id: document.id },
      grantee: { type: 'user', userId: user.id },
      permission,
      tokenHash: null,
      createdBy: owner.id,
    });
  };

  const openComment = async (): Promise<void> => {
    await deps.comments.create(actorFor(owner).ctx, {
      documentId: document.id,
      versionId: version.id,
      body: 'still open',
      anchor: { type: 'document' },
      authorId: owner.id,
    });
  };

  return {
    world,
    org,
    deps,
    document,
    version,
    owner,
    admin,
    member,
    actorFor,
    addUser,
    grantAccess,
    openComment,
  };
}

describe('requestReview', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('lets the owner request a member reviewer who has a grant', async () => {
    await s.grantAccess(s.member, 'comment');
    const res = await requestReview(s.deps, s.actorFor(s.owner), {
      documentId: s.document.id,
      reviewerUserId: s.member.id,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.reviewerUserId).toBe(s.member.id);
  });

  it('lets an org admin request even though they do not own the doc', async () => {
    const reviewer = s.addUser('member', 'r@acme.test');
    await s.grantAccess(reviewer, 'read');
    const res = await requestReview(s.deps, s.actorFor(s.admin), {
      documentId: s.document.id,
      reviewerUserId: reviewer.id,
    });
    expect(res.ok).toBe(true);
  });

  it('treats an admin reviewer as always having access (no grant needed)', async () => {
    const res = await requestReview(s.deps, s.actorFor(s.owner), {
      documentId: s.document.id,
      reviewerUserId: s.admin.id,
    });
    expect(res.ok).toBe(true);
  });

  it('lets a guest with a comment grant be requested', async () => {
    const guest = s.addUser('guest', 'guest@client.test');
    await s.grantAccess(guest, 'comment');
    const res = await requestReview(s.deps, s.actorFor(s.owner), {
      documentId: s.document.id,
      reviewerUserId: guest.id,
    });
    expect(res.ok).toBe(true);
  });

  it('forbids a plain member from requesting', async () => {
    const res = await requestReview(s.deps, s.actorFor(s.member), {
      documentId: s.document.id,
      reviewerUserId: s.admin.id,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
  });

  it('forbids a guest from requesting (defense in depth)', async () => {
    const guest = s.addUser('guest', 'guest@client.test');
    await s.grantAccess(guest, 'comment');
    const guestActor: Actor = { ctx: { orgId: s.org.id, userId: guest.id }, role: 'guest' };
    const res = await requestReview(s.deps, guestActor, {
      documentId: s.document.id,
      reviewerUserId: s.admin.id,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
  });

  it('rejects a reviewer with no access to the document', async () => {
    const res = await requestReview(s.deps, s.actorFor(s.owner), {
      documentId: s.document.id,
      reviewerUserId: s.member.id,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('reviewer_has_no_access');
  });

  it('rejects an unknown reviewer id', async () => {
    const res = await requestReview(s.deps, s.actorFor(s.owner), {
      documentId: s.document.id,
      reviewerUserId: 'nobody' as UserId,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('reviewer_not_found');
  });

  it('rejects a duplicate active request', async () => {
    await s.grantAccess(s.member, 'comment');
    const first = await requestReview(s.deps, s.actorFor(s.owner), {
      documentId: s.document.id,
      reviewerUserId: s.member.id,
    });
    expect(first.ok).toBe(true);
    const again = await requestReview(s.deps, s.actorFor(s.owner), {
      documentId: s.document.id,
      reviewerUserId: s.member.id,
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('already_requested');
  });

  it('404s on a missing document', async () => {
    const res = await requestReview(s.deps, s.actorFor(s.owner), {
      documentId: 'ghost' as Document['id'],
      reviewerUserId: s.admin.id,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('document_not_found');
  });
});

describe('revokeReviewRequest', () => {
  it('lets the owner revoke and thereby drop the reviewer', async () => {
    const s = setup();
    await s.grantAccess(s.member, 'comment');
    const req = await requestReview(s.deps, s.actorFor(s.owner), {
      documentId: s.document.id,
      reviewerUserId: s.member.id,
    });
    if (!req.ok) throw new Error('setup');
    const res = await revokeReviewRequest(s.deps, s.actorFor(s.owner), s.document.id, req.value.id);
    expect(res.ok).toBe(true);
    const active = await s.deps.reviews.activeRequestsForDocument(
      s.actorFor(s.owner).ctx,
      s.document.id,
    );
    expect(active).toHaveLength(0);
  });

  it('forbids a member from revoking', async () => {
    const s = setup();
    await s.grantAccess(s.member, 'comment');
    const req = await requestReview(s.deps, s.actorFor(s.owner), {
      documentId: s.document.id,
      reviewerUserId: s.member.id,
    });
    if (!req.ok) throw new Error('setup');
    const res = await revokeReviewRequest(
      s.deps,
      s.actorFor(s.member),
      s.document.id,
      req.value.id,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
  });

  it('forbids a guest from revoking', async () => {
    const s = setup();
    const guest = s.addUser('guest', 'guest@client.test');
    const guestActor: Actor = { ctx: { orgId: s.org.id, userId: guest.id }, role: 'guest' };
    const res = await revokeReviewRequest(
      s.deps,
      guestActor,
      s.document.id,
      'whatever' as ReviewRequestId,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
  });

  it('404s revoking an unknown request', async () => {
    const s = setup();
    const res = await revokeReviewRequest(
      s.deps,
      s.actorFor(s.owner),
      s.document.id,
      'missing' as ReviewRequestId,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('request_not_found');
  });
});

describe('submitReview', () => {
  it('records an approve verdict from an active reviewer and flips status', async () => {
    const s = setup();
    await s.grantAccess(s.member, 'comment');
    await requestReview(s.deps, s.actorFor(s.owner), {
      documentId: s.document.id,
      reviewerUserId: s.member.id,
    });
    const res = await submitReview(s.deps, s.actorFor(s.member), {
      documentId: s.document.id,
      verdict: 'approved',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.status).toBe('approved');
      expect(res.value.approval.versionId).toBe(s.version.id);
    }
  });

  it('changes_requested dominates', async () => {
    const s = setup();
    await s.grantAccess(s.member, 'comment');
    await requestReview(s.deps, s.actorFor(s.owner), {
      documentId: s.document.id,
      reviewerUserId: s.member.id,
    });
    const res = await submitReview(s.deps, s.actorFor(s.member), {
      documentId: s.document.id,
      verdict: 'changes_requested',
      note: 'needs work',
    });
    expect(res.ok && res.value.status).toBe('changes_requested');
  });

  it('rejects a verdict from someone not requested', async () => {
    const s = setup();
    const res = await submitReview(s.deps, s.actorFor(s.member), {
      documentId: s.document.id,
      verdict: 'approved',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('not_a_reviewer');
  });

  it('rejects an over-long note', async () => {
    const s = setup();
    await s.grantAccess(s.member, 'comment');
    await requestReview(s.deps, s.actorFor(s.owner), {
      documentId: s.document.id,
      reviewerUserId: s.member.id,
    });
    const res = await submitReview(s.deps, s.actorFor(s.member), {
      documentId: s.document.id,
      verdict: 'approved',
      note: 'x'.repeat(2001),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('note_too_long');
  });

  it('carries the acting API key id onto the approval (agent attribution)', async () => {
    const s = setup();
    await s.grantAccess(s.member, 'comment');
    await requestReview(s.deps, s.actorFor(s.owner), {
      documentId: s.document.id,
      reviewerUserId: s.member.id,
    });
    const agentActor: Actor = {
      ctx: { orgId: s.org.id, userId: s.member.id },
      role: 'member',
      apiKeyId: 'key-1',
    };
    const res = await submitReview(s.deps, agentActor, {
      documentId: s.document.id,
      verdict: 'approved',
    });
    expect(res.ok && res.value.approval.viaApiKeyId).toBe('key-1');
  });

  describe('hard gate', () => {
    it('blocks approve while open comments remain', async () => {
      const s = setup({ approvalGate: 'hard' });
      await s.grantAccess(s.member, 'comment');
      await requestReview(s.deps, s.actorFor(s.owner), {
        documentId: s.document.id,
        reviewerUserId: s.member.id,
      });
      await s.openComment();
      const res = await submitReview(s.deps, s.actorFor(s.member), {
        documentId: s.document.id,
        verdict: 'approved',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('open_comments_block_approval');
    });

    it('permits changes_requested even with open comments', async () => {
      const s = setup({ approvalGate: 'hard' });
      await s.grantAccess(s.member, 'comment');
      await requestReview(s.deps, s.actorFor(s.owner), {
        documentId: s.document.id,
        reviewerUserId: s.member.id,
      });
      await s.openComment();
      const res = await submitReview(s.deps, s.actorFor(s.member), {
        documentId: s.document.id,
        verdict: 'changes_requested',
      });
      expect(res.ok).toBe(true);
    });

    it('permits approve once no comments are open', async () => {
      const s = setup({ approvalGate: 'hard' });
      await s.grantAccess(s.member, 'comment');
      await requestReview(s.deps, s.actorFor(s.owner), {
        documentId: s.document.id,
        reviewerUserId: s.member.id,
      });
      const res = await submitReview(s.deps, s.actorFor(s.member), {
        documentId: s.document.id,
        verdict: 'approved',
      });
      expect(res.ok).toBe(true);
    });
  });

  it('soft gate never blocks approve with open comments', async () => {
    const s = setup({ approvalGate: 'soft' });
    await s.grantAccess(s.member, 'comment');
    await requestReview(s.deps, s.actorFor(s.owner), {
      documentId: s.document.id,
      reviewerUserId: s.member.id,
    });
    await s.openComment();
    const res = await submitReview(s.deps, s.actorFor(s.member), {
      documentId: s.document.id,
      verdict: 'approved',
    });
    expect(res.ok).toBe(true);
  });
});

describe('edge branches', () => {
  async function requestedReviewer(s: ReturnType<typeof setup>) {
    await s.grantAccess(s.member, 'comment');
    await requestReview(s.deps, s.actorFor(s.owner), {
      documentId: s.document.id,
      reviewerUserId: s.member.id,
    });
  }

  it('submitReview 409s no_version when the document has no current version', async () => {
    const s = setup();
    await requestedReviewer(s);
    // Drop the version pointer after the request was placed.
    const doc = s.world.documents.get(s.document.id);
    if (doc) s.world.documents.set(doc.id, { ...doc, currentVersionId: null });
    const res = await submitReview(s.deps, s.actorFor(s.member), {
      documentId: s.document.id,
      verdict: 'approved',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('no_version');
  });

  it('submitReview 404s on a soft-deleted document', async () => {
    const s = setup();
    const doc = s.world.documents.get(s.document.id);
    if (doc) s.world.documents.set(doc.id, { ...doc, deletedAt: new Date() });
    const res = await submitReview(s.deps, s.actorFor(s.member), {
      documentId: s.document.id,
      verdict: 'approved',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('document_not_found');
  });

  it('submitReview surfaces org_not_found when the org row is gone', async () => {
    const s = setup();
    await requestedReviewer(s);
    s.world.orgs.delete(s.org.id);
    const res = await submitReview(s.deps, s.actorFor(s.member), {
      documentId: s.document.id,
      verdict: 'approved',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('org_not_found');
  });

  it('requestReview surfaces org_not_found when the org row is gone', async () => {
    const s = setup();
    s.world.orgs.delete(s.org.id);
    const res = await requestReview(s.deps, s.actorFor(s.owner), {
      documentId: s.document.id,
      reviewerUserId: s.admin.id,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('org_not_found');
  });

  it('getReviewStatus 404s on a soft-deleted document', async () => {
    const s = setup();
    const doc = s.world.documents.get(s.document.id);
    if (doc) s.world.documents.set(doc.id, { ...doc, deletedAt: new Date() });
    const res = await getReviewStatus(s.deps, s.actorFor(s.owner), s.document.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('document_not_found');
  });

  it('getReviewStatus surfaces org_not_found when the org row is gone', async () => {
    const s = setup();
    s.world.orgs.delete(s.org.id);
    const res = await getReviewStatus(s.deps, s.actorFor(s.owner), s.document.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('org_not_found');
  });
});

describe('getReviewStatus', () => {
  it('returns the derived picture with gate and open count for a reader', async () => {
    const s = setup({ approvalGate: 'hard' });
    await s.grantAccess(s.member, 'comment');
    await requestReview(s.deps, s.actorFor(s.owner), {
      documentId: s.document.id,
      reviewerUserId: s.member.id,
    });
    await s.openComment();
    const res = await getReviewStatus(s.deps, s.actorFor(s.member), s.document.id);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.status).toBe('in_review');
      expect(res.value.gate).toBe('hard');
      expect(res.value.openCommentCount).toBe(1);
      expect(res.value.requests).toHaveLength(1);
    }
  });

  it('404s for a stranger with no access', async () => {
    const s = setup();
    const stranger = s.addUser('member', 'stranger@acme.test');
    const res = await getReviewStatus(s.deps, s.actorFor(stranger), s.document.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('document_not_found');
  });
});
