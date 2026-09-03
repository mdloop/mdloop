import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import { OidcAuthAdapter } from './oidc.adapter.js';

// Real-crypto, real-HTTP test, nothing mocked — same testing philosophy as
// packages/mcp/src/auth/oidc-jwt-verifier.test.ts: a real local node:http
// server plays the OIDC provider (discovery document, JWKS, /authorize,
// /token) and the adapter is driven through its actual public API, never a
// stubbed-out internals.

const CLIENT_ID = 'vorlyn-selfhost';
const REDIRECT_URI = 'http://localhost:3000/api/auth/callback';
const KID = 'test-key-1';

interface StoredAuthRequest {
  readonly challenge: string;
  readonly redirectUri: string;
  readonly nonce: string | undefined;
  readonly sub: string;
  readonly email: string | undefined;
  readonly nameClaims: Record<string, string>;
}

interface TokenOverrides {
  iss?: string;
  expiresInSeconds?: number;
}

describe('OidcAuthAdapter', () => {
  let server: Server;
  let issuer: string;
  let privateKey: CryptoKey;
  let jwk: Record<string, unknown>;
  const pending = new Map<string, StoredAuthRequest>();
  let overrides: TokenOverrides = {};
  let nextSub = 'user-1';
  let nextEmail: string | undefined = 'person@example.com';
  let nextNameClaims: Record<string, string> = { name: 'Person Example' };

  beforeAll(async () => {
    const { privateKey: sk, publicKey: pk } = await generateKeyPair('RS256', {
      extractable: true,
    });
    privateKey = sk;
    jwk = { ...(await exportJWK(pk)), kid: KID, alg: 'RS256', use: 'sig' };

    async function readBody(req: IncomingMessage): Promise<string> {
      const chunks: Buffer[] = [];
      for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
      return Buffer.concat(chunks).toString('utf8');
    }

    function json(res: ServerResponse, status: number, body: unknown): void {
      const data = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(data);
    }

    server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', issuer);
        if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
          json(res, 200, {
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            scopes_supported: ['openid', 'email', 'profile'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/jwks') {
          json(res, 200, { keys: [jwk] });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/authorize') {
          const code = randomUUID();
          const challenge = url.searchParams.get('code_challenge') ?? '';
          const redirectUri = url.searchParams.get('redirect_uri') ?? '';
          const nonce = url.searchParams.get('nonce') ?? undefined;
          const state = url.searchParams.get('state') ?? '';
          pending.set(code, {
            challenge,
            redirectUri,
            nonce,
            sub: nextSub,
            email: nextEmail,
            nameClaims: nextNameClaims,
          });
          const redirect = new URL(redirectUri);
          redirect.searchParams.set('code', code);
          if (state) redirect.searchParams.set('state', state);
          res.writeHead(302, { location: redirect.href });
          res.end();
          return;
        }
        if (req.method === 'POST' && url.pathname === '/token') {
          const body = new URLSearchParams(await readBody(req));
          const code = body.get('code') ?? '';
          const verifier = body.get('code_verifier') ?? '';
          const redirectUri = body.get('redirect_uri') ?? '';
          const stored = pending.get(code);
          if (!stored) {
            json(res, 400, { error: 'invalid_grant', error_description: 'unknown code' });
            return;
          }
          const expectedChallenge = createHash('sha256').update(verifier).digest('base64url');
          if (expectedChallenge !== stored.challenge || redirectUri !== stored.redirectUri) {
            json(res, 400, {
              error: 'invalid_grant',
              error_description: 'PKCE verification failed',
            });
            return;
          }
          // Single-use, like a real authorization code.
          pending.delete(code);

          const nowSeconds = Math.floor(Date.now() / 1000);
          const expiresInSeconds = overrides.expiresInSeconds ?? 3600;
          let builder = new SignJWT({
            ...(stored.email ? { email: stored.email } : {}),
            ...stored.nameClaims,
            ...(stored.nonce ? { nonce: stored.nonce } : {}),
          })
            .setProtectedHeader({ alg: 'RS256', kid: KID })
            .setIssuer(overrides.iss ?? issuer)
            .setAudience(CLIENT_ID)
            .setSubject(stored.sub)
            .setIssuedAt(nowSeconds);
          builder = builder.setExpirationTime(nowSeconds + expiresInSeconds);
          const idToken = await builder.sign(privateKey);

          json(res, 200, {
            access_token: `at-${code}`,
            token_type: 'bearer',
            expires_in: 3600,
            id_token: idToken,
          });
          return;
        }
        json(res, 404, { error: 'not_found' });
      })();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server has no address');
    issuer = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  afterEach(() => {
    overrides = {};
    nextSub = 'user-1';
    nextEmail = 'person@example.com';
    nextNameClaims = { name: 'Person Example' };
    pending.clear();
  });

  async function makeAdapter(): Promise<OidcAuthAdapter> {
    return OidcAuthAdapter.create({
      issuer,
      clientId: CLIENT_ID,
      allowInsecureRequestsForTests: true,
    });
  }

  /** Simulates the browser following the authorization redirect, returning the issued code. */
  async function driveAuthorizationRequest(
    adapter: OidcAuthAdapter,
    state = 'state-1',
  ): Promise<string> {
    const authUrl = adapter.authorizationUrl(REDIRECT_URI, state);
    const res = await fetch(authUrl, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    if (!location) throw new Error('no Location header on /authorize redirect');
    const code = new URL(location).searchParams.get('code');
    if (!code) throw new Error('no code on redirect');
    return code;
  }

  it('resolves the right AuthProfile on a full, valid exchange', async () => {
    const adapter = await makeAdapter();
    const code = await driveAuthorizationRequest(adapter);
    await expect(adapter.exchangeCode(code)).resolves.toEqual({
      providerUserId: 'user-1',
      email: 'person@example.com',
      displayName: 'Person Example',
    });
  });

  it('falls back to given_name + family_name when there is no name claim', async () => {
    nextNameClaims = { given_name: 'Ada', family_name: 'Lovelace' };
    const adapter = await makeAdapter();
    const code = await driveAuthorizationRequest(adapter);
    const profile = await adapter.exchangeCode(code);
    expect(profile.displayName).toBe('Ada Lovelace');
  });

  it('never populates ssoConnectionId (WorkOS-specific, meaningless for generic OIDC)', async () => {
    const adapter = await makeAdapter();
    const code = await driveAuthorizationRequest(adapter);
    const profile = await adapter.exchangeCode(code);
    expect(profile.ssoConnectionId).toBeUndefined();
  });

  it('rejects when the provider returns no email claim', async () => {
    nextEmail = undefined;
    const adapter = await makeAdapter();
    const code = await driveAuthorizationRequest(adapter);
    await expect(adapter.exchangeCode(code)).rejects.toThrow(/email/i);
  });

  it("actually enforces PKCE: the same code with a wrong verifier is rejected by the provider, but the adapter's own correct verifier still works", async () => {
    const adapter = await makeAdapter();
    const authUrl = adapter.authorizationUrl(REDIRECT_URI, 'state-pkce');
    const res = await fetch(authUrl, { redirect: 'manual' });
    const location = res.headers.get('location');
    if (!location) throw new Error('no Location header');
    const code = new URL(location).searchParams.get('code');
    if (!code) throw new Error('no code');

    // An attacker who intercepted only the authorization `code` (e.g. via a
    // leaked redirect) does not have the adapter's internal code_verifier —
    // simulate that directly against the real token endpoint.
    const attackerAttempt = await fetch(`${issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: 'totally-wrong-verifier',
      }),
    });
    expect(attackerAttempt.status).toBe(400);
    const attackerBody = (await attackerAttempt.json()) as { error: string };
    expect(attackerBody.error).toBe('invalid_grant');

    // The legitimate flow — the adapter using its own, correctly-generated
    // verifier for this same code — still succeeds.
    await expect(adapter.exchangeCode(code)).resolves.toMatchObject({
      providerUserId: 'user-1',
    });
  });

  it('rejects a token from the wrong issuer', async () => {
    overrides = { iss: 'https://not-this-provider.example' };
    const adapter = await makeAdapter();
    const code = await driveAuthorizationRequest(adapter);
    await expect(adapter.exchangeCode(code)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    overrides = { expiresInSeconds: -60 };
    const adapter = await makeAdapter();
    const code = await driveAuthorizationRequest(adapter);
    await expect(adapter.exchangeCode(code)).rejects.toThrow();
  });

  it('rejects exchangeCode called with no pending login (nothing to correlate the code with)', async () => {
    const adapter = await makeAdapter();
    await expect(adapter.exchangeCode('some-random-code')).rejects.toThrow(/no pending login/i);
  });

  it('builds an authorization URL carrying PKCE S256 challenge, state, nonce, and scopes', async () => {
    const adapter = await makeAdapter();
    const url = new URL(adapter.authorizationUrl(REDIRECT_URI, 'state-shape'));
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-shape');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(url.searchParams.get('scope')).toBe('openid email profile');
  });

  it('honors custom scopes when configured', async () => {
    const adapter = await OidcAuthAdapter.create({
      issuer,
      clientId: CLIENT_ID,
      scopes: ['openid', 'email'],
      allowInsecureRequestsForTests: true,
    });
    const url = new URL(adapter.authorizationUrl(REDIRECT_URI, 'state-scopes'));
    expect(url.searchParams.get('scope')).toBe('openid email');
  });

  it('supports a confidential client configured with a client secret', async () => {
    // The fake provider's token endpoint above never checks client_secret,
    // but discovery + Configuration construction must still succeed with one
    // configured, exercising the adapter's other constructor branch.
    const adapter = await OidcAuthAdapter.create({
      issuer,
      clientId: CLIENT_ID,
      clientSecret: 'shh-its-a-secret',
      allowInsecureRequestsForTests: true,
    });
    const code = await driveAuthorizationRequest(adapter);
    await expect(adapter.exchangeCode(code)).resolves.toMatchObject({
      providerUserId: 'user-1',
    });
  });
});
