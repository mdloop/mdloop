import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDataDir, resolveDataDir } from './data-dir.js';

describe('resolveDataDir', () => {
  it('VORLYN_DATA_DIR, when set, wins over every platform branch', () => {
    expect(
      resolveDataDir('darwin', { HOME: '/Users/jane', VORLYN_DATA_DIR: '/tmp/vorlyn-smoke' }),
    ).toBe('/tmp/vorlyn-smoke');
    expect(
      resolveDataDir('win32', { APPDATA: 'C:\\AppData', VORLYN_DATA_DIR: '/tmp/vorlyn-smoke' }),
    ).toBe('/tmp/vorlyn-smoke');
  });

  it('VORLYN_DATA_DIR wins even without HOME/APPDATA set at all', () => {
    expect(resolveDataDir('darwin', { VORLYN_DATA_DIR: '/tmp/vorlyn-smoke' })).toBe(
      '/tmp/vorlyn-smoke',
    );
  });

  it('ignores an empty-string VORLYN_DATA_DIR and falls back to the platform default', () => {
    expect(resolveDataDir('darwin', { HOME: '/Users/jane', VORLYN_DATA_DIR: '  ' })).toBe(
      path.join('/Users/jane', 'Library', 'Application Support', 'vorlyn'),
    );
  });

  it('macOS: ~/Library/Application Support/vorlyn', () => {
    expect(resolveDataDir('darwin', { HOME: '/Users/jane' })).toBe(
      path.join('/Users/jane', 'Library', 'Application Support', 'vorlyn'),
    );
  });

  it('macOS: throws a clear error when HOME is unset', () => {
    expect(() => resolveDataDir('darwin', {})).toThrow(/HOME/);
  });

  it('Linux: $XDG_DATA_HOME/vorlyn when XDG_DATA_HOME is set', () => {
    expect(resolveDataDir('linux', { HOME: '/home/jane', XDG_DATA_HOME: '/home/jane/.data' })).toBe(
      path.join('/home/jane/.data', 'vorlyn'),
    );
  });

  it('Linux: ~/.local/share/vorlyn when XDG_DATA_HOME is unset', () => {
    expect(resolveDataDir('linux', { HOME: '/home/jane' })).toBe(
      path.join('/home/jane', '.local', 'share', 'vorlyn'),
    );
  });

  it('Linux: ignores an empty-string XDG_DATA_HOME and falls back to the default', () => {
    expect(resolveDataDir('linux', { HOME: '/home/jane', XDG_DATA_HOME: '' })).toBe(
      path.join('/home/jane', '.local', 'share', 'vorlyn'),
    );
  });

  it('Linux: throws a clear error when HOME is unset and XDG_DATA_HOME is also unset', () => {
    expect(() => resolveDataDir('linux', {})).toThrow(/HOME/);
  });

  it('Windows: %APPDATA%\\vorlyn', () => {
    expect(resolveDataDir('win32', { APPDATA: 'C:\\Users\\jane\\AppData\\Roaming' })).toBe(
      path.join('C:\\Users\\jane\\AppData\\Roaming', 'vorlyn'),
    );
  });

  it('Windows: throws a clear error when APPDATA is unset', () => {
    expect(() => resolveDataDir('win32', {})).toThrow(/APPDATA/);
  });

  it('other/unrecognized platforms fall back to the Linux/XDG branch', () => {
    expect(resolveDataDir('freebsd', { HOME: '/home/jane' })).toBe(
      path.join('/home/jane', '.local', 'share', 'vorlyn'),
    );
  });
});

describe('ensureDataDir', () => {
  let root: string;

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates pgdata/ and blobs/ under the given directory', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vorlyn-data-dir-'));
    const dataDir = path.join(root, 'nested', 'vorlyn');

    const layout = await ensureDataDir(dataDir);

    expect(layout).toEqual({
      root: dataDir,
      pgdata: path.join(dataDir, 'pgdata'),
      blobs: path.join(dataDir, 'blobs'),
    });
    expect((await stat(layout.pgdata)).isDirectory()).toBe(true);
    expect((await stat(layout.blobs)).isDirectory()).toBe(true);
  });

  it('is idempotent — calling twice does not error', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vorlyn-data-dir-'));
    const dataDir = path.join(root, 'vorlyn');

    await ensureDataDir(dataDir);
    await expect(ensureDataDir(dataDir)).resolves.toBeDefined();
  });
});
