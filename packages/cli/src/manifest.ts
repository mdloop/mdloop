import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { vorlynDir, ensureVorlynDir } from './vorlyn-dir.js';

export { vorlynDir };

/** Per-file tracking state persisted in `.vorlyn/manifest.json`. */
export interface ManifestFileEntry {
  documentId: string;
  contentHash: string;
  versionSeq: number;
}

/**
 * `.vorlyn/manifest.json` — safe to commit. Contains
 * no credentials: the server resolves org/permissions from the API key
 * (RLS), never from client-supplied ids, so a stale or tampered manifest
 * carries no cross-tenant risk.
 *
 * `endpoint` is the one field a poisoned commit could weaponise (it is where
 * the API key gets sent), so it is never trusted on its own — see
 * `endpoint-trust.ts` for the scheme guard and the trust-on-first-use pin.
 */
export interface Manifest {
  endpoint: string;
  projectId: string;
  files: Record<string, ManifestFileEntry>;
}

const MANIFEST_FILENAME = 'manifest.json';

export function manifestPath(folder: string): string {
  return path.join(vorlynDir(folder), MANIFEST_FILENAME);
}

/** Reads `.vorlyn/manifest.json`; returns undefined when the folder isn't linked. */
export async function readManifest(folder: string): Promise<Manifest | undefined> {
  let raw: string;
  try {
    raw = await readFile(manifestPath(folder), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isManifestShape(parsed)) {
    throw new Error(`invalid manifest at ${manifestPath(folder)}`);
  }
  return parsed;
}

export async function writeManifest(folder: string, manifest: Manifest): Promise<void> {
  await ensureVorlynDir(folder);
  await writeFile(manifestPath(folder), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function isManifestShape(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.endpoint === 'string' &&
    typeof v.projectId === 'string' &&
    typeof v.files === 'object' &&
    v.files !== null
  );
}
