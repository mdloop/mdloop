import { describe, expect, it } from 'vitest';
import { assertNonSuperuserRole } from './role-assertions.js';
import type { RoleQueryable } from './role-assertions.js';

function fakeDb(rows: { rolsuper: boolean; rolbypassrls: boolean }[]): RoleQueryable {
  return { query: () => Promise.resolve({ rows }) };
}

describe('assertNonSuperuserRole', () => {
  it('passes for a non-superuser, non-bypassrls role', async () => {
    await expect(
      assertNonSuperuserRole(fakeDb([{ rolsuper: false, rolbypassrls: false }])),
    ).resolves.toBeUndefined();
  });

  it('throws when the connected role is a superuser', async () => {
    await expect(
      assertNonSuperuserRole(fakeDb([{ rolsuper: true, rolbypassrls: false }])),
    ).rejects.toThrow(/SUPERUSER or BYPASSRLS/);
  });

  it('throws when the connected role has BYPASSRLS', async () => {
    await expect(
      assertNonSuperuserRole(fakeDb([{ rolsuper: false, rolbypassrls: true }])),
    ).rejects.toThrow(/SUPERUSER or BYPASSRLS/);
  });

  it('throws when the connected role cannot be determined', async () => {
    await expect(assertNonSuperuserRole(fakeDb([]))).rejects.toThrow(/connected DB role/);
  });
});
