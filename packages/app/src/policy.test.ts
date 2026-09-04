import { describe, expect, it } from 'vitest';
import type { OrgId, UserId } from '@mdloop/shared';
import {
  canEditDocument,
  canManageDocument,
  canManageProject,
  canShareDocument,
} from './policy.js';
import type { Actor } from './use-cases/org-settings.js';

const orgId = 'org-1' as OrgId;
const owner = 'u-owner' as UserId;
const other = 'u-other' as UserId;

function actor(userId: UserId, role: Actor['role']): Actor {
  return { ctx: { orgId, userId }, role };
}

const document = { ownerId: owner };

describe('canManageDocument (unchanged by ADR 0008)', () => {
  it('is true for the owner and for any org admin, false for everyone else', () => {
    expect(canManageDocument(actor(owner, 'member'), document)).toBe(true);
    expect(canManageDocument(actor(other, 'admin'), document)).toBe(true);
    expect(canManageDocument(actor(other, 'member'), document)).toBe(false);
    expect(canManageDocument(actor(other, 'guest'), document)).toBe(false);
  });

  it('never consults a share grant — an edit grant buys no management rights', () => {
    // The predicate takes no grant at all; this is the structural guarantee
    // ADR 0008 decision 1 relies on. Asserted through behaviour: the very
    // actor that canEditDocument accepts is still refused here.
    const editor = actor(other, 'member');
    expect(canEditDocument(editor, document, { permission: 'edit' })).toBe(true);
    expect(canManageDocument(editor, document)).toBe(false);
  });
});

describe('canEditDocument (ADR 0008)', () => {
  it('is true for the document owner, with or without a grant', () => {
    expect(canEditDocument(actor(owner, 'member'), document)).toBe(true);
    expect(canEditDocument(actor(owner, 'member'), document, { permission: 'read' })).toBe(true);
  });

  it('is true for an org admin', () => {
    expect(canEditDocument(actor(other, 'admin'), document)).toBe(true);
  });

  it('is true for a member holding an explicit edit grant', () => {
    expect(canEditDocument(actor(other, 'member'), document, { permission: 'edit' })).toBe(true);
  });

  it('is false for a member with a weaker grant, or none at all', () => {
    expect(canEditDocument(actor(other, 'member'), document, { permission: 'comment' })).toBe(
      false,
    );
    expect(canEditDocument(actor(other, 'member'), document, { permission: 'read' })).toBe(false);
    expect(canEditDocument(actor(other, 'member'), document, undefined)).toBe(false);
  });

  it('is false for a guest even when the grant says edit (layer c of the carve-out)', () => {
    expect(canEditDocument(actor(other, 'guest'), document, { permission: 'edit' })).toBe(false);
    expect(canEditDocument(actor(other, 'guest'), document, { permission: 'comment' })).toBe(false);
  });

  it('is false for a guest who somehow owns the document', () => {
    // Unreachable today (a guest never creates a document), but the guest
    // branch must win over ownership, not the other way round.
    expect(canEditDocument(actor(owner, 'guest'), document, { permission: 'edit' })).toBe(false);
  });
});

describe('canShareDocument (ADR 0014)', () => {
  it('is true for the document owner, with or without a grant', () => {
    expect(canShareDocument(actor(owner, 'member'), document)).toBe(true);
    expect(canShareDocument(actor(owner, 'member'), document, { permission: 'read' })).toBe(true);
  });

  it('is true for an org admin', () => {
    expect(canShareDocument(actor(other, 'admin'), document)).toBe(true);
  });

  it('is true for a member holding a share grant', () => {
    expect(canShareDocument(actor(other, 'member'), document, { permission: 'share' })).toBe(true);
  });

  it('is true for a member holding an edit grant — edit inherits share', () => {
    expect(canShareDocument(actor(other, 'member'), document, { permission: 'edit' })).toBe(true);
  });

  it('is false for a member with a weaker grant, or none at all', () => {
    expect(canShareDocument(actor(other, 'member'), document, { permission: 'comment' })).toBe(
      false,
    );
    expect(canShareDocument(actor(other, 'member'), document, { permission: 'read' })).toBe(false);
    expect(canShareDocument(actor(other, 'member'), document, undefined)).toBe(false);
  });

  it('is false for a guest even when the grant says share or edit (guest cap is absolute)', () => {
    expect(canShareDocument(actor(other, 'guest'), document, { permission: 'edit' })).toBe(false);
    expect(canShareDocument(actor(other, 'guest'), document, { permission: 'share' })).toBe(false);
    expect(canShareDocument(actor(other, 'guest'), document, { permission: 'comment' })).toBe(
      false,
    );
  });

  it('is false for a guest who somehow owns the document — guest branch wins over ownership', () => {
    expect(canShareDocument(actor(owner, 'guest'), document, { permission: 'edit' })).toBe(false);
  });

  it('never consults canManageDocument-only state — a share grant buys sharing, not management', () => {
    // The structural counterpart of policy.test.ts's canManageDocument check
    // above: a share grant is sufficient for canShareDocument but must not
    // leak into canManageDocument.
    const sharer = actor(other, 'member');
    expect(canShareDocument(sharer, document, { permission: 'share' })).toBe(true);
    expect(canManageDocument(sharer, document)).toBe(false);
  });
});

describe('canManageProject', () => {
  it('is admin-only when the project has no recorded creator', () => {
    expect(canManageProject(actor(other, 'admin'), { createdBy: null })).toBe(true);
    expect(canManageProject(actor(other, 'member'), { createdBy: null })).toBe(false);
  });

  it('lets the creating member manage their own project', () => {
    expect(canManageProject(actor(other, 'member'), { createdBy: other })).toBe(true);
    expect(canManageProject(actor(other, 'member'), { createdBy: owner })).toBe(false);
  });
});
