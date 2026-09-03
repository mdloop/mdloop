import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import { OidcJwtVerifier } from './oidc-jwt-verifier.js';

// Real-crypto test, no live WorkOS and nothing mocked (this repo's testing
// philosophy — see cloudfront-signed-blob-url.test.ts and
// s3-storage.request.test.ts): a real RSA keypair signs real JWTs, and a
// real local node:http server serves the public JWK set, exactly like
// AuthKit's JWKS endpoint would over the network.

const ISSUER = 'https://auth.workos.com';
const AUDIENCE = 'https://mcp.vorlyn.test';
const KID = 'test-key-1';

interface SignOpts {
  readonly key?: CryptoKey;
  readonly kid?: string;
  readonly alg?: string;
  readonly iss?: string;
  readonly aud?: string;
  readonly sub?: string | null;
  readonly expiresInSeconds?: number;
}

describe('OidcJwtVerifier', () => {
  let server: Server;
  let jwksUrl: string;
  let rsaPrivateKey: CryptoKey;
  let otherRsaPrivateKey: CryptoKey;
  let psPrivateKey: CryptoKey;

  beforeAll(async () => {
    const rsaPair = await generateKeyPair('RS256', { extractable: true });
    rsaPrivateKey = rsaPair.privateKey;
    const rsaJwk = await exportJWK(rsaPair.publicKey);

    // A second RSA keypair never published in the JWKS below — signs a token
    // whose `kid` claims to be the real key but whose signature isn't.
    const otherRsaPair = await generateKeyPair('RS256', { extractable: true });
    otherRsaPrivateKey = otherRsaPair.privateKey;

    // A PS256 keypair, published under its own kid with its own alg — lets
    // the "wrong algorithm" test sign with a real, JWKS-matched key that the
    // verifier's algorithms allowlist (RS256 only) must still reject.
    const psPair = await generateKeyPair('PS256', { extractable: true });
    psPrivateKey = psPair.privateKey;
    const psJwk = await exportJWK(psPair.publicKey);

    const jwks = {
      keys: [
        { ...rsaJwk, kid: KID, alg: 'RS256', use: 'sig' },
        { ...psJwk, kid: 'ps-key', alg: 'PS256', use: 'sig' },
      ],
    };

    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(jwks));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server has no address');
    jwksUrl = `http://127.0.0.1:${String(address.port)}/jwks`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  function verifier(): OidcJwtVerifier {
    return new OidcJwtVerifier({ jwksUrl, issuer: ISSUER, audience: AUDIENCE });
  }

  async function sign(opts: SignOpts = {}): Promise<string> {
    const {
      key = rsaPrivateKey,
      kid = KID,
      alg = 'RS256',
      iss = ISSUER,
      aud = AUDIENCE,
      sub = 'user_abc',
      expiresInSeconds = 3600,
    } = opts;
    let builder = new SignJWT({}).setProtectedHeader({ alg, kid }).setIssuer(iss).setAudience(aud);
    if (sub !== null) builder = builder.setSubject(sub);
    return builder
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
      .sign(key);
  }

  it('accepts a validly signed, current token for the right issuer and audience', async () => {
    const token = await sign({ sub: 'user_abc' });
    await expect(verifier().verify(token)).resolves.toEqual({ sub: 'user_abc' });
  });

  it('rejects a token from the wrong issuer', async () => {
    const token = await sign({ iss: 'https://not-workos.example' });
    await expect(verifier().verify(token)).resolves.toBeUndefined();
  });

  it('rejects a token for the wrong audience', async () => {
    const token = await sign({ aud: 'https://someone-elses-resource.test' });
    await expect(verifier().verify(token)).resolves.toBeUndefined();
  });

  it('rejects a token signed with a kid not present in the JWKS', async () => {
    const token = await sign({ kid: 'unknown-kid' });
    await expect(verifier().verify(token)).resolves.toBeUndefined();
  });

  it('rejects a token whose kid is real but whose signature is from a different key', async () => {
    const token = await sign({ key: otherRsaPrivateKey, kid: KID });
    await expect(verifier().verify(token)).resolves.toBeUndefined();
  });

  it('rejects an expired token', async () => {
    const token = await sign({ expiresInSeconds: -60 });
    await expect(verifier().verify(token)).resolves.toBeUndefined();
  });

  it('rejects a token signed with a disallowed algorithm, even with a JWKS-matched key', async () => {
    // ps-key is genuinely published in the JWKS with alg PS256 — this proves
    // the verifier's explicit RS256 allowlist, not just "no matching key".
    const token = await sign({ key: psPrivateKey, kid: 'ps-key', alg: 'PS256' });
    await expect(verifier().verify(token)).resolves.toBeUndefined();
  });

  it('rejects a token with no subject claim', async () => {
    const token = await sign({ sub: null });
    await expect(verifier().verify(token)).resolves.toBeUndefined();
  });

  it('rejects garbage that is not a JWT at all', async () => {
    await expect(verifier().verify('not-a-jwt')).resolves.toBeUndefined();
  });
});
