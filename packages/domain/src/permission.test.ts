import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  canDelegate,
  highest,
  isGuestGrantable,
  isLinkGrantable,
  permits,
} from './permission.js';
import type {
  GrantablePermission,
  GuestGrantablePermission,
  LinkGrantablePermission,
  Permission,
} from './permission.js';

describe('permission lattice', () => {
  it('orders read < comment < share < edit', () => {
    expect(permits('read', 'read')).toBe(true);
    expect(permits('read', 'comment')).toBe(false);
    expect(permits('read', 'share')).toBe(false);
    expect(permits('read', 'edit')).toBe(false);

    expect(permits('comment', 'read')).toBe(true);
    expect(permits('comment', 'comment')).toBe(true);
    expect(permits('comment', 'share')).toBe(false);
    expect(permits('comment', 'edit')).toBe(false);

    expect(permits('share', 'read')).toBe(true);
    expect(permits('share', 'comment')).toBe(true);
    expect(permits('share', 'share')).toBe(true);
    expect(permits('share', 'edit')).toBe(false);

    expect(permits('edit', 'read')).toBe(true);
    expect(permits('edit', 'comment')).toBe(true);
    expect(permits('edit', 'share')).toBe(true);
    expect(permits('edit', 'edit')).toBe(true);
  });

  it('every permission satisfies itself', () => {
    for (const p of PERMISSIONS) expect(permits(p, p)).toBe(true);
  });

  it('highest picks the max held permission', () => {
    expect(highest([])).toBeUndefined();
    expect(highest(['read'])).toBe('read');
    expect(highest(['read', 'edit', 'comment'])).toBe('edit');
    expect(highest(['comment', 'read'])).toBe('comment');
    expect(highest(['comment', 'share'])).toBe('share');
    expect(highest(['share', 'edit'])).toBe('edit');
  });

  it('share and edit ARE grantable on a named user grant (ADR 0008, ADR 0014)', () => {
    const legal: GrantablePermission[] = ['read', 'comment', 'share', 'edit'];
    const asPermissions: Permission[] = legal;
    expect(asPermissions).toEqual(['read', 'comment', 'share', 'edit']);
  });

  it('neither share nor edit is ever grantable to an external guest (compile-time cap)', () => {
    // @ts-expect-error -- share must never be assignable to GuestGrantablePermission
    const illegalShare: GuestGrantablePermission = 'share';
    void illegalShare;
    // @ts-expect-error -- edit must never be assignable to GuestGrantablePermission
    const illegalEdit: GuestGrantablePermission = 'edit';
    void illegalEdit;
    const legal: GuestGrantablePermission[] = ['read', 'comment'];
    expect(legal).toEqual(['read', 'comment']);
  });

  it('neither share nor edit is ever grantable by link (compile-time cap)', () => {
    // @ts-expect-error -- share must never be assignable to LinkGrantablePermission
    const illegalShare: LinkGrantablePermission = 'share';
    void illegalShare;
    // @ts-expect-error -- edit must never be assignable to LinkGrantablePermission
    const illegalEdit: LinkGrantablePermission = 'edit';
    void illegalEdit;
    const legal: LinkGrantablePermission[] = ['read', 'comment'];
    expect(legal).toEqual(['read', 'comment']);
  });

  it('the runtime caps mirror the compile-time ones', () => {
    expect(isGuestGrantable('read')).toBe(true);
    expect(isGuestGrantable('comment')).toBe(true);
    expect(isGuestGrantable('share')).toBe(false);
    expect(isGuestGrantable('edit')).toBe(false);
    expect(isLinkGrantable('read')).toBe(true);
    expect(isLinkGrantable('comment')).toBe(true);
    expect(isLinkGrantable('share')).toBe(false);
    expect(isLinkGrantable('edit')).toBe(false);
  });

  it('canDelegate caps a grant at the granter’s own held level (ADR 0014)', () => {
    expect(canDelegate('share', 'read')).toBe(true);
    expect(canDelegate('share', 'comment')).toBe(true);
    expect(canDelegate('share', 'share')).toBe(true);
    expect(canDelegate('share', 'edit')).toBe(false);

    expect(canDelegate('edit', 'read')).toBe(true);
    expect(canDelegate('edit', 'comment')).toBe(true);
    expect(canDelegate('edit', 'share')).toBe(true);
    expect(canDelegate('edit', 'edit')).toBe(true);

    expect(canDelegate('comment', 'share')).toBe(false);
    expect(canDelegate('comment', 'edit')).toBe(false);
  });
});
