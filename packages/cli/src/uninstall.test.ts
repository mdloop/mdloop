import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INSTRUCTIONS_BEGIN, installGlobalAgentInstructions } from './agent-instructions.js';
import { writeCredentials } from './credentials.js';
import { recordFolderProject } from './folder-projects.js';
import { acquireInstanceRecord, markInstanceRunning } from './instance-record.js';
import { manifestPath, writeManifest } from './manifest.js';
import { mdloopDir } from './mdloop-dir.js';
import type { Io } from './output.js';
import { runUninstall } from './uninstall.js';

function collectIo(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { println: (l: string) => out.push(l), errln: (l: string) => err.push(l) },
    out,
    err,
  };
}

/** Puts a folder into the same on-disk state `mdloop link` would, without a live MCP server. */
async function linkFolder(folder: string, endpointOrigin: string): Promise<void> {
  await writeCredentials(folder, { apiKey: 'mdloop_test' });
  await writeManifest(folder, {
    endpoint: `${endpointOrigin}/mcp`,
    projectId: 'proj_1',
    files: {},
  });
}

describe('runUninstall', () => {
  let dataDir: string;
  let homeDir: string;
  let folder: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-uninstall-data-'));
    homeDir = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-uninstall-home-'));
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-uninstall-folder-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });

  it('reports nothing to clean up on a machine mdloop never touched', async () => {
    await rm(dataDir, { recursive: true, force: true }); // never created — the common case
    const { io, out } = collectIo();
    const code = await runUninstall({ dataDir, homeDir }, io);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/Nothing to clean up/);
  });

  it('unlinks every folder recorded in folder-projects.json', async () => {
    await linkFolder(folder, 'http://127.0.0.1:1');
    await recordFolderProject(dataDir, folder, {
      projectId: 'proj_1',
      projectName: 'test',
      endpointOrigin: 'http://127.0.0.1:1',
      linkedAt: new Date().toISOString(),
    });

    const { io } = collectIo();
    const code = await runUninstall({ dataDir, homeDir }, io);
    expect(code).toBe(0);
    await expect(access(manifestPath(folder))).rejects.toThrow();
    await expect(access(mdloopDir(folder))).rejects.toThrow();
  });

  it('skips a recorded folder that no longer exists on disk, without resurrecting it', async () => {
    const gone = path.join(tmpdir(), 'mdloop-cli-uninstall-gone-does-not-exist');
    await recordFolderProject(dataDir, gone, {
      projectId: 'proj_1',
      projectName: 'gone',
      endpointOrigin: 'http://127.0.0.1:1',
      linkedAt: new Date().toISOString(),
    });

    const { io } = collectIo();
    const code = await runUninstall({ dataDir, homeDir }, io);
    expect(code).toBe(0);
    await expect(access(gone)).rejects.toThrow();
  });

  it('skips a recorded folder that was already unlinked by hand', async () => {
    await recordFolderProject(dataDir, folder, {
      projectId: 'proj_1',
      projectName: 'test',
      endpointOrigin: 'http://127.0.0.1:1',
      linkedAt: new Date().toISOString(),
    });
    // folder exists but was never actually linked (no manifest) — recordFolderProject alone
    // reflects an auto-provision that link.ts then unwound, or a folder unlinked by hand.
    const { io, out } = collectIo();
    const code = await runUninstall({ dataDir, homeDir }, io);
    expect(code).toBe(0);
    expect(out.join('\n')).not.toMatch(/is not linked/);
  });

  it('removes the global instructions block and reports it', async () => {
    await mkdir(path.join(homeDir, '.claude'), { recursive: true });
    await installGlobalAgentInstructions(homeDir);
    const { io, out } = collectIo();
    const code = await runUninstall({ dataDir, homeDir }, io);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/claude.*removed/);
    const claudeMd = await readFile(path.join(homeDir, '.claude', 'CLAUDE.md'), 'utf8').catch(
      () => '',
    );
    expect(claudeMd).not.toContain(INSTRUCTIONS_BEGIN);
  });

  it('leaves a foreign global block untouched and returns exit code 1', async () => {
    await mkdir(path.join(homeDir, '.claude'), { recursive: true });
    const foreign = `${INSTRUCTIONS_BEGIN}\n(hand-edited, no matching end marker)\n`;
    await writeFile(path.join(homeDir, '.claude', 'CLAUDE.md'), foreign, 'utf8');
    const { io, out } = collectIo();
    const code = await runUninstall({ dataDir, homeDir }, io);
    expect(code).toBe(1);
    expect(out.join('\n')).toMatch(/left untouched/);
    expect(await readFile(path.join(homeDir, '.claude', 'CLAUDE.md'), 'utf8')).toBe(foreign);
  });

  it('leaves local document data in place by default and says so', async () => {
    await writeFile(path.join(dataDir, 'marker.txt'), 'real data', 'utf8');
    const { io, out } = collectIo();
    const code = await runUninstall({ dataDir, homeDir }, io);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/left in place/);
    await expect(access(path.join(dataDir, 'marker.txt'))).resolves.toBeUndefined();
  });

  it('--purge-data removes the data directory when no server is running against it', async () => {
    await writeFile(path.join(dataDir, 'marker.txt'), 'real data', 'utf8');
    const { io, out } = collectIo();
    const code = await runUninstall({ dataDir, homeDir, purgeData: true }, io);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/Removed local document data/);
    await expect(access(dataDir)).rejects.toThrow();
  });

  it('--purge-data refuses while a local server is live against this data directory', async () => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const record = await acquireInstanceRecord(dataDir, { owner: 'serve', pid: process.pid });
    await markInstanceRunning(dataDir, record, {
      apiPort: port,
      mcpPort: port,
      rootUrl: `http://127.0.0.1:${String(port)}`,
      mcpEndpoint: `http://127.0.0.1:${String(port)}/mcp`,
    });

    const { io, err } = collectIo();
    const code = await runUninstall({ dataDir, homeDir, purgeData: true }, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/still running/);
    await expect(access(dataDir)).resolves.toBeUndefined();

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
});
