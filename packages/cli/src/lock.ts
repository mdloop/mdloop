import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { vorlynDir, ensureVorlynDir } from './vorlyn-dir.js';
import { isProcessAlive } from './process-alive.js';

export interface LockInfo {
  pid: number;
  startedAt: string;
}

export function lockPath(folder: string): string {
  return path.join(vorlynDir(folder), '.lock');
}

export class LockConflictError extends Error {
  constructor(pid: number) {
    super(`another vorlyn process is running (pid ${String(pid)})`);
    this.name = 'LockConflictError';
  }
}

/** How many times to re-try after stealing a stale lock before giving up. */
const MAX_ATTEMPTS = 3;

/**
 * Acquires `.vorlyn/.lock`, protecting one `push` from racing another.
 * A lock held by a dead pid is stolen automatically
 * (the previous process crashed); a lock held by a live pid refuses.
 *
 * The acquire primitive is an exclusive create (`flag: 'wx'`), not
 * read-then-write: the Stop hook can fire within milliseconds of a manual
 * push, and a check-then-act pair lets both observe an empty folder and both
 * proceed. Only an `EEXIST` falls through to the staleness check, which is
 * the one place a read is legitimate.
 *
 * Returns the lock info written, which `releaseLock` uses to prove ownership.
 */
export async function acquireLock(
  folder: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
): Promise<LockInfo> {
  await ensureVorlynDir(folder);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const info: LockInfo = { pid: process.pid, startedAt: new Date().toISOString() };
    try {
      await writeFile(lockPath(folder), JSON.stringify(info), { flag: 'wx' });
      return info;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const existing = await readLock(folder);
    // Vanished between our failed create and this read — another process
    // released it; go straight back round and try to claim it.
    if (!existing) continue;
    if (isAlive(existing.pid)) throw new LockConflictError(existing.pid);
    await rm(lockPath(folder), { force: true });
  }
  throw new Error(`could not acquire ${lockPath(folder)} after ${String(MAX_ATTEMPTS)} attempts`);
}

/**
 * Removes `.vorlyn/.lock`, but only when it is still the one `owned` describes.
 * Without that check a process whose stale lock was stolen mid-run would
 * delete the live holder's lock on its way out.
 */
export async function releaseLock(folder: string, owned?: LockInfo): Promise<void> {
  if (owned) {
    const existing = await readLock(folder).catch(() => undefined);
    if (existing?.pid !== owned.pid || existing.startedAt !== owned.startedAt) return;
  }
  await rm(lockPath(folder), { force: true });
}

async function readLock(folder: string): Promise<LockInfo | undefined> {
  try {
    const raw = await readFile(lockPath(folder), 'utf8');
    return JSON.parse(raw) as LockInfo;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
