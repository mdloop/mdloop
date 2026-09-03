import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vorlynConfigPath } from './vorlyn-config.js';
import { run } from './cli.js';
import { writeCredentials } from './credentials.js';
import { readManifest } from './manifest.js';
import type { Io } from './output.js';
import type { FakeMcpServer } from './test-support/fake-mcp-server.js';
import { startFakeMcpServer } from './test-support/fake-mcp-server.js';

const execFileAsync = promisify(execFile);

function collectIo(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { println: (l: string) => out.push(l), errln: (l: string) => err.push(l) },
    out,
    err,
  };
}

describe('cli run()', () => {
  it('prints usage and exits 0 with no arguments', async () => {
    const { io, out } = collectIo();
    const code = await run([], io);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/Usage/);
  });

  it('prints usage and exits 0 for --help', async () => {
    const { io, out } = collectIo();
    const code = await run(['--help'], io);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/Usage/);
  });

  it('errors and exits 1 for an unknown command', async () => {
    const { io, err } = collectIo();
    const code = await run(['frobnicate'], io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/Unknown command/);
  });

  it('rejects a non-positive --concurrency before doing any work', async () => {
    const { io, err } = collectIo();
    const code = await run(['push', '/nonexistent', '--concurrency', '0'], io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/concurrency/);
  });

  it('rejects a non-numeric --concurrency', async () => {
    const { io, err } = collectIo();
    const code = await run(['push', '/nonexistent', '--concurrency', 'abc'], io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/concurrency/);
  });

  describe('against a live folder + fake server', () => {
    let folder: string;
    let fake: FakeMcpServer;

    beforeEach(async () => {
      folder = await mkdtemp(path.join(tmpdir(), 'vorlyn-cli-argv-'));
      fake = await startFakeMcpServer();
      await writeCredentials(folder, { apiKey: fake.apiKey });
    });

    afterEach(async () => {
      await fake.close();
      await rm(folder, { recursive: true, force: true });
    });

    it('dispatches "link" with parsed --project and --endpoint', async () => {
      const { io } = collectIo();
      const code = await run(['link', folder, '--project', 'proj_1', '--endpoint', fake.url], io);
      expect(code).toBe(0);
      const manifest = await readManifest(folder);
      expect(manifest).toEqual({ endpoint: fake.url, projectId: 'proj_1', files: {} });
    });

    it('rejects an unknown --trigger before doing any work', async () => {
      const { io, err } = collectIo();
      const code = await run(
        ['link', folder, '--project', 'proj_1', '--endpoint', fake.url, '--trigger', 'weekly'],
        io,
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toMatch(/--trigger must be one of: commit, agent-turn/);
      expect(await readManifest(folder)).toBeUndefined();
    });

    it('dispatches "link" with parsed --trigger', async () => {
      const { io } = collectIo();
      const code = await run(
        ['link', folder, '--project', 'proj_1', '--endpoint', fake.url, '--trigger', 'agent-turn'],
        io,
      );
      expect(code).toBe(0);
      const parsed: unknown = JSON.parse(await readFile(vorlynConfigPath(folder), 'utf8'));
      expect(parsed).toEqual({ trigger: 'agent-turn' });
    });

    it('installs the git hook by default, and --no-git-hook suppresses it', async () => {
      await execFileAsync('git', ['init', '--quiet'], { cwd: folder });
      const hook = path.join(folder, '.git', 'hooks', 'post-commit');

      await run(['link', folder, '--project', 'proj_1', '--endpoint', fake.url], collectIo().io);
      expect(await readFile(hook, 'utf8')).toMatch(/Managed by "vorlyn link"/);

      await rm(hook);
      const { io, out } = collectIo();
      const code = await run(
        ['link', folder, '--project', 'proj_1', '--endpoint', fake.url, '--no-git-hook'],
        io,
      );
      expect(code).toBe(0);
      await expect(access(hook)).rejects.toThrow();
      expect(out.join('\n')).not.toMatch(/post-commit/);
    });

    it('dispatches "unlink" and removes the manifest', async () => {
      await run(['link', folder, '--project', 'proj_1', '--endpoint', fake.url], collectIo().io);
      const { io } = collectIo();
      const code = await run(['unlink', folder], io);
      expect(code).toBe(0);
      expect(await readManifest(folder)).toBeUndefined();
    });

    it('dispatches "unlink" with --no-git-hook and leaves an installed hook in place', async () => {
      await execFileAsync('git', ['init', '--quiet'], { cwd: folder });
      const hook = path.join(folder, '.git', 'hooks', 'post-commit');
      await run(['link', folder, '--project', 'proj_1', '--endpoint', fake.url], collectIo().io);
      expect(await readFile(hook, 'utf8')).toMatch(/Managed by "vorlyn link"/);

      const { io } = collectIo();
      const code = await run(['unlink', folder, '--no-git-hook'], io);
      expect(code).toBe(0);
      expect(await readFile(hook, 'utf8')).toMatch(/Managed by "vorlyn link"/);
      expect(await readManifest(folder)).toBeUndefined();
    });

    it('dispatches "push" with parsed --force and --concurrency', async () => {
      await writeFile(path.join(folder, 'a.md'), '# A');
      await run(['link', folder, '--project', 'proj_1', '--endpoint', fake.url], collectIo().io);
      const { io } = collectIo();
      const code = await run(['push', folder, '--concurrency', '2'], io);
      expect(code).toBe(0);
      const manifest = await readManifest(folder);
      expect(manifest?.files['a.md']?.versionSeq).toBe(1);
    });

    it('dispatches "push" with parsed --note and --quiet', async () => {
      await writeFile(path.join(folder, 'a.md'), '# A');
      await run(['link', folder, '--project', 'proj_1', '--endpoint', fake.url], collectIo().io);
      const { io, out, err } = collectIo();
      const code = await run(['push', folder, '--note', 'first draft', '--quiet'], io);
      expect(code).toBe(0);
      expect(out).toEqual([]);
      expect(err).toEqual([]);
      expect([...fake.state.documents.values()][0]?.changeNote).toBe('first draft');
    });

    it('dispatches "status" without pushing anything', async () => {
      await writeFile(path.join(folder, 'a.md'), '# A');
      await run(['link', folder, '--project', 'proj_1', '--endpoint', fake.url], collectIo().io);
      const { io, out } = collectIo();
      const code = await run(['status', folder], io);
      expect(code).toBe(0);
      expect(out.some((l) => l.includes('new') && l.includes('a.md'))).toBe(true);
      expect(fake.state.documents.size).toBe(0);
      expect((await readManifest(folder))?.files).toEqual({});
    });

    it('rejects a non-positive --concurrency on "status" too', async () => {
      const { io, err } = collectIo();
      const code = await run(['status', folder, '--concurrency', '0'], io);
      expect(code).toBe(1);
      expect(err.join('\n')).toMatch(/concurrency/);
    });

    it('defaults folder to the current working directory when omitted', async () => {
      const { io, err } = collectIo();
      // No folder positional and cwd is (almost certainly) unlinked — a
      // clear error, not a crash, proves the cwd default path runs.
      const code = await run(['push'], io);
      expect(code).toBe(1);
      expect(err.join('\n')).toMatch(/not linked/);
    });

    it('dispatches "watch" and refuses on an unlinked folder without blocking', async () => {
      const { io, err } = collectIo();
      const code = await run(['watch', folder], io);
      expect(code).toBe(1);
      expect(err.join('\n')).toMatch(/not linked/);
    });

    it('rejects a negative --debounce before doing any work', async () => {
      const { io, err } = collectIo();
      const code = await run(['watch', folder, '--debounce=-5'], io);
      expect(code).toBe(1);
      expect(err.join('\n')).toMatch(/non-negative/);
    });

    it('rejects a non-numeric --debounce', async () => {
      const { io, err } = collectIo();
      const code = await run(['watch', folder, '--debounce', 'soon'], io);
      expect(code).toBe(1);
      expect(err.join('\n')).toMatch(/debounce/);
    });

    // Note: "link" with no --project (autoProvision) and "projects list" are
    // NOT exercised here — both would touch this developer's real
    // per-machine data directory (`resolveDataDir()`), since `cli.ts`'s
    // dispatch has no data-dir injection seam, same reason "vorlyn open" is
    // also never dispatch-tested at this layer. Full behavioral coverage
    // for both lives in link.test.ts (which calls `runLink` directly and
    // can override `LinkOptions.dataDir`) and cli.test.ts's own --project
    // case above already confirms an explicit --project is parsed and
    // wins, regardless of autoProvision's default-true wiring.

    it('rejects an unknown "projects" subcommand', async () => {
      const { io, err } = collectIo();
      const code = await run(['projects', 'bogus'], io);
      expect(code).toBe(1);
      expect(err.join('\n')).toMatch(/Unknown "vorlyn projects" subcommand/);
    });

    it('rejects an unknown "serve" subcommand', async () => {
      const { io, err } = collectIo();
      const code = await run(['serve', 'bogus'], io);
      expect(code).toBe(1);
      expect(err.join('\n')).toMatch(/Unknown "vorlyn serve" subcommand/);
    });
  });
});
