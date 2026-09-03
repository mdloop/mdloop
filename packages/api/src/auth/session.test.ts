import { describe, expect, it } from 'vitest';
import { csrfMatches, csrfTokenFor, decodeSession, encodeSession } from './session.js';
import type { SessionPayload } from './session.js';

const secret = 'test-secret';
const payload: SessionPayload = {
  userId: 'u1',
  orgId: 'o1',
  role: 'member',
  iat: Date.now(),
  exp: Date.now() + 60_000,
};

describe('session token', () => {
  it('round-trips a valid session', () => {
    const token = encodeSession(payload, secret);
    expect(decodeSession(token, [secret])).toEqual({ payload, secret });
  });

  it('rejects a tampered payload', () => {
    const token = encodeSession(payload, secret);
    const [body = '', mac = ''] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, role: 'admin' })).toString('base64url');
    expect(decodeSession(`${forged}.${mac}`, [secret])).toBeUndefined();
    expect(decodeSession(`${body}.AAAA`, [secret])).toBeUndefined();
  });

  it('rejects a token signed with a different secret', () => {
    const token = encodeSession(payload, 'other-secret');
    expect(decodeSession(token, [secret])).toBeUndefined();
  });

  it('rejects an expired token', () => {
    const token = encodeSession({ ...payload, exp: Date.now() - 1 }, secret);
    expect(decodeSession(token, [secret])).toBeUndefined();
  });

  it('rejects malformed tokens', () => {
    expect(decodeSession('', [secret])).toBeUndefined();
    expect(decodeSession('no-dot', [secret])).toBeUndefined();
    expect(decodeSession('a.b.c', [secret])).toBeUndefined();
  });

  it('rejects a validly-signed token that lacks iat (pre-Phase-24 shape)', () => {
    const noIat: Omit<SessionPayload, 'iat'> = {
      userId: payload.userId,
      orgId: payload.orgId,
      role: payload.role,
      exp: payload.exp,
    };
    // Properly signed by our secret, so only the missing-iat check can reject it.
    const legacy = encodeSession(noIat as SessionPayload, secret);
    expect(decodeSession(legacy, [secret])).toBeUndefined();
  });
});

// SESSION_SECRET rotation (P0.7): decodeSession accepts an ordered list of
// candidate secrets so a session signed under the outgoing secret keeps
// verifying until it naturally expires or is silently refreshed. Signing
// (encodeSession) is untouched — always one secret.
describe('session token rotation (SESSION_SECRET_PREVIOUS)', () => {
  const current = 'current-secret-aaaaaaaaaaaaaaaaaaaaaaaa';
  const previous = 'previous-secret-bbbbbbbbbbbbbbbbbbbbbbbb';

  it('decodes a token signed with current when previous is also offered, preferring current', () => {
    const token = encodeSession(payload, current);
    expect(decodeSession(token, [current, previous])).toEqual({ payload, secret: current });
  });

  it('decodes a token signed with the previous secret once it is offered as a candidate', () => {
    const token = encodeSession(payload, previous);
    expect(decodeSession(token, [current, previous])).toEqual({ payload, secret: previous });
  });

  it('reports which secret matched — the pairing invariant CSRF verification relies on', () => {
    const currentToken = encodeSession(payload, current);
    const previousToken = encodeSession(payload, previous);
    expect(decodeSession(currentToken, [current, previous])?.secret).toBe(current);
    expect(decodeSession(previousToken, [current, previous])?.secret).toBe(previous);
  });

  it('rejects a previous-secret-signed token when SESSION_SECRET_PREVIOUS is unset (only current offered) — no regression to steady state', () => {
    const token = encodeSession(payload, previous);
    expect(decodeSession(token, [current])).toBeUndefined();
  });

  it('rejects a token signed with neither current nor previous', () => {
    const token = encodeSession(payload, 'some-other-secret-entirely');
    expect(decodeSession(token, [current, previous])).toBeUndefined();
  });
});

describe('CSRF double-submit token', () => {
  const sessionToken = encodeSession(payload, secret);

  it('binds a token to the session and accepts a matching pair', () => {
    const t = csrfTokenFor(sessionToken, secret);
    expect(csrfMatches(t, t, sessionToken, secret)).toBe(true);
  });

  it('rejects when header and cookie disagree', () => {
    const t = csrfTokenFor(sessionToken, secret);
    expect(csrfMatches(t, 'other', sessionToken, secret)).toBe(false);
  });

  it('rejects a token not bound to this session', () => {
    const foreign = csrfTokenFor(encodeSession({ ...payload, userId: 'u2' }, secret), secret);
    expect(csrfMatches(foreign, foreign, sessionToken, secret)).toBe(false);
  });

  it('rejects when any part is missing', () => {
    const t = csrfTokenFor(sessionToken, secret);
    expect(csrfMatches(undefined, t, sessionToken, secret)).toBe(false);
    expect(csrfMatches(t, undefined, sessionToken, secret)).toBe(false);
    expect(csrfMatches(t, t, undefined, secret)).toBe(false);
  });
});

// The CSRF-pairing invariant under rotation (P0.7): a real client's CSRF
// cookie/header is always minted under the same secret that signed its
// session cookie (they're issued together at login/redeem/refresh). Verifying
// CSRF against the exact secret decodeSession matched — never trying both
// secrets independently for CSRF — is what guards.ts's `sessionSecretUsed`
// threading enforces; these tests exercise that same logic at the primitive
// level, one secret at a time, the way guards.ts actually calls it.
describe('CSRF verification paired to the secret that verified the session (rotation)', () => {
  const current = 'current-secret-aaaaaaaaaaaaaaaaaaaaaaaa';
  const previous = 'previous-secret-bbbbbbbbbbbbbbbbbbbbbbbb';

  it('a CSRF token minted under the previous secret, paired with a session also minted under the previous secret, verifies', () => {
    const sessionToken = encodeSession(payload, previous);
    const decoded = decodeSession(sessionToken, [current, previous]);
    expect(decoded?.secret).toBe(previous);
    const csrf = csrfTokenFor(sessionToken, previous);
    // guards.ts calls csrfMatches with decoded.secret — never an independent try-both.
    expect(csrfMatches(csrf, csrf, sessionToken, decoded!.secret)).toBe(true);
  });

  it('a CSRF token minted under current cannot be paired with a session minted under previous', () => {
    const sessionToken = encodeSession(payload, previous);
    const decoded = decodeSession(sessionToken, [current, previous]);
    expect(decoded?.secret).toBe(previous);
    // Attacker/stale value: a CSRF token that only checks out under `current`.
    const wrongCsrf = csrfTokenFor(sessionToken, current);
    expect(csrfMatches(wrongCsrf, wrongCsrf, sessionToken, decoded!.secret)).toBe(false);
  });

  it('a CSRF token minted under previous cannot be paired with a session minted under current', () => {
    const sessionToken = encodeSession(payload, current);
    const decoded = decodeSession(sessionToken, [current, previous]);
    expect(decoded?.secret).toBe(current);
    const wrongCsrf = csrfTokenFor(sessionToken, previous);
    expect(csrfMatches(wrongCsrf, wrongCsrf, sessionToken, decoded!.secret)).toBe(false);
  });
});
