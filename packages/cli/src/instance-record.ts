import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isProcessAlive } from './process-alive.js';

const INSTANCE_FILENAME = 'instance.json';
/** How many times to re-try after stealing a stale record before giving up — same as `lock.ts`. */
const MAX_ATTEMPTS = 3;

export function instanceRecordPath(dataDir: string): string {
  return path.join(dataDir, INSTANCE_FILENAME);
}

/**
 * `<dataDir>/instance.json` — the one embedded Vorlyn instance a machine's
 * data directory can have running at a time. `owner` distinguishes a
 * `vorlyn serve` daemon (detached, survives the launching terminal closing)
 * from a `vorlyn open` foreground session (tied to that terminal, torn down
 * on its own Ctrl-C) — see `serve.ts` and `open.ts`'s attach/own-mode split.
 * `logFile` is present only for `owner: "serve"`; a `vorlyn open` session
 * inherits its children's stdio directly, so there is nothing to point at.
 */
export interface InstanceRecord {
  version: 1;
  state: 'starting' | 'running';
  owner: 'serve' | 'open';
  pid: number;
  apiPort?: number;
  mcpPort?: number;
  rootUrl?: string;
  mcpEndpoint?: string;
  startedAt: string;
  logFile?: string;
}

function isInstanceRecordShape(value: unknown): value is InstanceRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    (v.state === 'starting' || v.state === 'running') &&
    (v.owner === 'serve' || v.owner === 'open') &&
    typeof v.pid === 'number' &&
    typeof v.startedAt === 'string'
  );
}

/** Reads `<dataDir>/instance.json`; returns undefined when absent. Throws on a corrupt file — a
 *  corrupt instance record is worth surfacing loudly, unlike `folder-projects.ts`'s cache-only file. */
export async function readInstanceRecord(dataDir: string): Promise<InstanceRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(instanceRecordPath(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isInstanceRecordShape(parsed)) {
    throw new Error(`invalid instance record at ${instanceRecordPath(dataDir)}`);
  }
  return parsed;
}

async function writeInstanceRecord(dataDir: string, record: InstanceRecord): Promise<void> {
  await writeFile(instanceRecordPath(dataDir), `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * Acquires `<dataDir>/instance.json`, protecting one embedded instance from
 * racing another — same exclusive-create-then-steal-if-stale shape as
 * `lock.ts`'s `acquireLock` (`wx`-create → `EEXIST` → staleness check →
 * steal), sharing `process-alive.ts`'s pid check. A record held by a dead
 * pid is stolen automatically; one held by a live pid refuses.
 *
 * Returns the record written, which `releaseInstanceRecord` uses to prove
 * ownership before removing it.
 */
export async function acquireInstanceRecord(
  dataDir: string,
  init: { owner: InstanceRecord['owner']; pid: number; logFile?: string },
  isAlive: (pid: number) => boolean = isProcessAlive,
): Promise<InstanceRecord> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const record: InstanceRecord = {
      version: 1,
      state: 'starting',
      owner: init.owner,
      pid: init.pid,
      startedAt: new Date().toISOString(),
      ...(init.logFile ? { logFile: init.logFile } : {}),
    };
    try {
      await writeFile(instanceRecordPath(dataDir), `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const existing = await readInstanceRecord(dataDir);
    // Vanished between our failed create and this read — another process
    // released it (or its own steal is mid-flight); go straight back round.
    if (!existing) continue;
    if (isAlive(existing.pid)) {
      throw new InstanceConflictError(existing);
    }
    await rm(instanceRecordPath(dataDir), { force: true });
  }
  throw new Error(
    `could not acquire ${instanceRecordPath(dataDir)} after ${String(MAX_ATTEMPTS)} attempts`,
  );
}

/** A live instance already holds the record — surfaced so callers (`serve.ts`, `open.ts`) can
 *  each decide what "already running" means for them (attach vs. refuse). */
export class InstanceConflictError extends Error {
  constructor(public readonly existing: InstanceRecord) {
    super(
      `another vorlyn instance is running (pid ${String(existing.pid)}, owner ${existing.owner})`,
    );
    this.name = 'InstanceConflictError';
  }
}

/** Flips `state` to `running` and fills in the discovered ports/urls — called once
 *  `startLocalInstance` resolves. Only ever called by whichever process's own `acquireInstanceRecord`
 *  succeeded, so no separate ownership check is needed here (unlike `releaseInstanceRecord`). */
export async function markInstanceRunning(
  dataDir: string,
  record: InstanceRecord,
  info: { apiPort: number; mcpPort: number; rootUrl: string; mcpEndpoint: string },
): Promise<InstanceRecord> {
  const updated: InstanceRecord = { ...record, state: 'running', ...info };
  await writeInstanceRecord(dataDir, updated);
  return updated;
}

/**
 * Removes `<dataDir>/instance.json`, but only when it is still the one
 * `owned` describes — same guard as `releaseLock`, for the same reason: a
 * process whose stale record was stolen mid-run must not delete the live
 * holder's record on its way out.
 */
export async function releaseInstanceRecord(
  dataDir: string,
  owned?: InstanceRecord,
): Promise<void> {
  if (owned) {
    const existing = await readInstanceRecord(dataDir).catch(() => undefined);
    if (existing?.pid !== owned.pid || existing.startedAt !== owned.startedAt) return;
  }
  await rm(instanceRecordPath(dataDir), { force: true });
}

/**
 * The read-only "is a usable instance up?" check every caller actually
 * wants — `open.ts`'s attach/own-mode split, `serve.ts start`'s idempotency,
 * `vorlyn-ensure.sh`'s `serve status`. A record only counts when its pid is
 * genuinely alive *and* its MCP port answers `/readyz`: the pid supplies
 * identity (so a stale record left behind by a crash is never mistaken for
 * a live one), `/readyz` supplies health (so a process that's alive but
 * still mid-startup, or wedged, doesn't count as usable either).
 */
export async function liveInstance(
  dataDir: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
  fetchImpl: typeof fetch = fetch,
): Promise<InstanceRecord | undefined> {
  const record = await readInstanceRecord(dataDir);
  if (!record) return undefined;
  if (record.state !== 'running' || !record.mcpPort) return undefined;
  if (!isAlive(record.pid)) return undefined;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${String(record.mcpPort)}/readyz`);
    if (!res.ok) return undefined;
  } catch {
    return undefined;
  }
  return record;
}
