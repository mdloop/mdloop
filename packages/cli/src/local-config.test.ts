import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateLocalConfig, localConfigPath } from './local-config.js';

describe('loadOrCreateLocalConfig', () => {
  let dataDir: string;

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('generates and persists a config on first call', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mdloop-local-config-'));

    const config = await loadOrCreateLocalConfig(dataDir);

    expect(config.sessionSecret.length).toBeGreaterThanOrEqual(32);
    expect(config.adminEmail).toBe('admin@localhost');
    expect(config.adminName).toBe('Admin');

    const raw = await readFile(localConfigPath(dataDir), 'utf8');
    expect(JSON.parse(raw)).toEqual(config);
  });

  it('mode 0600 — only the owner can read it', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mdloop-local-config-'));
    await loadOrCreateLocalConfig(dataDir);
    const { stat } = await import('node:fs/promises');
    const mode = (await stat(localConfigPath(dataDir))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns the same secret on a second call — never regenerates', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mdloop-local-config-'));

    const first = await loadOrCreateLocalConfig(dataDir);
    const second = await loadOrCreateLocalConfig(dataDir);

    expect(second).toEqual(first);
  });

  it('rejects a corrupt config file rather than silently regenerating', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mdloop-local-config-'));
    await writeFile(localConfigPath(dataDir), '{"sessionSecret": 42}\n', 'utf8');

    await expect(loadOrCreateLocalConfig(dataDir)).rejects.toThrow(/invalid local config/);
  });
});
