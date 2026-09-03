import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { OverviewDocumentDto, ProjectDto } from '../api/client.js';
import { buildPathTree, isRootLevelPath } from '../path-tree.js';
import type { TreeFolderNode } from '../path-tree.js';
import { loadCollapsedTreeState, TREE_COLLAPSE_STORAGE_KEY } from '../tree-collapse-state.js';
import type { CollapsedByGroup } from '../tree-collapse-state.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { versionSourceLabel } from './version-strip.js';
import {
  IconArchive,
  IconArchiveRestore,
  IconCheck,
  IconVorlynDown,
  IconLink,
  IconMoreHorizontal,
  IconTrash,
  IconX,
} from './icons.js';

export interface DocumentListProps {
  documents: OverviewDocumentDto[];
  projects: ProjectDto[];
  archivedView: boolean;
  /** Group the loaded documents by project — only meaningful in the All
   *  lane; unfiled/archived/project lanes stay a flat list regardless. */
  groupByProject?: boolean;
  onOpen: (id: string) => void;
  /** Fires when a project's group header is clicked (All lane only — see
   *  `groupByProject`). Not called for the "Unfiled" group, which has no
   *  project to navigate to. Optional because flat-list callers (unfiled/
   *  archived/project lanes) never render group headers at all. */
  onOpenProject?: (projectId: string) => void;
  onMove: (id: string, projectId: string | null) => void;
  onArchive: (id: string, archived: boolean) => void;
  onDelete: (id: string) => void;
  onBulkArchive: (ids: string[], archived: boolean) => void;
  onBulkMove: (ids: string[], projectId: string | null) => void;
  onBulkDelete: (ids: string[]) => void;
}

const dateFmt = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });

function Signal({ doc }: { doc: OverviewDocumentDto }): JSX.Element | null {
  if (doc.open + doc.resolved === 0) return null;
  if (doc.open > 0) {
    return (
      <span className="doc-signal">
        {doc.open} open{doc.resolved > 0 ? ` · ${String(doc.resolved)} resolved` : ''}
      </span>
    );
  }
  return <span className="doc-signal doc-signal--clear">✓ {doc.resolved} resolved</span>;
}

/** Sign-off chip beside the comment Signal — hidden while a doc is still a
 *  draft. Exported so other document rows (the project tree, Phase 29) can
 *  reuse the same chip instead of reinventing the review-status visual. */
export const REVIEW_LABELS: Record<OverviewDocumentDto['reviewStatus'], string> = {
  draft: '',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
};

export function ReviewChip({
  reviewStatus,
}: {
  reviewStatus: OverviewDocumentDto['reviewStatus'];
}): JSX.Element | null {
  const label = REVIEW_LABELS[reviewStatus];
  if (label === '') return null;
  return <span className={`review-chip review-chip--${reviewStatus}`}>{label}</span>;
}

/**
 * Repo-linkage indicator (Phase 34.D) — only rendered for `path !== null`,
 * i.e. a document the sync CLI mirrored in. A plain web/MCP upload (the
 * common case in most orgs) stays unbadged rather than labelling every row
 * "in Vorlyn", which would be noise, not signal. Reuses
 * `versionSourceLabel('cli')`'s copy rather than inventing new wording —
 * that string is about the sync *mechanism*, not any one version's origin
 * (a repo-linked doc's latest version can still have been pushed from the
 * web, which is exactly the divergence `RepoBackedConfirm` below warns
 * about), so the tooltip is worded to not overclaim currency.
 */
export function SourceBadge({ path }: { path: string | null }): JSX.Element | null {
  if (path === null) return null;
  return (
    <span
      className="source-badge"
      title="Linked to a local folder — vorlyn push mirrors this document's structure"
    >
      <IconLink size={11} />
      {versionSourceLabel('cli')}
    </span>
  );
}

/** True for any repo-backed document — `vorlyn push` (or the auto-installed
 *  git hook) can overwrite the next upload silently, so web-triggered
 *  mutations on these get an explicit confirm (Phase 34.D) that plain
 *  web/MCP-only documents don't need. */
function isRepoBacked(doc: OverviewDocumentDto): boolean {
  return doc.path !== null;
}

interface DocGroup {
  key: string;
  label: string;
  color: string;
  docs: OverviewDocumentDto[];
  mostRecentActivity: string;
}

/** Groups the *loaded* documents by project for the All lane. Paging stays
 *  as-is — this just regroups on every load-more append. Docs inside a
 *  group keep the server's activity order; groups themselves sort by their
 *  own most recent activity, desc, so the feed still reads newest-first
 *  overall. Empty groups can't happen here — a group only exists because a
 *  loaded doc put it in the map. */
function groupDocuments(documents: OverviewDocumentDto[], projects: ProjectDto[]): DocGroup[] {
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const order: string[] = [];
  const byKey = new Map<string, OverviewDocumentDto[]>();
  for (const doc of documents) {
    const key = doc.projectId ?? 'unfiled';
    let list = byKey.get(key);
    if (!list) {
      list = [];
      byKey.set(key, list);
      order.push(key);
    }
    list.push(doc);
  }
  const groups = order.map((key): DocGroup => {
    const docs = byKey.get(key) ?? [];
    const project = key === 'unfiled' ? null : (projectById.get(key) ?? null);
    const mostRecentActivity = docs.reduce(
      (max, d) => (d.lastActivityAt > max ? d.lastActivityAt : max),
      docs[0]?.lastActivityAt ?? '',
    );
    return {
      key,
      label: project ? project.name : 'Unfiled',
      color: project ? project.color : 'var(--lane-strong)',
      docs,
      mostRecentActivity,
    };
  });
  groups.sort((a, b) => (a.mostRecentActivity > b.mostRecentActivity ? -1 : 1));
  return groups;
}

export function DocumentList({
  documents,
  projects,
  archivedView,
  groupByProject = false,
  onOpen,
  onOpenProject,
  onMove,
  onArchive,
  onDelete,
  onBulkArchive,
  onBulkMove,
  onBulkDelete,
}: DocumentListProps): JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const ids = [...selected].filter((id) => documents.some((d) => d.id === id));
  const allSelected = documents.length > 0 && documents.every((d) => selected.has(d.id));
  const selectAllRef = useRef<HTMLInputElement>(null);
  /** Gates archive/move only when at least one target document is repo-
   *  backed (Phase 34.D) — non-repo-backed docs keep firing instantly, same
   *  as before this phase. Delete already has its own confirm at the shell
   *  level regardless of provenance; this is additive for the two actions
   *  that previously had none. */
  const [pendingRepoAction, setPendingRepoAction] = useState<
    | { kind: 'archive'; ids: string[]; archived: boolean }
    | { kind: 'move'; ids: string[]; projectId: string | null }
    | null
  >(null);
  const [collapsedByGroup, setCollapsedByGroup] = useState<CollapsedByGroup>(() =>
    groupByProject ? loadCollapsedTreeState() : {},
  );

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = ids.length > 0 && !allSelected;
    }
  }, [ids.length, allSelected]);

  useEffect(() => {
    if (!groupByProject) return;
    localStorage.setItem(TREE_COLLAPSE_STORAGE_KEY, JSON.stringify(collapsedByGroup));
  }, [collapsedByGroup, groupByProject]);

  // One menu open at a time; outside click or Escape closes it.
  useEffect(() => {
    if (!openMenuId) return;
    function onOutsideClick(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpenMenuId(null);
    }
    window.document.addEventListener('mousedown', onOutsideClick);
    window.document.addEventListener('keydown', onKeyDown);
    return () => {
      window.document.removeEventListener('mousedown', onOutsideClick);
      window.document.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenuId]);

  if (documents.length === 0) {
    return (
      <div className="empty">
        <h3>{archivedView ? 'Nothing archived' : 'No documents yet'}</h3>
        <p>
          {archivedView
            ? 'Archived documents land here, out of the way but easy to bring back.'
            : 'Drop a markdown file anywhere on this page, or use Upload above, to start the first handoff.'}
        </p>
      </div>
    );
  }

  const projectColor = new Map(projects.map((p) => [p.id, p.color]));

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(): void {
    setSelected(allSelected ? new Set() : new Set(documents.map((d) => d.id)));
  }

  function anyRepoBacked(targetIds: string[]): boolean {
    const targetSet = new Set(targetIds);
    return documents.some((d) => targetSet.has(d.id) && isRepoBacked(d));
  }

  /** Archiving (not restoring) a repo-backed doc gets a confirm; restoring
   *  is never destructive, so it stays instant regardless of provenance. */
  function runArchive(id: string, archived: boolean): void {
    if (archived && anyRepoBacked([id])) {
      setPendingRepoAction({ kind: 'archive', ids: [id], archived });
      return;
    }
    onArchive(id, archived);
  }

  function runMove(id: string, projectId: string | null): void {
    if (anyRepoBacked([id])) {
      setPendingRepoAction({ kind: 'move', ids: [id], projectId });
      return;
    }
    onMove(id, projectId);
  }

  function runBulkArchive(bulkIds: string[], archived: boolean): void {
    if (archived && anyRepoBacked(bulkIds)) {
      setPendingRepoAction({ kind: 'archive', ids: bulkIds, archived });
      return;
    }
    onBulkArchive(bulkIds, archived);
  }

  function runBulkMove(bulkIds: string[], projectId: string | null): void {
    if (anyRepoBacked(bulkIds)) {
      setPendingRepoAction({ kind: 'move', ids: bulkIds, projectId });
      return;
    }
    onBulkMove(bulkIds, projectId);
  }

  function toggleFolder(groupKey: string, path: string): void {
    setCollapsedByGroup((prev) => {
      const current = new Set(prev[groupKey] ?? []);
      if (current.has(path)) current.delete(path);
      else current.add(path);
      return { ...prev, [groupKey]: [...current] };
    });
  }

  const selecting = selected.size > 0;
  const groups = groupByProject ? groupDocuments(documents, projects) : null;

  function renderRow(doc: OverviewDocumentDto): JSX.Element {
    const menuOpen = openMenuId === doc.id;
    return (
      <li
        key={doc.id}
        className="doc-row"
        data-testid="doc-row"
        style={{ borderLeftColor: doc.projectId ? projectColor.get(doc.projectId) : undefined }}
        onClick={() => {
          onOpen(doc.id);
        }}
      >
        <input
          type="checkbox"
          className="doc-check"
          aria-label={`Select ${doc.title}`}
          checked={selected.has(doc.id)}
          onClick={(e) => {
            e.stopPropagation();
          }}
          onChange={() => {
            toggle(doc.id);
          }}
        />
        <div className="doc-row-title-block">
          <button
            type="button"
            className="doc-title doc-title--link"
            title={`Open ${doc.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(doc.id);
            }}
          >
            {doc.title}
          </button>
          {/* Unfiled/Archived/per-project lanes only (`groups === null` — the
           *  flat, ungrouped branch): the All lane's folder headers already
           *  show location there, so showing it again per-row would repeat
           *  the same information (see the plan note by the call site
           *  below). Deliberately separate from `SourceBadge` above, which
           *  is provenance ("came from a repo push"), not location. */}
          {groups === null && doc.path !== null && <span className="doc-row-path">{doc.path}</span>}
        </div>
        <Signal doc={doc} />
        <ReviewChip reviewStatus={doc.reviewStatus} />
        <SourceBadge path={doc.path} />
        <span className="doc-meta" title="Last activity">
          {dateFmt.format(new Date(doc.lastActivityAt))}
        </span>
        <div className="doc-actions" ref={menuOpen ? menuRef : undefined}>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`More actions for ${doc.title}`}
            title="More actions"
            onClick={(e) => {
              e.stopPropagation();
              setOpenMenuId(menuOpen ? null : doc.id);
            }}
          >
            <IconMoreHorizontal />
          </button>
          {menuOpen && (
            <div className="doc-menu" role="menu">
              {archivedView ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="doc-menu-item"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuId(null);
                      onArchive(doc.id, false);
                    }}
                  >
                    <IconArchiveRestore size={14} />
                    Restore
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="doc-menu-item doc-menu-item--danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuId(null);
                      onDelete(doc.id);
                    }}
                  >
                    <IconTrash size={14} />
                    Delete
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="doc-menu-item"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuId(null);
                      runArchive(doc.id, true);
                    }}
                  >
                    <IconArchive size={14} />
                    Archive
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="doc-menu-item doc-menu-item--danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuId(null);
                      onDelete(doc.id);
                    }}
                  >
                    <IconTrash size={14} />
                    Delete
                  </button>
                  <div className="doc-menu-separator" role="separator" />
                  <div className="doc-menu-heading">Move to</div>
                  <button
                    type="button"
                    role="menuitem"
                    className={`doc-menu-item${doc.projectId === null ? ' doc-menu-item--current' : ''}`}
                    disabled={doc.projectId === null}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuId(null);
                      runMove(doc.id, null);
                    }}
                  >
                    <span className="lane-chip" style={{ background: 'var(--lane-strong)' }} />
                    Unfiled
                    {doc.projectId === null && (
                      <IconCheck size={12} className="doc-menu-item-check" />
                    )}
                  </button>
                  {projects.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      role="menuitem"
                      className={`doc-menu-item${doc.projectId === p.id ? ' doc-menu-item--current' : ''}`}
                      disabled={doc.projectId === p.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenuId(null);
                        runMove(doc.id, p.id);
                      }}
                    >
                      <span className="lane-chip" style={{ background: p.color }} />
                      {p.name}
                      {doc.projectId === p.id && (
                        <IconCheck size={12} className="doc-menu-item-check" />
                      )}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </li>
    );
  }

  /** Nested folder header + children, for a project group's repo-mirrored
   *  docs (Phase 34.C) — visually matches `project-tree.tsx`'s `FolderRow`
   *  (same `tree-row--folder`/`tree-vorlyn`/`lane-signal`/`tree-children`
   *  classes) so the home lane's inline nesting and the per-project tree
   *  read as one system. Leaf docs still render through `renderRow`, so
   *  checkboxes, the actions menu, and bulk selection all keep working
   *  inside a folder exactly as they do at the root. */
  function renderFolder(groupKey: string, node: TreeFolderNode<OverviewDocumentDto>): JSX.Element {
    const collapsed = new Set(collapsedByGroup[groupKey] ?? []);
    const expanded = !collapsed.has(node.path);
    const hasChildren = node.folders.length > 0 || node.docs.length > 0;
    return (
      <li key={`folder-${groupKey}-${node.path}`} className="tree-folder doc-list-folder">
        <button
          type="button"
          className="tree-row tree-row--folder"
          title={node.path}
          aria-expanded={expanded}
          onClick={() => {
            toggleFolder(groupKey, node.path);
          }}
        >
          <IconVorlynDown
            size={12}
            className={`tree-vorlyn${expanded ? '' : ' tree-vorlyn--collapsed'}`}
          />
          <span className="tree-folder-name">{node.name}</span>
          {node.openCommentCount > 0 && (
            <span className="lane-signal">{node.openCommentCount}</span>
          )}
        </button>
        {expanded && hasChildren && (
          <ul className="tree-children">
            {node.folders.map((f) => renderFolder(groupKey, f))}
            {node.docs.map((doc) => renderRow(doc))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <>
      {pendingRepoAction && (
        <ConfirmDialog
          title={
            pendingRepoAction.kind === 'archive'
              ? pendingRepoAction.ids.length === 1
                ? 'Archive this document?'
                : `Archive ${String(pendingRepoAction.ids.length)} document(s)?`
              : pendingRepoAction.ids.length === 1
                ? 'Move this document?'
                : `Move ${String(pendingRepoAction.ids.length)} document(s)?`
          }
          body="This document is linked to a local folder. The local file won't be touched, and the repo stays the source of truth — vorlyn push still mirrors it here the same way next time."
          confirmLabel={pendingRepoAction.kind === 'archive' ? 'Archive' : 'Move'}
          onConfirm={() => {
            // Bulk variant handles the single-id case fine (it's just a
            // one-element loop) — no need to branch on length here.
            if (pendingRepoAction.kind === 'archive') {
              onBulkArchive(pendingRepoAction.ids, pendingRepoAction.archived);
            } else {
              onBulkMove(pendingRepoAction.ids, pendingRepoAction.projectId);
            }
            setPendingRepoAction(null);
          }}
          onCancel={() => {
            setPendingRepoAction(null);
          }}
        />
      )}
      {ids.length > 0 && (
        <div className="bulk-bar" data-testid="bulk-bar">
          <span>{ids.length} selected</span>
          {!archivedView && (
            <select
              className="doc-project-select"
              aria-label="Move selected to project"
              value=""
              onChange={(e) => {
                runBulkMove(ids, e.target.value === '' ? null : e.target.value);
                setSelected(new Set());
              }}
            >
              <option value="" disabled>
                Move to…
              </option>
              <option value="">Unfiled</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            title={archivedView ? 'Restore selected documents' : 'Archive selected documents'}
            onClick={() => {
              runBulkArchive(ids, !archivedView);
              setSelected(new Set());
            }}
          >
            {archivedView ? <IconArchiveRestore /> : <IconArchive />}
            {archivedView ? 'Restore' : 'Archive'}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-danger"
            title="Delete selected documents"
            onClick={() => {
              onBulkDelete(ids);
              setSelected(new Set());
            }}
          >
            <IconTrash />
            Delete
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Clear selection"
            title="Clear selection"
            onClick={() => {
              setSelected(new Set());
            }}
          >
            <IconX />
          </button>
        </div>
      )}
      {selecting && (
        <div className="doc-list-head">
          <input
            ref={selectAllRef}
            type="checkbox"
            className="doc-check"
            aria-label={allSelected ? 'Deselect all' : 'Select all'}
            title={allSelected ? 'Deselect all' : 'Select all'}
            checked={allSelected}
            onChange={toggleAll}
          />
          <button type="button" className="doc-list-head-label" onClick={toggleAll}>
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
        </div>
      )}
      <ul className={`doc-list${selecting ? ' doc-list--selecting' : ''}`}>
        {groups
          ? groups.flatMap((g) => [
              <li key={`group-${g.key}`} className="doc-group-header">
                {g.key === 'unfiled' ? (
                  <>
                    <span className="lane-chip" style={{ background: g.color }} />
                    {g.label}
                  </>
                ) : (
                  <button
                    type="button"
                    className="doc-group-header-link"
                    title={`Open ${g.label}`}
                    onClick={() => {
                      onOpenProject?.(g.key);
                    }}
                  >
                    <span className="lane-chip" style={{ background: g.color }} />
                    {g.label}
                  </button>
                )}
                <span className="doc-group-count">{g.docs.length}</span>
              </li>,
              // Root-level docs (no path, or a single-segment path) keep the
              // server's activity order — buildPathTree's own `rootDocs`
              // sorts alphabetically, which is right for a repo tree but
              // wrong for this feed, so only the nested (folder) part comes
              // from it; a group with no multi-segment paths at all ends up
              // with an empty `folders` array and renders exactly as before
              // this phase (Phase 34.C).
              ...g.docs.filter((d) => isRootLevelPath(d.path)).map((doc) => renderRow(doc)),
              ...buildPathTree(
                g.docs.filter((d) => !isRootLevelPath(d.path)),
                (d) => d.open,
              ).folders.map((folder) => renderFolder(g.key, folder)),
            ])
          : documents.map((doc) => renderRow(doc))}
      </ul>
    </>
  );
}
