import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { poolConfigFromEnv } from './pool-config.js';

describe('poolConfigFromEnv', () => {
  it('defaults to conservative single-instance values with no env set', () => {
    expect(poolConfigFromEnv({})).toEqual({
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
  });

  it('reads overrides from env', () => {
    expect(
      poolConfigFromEnv({
        DB_POOL_MAX: '25',
        DB_POOL_CONNECTION_TIMEOUT_MS: '2000',
        DB_POOL_IDLE_TIMEOUT_MS: '60000',
      }),
    ).toEqual({ max: 25, connectionTimeoutMillis: 2_000, idleTimeoutMillis: 60_000 });
  });

  // Behavior changed on purpose: this used to silently fall back to the
  // default on garbage/negative input, which is exactly the "typo'd var
  // name/value limps along instead of failing loud" gap that was closed.
  // Absence is still a legitimate
  // default (see the two tests above) — only a *present* garbage value now
  // throws.
  it('throws on a garbage (non-numeric) override instead of silently falling back', () => {
    expect(() => poolConfigFromEnv({ DB_POOL_MAX: 'nope' })).toThrow(/DB_POOL_MAX/);
  });

  it('throws on a non-positive override instead of silently falling back', () => {
    expect(() => poolConfigFromEnv({ DB_POOL_CONNECTION_TIMEOUT_MS: '-5' })).toThrow(
      /DB_POOL_CONNECTION_TIMEOUT_MS/,
    );
  });

  it('treats an empty string the same as unset', () => {
    expect(poolConfigFromEnv({ DB_POOL_MAX: '' })).toEqual({
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
  });

  describe('DB_SSL_CA_PATH (TLS to a real Postgres)', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'vorlyn-pool-config-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('omits ssl when unset, matching local dev over the trust socket', () => {
      expect(poolConfigFromEnv({}).ssl).toBeUndefined();
    });

    it('reads the CA bundle from disk and requires verification, never a plaintext or unverified fallback', async () => {
      const caPath = path.join(dir, 'rds-ca-bundle.pem');
      await writeFile(caPath, '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n');

      const { ssl } = poolConfigFromEnv({ DB_SSL_CA_PATH: caPath });

      expect(ssl).toEqual({
        ca: '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n',
        rejectUnauthorized: true,
      });
    });

    it('throws naming the field when the configured path cannot be read, instead of silently connecting without TLS', () => {
      const missingPath = path.join(dir, 'does-not-exist.pem');
      expect(() => poolConfigFromEnv({ DB_SSL_CA_PATH: missingPath })).toThrow(/DB_SSL_CA_PATH/);
    });
  });
});
