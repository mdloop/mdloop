import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vorlynConfigPath, ensureVorlynConfig, readVorlynConfig } from './vorlyn-config.js';
import { ensureVorlynDir } from './vorlyn-dir.js';

describe('.vorlyn/config.json', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'vorlyn-cli-config-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('creates the file with the given trigger when absent', async () => {
    await ensureVorlynConfig(folder, 'commit');
    expect(await readFile(vorlynConfigPath(folder), 'utf8')).toBe('{\n  "trigger": "commit"\n}\n');
  });

  it('writes agent-turn when that is what was asked for', async () => {
    await ensureVorlynConfig(folder, 'agent-turn');
    const parsed: unknown = JSON.parse(await readFile(vorlynConfigPath(folder), 'utf8'));
    expect(parsed).toEqual({ trigger: 'agent-turn' });
  });

  // The file is user-owned once it exists: include globs, a hand-set trigger,
  // anything a future hook reads. Never merged, never rewritten.
  it('leaves an existing file byte-for-byte alone', async () => {
    await ensureVorlynDir(folder);
    const handWritten = '{"trigger":"agent-turn","extra":"field"}';
    await writeFile(vorlynConfigPath(folder), handWritten, 'utf8');
    await ensureVorlynConfig(folder, 'commit');
    expect(await readFile(vorlynConfigPath(folder), 'utf8')).toBe(handWritten);
  });

  it('is idempotent', async () => {
    await ensureVorlynConfig(folder, 'commit');
    const first = await readFile(vorlynConfigPath(folder), 'utf8');
    await ensureVorlynConfig(folder, 'agent-turn');
    expect(await readFile(vorlynConfigPath(folder), 'utf8')).toBe(first);
  });

  it('creates .vorlyn/ (and its gitignore) on the way', async () => {
    await ensureVorlynConfig(folder, 'commit');
    expect(await readFile(path.join(folder, '.vorlyn', '.gitignore'), 'utf8')).toMatch(
      /^credentials$/m,
    );
  });

  // Same tolerant fallback claude-plugin/hooks/vorlyn-sync.sh already applies:
  // only the literal string "agent-turn" opts out of the "commit" default.
  describe('readVorlynConfig', () => {
    it('returns undefined when the file does not exist', async () => {
      expect(await readVorlynConfig(folder)).toBeUndefined();
    });

    it('resolves an explicit commit trigger', async () => {
      await ensureVorlynDir(folder);
      await writeFile(vorlynConfigPath(folder), '{"trigger":"commit"}', 'utf8');
      expect(await readVorlynConfig(folder)).toEqual({ trigger: 'commit' });
    });

    it('resolves an explicit agent-turn trigger', async () => {
      await ensureVorlynDir(folder);
      await writeFile(vorlynConfigPath(folder), '{"trigger":"agent-turn"}', 'utf8');
      expect(await readVorlynConfig(folder)).toEqual({ trigger: 'agent-turn' });
    });

    // Old repos, new default: a config.json with other fields but no
    // `trigger` key at all still resolves to "commit".
    it('defaults to commit when the field is absent but other fields are present', async () => {
      await ensureVorlynDir(folder);
      await writeFile(vorlynConfigPath(folder), '{"includeGlobs":["docs/**"]}', 'utf8');
      expect(await readVorlynConfig(folder)).toEqual({ trigger: 'commit' });
    });

    it('defaults to commit for a garbage or wrong-type trigger value', async () => {
      await ensureVorlynDir(folder);
      await writeFile(vorlynConfigPath(folder), '{"trigger":42}', 'utf8');
      expect(await readVorlynConfig(folder)).toEqual({ trigger: 'commit' });
    });

    it('throws on genuinely malformed JSON', async () => {
      await ensureVorlynDir(folder);
      await writeFile(vorlynConfigPath(folder), '{not json', 'utf8');
      await expect(readVorlynConfig(folder)).rejects.toThrow();
    });
  });
});
