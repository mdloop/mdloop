import { readdir } from 'node:fs/promises';
import path from 'node:path';

const IGNORED_DIRS = new Set(['node_modules', '.git', '.mdloop']);

/**
 * Recursively finds `*.md` files under `root`, skipping `node_modules`,
 * `.git`, and `.mdloop`. Returns paths relative to `root`, sorted — not a
 * full gitignore parser, just a reasonable ignore list.
 *
 * Deliberately walks straight through a nested `.mdloop/`-linked
 * subdirectory rather than treating it as a boundary: a doc legitimately
 * wanting review in two places at once (e.g. an internal project and a
 * separate, narrower distribution project living in the same repo) is a
 * real, supported setup — each linked root tracks and pushes its own copy as
 * an independent document.
 */
export async function walkMarkdownFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  await walk(root, root, results);
  return results.sort();
}

async function walk(root: string, dir: string, results: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walk(root, path.join(dir, entry.name), results);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(path.relative(root, path.join(dir, entry.name)));
    }
  }
}
