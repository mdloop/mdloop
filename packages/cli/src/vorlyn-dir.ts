import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const VORLYN_DIRNAME = '.vorlyn';
const GITIGNORE_FILENAME = '.gitignore';

/**
 * Everything in `.vorlyn/` that is per-machine, per-developer, or a live
 * secret. The rest of `.vorlyn/` — `manifest.json`, `config.json`, and this
 * `.gitignore` itself — is committed on purpose so teammates inherit the link
 * on clone.
 */
const IGNORED_ENTRIES = ['credentials', '.lock', 'endpoint-trust.json'];

const GITIGNORE_HEADER = [
  '# Managed by the vorlyn CLI. Local, per-machine state — never commit these.',
  '# manifest.json and config.json ARE committed, deliberately.',
];

export function vorlynDir(folder: string): string {
  return path.join(folder, VORLYN_DIRNAME);
}

export function vorlynGitignorePath(folder: string): string {
  return path.join(vorlynDir(folder), GITIGNORE_FILENAME);
}

/**
 * Creates `.vorlyn/` and guarantees the nested `.gitignore` that keeps
 * `credentials` (an API key in plaintext), the lock file, and the endpoint
 * trust pin out of git. Nested rather than a root-`.gitignore` edit: scoped
 * correctly, and it never touches a file the repo owns.
 *
 * Called from every writer of `.vorlyn/` rather than from `link` alone, so
 * there is no ordering in which the directory exists without its ignore file.
 * Merges into an existing file instead of clobbering it.
 */
export async function ensureVorlynDir(folder: string): Promise<void> {
  await mkdir(vorlynDir(folder), { recursive: true });
  await ensureVorlynGitignore(folder);
}

export async function ensureVorlynGitignore(folder: string): Promise<void> {
  const file = vorlynGitignorePath(folder);
  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const present = new Set(current.split('\n').map((line) => line.trim()));
  const missing = IGNORED_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length === 0) return;

  if (current === '') {
    await writeFile(file, `${[...GITIGNORE_HEADER, ...missing].join('\n')}\n`, 'utf8');
    return;
  }
  const separator = current.endsWith('\n') ? '' : '\n';
  await writeFile(file, `${current}${separator}${missing.join('\n')}\n`, 'utf8');
}
