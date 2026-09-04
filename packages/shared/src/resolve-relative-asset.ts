import { stat } from 'node:fs/promises';

/**
 * Node-only, despite living in `shared` alongside the wire-level DTO types —
 * both `@mdloop/api` (`serve-web-spa.ts`'s `webDistDir()`) and `@mdloop/cli`
 * (`local-instance.ts`'s embedded-entrypoint lookup) need the exact same
 * idiom: "this asset lives at one of a few possible relative paths,
 * depending on whether we're running from an npm-installed tarball or
 * inside this monorepo (built or unbuilt) — try each, in order, and fail
 * loud naming every path tried if none exist." One shared implementation
 * beats two hand-rolled loops that would drift.
 *
 * Safe for `@mdloop/web` too: it is a plain function export, never
 * side-effectful at module load, and `web` does not currently import
 * anything from this package's runtime surface (only `result.ts`/DTOs would
 * be reachable), so this adds no `node:fs` footprint to a browser bundle
 * that doesn't already pull it in.
 */
export async function firstExistingRelative(
  candidates: readonly string[],
  label: string,
  exists: (candidate: string) => Promise<boolean> = pathExists,
): Promise<string> {
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(
    `Could not find ${label}. Tried:\n${candidates.map((c) => `  - ${c}`).join('\n')}`,
  );
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}
