import { describe, expect, it } from 'vitest';
import { SingleUserAuthAdapter } from './single-user.adapter.js';
import type { AuthProfile } from '@vorlyn/app';

const profile: AuthProfile = {
  providerUserId: 'self-host-owner',
  email: 'owner@example.com',
  displayName: 'Owner',
};

describe('SingleUserAuthAdapter', () => {
  it('resolves exchangeCode to exactly the configured profile, regardless of code', async () => {
    const adapter = new SingleUserAuthAdapter(profile);
    await expect(adapter.exchangeCode('anything')).resolves.toEqual(profile);
    await expect(adapter.exchangeCode('')).resolves.toEqual(profile);
  });

  it('embeds the redirect URI and state in authorizationUrl, like the loopback literal', () => {
    const adapter = new SingleUserAuthAdapter(profile);
    const url = adapter.authorizationUrl('http://localhost:5173/callback', 'state-123');
    expect(url).toBe('http://localhost:5173/callback?code=single-user&state=state-123');
  });

  it('uses the configured identity, not a hardcoded dev fixture', async () => {
    const other: AuthProfile = {
      providerUserId: 'wos_someone_else',
      email: 'someone@else.example',
      displayName: 'Someone Else',
      ssoConnectionId: 'org_123',
    };
    const adapter = new SingleUserAuthAdapter(other);
    const resolved = await adapter.exchangeCode('code');
    expect(resolved).toEqual(other);
    expect(resolved.email).not.toBe('dev@vorlyn.local');
  });
});
