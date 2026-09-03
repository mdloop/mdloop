import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { vorlynDir, ensureVorlynDir } from './vorlyn-dir.js';

/**
 * `.vorlyn/credentials` — never in the manifest, never committed. The
 * "never committed" half is enforced, not just documented: every writer of
 * `.vorlyn/` routes through `ensureVorlynDir`, which guarantees the nested
 * `.gitignore` listing this file.
 */
export interface Credentials {
  apiKey: string;
}

const CREDENTIALS_FILENAME = 'credentials';

export function credentialsPath(folder: string): string {
  return path.join(vorlynDir(folder), CREDENTIALS_FILENAME);
}

export async function readCredentials(folder: string): Promise<Credentials | undefined> {
  let raw: string;
  try {
    raw = await readFile(credentialsPath(folder), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).apiKey !== 'string'
  ) {
    throw new Error(`invalid credentials file at ${credentialsPath(folder)}`);
  }
  return parsed as Credentials;
}

/**
 * Writes `.vorlyn/credentials` at mode 0600 regardless of the process umask.
 * The mode is passed to `writeFile` rather than chmod'd afterwards: a
 * write-then-chmod leaves the key readable at the umask default for however
 * long the two syscalls are apart.
 *
 * Note `writeFile`'s `mode` only applies at creation, so an existing file
 * that was somehow created over-permissively keeps its mode — but this
 * function is the only thing that ever creates it.
 */
export async function writeCredentials(folder: string, credentials: Credentials): Promise<void> {
  await ensureVorlynDir(folder);
  await writeFile(credentialsPath(folder), `${JSON.stringify(credentials, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * Resolution order: `VORLYN_API_KEY` env var, else `.vorlyn/credentials` in
 * the linked folder. Never resolved from the manifest.
 */
export async function resolveApiKey(
  folder: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const fromEnv = env.VORLYN_API_KEY;
  if (fromEnv) return fromEnv;
  const credentials = await readCredentials(folder);
  return credentials?.apiKey;
}

/**
 * Reads the admin API key `selfhost-embedded-main.ts` mints once, on the
 * boot that first creates the org, into `<dataDir>/bootstrap.json` — the
 * one credential a brand-new local instance has no other way to hand out
 * (there's no browser-driven login+settings-page flow the way a real
 * self-host deploy's admin would use). Both `vorlyn open` (unconditionally)
 * and `vorlyn link --autoProvision` (only against a local endpoint) fall
 * back to this when no other credential source has one.
 *
 * Best-effort, not a hard requirement: returns undefined on anything short
 * of a well-formed key (missing file, malformed JSON, wrong shape) rather
 * than throwing — callers decide what "no key available" means for them.
 */
export async function readLocalBootstrapApiKey(dataDir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path.join(dataDir, 'bootstrap.json'), 'utf8');
    const parsed = JSON.parse(raw) as { apiKey?: unknown };
    return typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined;
  } catch {
    return undefined;
  }
}
