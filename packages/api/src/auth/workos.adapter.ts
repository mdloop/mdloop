import { WorkOS } from '@workos-inc/node';
import type { AuthPort, AuthProfile } from '@mdloop/app';

/**
 * WorkOS AuthKit adapter (CONSTITUTION.md §2). The only file that touches the
 * WorkOS SDK for authentication — swap here, nowhere else.
 */
export class WorkosAuthAdapter implements AuthPort {
  private readonly workos: WorkOS;

  constructor(
    apiKey: string,
    private readonly clientId: string,
  ) {
    this.workos = new WorkOS(apiKey);
  }

  authorizationUrl(redirectUri: string, state: string): string {
    return this.workos.userManagement.getAuthorizationUrl({
      clientId: this.clientId,
      redirectUri,
      provider: 'authkit',
      state,
    });
  }

  async exchangeCode(code: string): Promise<AuthProfile> {
    const { user, organizationId, authenticationMethod } =
      await this.workos.userManagement.authenticateWithCode({
        clientId: this.clientId,
        code,
      });
    const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ');
    return {
      providerUserId: user.id,
      email: user.email,
      displayName,
      // Enterprise JIT (Phase 15): WorkOS's Organization id is the stable
      // handle its SSO connections attach to — only meaningful when this
      // login actually went through SSO, never for password/OTP/OAuth.
      ...(authenticationMethod === 'SSO' && organizationId
        ? { ssoConnectionId: organizationId }
        : {}),
    };
  }
}
