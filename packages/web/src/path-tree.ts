/**
 * Repo-path tree — pure transform from a flat list of documents (Phase 29's
 * `GET /projects/:id/tree` shape, or — Phase 34.C — the home lane's overview
 * shape) into a nested folder structure for `project-tree.tsx` and the home
 * lane's per-project grouping in `document-list.tsx`. Mirrors the testability
 * precedent of `outline.ts` (parseOutline) and the nested-node shape
 * precedent of `buildReplyTree` in `components/viewer.tsx`, but splits a
 * repo-relative `path` on `/` instead of following parent pointers.
 *
 * Generic over the doc shape (`TDoc`) since the two callers disagree on their
 * signal field: `ProjectTreeDocumentDto` carries `openCommentCount`, the home
 * lane's `OverviewDocumentDto` carries `open`/`resolved` instead. Callers
 * supply an accessor for the folder-level rollup; the common
 * `ProjectTreeDocumentDto` case has a zero-arg overload so existing callers
 * are unaffected.
 */

import type { ProjectTreeDocumentDto } from './api/client.js';

export interface PathTreeDoc {
  readonly id: string;
  readonly title: string;
  readonly path: string | null;
}

export interface TreeFolderNode<TDoc extends PathTreeDoc = ProjectTreeDocumentDto> {
  readonly kind: 'folder';
  readonly name: string;
  /** Full accumulated path from the project root, e.g. `docs/specs` — stable
   *  across renders, used as the collapse-state key. */
  readonly path: string;
  readonly folders: TreeFolderNode<TDoc>[];
  readonly docs: TDoc[];
  /** Sum of the per-doc open-comment accessor over every document nested
   *  under this folder, at any depth — the "review attention map" signal the
   *  tree renders. */
  readonly openCommentCount: number;
}

export interface PathTree<TDoc extends PathTreeDoc = ProjectTreeDocumentDto> {
  /**
   * Documents that don't belong to any folder: `path === null` (no repo
   * origin — a manually-uploaded doc) and single-segment paths (a file
   * sitting directly at the project root, e.g. `README.md`). Neither ever
   * gets a folder wrapper; both surface flat, at the top of the tree.
   */
  readonly rootDocs: TDoc[];
  readonly folders: TreeFolderNode<TDoc>[];
}

interface MutableFolder<TDoc extends PathTreeDoc> {
  name: string;
  path: string;
  folders: Map<string, MutableFolder<TDoc>>;
  docs: TDoc[];
}

function newFolder<TDoc extends PathTreeDoc>(name: string, path: string): MutableFolder<TDoc> {
  return { name, path, folders: new Map(), docs: [] };
}

function pathSegments(path: string | null): string[] {
  return path === null ? [] : path.split('/').filter((s) => s.length > 0);
}

/** True for a document that stays out of `folders` — no repo path, or a
 *  single-segment path sitting directly at the project root. Exported so
 *  callers that need to keep a doc's original ordering (the home lane's
 *  activity feed, which `buildPathTree`'s own alphabetical `rootDocs` sort
 *  would disturb) can split root-level docs out without re-deriving the
 *  segment rule. */
export function isRootLevelPath(path: string | null): boolean {
  return pathSegments(path).length <= 1;
}

function freeze<TDoc extends PathTreeDoc>(
  folder: MutableFolder<TDoc>,
  openCommentCountOf: (doc: TDoc) => number,
): TreeFolderNode<TDoc> {
  const folders = [...folder.folders.values()]
    .map((f) => freeze(f, openCommentCountOf))
    .sort((a, b) => a.name.localeCompare(b.name));
  const docs = [...folder.docs].sort((a, b) => a.title.localeCompare(b.title));
  const openCommentCount =
    folders.reduce((sum, f) => sum + f.openCommentCount, 0) +
    docs.reduce((sum, d) => sum + openCommentCountOf(d), 0);
  return { kind: 'folder', name: folder.name, path: folder.path, folders, docs, openCommentCount };
}

/** Common case: `ProjectTreeDocumentDto`'s own `openCommentCount` field is
 *  the rollup source, no accessor needed. */
export function buildPathTree(docs: readonly ProjectTreeDocumentDto[]): PathTree;
/** Generic case (Phase 34.C): any doc shape with `id`/`title`/`path`, plus
 *  how to read its open-comment count for the folder-level rollup. */
export function buildPathTree<TDoc extends PathTreeDoc>(
  docs: readonly TDoc[],
  openCommentCountOf: (doc: TDoc) => number,
): PathTree<TDoc>;
export function buildPathTree<TDoc extends PathTreeDoc>(
  docs: readonly TDoc[],
  openCommentCountOf: (doc: TDoc) => number = (d) => {
    const withCount = d as unknown as { openCommentCount?: number };
    return withCount.openCommentCount ?? 0;
  },
): PathTree<TDoc> {
  const rootDocs: TDoc[] = [];
  const root = newFolder<TDoc>('', '');

  for (const doc of docs) {
    const segments = pathSegments(doc.path);
    if (segments.length <= 1) {
      rootDocs.push(doc);
      continue;
    }
    let folder = root;
    let path = '';
    for (const seg of segments.slice(0, -1)) {
      path = path ? `${path}/${seg}` : seg;
      let next = folder.folders.get(seg);
      if (!next) {
        next = newFolder<TDoc>(seg, path);
        folder.folders.set(seg, next);
      }
      folder = next;
    }
    folder.docs.push(doc);
  }

  return {
    rootDocs: rootDocs.sort((a, b) => a.title.localeCompare(b.title)),
    folders: [...root.folders.values()]
      .map((f) => freeze(f, openCommentCountOf))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
