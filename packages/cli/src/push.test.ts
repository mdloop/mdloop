import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ok } from '@vorlyn/shared';
import { writeCredentials } from './credentials.js';
import { endpointTrustPath, pinTrustedOrigin, readTrustedOrigin } from './endpoint-trust.js';
import { sha256Hex } from './hash.js';
import { runLink } from './link.js';
import { lockPath } from './lock.js';
import type { Manifest, ManifestFileEntry } from './manifest.js';
import { readManifest, writeManifest } from './manifest.js';
import type { VorlynMcpClient } from './mcp-client.js';
import type { Io } from './output.js';
import type { PushDeps } from './push.js';
import { runPush, toPosixPath } from './push.js';
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

describe('runPush', () => {
  let folder: string;
  let fake: FakeMcpServer;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'vorlyn-cli-push-'));
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

  it('errors clearly when the folder is not linked', async () => {
    const { io, err } = collectIo();
    const code = await runPush({ folder, force: false, concurrency: 3 }, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/not linked/);
  });

  it('creates a new document for an untracked file', async () => {
    await link();
    await writeFile(path.join(folder, 'a.md'), '# A');
    const { io, out } = collectIo();
    const code = await runPush({ folder, force: false, concurrency: 3 }, io);
    expect(code).toBe(0);
    expect(out.some((l) => l.includes('pushed') && l.includes('a.md'))).toBe(true);
    const manifest = await readManifest(folder);
    expect(manifest?.files['a.md']?.versionSeq).toBe(1);
    expect(fake.state.documents.size).toBe(1);
  });

  it('skips an unchanged file without a network call', async () => {
    await writeFile(path.join(folder, 'a.md'), '# A');
    const bytes = await readFile(path.join(folder, 'a.md'));
    await link({ 'a.md': { documentId: 'doc_1', contentHash: sha256Hex(bytes), versionSeq: 1 } });
    fake.state.documents.set('doc_1', { id: 'doc_1', title: 'A', versionSeq: 1, content: '# A' });
    const { io, out } = collectIo();
    const code = await runPush({ folder, force: false, concurrency: 3 }, io);
    expect(code).toBe(0);
    expect(out.some((l) => l.includes('unchanged'))).toBe(true);
    expect(fake.state.callCounts.get_document_status ?? 0).toBe(0);
    expect(fake.state.callCounts.upload_document ?? 0).toBe(0);
  });

  it('checks the seq with get_document_status, never downloading the body', async () => {
    await writeFile(path.join(folder, 'a.md'), '# A changed');
    await link({ 'a.md': { documentId: 'doc_1', contentHash: 'sha256:stale', versionSeq: 1 } });
    fake.state.documents.set('doc_1', { id: 'doc_1', title: 'A', versionSeq: 1, content: '# A' });
    const { io } = collectIo();
    const code = await runPush({ folder, force: false, concurrency: 3 }, io);
    expect(code).toBe(0);
    expect(fake.state.callCounts.get_document_status ?? 0).toBe(1);
    // The whole point of the new tool: the guard costs metadata, not markdown.
    expect(fake.state.callCounts.get_document ?? 0).toBe(0);
  });

  it('records --note as the change note on every version the run creates', async () => {
    await writeFile(path.join(folder, 'new.md'), '# New');
    await writeFile(path.join(folder, 'tracked.md'), '# Tracked changed');
    // Tracked fixture ids must stay outside the fake's `doc_<n>` mint
    // sequence whenever the same run also creates a document — otherwise the
    // minted id collides with the fixture and the two race.
    await link({
      'tracked.md': { documentId: 'doc_tracked', contentHash: 'sha256:stale', versionSeq: 1 },
    });
    fake.state.documents.set('doc_tracked', {
      id: 'doc_tracked',
      title: 'Tracked',
      versionSeq: 1,
      content: '# Tracked',
    });
    const { io } = collectIo();
    const code = await runPush(
      { folder, force: false, concurrency: 3, note: 'tightened the rollback steps' },
      io,
    );
    expect(code).toBe(0);
    // Both legs of upload_document — new-version and new-document — carry it.
    expect(fake.state.documents.get('doc_tracked')?.changeNote).toBe(
      'tightened the rollback steps',
    );
    const created = [...fake.state.documents.values()].find((d) => d.title === 'new');
    expect(created?.changeNote).toBe('tightened the rollback steps');
  });

  it('leaves the change note unset when --note is omitted', async () => {
    await writeFile(path.join(folder, 'a.md'), '# A');
    await link();
    const { io } = collectIo();
    await runPush({ folder, force: false, concurrency: 3 }, io);
    expect([...fake.state.documents.values()][0]?.changeNote).toBeNull();
  });

  it('--quiet prints nothing on a clean run but keeps the exit code', async () => {
    await writeFile(path.join(folder, 'a.md'), '# A');
    await link();
    const { io, out, err } = collectIo();
    const code = await runPush({ folder, force: false, concurrency: 3, quiet: true }, io);
    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    // Silence is not a no-op: the push really happened.
    expect(fake.state.documents.size).toBe(1);
    expect((await readManifest(folder))?.files['a.md']?.versionSeq).toBe(1);
  });

  it('--quiet still surfaces conflicts and failures, with the same exit code', async () => {
    await writeFile(path.join(folder, 'a.md'), '# A changed');
    await writeFile(path.join(folder, 'b.md'), '# B changed');
    await writeFile(path.join(folder, 'c.md'), '# C');
    // c.md is untracked, so this run also mints a document — keep the tracked
    // fixture off the fake's `doc_<n>` mint sequence so the two can't collide.
    await link({
      'a.md': { documentId: 'doc_ahead', contentHash: 'sha256:stale', versionSeq: 1 },
      'b.md': { documentId: 'doc_forbidden', contentHash: 'sha256:stale', versionSeq: 1 },
    });
    fake.state.documents.set('doc_ahead', {
      id: 'doc_ahead',
      title: 'A',
      versionSeq: 2,
      content: 'server-ahead',
    });
    const { io, out, err } = collectIo();
    const code = await runPush({ folder, force: false, concurrency: 3, quiet: true }, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/conflict/);
    expect(err.join('\n')).toMatch(/forbidden/);
    // The successful push of c.md and the summary stay silent.
    expect(out).toEqual([]);
  });

  it('refuses a changed file whose server seq has moved, unless --force', async () => {
    await writeFile(path.join(folder, 'a.md'), '# A changed');
    await link({ 'a.md': { documentId: 'doc_1', contentHash: 'sha256:stale', versionSeq: 1 } });
    fake.state.documents.set('doc_1', {
      id: 'doc_1',
      title: 'A',
      versionSeq: 2,
      content: 'server-ahead',
    });
    const { io, err } = collectIo();
    const code = await runPush({ folder, force: false, concurrency: 3 }, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/conflict/);
    expect(err.join('\n')).toMatch(/local knows seq 1, server is at seq 2/);
    const manifest = await readManifest(folder);
    expect(manifest?.files['a.md']?.versionSeq).toBe(1);
  });

  it('overrides a conflict with --force', async () => {
    await writeFile(path.join(folder, 'a.md'), '# A changed');
    await link({ 'a.md': { documentId: 'doc_1', contentHash: 'sha256:stale', versionSeq: 1 } });
    fake.state.documents.set('doc_1', {
      id: 'doc_1',
      title: 'A',
      versionSeq: 2,
      content: 'server-ahead',
    });
    const { io } = collectIo();
    const code = await runPush({ folder, force: true, concurrency: 3 }, io);
    expect(code).toBe(0);
    const manifest = await readManifest(folder);
    expect(manifest?.files['a.md']?.versionSeq).toBe(3);
  });

  it('reports a forbidden error clearly and continues with other files', async () => {
    await writeFile(path.join(folder, 'a.md'), '# A changed');
    await writeFile(path.join(folder, 'b.md'), '# B');
    await link({
      'a.md': { documentId: 'doc_forbidden', contentHash: 'sha256:stale', versionSeq: 1 },
    });
    const { io, err, out } = collectIo();
    const code = await runPush({ folder, force: false, concurrency: 3 }, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/forbidden/);
    expect(out.some((l) => l.includes('pushed') && l.includes('b.md'))).toBe(true);
  });

  // Phase 33.A.1: a tier-cap failure now carries a human-readable message
  // through the MCP boundary (packages/mcp/src/server.ts) and the CLI client
  // (packages/cli/src/mcp-client.ts) — this proves push.ts's `recordResult`
  // actually prefers it over the bare code, using the fake server's
  // 'cap-exceeded' sentinel title (test-support/fake-mcp-server.ts).
  it('renders the human-readable message for a tier-cap failure, not the bare code', async () => {
    await writeFile(path.join(folder, 'cap-exceeded.md'), '# New');
    await link();
    const { io, err } = collectIo();
    const code = await runPush({ folder, force: false, concurrency: 3 }, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain(
      "failed     cap-exceeded.md: This org already has 100 active documents, this tier's limit",
    );
    expect(err.join('\n')).not.toMatch(/failed\s+cap-exceeded\.md: doc_cap_exceeded\s*$/m);
  });

  it('respects the concurrency cap on a bulk push', async () => {
    await fake.close();
    fake = await startFakeMcpServer({ uploadDelayMs: 30 });
    await writeCredentials(folder, { apiKey: fake.apiKey });
    for (let i = 0; i < 6; i += 1) {
      await writeFile(path.join(folder, `f${String(i)}.md`), `# ${String(i)}`);
    }
    await link();
    const { io } = collectIo();
    const code = await runPush({ folder, force: false, concurrency: 2 }, io);
    expect(code).toBe(0);
    expect(fake.state.maxConcurrentUploads).toBeLessThanOrEqual(2);
    expect(fake.state.maxConcurrentUploads).toBeGreaterThan(0);
  });

  it('allows more in-flight uploads with a higher concurrency cap', async () => {
    await fake.close();
    fake = await startFakeMcpServer({ uploadDelayMs: 30 });
    await writeCredentials(folder, { apiKey: fake.apiKey });
    for (let i = 0; i < 6; i += 1) {
      await writeFile(path.join(folder, `f${String(i)}.md`), `# ${String(i)}`);
    }
    await link();
    const { io } = collectIo();
    await runPush({ folder, force: false, concurrency: 6 }, io);
    expect(fake.state.maxConcurrentUploads).toBeGreaterThan(2);
  });

  it('releases the lock file after a clean run', async () => {
    await link();
    await writeFile(path.join(folder, 'a.md'), '# A');
    const { io } = collectIo();
    await runPush({ folder, force: false, concurrency: 3 }, io);
    await expect(stat(lockPath(folder))).rejects.toThrow();
  });

  it('releases the lock file even when the connection fails', async () => {
    await link();
    await fake.close();
    await writeFile(path.join(folder, 'a.md'), '# A');
    const { io, err } = collectIo();
    const code = await runPush({ folder, force: false, concurrency: 3 }, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/Could not connect/);
    await expect(stat(lockPath(folder))).rejects.toThrow();
  });

  describe('endpoint trust (a committed manifest is attacker-reachable)', () => {
    it('refuses plain http to a non-loopback host before touching the network', async () => {
      await writeManifest(folder, {
        endpoint: 'http://attacker.example.net/mcp',
        projectId: 'proj_1',
        files: {},
      });
      await writeFile(path.join(folder, 'a.md'), '# A');
      const { io, err } = collectIo();
      const code = await runPush({ folder, force: false, concurrency: 3 }, io);
      expect(code).toBe(1);
      expect(err.join('\n')).toMatch(/Refusing to send your API key/);
      expect(await readTrustedOrigin(folder)).toBeUndefined();
    });

    it('allows plain http to loopback (the make dev workflow) without ever pinning it (the local daemon port is dynamic; see endpoint-trust.test.ts for the remote-endpoint pinning behavior, which is unchanged)', async () => {
      await link();
      await writeFile(path.join(folder, 'a.md'), '# A');
      const { io } = collectIo();
      expect(await runPush({ folder, force: false, concurrency: 3 }, io)).toBe(0);
      expect(await readTrustedOrigin(folder)).toBeUndefined();
    });

    it('keeps working across repeated runs against the unchanged origin', async () => {
      await link();
      await writeFile(path.join(folder, 'a.md'), '# A');
      const { io } = collectIo();
      expect(await runPush({ folder, force: false, concurrency: 3 }, io)).toBe(0);
      await writeFile(path.join(folder, 'a.md'), '# A again');
      expect(await runPush({ folder, force: false, concurrency: 3 }, io)).toBe(0);
      expect(await runPush({ folder, force: false, concurrency: 3 }, io)).toBe(0);
    });

    // A push against a *local* endpoint is never refused for a stale pin,
    // whether or not the pin points somewhere else: loopback is exempt from
    // the pin comparison entirely (endpoint-trust.ts — it can never be the
    // spoofed-remote-host attack the pin exists to catch). Genuine
    // remote-to-remote repoint refusal is unit-tested directly against
    // assertEndpointTrusted in endpoint-trust.test.ts, which needs no live
    // connection to a real remote host.
    it('still pushes to a local endpoint despite a stale remote pin from an earlier link, and leaves that pin untouched', async () => {
      await link();
      await pinTrustedOrigin(folder, 'https://vorlyn.example.com');
      await writeFile(path.join(folder, 'a.md'), '# A');
      const { io } = collectIo();
      const code = await runPush({ folder, force: false, concurrency: 3 }, io);
      expect(code).toBe(0);
      expect(fake.state.documents.size).toBe(1);
      expect(await readTrustedOrigin(folder)).toBe('https://vorlyn.example.com');
    });

    it('the same holds with --force', async () => {
      await link();
      await pinTrustedOrigin(folder, 'https://vorlyn.example.com');
      await writeFile(path.join(folder, 'a.md'), '# A');
      const { io } = collectIo();
      const code = await runPush({ folder, force: true, concurrency: 3 }, io);
      expect(code).toBe(0);
      expect(fake.state.documents.size).toBe(1);
    });

    it('deleting a stale, irrelevant pin file by hand has no effect on a local push', async () => {
      await link();
      await pinTrustedOrigin(folder, 'https://vorlyn.example.com');
      await rm(endpointTrustPath(folder));
      await writeFile(path.join(folder, 'a.md'), '# A');
      const { io } = collectIo();
      expect(await runPush({ folder, force: false, concurrency: 3 }, io)).toBe(0);
      expect(await readTrustedOrigin(folder)).toBeUndefined();
    });
  });

  describe('partial-run durability', () => {
    /** Files are walked sorted, so a.md/b.md/c.md run in that order at concurrency 1. */
    async function threeFiles(): Promise<void> {
      await link();
      for (const name of ['a.md', 'b.md', 'c.md']) {
        await writeFile(path.join(folder, name), `# ${name}`);
      }
    }

    function stubClient(uploadDocument: VorlynMcpClient['uploadDocument']): VorlynMcpClient {
      return {
        listProjects: () => Promise.resolve(ok([])),
        createProject: () => Promise.resolve(ok({ id: '', name: '', color: '#6366f1' })),
        getDocument: () => Promise.resolve(ok({ id: '', title: '', versionSeq: 0, content: '' })),
        getDocumentStatus: () =>
          Promise.resolve(
            ok({ documentId: '', versionSeq: 1, contentHash: '', myPermission: 'edit' }),
          ),
        uploadDocument,
        // Unlimited headroom: these tests are about upload durability, not
        // the pre-flight warning — no ceiling means warnIfOverHeadroom is
        // always a no-op here.
        getOrgUsage: () =>
          Promise.resolve(ok({ tier: 'enterprise', activeDocCount: 0, maxActiveDocs: null })),
        close: () => Promise.resolve(),
      };
    }

    function depsWith(client: VorlynMcpClient): {
      deps: PushDeps;
      exits: number[];
      signals: EventEmitter;
    } {
      const exits: number[] = [];
      // A local emitter, not `process`: the interrupt path must be testable
      // without firing a real SIGINT into the test runner.
      const signals = new EventEmitter();
      return {
        deps: {
          exit: (code) => exits.push(code),
          connect: () => Promise.resolve(client),
          signals,
        },
        exits,
        signals,
      };
    }

    // Two reviewers hit this from two directions: a user's Ctrl-C, and the
    // Stop hook's timeout kill. The old handler called process.exit() straight
    // from the signal, so the finally that writes the manifest never ran and
    // every completed upload was re-created as a duplicate next run.
    it('writes the manifest for uploads that completed before a signal', async () => {
      await threeFiles();
      let uploads = 0;
      const signals = new EventEmitter();
      const client = stubClient(() => {
        uploads += 1;
        if (uploads === 2) signals.emit('SIGINT');
        return Promise.resolve(
          ok({ documentId: `doc_${String(uploads)}`, versionSeq: 1, deduplicated: false }),
        );
      });
      const exits: number[] = [];
      const deps: PushDeps = {
        exit: (code) => exits.push(code),
        connect: () => Promise.resolve(client),
        signals,
      };
      const { io, err } = collectIo();

      const code = await runPush({ folder, force: false, concurrency: 1 }, io, deps);

      expect(code).toBe(1);
      expect(exits).toEqual([1]);
      expect(err.join('\n')).toMatch(/Interrupt received/);
      expect(err.join('\n')).toMatch(/re-run "vorlyn push" to finish/);
      const manifest = await readManifest(folder);
      // a.md finished before the signal, b.md was in flight and allowed to
      // land; c.md was never started. All three states are recorded honestly.
      expect(Object.keys(manifest?.files ?? {}).sort()).toEqual(['a.md', 'b.md']);
      expect(uploads).toBe(2);
    });

    it('SIGTERM (the Stop-hook timeout kill) is handled the same way', async () => {
      await threeFiles();
      const signals = new EventEmitter();
      const client = stubClient(() => {
        signals.emit('SIGTERM');
        return Promise.resolve(ok({ documentId: 'doc_1', versionSeq: 1, deduplicated: false }));
      });
      const exits: number[] = [];
      const deps: PushDeps = {
        exit: (code) => exits.push(code),
        connect: () => Promise.resolve(client),
        signals,
      };
      const { io } = collectIo();
      await runPush({ folder, force: false, concurrency: 1 }, io, deps);
      expect(Object.keys((await readManifest(folder))?.files ?? {})).toEqual(['a.md']);
      // And the lock never outlives the interrupted run.
      await expect(stat(lockPath(folder))).rejects.toThrow();
      // The handler is unregistered on the way out — no listener leak.
      expect(signals.listenerCount('SIGTERM')).toBe(0);
      expect(signals.listenerCount('SIGINT')).toBe(0);
    });

    it('a second signal exits immediately with 130', async () => {
      await threeFiles();
      const signals = new EventEmitter();
      const client = stubClient(() => {
        signals.emit('SIGINT');
        signals.emit('SIGINT');
        return Promise.resolve(ok({ documentId: 'doc_1', versionSeq: 1, deduplicated: false }));
      });
      const exits: number[] = [];
      const deps: PushDeps = {
        exit: (code) => exits.push(code),
        connect: () => Promise.resolve(client),
        signals,
      };
      const { io } = collectIo();
      await runPush({ folder, force: false, concurrency: 1 }, io, deps);
      expect(exits).toContain(130);
    });

    it('--quiet keeps the interrupt notice off stderr but still saves progress', async () => {
      await threeFiles();
      const signals = new EventEmitter();
      const client = stubClient(() => {
        signals.emit('SIGINT');
        return Promise.resolve(ok({ documentId: 'doc_1', versionSeq: 1, deduplicated: false }));
      });
      const deps: PushDeps = {
        exit: () => undefined,
        connect: () => Promise.resolve(client),
        signals,
      };
      const { io, err } = collectIo();
      await runPush({ folder, force: false, concurrency: 1, quiet: true }, io, deps);
      expect(err.join('\n')).not.toMatch(/Interrupt received/);
      expect(Object.keys((await readManifest(folder))?.files ?? {})).toEqual(['a.md']);
    });

    // A rejecting callTool used to reject mapWithConcurrency's Promise.all,
    // discarding sibling workers' results — including uploads the server had
    // already accepted.
    it('a transport-level rejection on one file never loses the others', async () => {
      await threeFiles();
      const client = stubClient((input) => {
        if (input.content.includes('b.md')) {
          return Promise.reject(new Error('socket hang up'));
        }
        return Promise.resolve(
          ok({
            documentId: `doc_${input.content.slice(2, 3)}`,
            versionSeq: 1,
            deduplicated: false,
          }),
        );
      });
      const { deps } = depsWith(client);
      const { io, err } = collectIo();

      const code = await runPush({ folder, force: false, concurrency: 3 }, io, deps);

      expect(code).toBe(1);
      // Never the raw thrown message ("socket hang up") — it can carry
      // transport/server response content, so a transport-level rejection
      // with no errno collapses to a static code (packages/cli/src/push.ts,
      // `failureCode`).
      expect(err.join('\n')).toMatch(/failed .*b\.md: unknown_error/);
      expect(err.join('\n')).not.toMatch(/socket hang up/);
      expect(Object.keys((await readManifest(folder))?.files ?? {}).sort()).toEqual([
        'a.md',
        'c.md',
      ]);
    });

    it('reports a file deleted between the walk and the read as a failure, not a crash', async () => {
      await threeFiles();
      const client = stubClient((input) => {
        if (input.content.includes('a.md')) {
          // Vanishes mid-run, the way a `git checkout` would take it.
          return rm(path.join(folder, 'b.md')).then(() =>
            ok({ documentId: 'doc_a', versionSeq: 1, deduplicated: false }),
          );
        }
        return Promise.resolve(ok({ documentId: 'doc_c', versionSeq: 1, deduplicated: false }));
      });
      const { deps } = depsWith(client);
      const { io, err } = collectIo();

      const code = await runPush({ folder, force: false, concurrency: 1 }, io, deps);

      expect(code).toBe(1);
      expect(err.join('\n')).toMatch(/failed .*b\.md: ENOENT/);
      expect(Object.keys((await readManifest(folder))?.files ?? {}).sort()).toEqual([
        'a.md',
        'c.md',
      ]);
    });
  });

  // The bug this whole fix targets: `vorlyn link` run before `git init`
  // silently skips installing the commit-trigger hook, and nothing ever
  // pointed out the gap again once the folder became a git repo.
  describe('commit-trigger drift warning', () => {
    it('warns when the folder was linked before git init and never re-linked since', async () => {
      const { io: linkIo } = collectIo();
      expect(await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, linkIo)).toBe(0);
      await execFileAsync('git', ['init', '--quiet'], { cwd: folder });

      await writeFile(path.join(folder, 'a.md'), '# A');
      const { io, err } = collectIo();
      const code = await runPush({ folder, force: false, concurrency: 3 }, io);
      expect(code).toBe(0);
      expect(err.join('\n')).toMatch(/no git post-commit hook is installed/);
    });

    it('does not warn once a relink after git init actually installs the hook', async () => {
      const { io: linkIo } = collectIo();
      expect(await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, linkIo)).toBe(0);
      await execFileAsync('git', ['init', '--quiet'], { cwd: folder });
      expect(await runLink({ folder, endpoint: fake.url, projectId: 'proj_1' }, linkIo)).toBe(0);

      await writeFile(path.join(folder, 'a.md'), '# A');
      const { io, err } = collectIo();
      const code = await runPush({ folder, force: false, concurrency: 3 }, io);
      expect(code).toBe(0);
      expect(err.join('\n')).not.toMatch(/no git post-commit hook is installed/);
    });
  });

  // C1: the CLI never sent `path` at all, which is why every CLI-pushed
  // document rendered flat/pathless everywhere downstream (home page,
  // Cmd+K, the project tree) despite all of that machinery being built and
  // gated on `path !== null` since Phase 29.
  describe('path (Phase 29 backfill, C1)', () => {
    it('sends path equal to the POSIX-normalized repo-relative path for a new file', async () => {
      await link();
      await mkdir(path.join(folder, 'docs'), { recursive: true });
      await writeFile(path.join(folder, 'docs', 'a.md'), '# A');
      const { io } = collectIo();
      const code = await runPush({ folder, force: false, concurrency: 3 }, io);
      expect(code).toBe(0);
      const created = [...fake.state.documents.values()][0];
      expect(created?.path).toBe('docs/a.md');
    });

    it('also sends path when pushing an update to an already-tracked file (the backfill)', async () => {
      await writeFile(path.join(folder, 'tracked.md'), '# Tracked changed');
      await link({
        'tracked.md': { documentId: 'doc_tracked', contentHash: 'sha256:stale', versionSeq: 1 },
      });
      fake.state.documents.set('doc_tracked', {
        id: 'doc_tracked',
        title: 'Tracked',
        versionSeq: 1,
        content: '# Tracked',
        path: null, // exactly the pre-fix state: tracked but never got a path
      });
      const { io } = collectIo();
      const code = await runPush({ folder, force: false, concurrency: 3 }, io);
      expect(code).toBe(0);
      expect(fake.state.documents.get('doc_tracked')?.path).toBe('tracked.md');
    });

    // Newly reachable once pushes send `path`: the fake server's
    // 'taken/path.md' sentinel mirrors the real server's path_taken
    // rejection, which — unlike the tier-cap codes — never carries a
    // server-supplied `message`, so this proves push.ts's local
    // `PATH_FAILURE_MESSAGES` lookup is actually wired in, not just the
    // server-message pass-through the cap-exceeded test above already covers.
    it('renders friendly text for path_taken instead of the bare code', async () => {
      await link();
      await mkdir(path.join(folder, 'taken'), { recursive: true });
      await writeFile(path.join(folder, 'taken', 'path.md'), '# Taken');
      const { io, err } = collectIo();
      const code = await runPush({ folder, force: false, concurrency: 3 }, io);
      expect(code).toBe(1);
      expect(err.join('\n')).toContain(
        'Another document already exists at this path in the project',
      );
      expect(err.join('\n')).not.toMatch(/failed\s+.*: path_taken\s*$/m);
    });

    it('toPosixPath normalizes a platform-style (backslash) relative path to forward slashes', () => {
      expect(toPosixPath('docs\\specs\\auth.md')).toBe('docs/specs/auth.md');
      // Already-POSIX input is left untouched.
      expect(toPosixPath('docs/specs/auth.md')).toBe('docs/specs/auth.md');
    });
  });

  describe('org-usage pre-flight warning (Phase 33.D)', () => {
    it('warns before uploading when a batch would exceed the doc cap', async () => {
      await link();
      fake.state.orgUsage = { tier: 'free', activeDocCount: 98, maxActiveDocs: 100 };
      await writeFile(path.join(folder, 'a.md'), '# A');
      await writeFile(path.join(folder, 'b.md'), '# B');
      await writeFile(path.join(folder, 'c.md'), '# C');
      const { io, err, out } = collectIo();
      const code = await runPush({ folder, force: false, concurrency: 3 }, io);
      expect(code).toBe(0);
      expect(err.join('\n')).toMatch(/this push will attempt 3 new documents/);
      expect(err.join('\n')).toMatch(/98\/100/);
      // Printed before any per-file output, not interleaved.
      const warnIndex = err.findIndex((l) => l.includes('this push will attempt'));
      expect(warnIndex).toBe(0);
      expect(out.some((l) => l.startsWith('pushed'))).toBe(true);
    });

    it('never warns when there are no new files, and never calls get_org_usage', async () => {
      await link({
        'a.md': { documentId: 'doc_1', contentHash: sha256Hex(Buffer.from('# A')), versionSeq: 1 },
      });
      fake.state.orgUsage = { tier: 'free', activeDocCount: 100, maxActiveDocs: 100 };
      await writeFile(path.join(folder, 'a.md'), '# A');
      const { io, err } = collectIo();
      const code = await runPush({ folder, force: false, concurrency: 3 }, io);
      expect(code).toBe(0);
      expect(err.join('\n')).not.toMatch(/this push will attempt/);
      expect(fake.state.callCounts.get_org_usage ?? 0).toBe(0);
    });

    it('never warns when the batch stays within headroom', async () => {
      await link();
      fake.state.orgUsage = { tier: 'team', activeDocCount: 1, maxActiveDocs: 5_000 };
      await writeFile(path.join(folder, 'a.md'), '# A');
      const { io, err } = collectIo();
      const code = await runPush({ folder, force: false, concurrency: 3 }, io);
      expect(code).toBe(0);
      expect(err.join('\n')).not.toMatch(/this push will attempt/);
    });

    it('never warns on an unlimited tier (maxActiveDocs null)', async () => {
      await link();
      fake.state.orgUsage = { tier: 'enterprise', activeDocCount: 999_999, maxActiveDocs: null };
      await writeFile(path.join(folder, 'a.md'), '# A');
      const { io, err } = collectIo();
      const code = await runPush({ folder, force: false, concurrency: 3 }, io);
      expect(code).toBe(0);
      expect(err.join('\n')).not.toMatch(/this push will attempt/);
    });

    it('fails open: a get_org_usage error never blocks or fails the push', async () => {
      await link();
      fake.state.orgUsage = 'fail';
      await writeFile(path.join(folder, 'a.md'), '# A');
      const { io, err, out } = collectIo();
      const code = await runPush({ folder, force: false, concurrency: 3 }, io);
      expect(code).toBe(0);
      expect(err.join('\n')).not.toMatch(/this push will attempt/);
      expect(out.some((l) => l.startsWith('pushed'))).toBe(true);
    });

    it('is not suppressed by --quiet', async () => {
      await link();
      fake.state.orgUsage = { tier: 'free', activeDocCount: 100, maxActiveDocs: 100 };
      await writeFile(path.join(folder, 'a.md'), '# A');
      const { io, err, out } = collectIo();
      const code = await runPush({ folder, force: false, concurrency: 3, quiet: true }, io);
      expect(code).toBe(0);
      expect(err.join('\n')).toMatch(/this push will attempt 1 new document/);
      // --quiet still suppresses the routine per-file/summary lines.
      expect(out).toEqual([]);
    });
  });
});
