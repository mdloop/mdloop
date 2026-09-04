import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  credentialsPath,
  readCredentials,
  resolveApiKey,
  writeCredentials,
} from './credentials.js';

describe('credentials', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-creds-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('round-trips via readCredentials', async () => {
    await writeCredentials(folder, { apiKey: 'mdloop_y' });
    expect(await readCredentials(folder)).toEqual({ apiKey: 'mdloop_y' });
  });

  it('returns undefined when no credentials file exists', async () => {
    expect(await readCredentials(folder)).toBeUndefined();
  });

  it('writes the credentials file with mode 0600', async () => {
    await writeCredentials(folder, { apiKey: 'mdloop_x' });
    const info = await stat(credentialsPath(folder));
    expect(info.mode & 0o777).toBe(0o600);
  });

  describe('resolveApiKey precedence', () => {
    it('resolves undefined when neither env nor file is set', async () => {
      expect(await resolveApiKey(folder, {})).toBeUndefined();
    });

    it('resolves from the credentials file when present', async () => {
      await writeCredentials(folder, { apiKey: 'mdloop_from_file' });
      expect(await resolveApiKey(folder, {})).toBe('mdloop_from_file');
    });

    it('prefers MDLOOP_API_KEY over the credentials file', async () => {
      await writeCredentials(folder, { apiKey: 'mdloop_from_file' });
      expect(await resolveApiKey(folder, { MDLOOP_API_KEY: 'mdloop_from_env' })).toBe(
        'mdloop_from_env',
      );
    });
  });
});
