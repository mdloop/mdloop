import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * `<dataDir>/config.json` — the one piece of state `mdloop open` needs across
 * runs that isn't the database itself: a stable session secret (so a restart
 * doesn't invalidate every open browser session) and the admin identity
 * `selfhost-embedded-main.ts` bootstraps on first boot (same defaults
 * `selfhost-main.ts` itself uses: `admin@localhost` / `Admin`).
 *
 * Lives in the platform data directory (`data-dir.ts`), never in the linked
 * folder — unlike `.mdloop/manifest.json`/`credentials`, this is instance
 * state, not per-folder state, and a data directory backs every folder
 * `mdloop open` is ever pointed at from this machine.
 */
export interface LocalConfig {
  readonly sessionSecret: string;
  readonly adminEmail: string;
  readonly adminName: string;
}

const CONFIG_FILENAME = 'config.json';

export function localConfigPath(dataDir: string): string {
  return path.join(dataDir, CONFIG_FILENAME);
}

function isLocalConfigShape(value: unknown): value is LocalConfig {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionSecret === 'string' &&
    typeof v.adminEmail === 'string' &&
    typeof v.adminName === 'string'
  );
}

/**
 * Idempotent: reads `<dataDir>/config.json` if it already exists (from a
 * prior `mdloop open` run against this data directory), otherwise generates
 * one — `randomBytes(32).toString('base64url')` for the session secret,
 * matching `configFromEnv`'s `SESSION_SECRET` minimum-length requirement
 * (32+ chars) with room to spare — and persists it at mode 0600 (same
 * "secret file, only this user can read it" convention as
 * `credentials.ts`'s `.mdloop/credentials`).
 *
 * A session secret that changed on every run would invalidate every open
 * browser session each time `mdloop open` restarted — the entire reason this
 * is written once and reused, not regenerated per boot the way
 * `selfhost-main.ts`'s own `SESSION_SECRET` env var would be for a real
 * deployment (there, it's the operator's job to keep it stable across
 * redeploys; here, nobody but this file is responsible for that).
 */
export async function loadOrCreateLocalConfig(dataDir: string): Promise<LocalConfig> {
  try {
    const raw = await readFile(localConfigPath(dataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isLocalConfigShape(parsed)) {
      throw new Error(`invalid local config at ${localConfigPath(dataDir)}`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const config: LocalConfig = {
    sessionSecret: randomBytes(32).toString('base64url'),
    adminEmail: 'admin@localhost',
    adminName: 'Admin',
  };
  await writeFile(localConfigPath(dataDir), `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return config;
}
