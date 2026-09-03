import { describe, expect, it } from 'vitest';
import { tenantContext } from './tenant-context.js';
import type { OrgId, UserId } from '@vorlyn/shared';

describe('tenantContext', () => {
  it('binds org and user', () => {
    const ctx = tenantContext('org-1' as OrgId, 'user-1' as UserId);
    expect(ctx).toEqual({ orgId: 'org-1', userId: 'user-1' });
  });
});
