import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mdloopConfigPath } from './mdloop-config.js';
import { mdloopGitignorePath } from './mdloop-dir.js';
import { writeCredentials } from './credentials.js';
import { pinTrustedOrigin, readTrustedOrigin } from './endpoint-trust.js';
import { GIT_HOOK_MARKER, POST_COMMIT_HOOK } from './git-hook.js';
import { acquireInstanceRecord, markInstanceRunning } from './instance-record.js';
import { runLink } from './link.js';
import { readManifest, writeManifest } from './manifest.js';
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

describe('runLink', () => {
  let folder: string;
  let fake: FakeMcpServer;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-link-'));
    fake = await startFakeMcpServer();
    await writeCredentials(folder, { apiKey: fake.apiKey });
  });

  afterEach(async () => {
    await fake.close();
    await rm(folder, { recursive: true, force: true });
  });

  it('errors clearly with no API key available', async () => {
    const bareFolder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-link-bare-'));
    const { io, err } = collectIo();
    const code = await runLink({ folder: bareFolder, endpoint: fake.url, projectId: 'proj_1' }, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/API key/);
    await rm(bareFolder, { recursive: true, force: true });
  });

  it('links to a validated --project id', async () => {
    const { io } = collectIo();
    const code = await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, io);
    expect(code).toBe(0);
    const manifest = await readManifest(folder);
    expect(manifest).toEqual({ endpoint: fake.url, projectId: 'proj_1', files: {} });
  });

  it('errors on an unknown --project id', async () => {
    const { io, err } = collectIo();
    const code = await runLink({ folder, endpoint: fake.url, projectId: 'proj_nope' }, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/project_not_found/);
  });

  it('prompts interactively when --project is omitted on a TTY', async () => {
    const { io } = collectIo();
    const code = await runLink({ folder, endpoint: fake.url }, io, {
      isTTY: true,
      ask: () => Promise.resolve('2'),
    });
    expect(code).toBe(0);
    const manifest = await readManifest(folder);
    expect(manifest?.projectId).toBe('proj_2');
  });

  it('errors with an invalid selection', async () => {
    const { io, err } = collectIo();
    const code = await runLink({ folder, endpoint: fake.url }, io, {
      isTTY: true,
      ask: () => Promise.resolve('99'),
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/Invalid selection/);
  });

  it('errors with the project list on stderr when not a TTY and --project is omitted', async () => {
    const { io, err } = collectIo();
    const code = await runLink({ folder, endpoint: fake.url }, io, {
      isTTY: false,
      ask: () => Promise.resolve(''),
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/--project/);
    expect(err.join('\n')).toMatch(/proj_1/);
  });

  it('writes .mdloop/.gitignore so the credentials file can never be committed', async () => {
    const { io } = collectIo();
    await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, io);
    const ignore = await readFile(mdloopGitignorePath(folder), 'utf8');
    expect(ignore).toMatch(/^credentials$/m);
    expect(ignore).toMatch(/^\.lock$/m);
    expect(ignore).toMatch(/^endpoint-trust\.json$/m);
  });

  it('writes .mdloop/.gitignore even when link bails out for want of a key', async () => {
    const bareFolder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-link-bare-'));
    const { io } = collectIo();
    // A folder that will hold a credentials file next needs the ignore file
    // now, not after the first successful link.
    expect(await runLink({ folder: bareFolder, endpoint: fake.url, projectId: 'proj_1' }, io)).toBe(
      1,
    );
    expect(await readFile(mdloopGitignorePath(bareFolder), 'utf8')).toMatch(/^credentials$/m);
    await rm(bareFolder, { recursive: true, force: true });
  });

  // link is the trust-on-first-use moment for the manifest's endpoint.
  it('never pins a local endpoint (its port is dynamic and legitimately changes across daemon restarts — see endpoint-trust.test.ts for the remote-endpoint pinning behavior, which is unchanged)', async () => {
    const { io } = collectIo();
    await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, io);
    expect(await readTrustedOrigin(folder)).toBeUndefined();
  });

  it('refuses to link to a plain-http non-loopback endpoint', async () => {
    const { io, err } = collectIo();
    const code = await runLink(
      { folder, endpoint: 'http://attacker.example.net/mcp', projectId: 'proj_1' },
      io,
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/Refusing to send your API key/);
    expect(await readTrustedOrigin(folder)).toBeUndefined();
  });

  // A pin can only ever be written for a *remote* origin (pinTrustedOrigin is
  // a no-op for a loopback one, per endpoint-trust.ts) — that scenario, and
  // the remote-to-remote refusal it defends against, is unit-tested directly
  // against assertEndpointTrusted/pinTrustedOrigin in endpoint-trust.test.ts,
  // which needs no live connection. What's worth confirming at this
  // integration level is the opposite direction: a folder previously pinned
  // to a remote host is still allowed to relink to a *local* endpoint — the
  // pin comparison is skipped entirely for loopback, since loopback can
  // never be the spoofed-remote-host attack the pin exists to catch.
  it('allows relinking to a local endpoint even while a remote pin stands from an earlier link', async () => {
    await pinTrustedOrigin(folder, 'https://mdloop.example.com');
    const { io } = collectIo();
    const code = await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, io);
    expect(code).toBe(0);
    // Untouched: pinTrustedOrigin never writes for a loopback origin, and the
    // stale remote pin is simply irrelevant to a local connect, not erased.
    expect(await readTrustedOrigin(folder)).toBe('https://mdloop.example.com');
  });

  it('does not pin an endpoint that failed to connect', async () => {
    await fake.close();
    const { io, err } = collectIo();
    const code = await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/Could not connect/);
    expect(await readTrustedOrigin(folder)).toBeUndefined();
  });

  it('preserves existing file entries on relink to the same project', async () => {
    await writeManifest(folder, {
      endpoint: fake.url,
      projectId: 'proj_1',
      files: { 'a.md': { documentId: 'doc_1', contentHash: 'sha256:x', versionSeq: 1 } },
    });
    const { io } = collectIo();
    const code = await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, io);
    expect(code).toBe(0);
    const manifest = await readManifest(folder);
    expect(manifest?.projectId).toBe('proj_1');
    expect(manifest?.files['a.md']).toEqual({
      documentId: 'doc_1',
      contentHash: 'sha256:x',
      versionSeq: 1,
    });
  });

  it('refuses to relink to a different project', async () => {
    const originalManifest = {
      endpoint: fake.url,
      projectId: 'proj_1',
      files: { 'a.md': { documentId: 'doc_1', contentHash: 'sha256:x', versionSeq: 1 } },
    };
    await writeManifest(folder, originalManifest);
    const { io, err } = collectIo();
    const code = await runLink({ folder, endpoint: fake.url, projectId: 'proj_2' }, io);
    expect(code).toBe(1);
    const message = err.join('\n');
    expect(message).toMatch(/proj_1/);
    expect(message).toMatch(/proj_2/);
    expect(message).toMatch(/unlink/);
    const manifest = await readManifest(folder);
    expect(manifest).toEqual(originalManifest);
  });

  it('refuses to relink to a different project even with zero tracked files', async () => {
    const { io: linkIo } = collectIo();
    expect(await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, linkIo)).toBe(0);
    const { io, err } = collectIo();
    const code = await runLink({ folder, endpoint: fake.url, projectId: 'proj_2' }, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/proj_1/);
    const manifest = await readManifest(folder);
    expect(manifest?.projectId).toBe('proj_1');
  });

  // .mdloop/config.json records which event owns the push. Seeded on the first
  // link, user-owned forever after.
  describe('trigger config', () => {
    it('seeds commit as the default on a first link', async () => {
      const { io } = collectIo();
      await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, io);
      const parsed: unknown = JSON.parse(await readFile(mdloopConfigPath(folder), 'utf8'));
      expect(parsed).toEqual({ trigger: 'commit' });
    });

    it('writes agent-turn when asked', async () => {
      const { io } = collectIo();
      await runLink({ folder, endpoint: fake.url, projectId: 'proj_1', trigger: 'agent-turn' }, io);
      const parsed: unknown = JSON.parse(await readFile(mdloopConfigPath(folder), 'utf8'));
      expect(parsed).toEqual({ trigger: 'agent-turn' });
    });

    it('leaves an existing config untouched on relink', async () => {
      const { io } = collectIo();
      await runLink({ folder, endpoint: fake.url, projectId: 'proj_1', trigger: 'agent-turn' }, io);
      await runLink({ folder, endpoint: fake.url, projectId: 'proj_2', trigger: 'commit' }, io);
      const parsed: unknown = JSON.parse(await readFile(mdloopConfigPath(folder), 'utf8'));
      expect(parsed).toEqual({ trigger: 'agent-turn' });
    });

    it('writes no config at all when the link fails validation', async () => {
      const { io } = collectIo();
      expect(await runLink({ folder, endpoint: fake.url, projectId: 'proj_nope' }, io)).toBe(1);
      await expect(access(mdloopConfigPath(folder))).rejects.toThrow();
    });
  });

  describe('git post-commit hook', () => {
    let hook: string;

    beforeEach(async () => {
      await execFileAsync('git', ['init', '--quiet'], { cwd: folder });
      hook = path.join(folder, '.git', 'hooks', 'post-commit');
    });

    it('installs an executable hook and says so plainly', async () => {
      const { io, out } = collectIo();
      expect(await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, io)).toBe(0);
      expect(await readFile(hook, 'utf8')).toBe(POST_COMMIT_HOOK);
      expect((await stat(hook)).mode & 0o111).not.toBe(0);
      expect(out.join('\n')).toMatch(/Installed a git post-commit hook/);
      expect(out.join('\n')).toMatch(/every commit will now push/);
    });

    it('upgrades its own stale hook on relink', async () => {
      // A hook this CLI wrote at an older version: our marker, older body.
      await writeFile(hook, `#!/usr/bin/env bash\n${GIT_HOOK_MARKER}\nmdloop push --stale\n`, {
        encoding: 'utf8',
        mode: 0o755,
      });
      const { io, out } = collectIo();
      await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, io);
      expect(await readFile(hook, 'utf8')).toBe(POST_COMMIT_HOOK);
      expect(out.join('\n')).toMatch(/Updated the git post-commit hook/);
    });

    it('never touches a foreign hook, and prints the line to add instead', async () => {
      const foreign = '#!/bin/sh\nnpx lint-staged\n';
      await writeFile(hook, foreign, { encoding: 'utf8', mode: 0o755 });
      const { io, out } = collectIo();
      await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, io);
      expect(await readFile(hook, 'utf8')).toBe(foreign);
      const printed = out.join('\n');
      expect(printed).toMatch(/already exists and was left untouched/);
      expect(printed).toContain('"$MDLOOP" push --note');
    });

    it('stays quiet on a routine relink that changes nothing', async () => {
      await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, collectIo().io);
      const { io, out } = collectIo();
      await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, io);
      expect(out.join('\n')).not.toMatch(/post-commit/);
    });

    it('installs nothing with installGitHook: false', async () => {
      const { io, out } = collectIo();
      await runLink({ folder, endpoint: fake.url, projectId: 'proj_1', installGitHook: false }, io);
      await expect(access(hook)).rejects.toThrow();
      expect(out.join('\n')).not.toMatch(/post-commit/);
    });
  });

  // The default trigger is "commit", so linking outside git leaves neither
  // push mechanism active (no git hook to install; the Stop hook stands down
  // whenever trigger reads "commit"). That gap used to be entirely silent.
  it('warns about the missing hook when linking outside git with the default trigger', async () => {
    const { io, out } = collectIo();
    expect(await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, io)).toBe(0);
    expect(out.join('\n')).toMatch(/Not inside a git repo yet/);
    expect(out.join('\n')).toMatch(/re-run "mdloop link" to install it/);
  });

  it('says nothing about hooks when linking outside git with --trigger agent-turn', async () => {
    const { io, out } = collectIo();
    expect(
      await runLink({ folder, endpoint: fake.url, projectId: 'proj_1', trigger: 'agent-turn' }, io),
    ).toBe(0);
    expect(out.join('\n')).not.toMatch(/post-commit/);
    expect(out.join('\n')).not.toMatch(/git repo/);
  });

  describe('endpoint resolution with no explicit endpoint', () => {
    let dataDir: string;

    beforeEach(async () => {
      dataDir = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-link-endpoint-datadir-'));
    });

    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true });
    });

    /**
     * Regression pin: `DEFAULT_ENDPOINT` names a fixed port (3001) that
     * stopped meaning anything once ports became OS-assigned — reproduced
     * manually against a real running daemon, where a bare `mdloop link`
     * (no `--endpoint`, no existing manifest, no `MDLOOP_MCP_URL`) failed
     * to connect outright because the real daemon was never on port 3001 in
     * the first place. This is exactly the call shape `mdloop-ensure.sh`
     * uses. Before falling back to `DEFAULT_ENDPOINT`, resolution must
     * check for a live local instance recorded in the data directory and
     * use its real endpoint instead.
     */
    it('discovers and uses a live local instance instead of falling back to the fixed default port', async () => {
      const mcpPort = Number(new URL(fake.url).port);
      const record = await acquireInstanceRecord(dataDir, { owner: 'serve', pid: process.pid });
      await markInstanceRunning(dataDir, record, {
        apiPort: mcpPort + 1000, // arbitrary — irrelevant to this test
        mcpPort,
        rootUrl: 'http://127.0.0.1:9999',
        mcpEndpoint: fake.url,
      });

      const { io } = collectIo();
      const code = await runLink({ folder, projectId: 'proj_1', dataDir }, io);

      expect(code).toBe(0);
      expect((await readManifest(folder))?.endpoint).toBe(fake.url);
    });

    it('still falls back to DEFAULT_ENDPOINT when nothing is running locally (and so fails to connect, honestly)', async () => {
      const { io, err } = collectIo();
      const code = await runLink({ folder, projectId: 'proj_1', dataDir }, io);
      expect(code).toBe(1);
      expect(err.join('\n')).toMatch(/Could not connect to http:\/\/localhost:3001\/mcp/);
    });
  });

  describe('autoProvision', () => {
    let dataDir: string;

    beforeEach(async () => {
      dataDir = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-link-datadir-'));
    });

    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true });
    });

    /**
     * Regression pin: `mdloop link` never creates an API key of its own —
     * true and unchanged for the explicit/remote case — but a brand-new
     * folder that was never `mdloop open`ed by hand (this is exactly what
     * `mdloop-ensure.sh`'s bare `mdloop link` hits for a fresh repo) used
     * to have no way to get one at all under auto-provisioning, since only
     * `mdloop open`'s bootstrap logic ever read `bootstrap.json`. Against a
     * local endpoint, with auto-provisioning on, this must now succeed using
     * the same bootstrap key `mdloop open` reads — and persist it, so a
     * second run doesn't need the fallback again.
     */
    it('falls back to the local bootstrap API key when nothing else has one, against a local endpoint with autoProvision on', async () => {
      const freshFolder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-link-nocreds-'));
      await writeFile(
        path.join(dataDir, 'bootstrap.json'),
        JSON.stringify({ apiKey: fake.apiKey }),
        'utf8',
      );
      try {
        const { io } = collectIo();
        const code = await runLink(
          { folder: freshFolder, endpoint: fake.url, autoProvision: true, dataDir },
          io,
        );
        expect(code).toBe(0);
        expect((await readManifest(freshFolder))?.endpoint).toBe(fake.url);
        // Persisted for next time, same as mdloop open's own bootstrap flow.
        const creds = JSON.parse(
          await readFile(path.join(freshFolder, '.mdloop', 'credentials'), 'utf8'),
        ) as { apiKey: string };
        expect(creds.apiKey).toBe(fake.apiKey);
      } finally {
        await rm(freshFolder, { recursive: true, force: true });
      }
    });

    it('does NOT fall back to the bootstrap key without autoProvision — "link does not create one" still holds', async () => {
      const freshFolder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-link-nocreds-'));
      await writeFile(
        path.join(dataDir, 'bootstrap.json'),
        JSON.stringify({ apiKey: fake.apiKey }),
        'utf8',
      );
      try {
        const { io, err } = collectIo();
        const code = await runLink({ folder: freshFolder, endpoint: fake.url, dataDir }, io);
        expect(code).toBe(1);
        expect(err.join('\n')).toMatch(/link does not create one/);
      } finally {
        await rm(freshFolder, { recursive: true, force: true });
      }
    });

    it('creates a new project named after the folder when nothing matches', async () => {
      const { io } = collectIo();
      const code = await runLink({ folder, endpoint: fake.url, autoProvision: true, dataDir }, io);
      expect(code).toBe(0);
      expect(fake.state.callCounts.create_project ?? 0).toBe(1);
      const manifest = await readManifest(folder);
      const created = [...fake.state.projects].at(-1);
      expect(manifest?.projectId).toBe(created?.id);
      expect(created?.name).toBe(path.basename(folder));
    });

    it('reuses the mapping on a later link of the same (unlinked-in-between) folder, without creating again', async () => {
      const first = await runLink(
        { folder, endpoint: fake.url, autoProvision: true, dataDir },
        collectIo().io,
      );
      expect(first).toBe(0);
      const firstProjectId = (await readManifest(folder))?.projectId;
      expect(fake.state.callCounts.create_project ?? 0).toBe(1);

      // Remove only the manifest (as "mdloop unlink" would) — the
      // machine-wide projects.json mapping in `dataDir` is untouched.
      await rm(path.join(folder, '.mdloop', 'manifest.json'));

      const { io } = collectIo();
      const second = await runLink(
        { folder, endpoint: fake.url, autoProvision: true, dataDir },
        io,
      );
      expect(second).toBe(0);
      expect(fake.state.callCounts.create_project ?? 0).toBe(1); // still 1 — no second create
      expect((await readManifest(folder))?.projectId).toBe(firstProjectId);
    });

    it('reuses an existing project whose name matches the folder, without creating one', async () => {
      const namedFolder = path.join(
        await mkdtemp(path.join(tmpdir(), 'mdloop-cli-link-parent-')),
        'Alpha',
      );
      await mkdir(namedFolder, { recursive: true });
      await writeCredentials(namedFolder, { apiKey: fake.apiKey });

      const { io } = collectIo();
      // proj_1 is seeded as "Alpha" in the fake server's fixtures.
      const code = await runLink(
        { folder: namedFolder, endpoint: fake.url, autoProvision: true, dataDir },
        io,
      );
      expect(code).toBe(0);
      expect(fake.state.callCounts.create_project ?? 0).toBe(0);
      expect((await readManifest(namedFolder))?.projectId).toBe('proj_1');

      await rm(path.dirname(namedFolder), { recursive: true, force: true });
    });

    it('picks the oldest and warns when more than one existing project shares the folder name, without creating another', async () => {
      const namedFolder = path.join(
        await mkdtemp(path.join(tmpdir(), 'mdloop-cli-link-parent-')),
        'Beta',
      );
      await mkdir(namedFolder, { recursive: true });
      await writeCredentials(namedFolder, { apiKey: fake.apiKey });
      // A second "Beta", newer than the seeded proj_2 — the seeded one
      // should still win as "oldest" since it comes first in the array.
      fake.state.projects.push({ id: 'proj_beta_2', name: 'Beta', color: '#000000' });

      const { io, err } = collectIo();
      const code = await runLink(
        { folder: namedFolder, endpoint: fake.url, autoProvision: true, dataDir },
        io,
      );
      expect(code).toBe(0);
      expect(fake.state.callCounts.create_project ?? 0).toBe(0);
      expect((await readManifest(namedFolder))?.projectId).toBe('proj_2');
      expect(err.join('\n')).toMatch(/2 existing projects are named "Beta"/);
      expect(err.join('\n')).toMatch(/proj_beta_2/);

      await rm(path.dirname(namedFolder), { recursive: true, force: true });
    });

    it('an explicit --project still wins outright, autoProvision or not', async () => {
      const { io } = collectIo();
      const code = await runLink(
        { folder, endpoint: fake.url, projectId: 'proj_2', autoProvision: true, dataDir },
        io,
      );
      expect(code).toBe(0);
      expect(fake.state.callCounts.create_project ?? 0).toBe(0);
      expect((await readManifest(folder))?.projectId).toBe('proj_2');
    });
  });
});
