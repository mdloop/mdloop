import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeCredentials } from './credentials.js';
import { pinTrustedOrigin, readTrustedOrigin } from './endpoint-trust.js';
import { sha256Hex } from './hash.js';
import { runLink } from './link.js';
import { lockPath } from './lock.js';
import type { Manifest, ManifestFileEntry } from './manifest.js';
import { readManifest, writeManifest } from './manifest.js';
import type { Io } from './output.js';
import { runStatus } from './status.js';
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

describe('runStatus', () => {
  let folder: string;
  let fake: FakeMcpServer;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-status-'));
    fake = await startFakeMcpServer();
    await writeCredentials(folder, { apiKey: fake.apiKey });
  });

  afterEach(async () => {
    await fake.close();
    await rm(folder, { recursive: true, force: true });
  });

  async function link(files: Record<string, ManifestFileEntry> = {}): Promise<void> {
    const manifest: Manifest = { endpoint: fake.url, projectId: 'proj_1', files };
    await writeManifest(folder, manifest);
  }

  async function trackUnchanged(relPath: string, content: string, seq = 1): Promise<void> {
    await writeFile(path.join(folder, relPath), content);
    const bytes = await readFile(path.join(folder, relPath));
    await link({
      [relPath]: { documentId: 'doc_1', contentHash: sha256Hex(bytes), versionSeq: seq },
    });
    fake.state.documents.set('doc_1', { id: 'doc_1', title: relPath, versionSeq: seq, content });
  }

  it('errors clearly when the folder is not linked', async () => {
    const { io, err } = collectIo();
    const code = await runStatus({ folder, concurrency: 3 }, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/not linked/);
  });

  it('reports an unchanged file without any network call', async () => {
    await trackUnchanged('a.md', '# A');
    const { io, out } = collectIo();
    const code = await runStatus({ folder, concurrency: 3 }, io);
    expect(code).toBe(0);
    expect(out.some((l) => l.startsWith('unchanged') && l.includes('a.md'))).toBe(true);
    expect(fake.state.callCounts.get_document_status ?? 0).toBe(0);
  });

  it('reports a locally-modified file as modified when the server has not moved', async () => {
    await trackUnchanged('a.md', '# A');
    await writeFile(path.join(folder, 'a.md'), '# A edited locally');
    const { io, out } = collectIo();
    const code = await runStatus({ folder, concurrency: 3 }, io);
    expect(code).toBe(0);
    expect(out.some((l) => l.startsWith('modified') && l.includes('a.md'))).toBe(true);
    expect(fake.state.callCounts.get_document_status ?? 0).toBe(1);
  });

  it('reports a conflict when the server moved past the tracked seq', async () => {
    await trackUnchanged('a.md', '# A');
    await writeFile(path.join(folder, 'a.md'), '# A edited locally');
    const doc = fake.state.documents.get('doc_1');
    if (doc) doc.versionSeq = 4;
    const { io, out } = collectIo();
    const code = await runStatus({ folder, concurrency: 3 }, io);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/conflicted .*a\.md.*local knows seq 1, server is at seq 4/);
  });

  it('reports an untracked markdown file as new, and a tracked-but-deleted one as missing', async () => {
    await writeFile(path.join(folder, 'fresh.md'), '# Fresh');
    await link({ 'gone.md': { documentId: 'doc_9', contentHash: 'sha256:x', versionSeq: 1 } });
    const { io, out } = collectIo();
    const code = await runStatus({ folder, concurrency: 3 }, io);
    expect(code).toBe(0);
    expect(out.some((l) => l.startsWith('new') && l.includes('fresh.md'))).toBe(true);
    // Deletion is never inferred — status says so out loud.
    expect(out.some((l) => l.startsWith('missing') && l.includes('gone.md'))).toBe(true);
    expect(fake.state.callCounts.get_document_status ?? 0).toBe(0);
  });

  it('reports a per-file lookup failure and exits 1', async () => {
    await writeFile(path.join(folder, 'a.md'), '# A changed');
    await link({ 'a.md': { documentId: 'doc_forbidden', contentHash: 'sha256:x', versionSeq: 1 } });
    const { io, err } = collectIo();
    const code = await runStatus({ folder, concurrency: 3 }, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/failed .*a\.md: forbidden/);
  });

  it('changes nothing: no upload, no manifest write, no lock taken', async () => {
    await trackUnchanged('a.md', '# A');
    await writeFile(path.join(folder, 'a.md'), '# A edited locally');
    const before = await readManifest(folder);
    const { io } = collectIo();
    await runStatus({ folder, concurrency: 3 }, io);
    expect(await readManifest(folder)).toEqual(before);
    expect(fake.state.callCounts.upload_document ?? 0).toBe(0);
    expect(fake.state.documents.get('doc_1')?.content).toBe('# A');
    // No lock: status must answer during an in-flight push, not refuse.
    await expect(stat(lockPath(folder))).rejects.toThrow();
  });

  describe('endpoint trust', () => {
    it('refuses plain http to a non-loopback host', async () => {
      await writeManifest(folder, {
        endpoint: 'http://attacker.example.net/mcp',
        projectId: 'proj_1',
        files: {},
      });
      const { io, err } = collectIo();
      const code = await runStatus({ folder, concurrency: 3 }, io);
      expect(code).toBe(1);
      expect(err.join('\n')).toMatch(/Refusing to send your API key/);
    });

    // Loopback is exempt from the pin comparison entirely (endpoint-trust.ts
    // — see push.test.ts's equivalent cases for the full reasoning); genuine
    // remote-to-remote repoint refusal is unit-tested directly against
    // assertEndpointTrusted in endpoint-trust.test.ts.
    it('still succeeds against a local endpoint despite a stale remote pin from an earlier link', async () => {
      await link();
      await pinTrustedOrigin(folder, 'https://mdloop.example.com');
      const { io } = collectIo();
      const code = await runStatus({ folder, concurrency: 3 }, io);
      expect(code).toBe(0);
      expect(await readTrustedOrigin(folder)).toBe('https://mdloop.example.com');
    });

    it('never pins a local endpoint on a read-only run', async () => {
      await link();
      const { io } = collectIo();
      expect(await runStatus({ folder, concurrency: 3 }, io)).toBe(0);
      expect(await readTrustedOrigin(folder)).toBeUndefined();
    });
  });

  it('summarises every bucket on one line', async () => {
    await trackUnchanged('a.md', '# A');
    await writeFile(path.join(folder, 'b.md'), '# B');
    const { io, out } = collectIo();
    await runStatus({ folder, concurrency: 3 }, io);
    expect(out[out.length - 1]).toBe(
      '0 modified, 1 new, 0 conflicted, 1 unchanged, 0 missing, 0 failed',
    );
  });

  // The bug this whole fix targets: `mdloop link` run before `git init`
  // silently skips installing the commit-trigger hook, and nothing ever
  // pointed out the gap again once the folder became a git repo.
  describe('commit-trigger drift warning', () => {
    it('warns when the folder was linked before git init and never re-linked since', async () => {
      const { io: linkIo } = collectIo();
      expect(await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, linkIo)).toBe(0);
      await execFileAsync('git', ['init', '--quiet'], { cwd: folder });

      const { io, err } = collectIo();
      const code = await runStatus({ folder, concurrency: 3 }, io);
      expect(code).toBe(0);
      expect(err.join('\n')).toMatch(/no git post-commit hook is installed/);
    });

    it('does not warn once a relink after git init actually installs the hook', async () => {
      const { io: linkIo } = collectIo();
      expect(await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, linkIo)).toBe(0);
      await execFileAsync('git', ['init', '--quiet'], { cwd: folder });
      expect(await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, linkIo)).toBe(0);

      const { io, err } = collectIo();
      const code = await runStatus({ folder, concurrency: 3 }, io);
      expect(code).toBe(0);
      expect(err.join('\n')).not.toMatch(/no git post-commit hook is installed/);
    });
  });

  describe('org-usage pre-flight warning (Phase 33.D)', () => {
    it('warns when new files would exceed the doc cap', async () => {
      await link();
      fake.state.orgUsage = { tier: 'free', activeDocCount: 99, maxActiveDocs: 100 };
      await writeFile(path.join(folder, 'a.md'), '# A');
      await writeFile(path.join(folder, 'b.md'), '# B');
      const { io, err } = collectIo();
      const code = await runStatus({ folder, concurrency: 3 }, io);
      expect(code).toBe(0);
      expect(err.join('\n')).toMatch(/this push will attempt 2 new documents/);
      expect(err.join('\n')).toMatch(/99\/100/);
    });

    it('never warns when there are no new files', async () => {
      await link({
        'a.md': { documentId: 'doc_1', contentHash: sha256Hex(Buffer.from('# A')), versionSeq: 1 },
      });
      fake.state.orgUsage = { tier: 'free', activeDocCount: 100, maxActiveDocs: 100 };
      await writeFile(path.join(folder, 'a.md'), '# A');
      const { io, err } = collectIo();
      const code = await runStatus({ folder, concurrency: 3 }, io);
      expect(code).toBe(0);
      expect(err.join('\n')).not.toMatch(/this push will attempt/);
    });

    it('fails open: a get_org_usage error never fails the status check', async () => {
      await link();
      fake.state.orgUsage = 'fail';
      await writeFile(path.join(folder, 'a.md'), '# A');
      const { io, err, out } = collectIo();
      const code = await runStatus({ folder, concurrency: 3 }, io);
      expect(code).toBe(0);
      expect(err.join('\n')).not.toMatch(/this push will attempt/);
      expect(out.some((l) => l.startsWith('new'))).toBe(true);
    });
  });
});
