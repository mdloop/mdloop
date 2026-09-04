/**
 * Collapsed folder paths, keyed by project id (or `'unfiled'` for the home
 * lane's ungrouped bucket, Phase 34.C) — shared between the sidebar/switcher
 * tree (`project-tree.tsx`) and the home lane's inline per-project folder
 * nesting (`document-list.tsx`) so collapsing a folder in one place stays
 * collapsed in the other. `'unfiled'` never collides with a real project id
 * (those are UUIDs).
 */
export const TREE_COLLAPSE_STORAGE_KEY = 'mdloop-tree-collapsed';

export type CollapsedByGroup = Record<string, string[]>;

export function loadCollapsedTreeState(): CollapsedByGroup {
  const stored = localStorage.getItem(TREE_COLLAPSE_STORAGE_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored) as CollapsedByGroup;
  } catch {
    return {};
  }
}
