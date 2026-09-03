import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isProcessAlive } from './process-alive.js';

const MAPPING_FILENAME = 'projects.json';
const LOCK_SUFFIX = '.lock';
/** How many times to re-try after stealing a stale lock before giving up — same as `lock.ts`. */
const MAX_ATTEMPTS = 3;

export function folderProjectsPath(dataDir: string): string {
  return path.join(dataDir, MAPPING_FILENAME);
}

/** One folder's remembered project, keyed by the folder's realpath in `FolderProjectsFile.folders`. */
export interface FolderProjectEntry {
  projectId: string;
  projectName: string;
  /** Compared on reuse — a mapping made against one server is never reused against another
   *  (a local instance today, a different local instance tomorrow, or a remote one entirely). */
  endpointOrigin: string;
  linkedAt: string;
}

export interface FolderProjectsFile {
  version: 1;
  folders: Record<string, FolderProjectEntry>;
}

/** A fresh empty file every call — never a shared constant. Every caller (`recordFolderProject`
 *  chief among them) mutates the `.folders` map it gets back in place; a single shared object
 *  here would silently accumulate every "file didn't exist yet" write from every distinct
 *  `dataDir` this process ever touches into one another. */
function emptyFile(): FolderProjectsFile {
  return { version: 1, folders: {} };
}

function isFolderProjectsShape(value: unknown): value is FolderProjectsFile {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && typeof v.folders === 'object' && v.folders !== null;
}

/**
 * Reads `<dataDir>/projects.json`. Corruption is non-fatal — this file is a
 * cache, `.vorlyn/manifest.json` stays the source of truth for any folder
 * that's actually linked — so an unparseable or wrong-version file is
 * treated as empty rather than thrown. A genuinely missing file is the same
 * "start empty" case, not a distinct one.
 */
export async function readFolderProjects(dataDir: string): Promise<FolderProjectsFile> {
  let raw: string;
  try {
    raw = await readFile(folderProjectsPath(dataDir), 'utf8');
  } catch {
    return emptyFile();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isFolderProjectsShape(parsed)) return emptyFile();
    return parsed;
  } catch {
    return emptyFile();
  }
}

/** Atomic write: temp file + rename, so a crash mid-write never leaves truncated JSON behind. */
async function writeFolderProjects(dataDir: string, file: FolderProjectsFile): Promise<void> {
  const finalPath = folderProjectsPath(dataDir);
  const tmpPath = `${finalPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmpPath, finalPath);
}

/**
 * Canonicalizes a folder path for use as a `projects.json` key — `realpath`
 * where possible (macOS's `/tmp` → `/private/tmp` is the case that would
 * otherwise silently miss every mapping), falling back to a plain resolve
 * when the folder doesn't exist yet (`realpath` throws ENOENT; a caller
 * building a mapping for a folder it hasn't created yet is legitimate).
 * Deliberately not case-folded: HFS+ case-insensitivity is real, but folding
 * risks collapsing genuinely distinct directories on a case-sensitive
 * volume, which is the worse failure of the two.
 */
export async function canonicalFolderKey(folder: string): Promise<string> {
  try {
    return await realpath(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(folder);
    throw error;
  }
}

async function withFolderProjectsLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${folderProjectsPath(dataDir)}${LOCK_SUFFIX}`;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      await writeFile(lockPath, `${String(process.pid)}\n`, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const held = await readFile(lockPath, 'utf8').catch(() => undefined);
      const pid = held ? Number.parseInt(held.trim(), 10) : NaN;
      if (Number.isInteger(pid) && isProcessAlive(pid)) {
        // Held by a live process racing us for the same folder's first-ever
        // mapping — brief, bounded backoff and retry rather than refuse
        // outright: unlike `lock.ts`'s push lock (one folder, one owner),
        // this lock only ever guards a few milliseconds of read-modify-write
        // across *different* folders sharing one machine-wide file.
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      await rm(lockPath, { force: true });
      continue;
    }
    try {
      return await fn();
    } finally {
      await rm(lockPath, { force: true });
    }
  }
  throw new Error(`could not acquire ${lockPath} after ${String(MAX_ATTEMPTS)} attempts`);
}

/** Looks up a folder's remembered project, if the mapping's recorded endpoint origin still matches. */
export async function lookupFolderProject(
  dataDir: string,
  folder: string,
  endpointOrigin: string,
): Promise<FolderProjectEntry | undefined> {
  const key = await canonicalFolderKey(folder);
  const file = await readFolderProjects(dataDir);
  const entry = file.folders[key];
  if (entry?.endpointOrigin !== endpointOrigin) return undefined;
  return entry;
}

/** Records (or overwrites) a folder's project mapping, lock-guarded against a concurrent writer
 *  recording a *different* folder's first-ever mapping at the same moment. */
export async function recordFolderProject(
  dataDir: string,
  folder: string,
  entry: FolderProjectEntry,
): Promise<void> {
  const key = await canonicalFolderKey(folder);
  await withFolderProjectsLock(dataDir, async () => {
    const file = await readFolderProjects(dataDir);
    file.folders[key] = entry;
    await writeFolderProjects(dataDir, file);
  });
}

/** Every folder this data directory has ever auto-linked — `vorlyn projects list`'s data source. */
export async function listFolderProjects(
  dataDir: string,
): Promise<(FolderProjectEntry & { folder: string })[]> {
  const file = await readFolderProjects(dataDir);
  return Object.entries(file.folders)
    .map(([folder, entry]) => ({ folder, ...entry }))
    .sort((a, b) => a.linkedAt.localeCompare(b.linkedAt));
}
