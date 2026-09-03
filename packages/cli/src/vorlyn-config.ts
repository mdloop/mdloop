import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { vorlynDir, ensureVorlynDir } from './vorlyn-dir.js';

/**
 * Which event owns the push for this repo.
 *
 * `commit` is the default: a git post-commit hook fires regardless of which coding agent or
 * editor made the change, so it is the only trigger that works for every
 * harness without a per-harness adapter. `agent-turn` is the opt-in
 * Claude-Code-specific enhancement — the plugin's `Stop` hook pushes once per
 * agent turn for people who want per-turn freshness.
 */
export type Trigger = 'commit' | 'agent-turn';

/** Parsed shape of `.vorlyn/config.json` this CLI cares about. */
export interface VorlynConfig {
  trigger: Trigger;
}

const CONFIG_FILENAME = 'config.json';

export function vorlynConfigPath(folder: string): string {
  return path.join(vorlynDir(folder), CONFIG_FILENAME);
}

/**
 * Seeds `.vorlyn/config.json` with a trigger — **only when the file does not
 * already exist**.
 *
 * Deliberately not a merge (unlike `ensureVorlynGitignore`, which has to merge
 * because it owns specific lines in a file the repo may also use). This file
 * is user-owned the moment it exists: a team that hand-set `agent-turn`, or
 * added include globs the hooks read, keeps every byte of it across relinks.
 * `vorlyn link --trigger ...` on a repo that already has a config is a no-op by
 * design; editing the file is the way to change it.
 */
export async function ensureVorlynConfig(folder: string, trigger: Trigger): Promise<void> {
  try {
    await readFile(vorlynConfigPath(folder), 'utf8');
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await ensureVorlynDir(folder);
  await writeFile(vorlynConfigPath(folder), `${JSON.stringify({ trigger }, null, 2)}\n`, 'utf8');
}

/**
 * Reads `.vorlyn/config.json` and resolves the trigger, tolerantly.
 *
 * Mirrors the fallback `claude-plugin/hooks/vorlyn-sync.sh` already applies
 * (its own comment: "config.json with no `trigger` field, or none at all:
 * they get the new default"): only the literal string `'agent-turn'` opts out
 * of the `'commit'` default. A missing key, a wrong-typed value, `'commit'`
 * itself, or outright garbage — all resolve to `'commit'`, never a thrown
 * error. That tolerance matters because, per `ensureVorlynConfig`'s own doc
 * comment, this file is user-owned the moment it exists: other fields (include
 * globs the hooks read) can live in it, and this reader has no business
 * rejecting a file just because it doesn't recognize every field. Only a
 * genuinely malformed JSON document is allowed to throw, same as `readManifest`.
 *
 * Returns undefined when the file does not exist at all, same ENOENT-tolerant
 * pattern as `readManifest`.
 */
export async function readVorlynConfig(folder: string): Promise<VorlynConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(vorlynConfigPath(folder), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  const trigger =
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as Record<string, unknown>).trigger === 'agent-turn'
      ? 'agent-turn'
      : 'commit';
  return { trigger };
}
