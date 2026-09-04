import type { AuthPort, AuthProfile } from '@mdloop/app';

/**
 * Single-identity auth adapter for self-hosted, single-user mdloop
 * instances (open-source release track). There is no real IdP round trip —
 * `authorizationUrl` immediately redirects back with a synthetic code, and
 * `exchangeCode` always resolves to the one configured profile, mirroring
 * the inline loopback literals `dev-main.ts`/`e2e-main.ts` already use for
 * the same "no login screen" shape.
 *
 * The difference from those dev-only literals is that the identity is
 * configured, not hardcoded: a self-hoster's instance should authenticate
 * as *their* email/name, not `dev@mdloop.local`. This makes the class safe
 * to use in a real (if single-tenant, single-user) deployment — unlike the
 * dev/e2e literals, which stay exactly as they are.
 */
export class SingleUserAuthAdapter implements AuthPort {
  constructor(private readonly profile: AuthProfile) {}

  authorizationUrl(redirectUri: string, state: string): string {
    return `${redirectUri}?code=single-user&state=${state}`;
  }

  exchangeCode(_code: string): Promise<AuthProfile> {
    return Promise.resolve(this.profile);
  }
}
