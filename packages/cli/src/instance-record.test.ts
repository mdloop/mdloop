import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireInstanceRecord,
  InstanceConflictError,
  instanceRecordPath,
  liveInstance,
  markInstanceRunning,
  readInstanceRecord,
  releaseInstanceRecord,
} from './instance-record.js';
import type { InstanceRecord } from './instance-record.js';

describe('instance-record', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-instance-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('acquireInstanceRecord', () => {
    it('succeeds and returns the record when none exists', async () => {
      const record = await acquireInstanceRecord(dataDir, { owner: 'serve', pid: 123 });

      expect(record.owner).toBe('serve');
      expect(record.pid).toBe(123);
      expect(record.state).toBe('starting');
      const onDisk = JSON.parse(
        await readFile(instanceRecordPath(dataDir), 'utf8'),
      ) as InstanceRecord;
      expect(onDisk).toEqual(record);
    });

    it('throws InstanceConflictError carrying the existing record on a live-pid conflict', async () => {
      const existing = await acquireInstanceRecord(
        dataDir,
        { owner: 'serve', pid: 111 },
        () => true,
      );

      await expect(
        acquireInstanceRecord(dataDir, { owner: 'open', pid: 222 }, () => true),
      ).rejects.toBeInstanceOf(InstanceConflictError);

      try {
        await acquireInstanceRecord(dataDir, { owner: 'open', pid: 222 }, () => true);
        expect.unreachable('expected acquireInstanceRecord to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(InstanceConflictError);
        expect((error as InstanceConflictError).existing).toEqual(existing);
      }
    });

    it('steals a record held by a dead pid', async () => {
      const stale: InstanceRecord = {
        version: 1,
        state: 'running',
        owner: 'serve',
        pid: 999999,
        startedAt: 'x',
      };
      await writeFile(instanceRecordPath(dataDir), JSON.stringify(stale));

      const record = await acquireInstanceRecord(
        dataDir,
        { owner: 'serve', pid: process.pid },
        () => false,
      );

      expect(record.pid).toBe(process.pid);
      expect(record.state).toBe('starting');
      const onDisk = JSON.parse(
        await readFile(instanceRecordPath(dataDir), 'utf8'),
      ) as InstanceRecord;
      expect(onDisk.pid).toBe(process.pid);
    });

    // MAX_ATTEMPTS exhaustion (every one of 3 attempts racing a live steal) would
    // need to fake writeFile's EEXIST/rm race deterministically across attempts —
    // not practically reachable through this function's public isAlive seam alone,
    // so it's intentionally not covered here.
  });

  describe('readInstanceRecord', () => {
    it('returns undefined when absent', async () => {
      expect(await readInstanceRecord(dataDir)).toBeUndefined();
    });

    it('throws on a shape missing required fields (startedAt)', async () => {
      await writeFile(
        instanceRecordPath(dataDir),
        JSON.stringify({ version: 1, state: 'running', owner: 'serve', pid: 1 }),
      );

      await expect(readInstanceRecord(dataDir)).rejects.toThrow();
    });

    it('throws on a shape missing pid', async () => {
      await writeFile(
        instanceRecordPath(dataDir),
        JSON.stringify({ version: 1, state: 'running', owner: 'serve', startedAt: 'x' }),
      );

      await expect(readInstanceRecord(dataDir)).rejects.toThrow();
    });

    it('throws when state is outside its literal union', async () => {
      await writeFile(
        instanceRecordPath(dataDir),
        JSON.stringify({ version: 1, state: 'paused', owner: 'serve', pid: 1, startedAt: 'x' }),
      );

      await expect(readInstanceRecord(dataDir)).rejects.toThrow();
    });

    it('throws when owner is outside its literal union', async () => {
      await writeFile(
        instanceRecordPath(dataDir),
        JSON.stringify({ version: 1, state: 'running', owner: 'nobody', pid: 1, startedAt: 'x' }),
      );

      await expect(readInstanceRecord(dataDir)).rejects.toThrow();
    });
  });

  describe('markInstanceRunning', () => {
    it('flips state to running and merges in the ports/urls; round-trips through readInstanceRecord', async () => {
      const record = await acquireInstanceRecord(dataDir, { owner: 'serve', pid: process.pid });

      const updated = await markInstanceRunning(dataDir, record, {
        apiPort: 4000,
        mcpPort: 4001,
        rootUrl: 'http://127.0.0.1:4000',
        mcpEndpoint: 'http://127.0.0.1:4001/mcp',
      });

      expect(updated.state).toBe('running');
      expect(updated.apiPort).toBe(4000);
      expect(updated.mcpPort).toBe(4001);
      expect(updated.rootUrl).toBe('http://127.0.0.1:4000');
      expect(updated.mcpEndpoint).toBe('http://127.0.0.1:4001/mcp');
      expect(await readInstanceRecord(dataDir)).toEqual(updated);
    });
  });

  describe('releaseInstanceRecord', () => {
    it('removes the file when owned matches what is on disk', async () => {
      const record = await acquireInstanceRecord(dataDir, { owner: 'serve', pid: process.pid });

      await releaseInstanceRecord(dataDir, record);

      expect(await readInstanceRecord(dataDir)).toBeUndefined();
    });

    it('is a no-op when owned pid/startedAt do not match what is currently on disk (a stolen-then-original-exits race)', async () => {
      const mine = await acquireInstanceRecord(dataDir, { owner: 'serve', pid: process.pid });
      const stolen: InstanceRecord = {
        version: 1,
        state: 'starting',
        owner: 'serve',
        pid: 555,
        startedAt: 'later',
      };
      await writeFile(instanceRecordPath(dataDir), JSON.stringify(stolen));

      await releaseInstanceRecord(dataDir, mine);

      expect(await readInstanceRecord(dataDir)).toEqual(stolen);
    });

    it('removes unconditionally when called with no owned argument', async () => {
      await acquireInstanceRecord(dataDir, { owner: 'serve', pid: process.pid });

      await releaseInstanceRecord(dataDir);

      expect(await readInstanceRecord(dataDir)).toBeUndefined();
    });
  });

  describe('liveInstance', () => {
    it('returns undefined when no record exists', async () => {
      expect(await liveInstance(dataDir, () => true)).toBeUndefined();
    });

    it('returns undefined when the pid is not alive', async () => {
      const record = await acquireInstanceRecord(dataDir, { owner: 'serve', pid: process.pid });
      await markInstanceRunning(dataDir, record, {
        apiPort: 1,
        mcpPort: 2,
        rootUrl: 'http://127.0.0.1:1',
        mcpEndpoint: 'http://127.0.0.1:2/mcp',
      });

      expect(await liveInstance(dataDir, () => false)).toBeUndefined();
    });

    it('returns undefined when state is still starting', async () => {
      await acquireInstanceRecord(dataDir, { owner: 'serve', pid: process.pid });

      expect(await liveInstance(dataDir, () => true)).toBeUndefined();
    });

    it('returns undefined when mcpPort is absent even though state is running', async () => {
      const record = await acquireInstanceRecord(dataDir, { owner: 'serve', pid: process.pid });
      const forcedRunningNoPort: InstanceRecord = { ...record, state: 'running' };
      await writeFile(instanceRecordPath(dataDir), JSON.stringify(forcedRunningNoPort));

      expect(await liveInstance(dataDir, () => true)).toBeUndefined();
    });

    it('returns undefined when fetch throws', async () => {
      const record = await acquireInstanceRecord(dataDir, { owner: 'serve', pid: process.pid });
      await markInstanceRunning(dataDir, record, {
        apiPort: 1,
        mcpPort: 2,
        rootUrl: 'http://127.0.0.1:1',
        mcpEndpoint: 'http://127.0.0.1:2/mcp',
      });
      const throwingFetch = (() =>
        Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;

      expect(await liveInstance(dataDir, () => true, throwingFetch)).toBeUndefined();
    });

    it('returns undefined when fetch resolves with res.ok === false', async () => {
      const record = await acquireInstanceRecord(dataDir, { owner: 'serve', pid: process.pid });
      await markInstanceRunning(dataDir, record, {
        apiPort: 1,
        mcpPort: 2,
        rootUrl: 'http://127.0.0.1:1',
        mcpEndpoint: 'http://127.0.0.1:2/mcp',
      });
      const notOkFetch = (() => Promise.resolve({ ok: false })) as unknown as typeof fetch;

      expect(await liveInstance(dataDir, () => true, notOkFetch)).toBeUndefined();
    });

    it('returns the record when pid is alive, state is running, and fetch reports ok', async () => {
      const record = await acquireInstanceRecord(dataDir, { owner: 'serve', pid: process.pid });
      const updated = await markInstanceRunning(dataDir, record, {
        apiPort: 1,
        mcpPort: 2,
        rootUrl: 'http://127.0.0.1:1',
        mcpEndpoint: 'http://127.0.0.1:2/mcp',
      });
      const okFetch = (() => Promise.resolve({ ok: true })) as unknown as typeof fetch;

      expect(await liveInstance(dataDir, () => true, okFetch)).toEqual(updated);
    });
  });
});
