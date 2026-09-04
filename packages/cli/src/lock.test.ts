import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, LockConflictError, lockPath, releaseLock } from './lock.js';
import type { LockInfo } from './lock.js';

describe('lock', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-lock-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('acquires when no lock file exists, writing our own pid', async () => {
    await acquireLock(folder);
    const raw = await readFile(lockPath(folder), 'utf8');
    const info = JSON.parse(raw) as LockInfo;
    expect(info.pid).toBe(process.pid);
    expect(typeof info.startedAt).toBe('string');
  });

  it('steals a lock held by a dead pid', async () => {
    await mkdir(path.join(folder, '.mdloop'), { recursive: true });
    await writeFile(lockPath(folder), JSON.stringify({ pid: 999999, startedAt: 'x' }));
    await acquireLock(folder, () => false);
    const raw = await readFile(lockPath(folder), 'utf8');
    expect((JSON.parse(raw) as LockInfo).pid).toBe(process.pid);
  });

  it('refuses a lock held by a live pid', async () => {
    await mkdir(path.join(folder, '.mdloop'), { recursive: true });
    await writeFile(lockPath(folder), JSON.stringify({ pid: 123, startedAt: 'x' }));
    await expect(acquireLock(folder, () => true)).rejects.toBeInstanceOf(LockConflictError);
    // Refusal must not clobber the existing lock file.
    const raw = await readFile(lockPath(folder), 'utf8');
    expect((JSON.parse(raw) as LockInfo).pid).toBe(123);
  });

  it('release removes the lock file and is a no-op when absent', async () => {
    await acquireLock(folder);
    await releaseLock(folder);
    await expect(readFile(lockPath(folder), 'utf8')).rejects.toThrow();
    await expect(releaseLock(folder)).resolves.toBeUndefined();
  });

  // Read-check-write let two near-simultaneous pushes (a Stop hook firing
  // beside a manual push) both see an empty folder and both proceed.
  it('lets exactly one of two concurrent acquires win', async () => {
    const settled = await Promise.allSettled([acquireLock(folder), acquireLock(folder)]);
    const won = settled.filter((r) => r.status === 'fulfilled');
    const lost = settled.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(LockConflictError);
  });

  it('retries after stealing a stale lock rather than giving up', async () => {
    await mkdir(path.join(folder, '.mdloop'), { recursive: true });
    await writeFile(lockPath(folder), JSON.stringify({ pid: 999999, startedAt: 'x' }));
    const info = await acquireLock(folder, () => false);
    expect(info.pid).toBe(process.pid);
    const onDisk = JSON.parse(await readFile(lockPath(folder), 'utf8')) as LockInfo;
    expect(onDisk.startedAt).toBe(info.startedAt);
  });

  it('returns the lock info it wrote', async () => {
    const info = await acquireLock(folder);
    const onDisk = JSON.parse(await readFile(lockPath(folder), 'utf8')) as LockInfo;
    expect(onDisk).toEqual(info);
  });

  // After a steal, the previous holder must not delete the new holder's lock.
  it('release leaves a lock it does not own alone', async () => {
    const mine = await acquireLock(folder);
    await writeFile(lockPath(folder), JSON.stringify({ pid: process.pid, startedAt: 'later' }));
    await releaseLock(folder, mine);
    const onDisk = JSON.parse(await readFile(lockPath(folder), 'utf8')) as LockInfo;
    expect(onDisk.startedAt).toBe('later');
  });

  it('release removes a lock it does own', async () => {
    const mine = await acquireLock(folder);
    await releaseLock(folder, mine);
    await expect(readFile(lockPath(folder), 'utf8')).rejects.toThrow();
  });

  it('release is a no-op when the owned lock is already gone', async () => {
    const mine = await acquireLock(folder);
    await releaseLock(folder, mine);
    await expect(releaseLock(folder, mine)).resolves.toBeUndefined();
  });
});
