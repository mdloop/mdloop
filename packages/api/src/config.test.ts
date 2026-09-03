import { describe, expect, it } from 'vitest';
import { configFromEnv } from './config.js';

const validEnv = {
  SESSION_SECRET: 'a'.repeat(32),
  DATABASE_URL: 'postgres://user:pass@localhost:5432/vorlyn',
};

describe('configFromEnv', () => {
  it('accepts a minimal valid env and applies documented defaults', () => {
    const config = configFromEnv(validEnv);
    expect(config).toEqual({
      baseUrl: 'http://localhost:3000',
      webAppUrl: 'http://localhost:5173',
      sessionSecret: validEnv.SESSION_SECRET,
      secureCookies: false,
      webOrigin: 'http://localhost:5173',
    });
  });

  it('throws naming the field when SESSION_SECRET is missing', () => {
    const rest: Record<string, string> = { ...validEnv };
    delete rest.SESSION_SECRET;
    expect(() => configFromEnv(rest)).toThrow(/SESSION_SECRET/);
  });

  it('throws naming the field when SESSION_SECRET is too short', () => {
    expect(() => configFromEnv({ ...validEnv, SESSION_SECRET: 'too-short' })).toThrow(
      /SESSION_SECRET/,
    );
  });

  it('throws naming the field when DATABASE_URL is missing', () => {
    const rest: Record<string, string> = { ...validEnv };
    delete rest.DATABASE_URL;
    expect(() => configFromEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('throws naming the field when DATABASE_URL is not a connection string', () => {
    expect(() => configFromEnv({ ...validEnv, DATABASE_URL: 'not-a-url' })).toThrow(/DATABASE_URL/);
  });

  it('throws naming the field when DATABASE_URL has the wrong scheme', () => {
    expect(() => configFromEnv({ ...validEnv, DATABASE_URL: 'mysql://localhost/vorlyn' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('throws naming the field on a garbage PORT', () => {
    expect(() => configFromEnv({ ...validEnv, PORT: 'nope' })).toThrow(/PORT/);
  });

  it('throws naming the field on a non-positive PORT', () => {
    expect(() => configFromEnv({ ...validEnv, PORT: '-1' })).toThrow(/PORT/);
  });

  it('throws naming the field on an invalid NODE_ENV', () => {
    expect(() => configFromEnv({ ...validEnv, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('sets secureCookies from NODE_ENV=production', () => {
    expect(configFromEnv({ ...validEnv, NODE_ENV: 'production' }).secureCookies).toBe(true);
  });

  it('reports every failing field in one error, not just the first', () => {
    expect(() => configFromEnv({ SESSION_SECRET: 'too-short', PORT: 'nope' })).toThrow(
      /SESSION_SECRET.*PORT|PORT.*SESSION_SECRET/s,
    );
  });

  it('builds the workos group when both vars are set', () => {
    const config = configFromEnv({
      ...validEnv,
      WORKOS_API_KEY: 'sk_test_123',
      WORKOS_CLIENT_ID: 'client_123',
    });
    expect(config.workos).toEqual({ apiKey: 'sk_test_123', clientId: 'client_123' });
  });

  it('throws when only one workos var is set (half-set group)', () => {
    expect(() => configFromEnv({ ...validEnv, WORKOS_API_KEY: 'sk_test_123' })).toThrow(
      /WORKOS_API_KEY.*WORKOS_CLIENT_ID/,
    );
  });

  it('passes through PUBLIC_HUB_ORG_ID when set', () => {
    expect(configFromEnv({ ...validEnv, PUBLIC_HUB_ORG_ID: 'org_123' }).publicHubOrgId).toBe(
      'org_123',
    );
  });

  it('omits publicHubOrgId when unset', () => {
    expect(configFromEnv(validEnv).publicHubOrgId).toBeUndefined();
  });

  // The "unset" sentinel a deployment's config store may need to inject when
  // it can't represent a truly empty value (e.g. AWS SSM rejects an empty
  // String parameter) until a real value is configured. Must resolve to the
  // same "publishing disabled" outcome as never setting the var at all, not
  // to a literal org id of "unset".
  it('treats the "unset" SSM sentinel the same as an unset var', () => {
    expect(
      configFromEnv({ ...validEnv, PUBLIC_HUB_ORG_ID: 'unset' }).publicHubOrgId,
    ).toBeUndefined();
  });

  it('omits sessionSecretPrevious when unset (steady state, no rotation in flight)', () => {
    expect(configFromEnv(validEnv).sessionSecretPrevious).toBeUndefined();
  });

  it('passes through sessionSecretPrevious when set (P0.7 rotation)', () => {
    const previous = 'b'.repeat(32);
    expect(
      configFromEnv({ ...validEnv, SESSION_SECRET_PREVIOUS: previous }).sessionSecretPrevious,
    ).toBe(previous);
  });

  it('throws naming the field when SESSION_SECRET_PREVIOUS is too short', () => {
    expect(() => configFromEnv({ ...validEnv, SESSION_SECRET_PREVIOUS: 'too-short' })).toThrow(
      /SESSION_SECRET_PREVIOUS/,
    );
  });

  // Node's `--env-file` sets `KEY=` (blank) to '', not absent — a blank
  // optional var must behave identically to an omitted one. Regression
  // coverage for the `make dev` Makefile fix that made `.env` loading real
  // (2026-08-12).
  it('treats a blank optional var the same as an unset one', () => {
    const config = configFromEnv({
      ...validEnv,
      PUBLIC_HUB_ORG_ID: '',
      SESSION_SECRET_PREVIOUS: '',
    });
    expect(config.publicHubOrgId).toBeUndefined();
    expect(config.sessionSecretPrevious).toBeUndefined();
  });

  it('a blank value does not defeat a required-together group check — still rejects a real half-set group', () => {
    expect(() =>
      configFromEnv({ ...validEnv, WORKOS_API_KEY: 'sk_test_123', WORKOS_CLIENT_ID: '' }),
    ).toThrow(/WORKOS_API_KEY.*WORKOS_CLIENT_ID/);
  });
});
