import { describe, expect, it } from 'vitest';
import { mcpHttpEnvFromEnv } from './env-config.js';

const BASE_ENV = { DATABASE_URL: 'postgres://user:pass@localhost:5432/db' };

describe('mcpHttpEnvFromEnv — MCP OAuth (ADR 0013)', () => {
  it('leaves OAuth off when none of the four vars are set', () => {
    const env = mcpHttpEnvFromEnv(BASE_ENV);
    expect(env.WORKOS_CLIENT_ID).toBeUndefined();
    expect(env.WORKOS_AUTHKIT_ISSUER).toBeUndefined();
    expect(env.WORKOS_JWKS_URL).toBeUndefined();
    expect(env.MCP_RESOURCE_INDICATOR).toBeUndefined();
  });

  it('accepts the three required vars and computes the JWKS URL default from the issuer', () => {
    const env = mcpHttpEnvFromEnv({
      ...BASE_ENV,
      WORKOS_CLIENT_ID: 'client_123',
      WORKOS_AUTHKIT_ISSUER: 'https://auth.workos.com',
      MCP_RESOURCE_INDICATOR: 'https://mcp.mdloop.test',
    });
    expect(env.WORKOS_JWKS_URL).toBe('https://auth.workos.com/oauth2/jwks');
  });

  it('honors an explicit WORKOS_JWKS_URL over the computed default', () => {
    const env = mcpHttpEnvFromEnv({
      ...BASE_ENV,
      WORKOS_CLIENT_ID: 'client_123',
      WORKOS_AUTHKIT_ISSUER: 'https://auth.workos.com',
      MCP_RESOURCE_INDICATOR: 'https://mcp.mdloop.test',
      WORKOS_JWKS_URL: 'https://jwks.example/custom',
    });
    expect(env.WORKOS_JWKS_URL).toBe('https://jwks.example/custom');
  });

  it('rejects a partially-configured group (missing WORKOS_AUTHKIT_ISSUER)', () => {
    expect(() =>
      mcpHttpEnvFromEnv({
        ...BASE_ENV,
        WORKOS_CLIENT_ID: 'client_123',
        MCP_RESOURCE_INDICATOR: 'https://mcp.mdloop.test',
      }),
    ).toThrow(
      /WORKOS_CLIENT_ID, WORKOS_AUTHKIT_ISSUER, MCP_RESOURCE_INDICATOR must all be set together/,
    );
  });

  it('rejects WORKOS_JWKS_URL set alone with none of the three required vars', () => {
    expect(() =>
      mcpHttpEnvFromEnv({ ...BASE_ENV, WORKOS_JWKS_URL: 'https://jwks.example/custom' }),
    ).toThrow(/must all be set together to enable MCP OAuth/);
  });

  it('rejects a malformed issuer URL', () => {
    expect(() =>
      mcpHttpEnvFromEnv({
        ...BASE_ENV,
        WORKOS_CLIENT_ID: 'client_123',
        WORKOS_AUTHKIT_ISSUER: 'not-a-url',
        MCP_RESOURCE_INDICATOR: 'https://mcp.mdloop.test',
      }),
    ).toThrow(/WORKOS_AUTHKIT_ISSUER/);
  });
});

describe('mcpHttpEnvFromEnv — blank env vars treated as unset', () => {
  // Node's `--env-file` sets `KEY=` (blank) to '', not absent — a blank
  // optional var must behave identically to an omitted one, not fail
  // validation as if it were a garbage value. Regression coverage for the
  // `make dev` Makefile fix that made `.env` loading real (2026-08-12).
  it('leaves OAuth off when the three vars are present but blank', () => {
    const env = mcpHttpEnvFromEnv({
      ...BASE_ENV,
      WORKOS_CLIENT_ID: '',
      WORKOS_AUTHKIT_ISSUER: '',
      MCP_RESOURCE_INDICATOR: '',
      WORKOS_JWKS_URL: '',
    });
    expect(env.WORKOS_CLIENT_ID).toBeUndefined();
    expect(env.WORKOS_AUTHKIT_ISSUER).toBeUndefined();
    expect(env.MCP_RESOURCE_INDICATOR).toBeUndefined();
    expect(env.WORKOS_JWKS_URL).toBeUndefined();
  });

  it('does not choke on other blank optional vars alongside it', () => {
    expect(() =>
      mcpHttpEnvFromEnv({
        ...BASE_ENV,
        OTEL_EXPORTER_OTLP_ENDPOINT: '',
        OTEL_SDK_DISABLED: '',
        REDIS_URL: '',
      }),
    ).not.toThrow();
  });

  it('a blank value does not defeat the OAuth group check — still rejects a real partial group', () => {
    expect(() =>
      mcpHttpEnvFromEnv({
        ...BASE_ENV,
        WORKOS_CLIENT_ID: 'client_123',
        WORKOS_AUTHKIT_ISSUER: '',
        MCP_RESOURCE_INDICATOR: 'https://mcp.mdloop.test',
      }),
    ).toThrow(/must all be set together to enable MCP OAuth/);
  });
});
