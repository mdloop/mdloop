import {
  None,
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  discovery,
  randomNonce,
  randomPKCECodeVerifier,
} from 'openid-client';
import type { Configuration } from 'openid-client';
import type { AuthPort, AuthProfile } from '@vorlyn/app';

export interface OidcAuthAdapterConfig {
  /** OIDC discovery issuer — `${issuer}/.well-known/openid-configuration` is fetched, never hardcoded per-provider endpoints. */
  readonly issuer: string;
  readonly clientId: string;
  /** Omit for a public client authenticating via PKCE alone — both shapes are valid self-host setups. */
  readonly clientSecret?: string;
  /** Defaults to ['openid', 'email', 'profile']. */
  readonly scopes?: readonly string[];
  /**
   * Test-only escape hatch: lets discovery/token/userinfo calls target a
   * plain-http endpoint instead of requiring TLS. Never set true in real
   * wiring (`selfhost-main.ts` never sets this) — mirrors the
   * `SmtpEmailAdapterConfig.transporter` escape hatch already used in this
   * codebase for the same "inject a fake instead of hitting the network in
   * prod" purpose.
   */
  readonly allowInsecureRequestsForTests?: boolean;
}

const DEFAULT_SCOPES = ['openid', 'email', 'profile'];

/**
 * How long a pending authorization request's PKCE verifier/nonce stay valid
 * before `exchangeCode` refuses to use them — matches auth-routes.ts's own
 * `vorlyn_oauth_state` cookie `maxAge` (600s), the sibling piece of state
 * this same round trip already carries.
 */
const PENDING_TTL_MS = 10 * 60 * 1000;

interface PkceMaterial {
  readonly verifier: string;
  readonly challenge: string;
  readonly nonce: string;
}

interface PendingFlow {
  readonly verifier: string;
  readonly nonce: string;
  readonly redirectUri: string;
  readonly expiresAtMs: number;
}

/**
 * Generic OIDC browser-login `AuthPort` for self-hosted instances (open-
 * source release track) — works against any standards-compliant provider
 * (Keycloak, Authentik, Dex, Google, Okta, ...) via OIDC discovery, never a
 * hardcoded per-provider endpoint. Authorization-code flow with PKCE
 * (`openid-client` v6's functional API — see package README, this class
 * does not hand-roll any crypto or protocol logic).
 *
 * ## The PKCE-verifier-storage problem, and how this class solves it
 *
 * `AuthPort.authorizationUrl(redirectUri, state): string` is synchronous and
 * returns a plain URL string; `AuthPort.exchangeCode(code): Promise<AuthProfile>`
 * receives only the authorization `code` — not `state`, not `redirectUri`.
 * Looking at how `auth-routes.ts` drives this (the only caller): it
 * generates `state` itself, stores it in a short-lived cookie for its own
 * CSRF check, and — critically — never forwards `state` into `exchangeCode`.
 * So neither of the two obvious homes for a PKCE `code_verifier` (a value
 * that must survive from the authorization request to the token exchange)
 * is reachable from inside `exchangeCode`: there is no `state` argument to
 * key a lookup by, and there is no cookie/session access from an `AuthPort`
 * implementation (it never sees the Fastify request/reply).
 *
 * This class does not change `AuthPort`'s signature (every other adapter —
 * `WorkosAuthAdapter`, `SingleUserAuthAdapter` — and every test implementing
 * it would break). Instead it keeps its own single-slot, short-TTL, in-
 * memory correlation: `authorizationUrl` consumes one pre-generated
 * `{verifier, challenge, nonce}` triple, stashes `{verifier, nonce,
 * redirectUri}` as `this.pending` (redirectUri travels along for exactly
 * the same reason — `exchangeCode` needs it too, to rebuild the callback URL
 * `authorizationCodeGrant` expects, and it is likewise absent from
 * `exchangeCode`'s signature), and kicks off background regeneration of the
 * next triple (PKCE challenge computation is `async` — WebCrypto digest —
 * so it cannot be done synchronously inside `authorizationUrl` itself).
 * `exchangeCode` consumes and clears `this.pending`.
 *
 * The real state/CSRF check for the OAuth round trip itself stays exactly
 * where it already is — auth-routes.ts's `vorlyn_oauth_state` cookie
 * comparison, which runs *before* `exchangeCode` is ever called — so this
 * class deliberately does not duplicate it; the `nonce` above is a second,
 * independent check (ID-token replay/substitution defense), not a stand-in
 * for the missing `state`.
 *
 * **Known limitation, honestly flagged rather than hidden**: because there
 * is exactly one pending slot, only one login can be genuinely in flight at
 * a time. Self-host is single-instance/single-org by design (see
 * `selfhost-main.ts`), so in practice this means "one browser tab logging in
 * at once" — a second, overlapping attempt overwrites the first's pending
 * verifier, and the first tab's `exchangeCode` then fails closed (a clear
 * thrown error, never a silent wrong-verifier success) rather than
 * succeeding with mismatched material. This is a real constraint of
 * `AuthPort`'s fixed two-method, no-side-channel shape, not a bug in this
 * class — carrying the verifier correctly across concurrent flows would
 * need `AuthPort` itself to grow a slot for it (e.g. an explicit state
 * object threaded through both calls), which this pass was told not to do.
 */
export class OidcAuthAdapter implements AuthPort {
  private ready: PkceMaterial | undefined;
  private pending: PendingFlow | undefined;

  private constructor(
    private readonly config: OidcAuthAdapterConfig,
    private readonly discovered: Configuration,
  ) {}

  /**
   * Async factory — OIDC discovery (`.well-known/openid-configuration`) is
   * inherently a network round trip, and `AuthPort`'s constructor-less
   * interface gives no other place to await it. Callers (`selfhost-main.ts`)
   * `await` this at boot, the same "fail loud at startup, not on first
   * request" instinct `assertNonSuperuserRole`/`configFromEnv` already use
   * elsewhere in this codebase — by the time the server starts accepting
   * requests, discovery has already succeeded and the first PKCE material is
   * already buffered.
   */
  static async create(config: OidcAuthAdapterConfig): Promise<OidcAuthAdapter> {
    const issuerUrl = new URL(config.issuer);
    // allowInsecureRequests must be threaded through discovery's own
    // `execute` option, not called after — the discovery request itself is
    // the first (and by default HTTPS-only) network call, so calling it on
    // the resulting Configuration would be too late.
    // Deliberately reaching for the library's own "you shouldn't need this
    // outside tests" escape hatch, only when allowInsecureRequestsForTests is
    // explicitly set (never by selfhost-main.ts's real wiring).
    const discoveryOptions = config.allowInsecureRequestsForTests
      ? // eslint-disable-next-line @typescript-eslint/no-deprecated
        { execute: [allowInsecureRequests] }
      : undefined;
    const discovered =
      config.clientSecret !== undefined
        ? await discovery(
            issuerUrl,
            config.clientId,
            config.clientSecret,
            undefined,
            discoveryOptions,
          )
        : await discovery(issuerUrl, config.clientId, undefined, None(), discoveryOptions);
    const adapter = new OidcAuthAdapter(config, discovered);
    await adapter.refill();
    return adapter;
  }

  /** Generates the next flow's PKCE verifier/challenge/nonce ahead of time (see class doc comment). */
  private async refill(): Promise<void> {
    const verifier = randomPKCECodeVerifier();
    const challenge = await calculatePKCECodeChallenge(verifier);
    const nonce = randomNonce();
    this.ready = { verifier, challenge, nonce };
  }

  authorizationUrl(redirectUri: string, state: string): string {
    const ready = this.ready;
    if (!ready) {
      // Only reachable if two logins are started back-to-back faster than
      // the async refill() above can complete (self-host, single-instance —
      // exceedingly rare in practice). Fails loud rather than reusing stale
      // or absent PKCE material.
      throw new Error(
        'OidcAuthAdapter: not ready to start a new login yet — please try again in a moment',
      );
    }
    this.ready = undefined;
    this.pending = {
      verifier: ready.verifier,
      nonce: ready.nonce,
      redirectUri,
      expiresAtMs: Date.now() + PENDING_TTL_MS,
    };
    void this.refill();

    const scopes = this.config.scopes ?? DEFAULT_SCOPES;
    const url = buildAuthorizationUrl(this.discovered, {
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      state,
      code_challenge: ready.challenge,
      code_challenge_method: 'S256',
      nonce: ready.nonce,
    });
    return url.href;
  }

  async exchangeCode(code: string): Promise<AuthProfile> {
    const pending = this.pending;
    if (!pending || pending.expiresAtMs < Date.now()) {
      throw new Error(
        'OidcAuthAdapter: no pending login found for this code — it may have expired, ' +
          'or a second login attempt overwrote it. Please try signing in again.',
      );
    }
    this.pending = undefined;

    // Reconstructs the callback URL authorizationCodeGrant expects. `state`
    // is deliberately NOT included — auth-routes.ts already validated it
    // against its own cookie before ever calling exchangeCode, and
    // exchangeCode has no access to that value (see class doc comment), so
    // `expectedState` below is left at its default (no-state) expectation
    // rather than duplicating a check exchangeCode cannot correctly perform.
    const callbackUrl = new URL(pending.redirectUri);
    callbackUrl.searchParams.set('code', code);

    const tokens = await authorizationCodeGrant(this.discovered, callbackUrl, {
      pkceCodeVerifier: pending.verifier,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    });

    const claims = tokens.claims();
    if (!claims) {
      throw new Error('OidcAuthAdapter: provider did not return an ID token');
    }
    const email = typeof claims.email === 'string' ? claims.email : undefined;
    if (!email) {
      throw new Error(
        'OidcAuthAdapter: ID token has no "email" claim — ensure the "email" scope is requested and granted',
      );
    }
    const name = typeof claims.name === 'string' ? claims.name : undefined;
    const givenName = typeof claims.given_name === 'string' ? claims.given_name : undefined;
    const familyName = typeof claims.family_name === 'string' ? claims.family_name : undefined;
    const displayName =
      name && name.length > 0
        ? name
        : [givenName, familyName].filter((v): v is string => Boolean(v)).join(' ');

    return {
      providerUserId: claims.sub,
      email,
      displayName,
      // Deliberately omitted: ssoConnectionId is WorkOS-Organization-
      // specific (Phase 15 enterprise JIT), meaningless for a generic OIDC
      // provider.
    };
  }
}
