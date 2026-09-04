import { useEffect, useRef, useState } from 'react';
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ProjectTreeDocumentDto } from '../api/client.js';
import type { PathTree, TreeFolderNode } from '../path-tree.js';
import { loadCollapsedTreeState, TREE_COLLAPSE_STORAGE_KEY } from '../tree-collapse-state.js';
import type { CollapsedByGroup } from '../tree-collapse-state.js';
import { ReviewChip, SourceBadge } from './document-list.js';
import { IconMdloopDown } from './icons.js';

/**
 * Review-attention map for a project's repo-mirrored documents (Phase 29) —
 * deliberately not a file browser: folder rows carry the aggregated
 * unresolved-comment count of everything nested beneath them (`--lane-signal`,
 * same chip the sidebar already uses for a project's open count), so a
 * reviewer scans the tree for where people are stuck. No per-file icons —
 * every document here is markdown, a type glyph would be noise. Structure
 * reads through hairline indent guides (`.tree-children`) instead.
 *
 * Phase 33.E: also embedded in the viewer's doc switcher popover, alongside
 * its original sidebar use — three props exist purely to make that second
 * home behave like a short-lived dropdown instead of a second sidebar:
 * `currentDocumentId` (highlight what's already open), `asListbox` (the
 * switcher wants listbox/option semantics on its rows, same as the flat
 * list it replaced; the sidebar tree stays a plain nav list, unchanged), and
 * `persistCollapseState` (default true — set false by the switcher so its
 * short-lived instance never fights the sidebar's over the one localStorage
 * key; see STORAGE_KEY below).
 */

function matchesQuery(doc: ProjectTreeDocumentDto, query: string): boolean {
  // Root docs with no repo path (manual uploads) have nothing path-shaped to
  // search, so the filter falls back to their title.
  return (doc.path ?? doc.title).toLowerCase().includes(query);
}

/** A folder plus its children narrowed to only what matches the current
 *  filter (or, unfiltered, every child unchanged) — one shape covers both
 *  render paths so `FolderRow` doesn't need to know which mode it's in. */
interface FolderView {
  folder: TreeFolderNode;
  folders: FolderView[];
  docs: ProjectTreeDocumentDto[];
}

function wrapAll(folder: TreeFolderNode): FolderView {
  return { folder, folders: folder.folders.map(wrapAll), docs: folder.docs };
}

function filterFolder(folder: TreeFolderNode, query: string): FolderView | null {
  const folders = folder.folders
    .map((f) => filterFolder(f, query))
    .filter((f): f is FolderView => f !== null);
  const docs = folder.docs.filter((d) => matchesQuery(d, query));
  if (folders.length === 0 && docs.length === 0) return null;
  return { folder, folders, docs };
}

function DocRow({
  doc,
  onOpen,
  currentDocumentId,
  asListbox,
  showSourceBadge,
}: {
  doc: ProjectTreeDocumentDto;
  onOpen: (id: string) => void;
  currentDocumentId?: string;
  asListbox?: boolean;
  /** Only meaningful at the tree root, where a manual (`path === null`)
   *  upload can sit beside a CLI-mirrored file — inside a folder every doc
   *  is repo-linked by construction, so the badge would be redundant noise
   *  on every single row (Phase 34.D). */
  showSourceBadge?: boolean;
}): JSX.Element {
  const isCurrent = doc.id === currentDocumentId;
  return (
    <li className="tree-doc">
      <button
        type="button"
        className={`tree-row tree-row--doc${isCurrent ? ' tree-row--current' : ''}`}
        title={`Open ${doc.title}`}
        {...(asListbox ? { role: 'option', 'aria-selected': isCurrent } : {})}
        onClick={() => {
          onOpen(doc.id);
        }}
      >
        <span className="doc-title tree-doc-title">{doc.title}</span>
        {doc.openCommentCount > 0 && (
          <span className="doc-signal">{doc.openCommentCount} open</span>
        )}
        <ReviewChip reviewStatus={doc.reviewStatus} />
        {showSourceBadge && <SourceBadge path={doc.path} />}
      </button>
    </li>
  );
}

function FolderRow({
  node,
  expanded,
  onToggle,
  onOpen,
  isExpanded,
  currentDocumentId,
  asListbox,
}: {
  node: FolderView;
  expanded: boolean;
  onToggle: (path: string) => void;
  onOpen: (id: string) => void;
  isExpanded: (path: string) => boolean;
  currentDocumentId?: string;
  asListbox?: boolean;
}): JSX.Element {
  const { folder, folders, docs } = node;
  const hasChildren = folders.length > 0 || docs.length > 0;
  return (
    <li className="tree-folder">
      <button
        type="button"
        className="tree-row tree-row--folder"
        title={folder.path}
        aria-expanded={expanded}
        onClick={() => {
          onToggle(folder.path);
        }}
      >
        <IconMdloopDown
          size={12}
          className={`tree-mdloop${expanded ? '' : ' tree-mdloop--collapsed'}`}
        />
        <span className="tree-folder-name">{folder.name}</span>
        {folder.openCommentCount > 0 && (
          <span className="lane-signal">{folder.openCommentCount}</span>
        )}
      </button>
      {expanded && hasChildren && (
        <ul className="tree-children">
          {folders.map((f) => (
            <FolderRow
              key={f.folder.path}
              node={f}
              expanded={isExpanded(f.folder.path)}
              onToggle={onToggle}
              onOpen={onOpen}
              isExpanded={isExpanded}
              {...(currentDocumentId !== undefined ? { currentDocumentId } : {})}
              {...(asListbox !== undefined ? { asListbox } : {})}
            />
          ))}
          {docs.map((d) => (
            <DocRow
              key={d.id}
              doc={d}
              onOpen={onOpen}
              {...(currentDocumentId !== undefined ? { currentDocumentId } : {})}
              {...(asListbox !== undefined ? { asListbox } : {})}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function ProjectTree({
  projectId,
  tree,
  onOpen,
  currentDocumentId,
  asListbox,
  persistCollapseState = true,
  onEscape,
}: {
  projectId: string;
  tree: PathTree;
  onOpen: (id: string) => void;
  /** Highlights the already-open document — the switcher's one affordance
   *  the plain sidebar tree has no use for. */
  currentDocumentId?: string;
  /** listbox/option semantics on rows, matching the flat list the switcher
   *  replaced. The sidebar tree stays a plain nav list — leave unset there. */
  asListbox?: boolean;
  /** Default true (sidebar behavior, unchanged). The switcher's embedded
   *  instance is short-lived and opens fresh every time, so it sets this
   *  false rather than fighting the sidebar's own instance over the one
   *  `STORAGE_KEY` — two mounted instances persisting to the same key would
   *  otherwise stomp each other's writes, last-render-wins. */
  persistCollapseState?: boolean;
  /** Escape inside the tree — only meaningful (and only wired) when the tree
   *  is embedded in something dismissible, i.e. the switcher popover. */
  onEscape?: () => void;
}): JSX.Element {
  const [collapsedByProject, setCollapsedByProject] = useState<CollapsedByGroup>(() =>
    persistCollapseState ? loadCollapsedTreeState() : {},
  );
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!persistCollapseState) return;
    localStorage.setItem(TREE_COLLAPSE_STORAGE_KEY, JSON.stringify(collapsedByProject));
  }, [collapsedByProject, persistCollapseState]);

  const collapsed = new Set(collapsedByProject[projectId] ?? []);

  function toggleFolder(path: string): void {
    setCollapsedByProject((prev) => {
      const current = new Set(prev[projectId] ?? []);
      if (current.has(path)) current.delete(path);
      else current.add(path);
      return { ...prev, [projectId]: [...current] };
    });
  }

  const query = filter.trim().toLowerCase();
  const filtering = query.length > 0;

  // While filtering, every folder that survives the filter is forced open so
  // the match is actually visible — collapse state only governs the
  // unfiltered view.
  function isExpanded(path: string): boolean {
    return filtering || !collapsed.has(path);
  }

  const rootDocs = filtering ? tree.rootDocs.filter((d) => matchesQuery(d, query)) : tree.rootDocs;
  const folders = filtering
    ? tree.folders.map((f) => filterFolder(f, query)).filter((f): f is FolderView => f !== null)
    : tree.folders.map(wrapAll);

  const nothingToShow = rootDocs.length === 0 && folders.length === 0;

  /**
   * Arrow-key movement across whatever `.tree-row` buttons are currently
   * rendered (folders and docs alike — a flat DOM query, not a modeled
   * index, since the visible set already changes shape on every
   * expand/collapse/filter and re-deriving it here would just duplicate
   * that logic). Enter/Space activate natively — every row is a real
   * `<button>`. Escape only does something when the caller gave us
   * somewhere to send it (the switcher popover; the sidebar has no
   * `onEscape` and this is a no-op there).
   */
  function onTreeKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      if (onEscape) {
        e.stopPropagation();
        onEscape();
      }
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const root = rootRef.current;
    if (!root) return;
    const rows = [...root.querySelectorAll<HTMLButtonElement>('.tree-row')];
    if (rows.length === 0) return;
    e.preventDefault();
    const active = document.activeElement;
    const currentIndex = rows.findIndex((r) => r === active);
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    const nextIndex =
      currentIndex === -1
        ? delta === 1
          ? 0
          : rows.length - 1
        : (currentIndex + delta + rows.length) % rows.length;
    rows[nextIndex]?.focus();
  }

  return (
    <div
      className="project-tree"
      ref={rootRef}
      {...(asListbox ? { role: 'listbox' } : {})}
      onKeyDown={onTreeKeyDown}
    >
      <div className="tree-filter">
        <input
          type="search"
          className="tree-filter-input"
          placeholder="Filter by path…"
          aria-label="Filter documents by path"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
          }}
        />
      </div>
      {nothingToShow ? (
        <p className="help-text tree-empty">
          {filtering ? `No paths match "${filter}".` : 'No documents in this project yet.'}
        </p>
      ) : (
        <ul className="tree-root">
          {rootDocs.map((d) => (
            <DocRow
              key={d.id}
              doc={d}
              onOpen={onOpen}
              showSourceBadge
              {...(currentDocumentId !== undefined ? { currentDocumentId } : {})}
              {...(asListbox !== undefined ? { asListbox } : {})}
            />
          ))}
          {folders.map((f) => (
            <FolderRow
              key={f.folder.path}
              node={f}
              expanded={isExpanded(f.folder.path)}
              onToggle={toggleFolder}
              onOpen={onOpen}
              isExpanded={isExpanded}
              {...(currentDocumentId !== undefined ? { currentDocumentId } : {})}
              {...(asListbox !== undefined ? { asListbox } : {})}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
