import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { ApiError, api } from '../api/client.js';
import { errorCopy } from '../api/error-copy.js';
import type { Me, OverviewDocumentDto, ProjectDto, ProjectTreeDto } from '../api/client.js';
import { buildPathTree } from '../path-tree.js';
import { DocumentList } from './document-list.js';
import { ProjectForm } from './project-form.js';
import { ProjectSharePanel } from './project-share-panel.js';
import { ProjectTree } from './project-tree.js';
import { DropOverlay, UploadButton, useDropTarget } from './upload-dropzone.js';
import type { UploadFile } from './upload-dropzone.js';
import { uploadErrorCopy } from '../upload-precheck.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { AppHeader } from './app-header.js';
import type { ThemeMode } from '../theme.js';
import {
  IconCheck,
  IconVorlynDown,
  IconCopy,
  IconLink,
  IconMoreHorizontal,
  IconPencil,
  IconPlus,
  IconShare,
  IconTrash,
} from './icons.js';

/**
 * Discoverability nudge for repo sync (Phase 20/29). The tree view below only
 * appears once documents carry a `path`, which only the CLI sets — so an org
 * that has never run `vorlyn link` has no way to learn the capability exists.
 *
 * Phase 34.E: moved from a three-block aside at the bottom of the document
 * list to one line at the top of the project view — a persistent status
 * affordance rather than a one-time onboarding blurb, so "is this project
 * linked" stays answerable at a glance instead of disappearing the moment it
 * would (`CliLinkedIndicator` below takes over once `treeHasPaths` flips).
 * Command + explanation collapse behind the line and only expand on click,
 * so the default state is genuinely subtle.
 *
 * The command is project-scoped: `--project <id>` baked in, copy-to-clipboard,
 * so nobody hand-transcribes a uuid. Never shown to a guest — this whole
 * surface lives under `Shell`, which guest sessions never reach (`app.tsx`
 * routes `role === 'guest'` straight to a viewer-only chrome), and API keys
 * refuse to mint for guests server-side (`createApiKey`/`actorForApiKey`), so
 * "which project" is the only thing left to make explicit here — "who's
 * allowed" is already enforced below this component, not by it.
 *
 * "Learn more" opens org settings rather than an external URL: there is no
 * publicly linkable docs site, so the same install content lives in-app
 * under Settings → API keys (commit `9eafe41`).
 */
function CliLinkHint({
  projectId,
  onOpenOrgSettings,
}: {
  /** Null only from the org-wide empty-state placement (no project to scope
   *  the command to yet — see `showCliHint` below); the project-lane top
   *  affordance always passes a real id. */
  projectId: string | null;
  onOpenOrgSettings: () => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const command = projectId ? `vorlyn link --project ${projectId}` : 'vorlyn link';

  return (
    <aside className="cli-hint cli-hint--compact" data-testid="cli-hint">
      <div className="cli-hint-line">
        <IconLink size={13} />
        <button
          type="button"
          className="cli-hint-toggle"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((e) => !e);
          }}
        >
          {projectId ? 'Link to a local folder' : 'Link a project to a local folder'}
        </button>
        <button type="button" className="cli-hint-link" onClick={onOpenOrgSettings}>
          Learn more
        </button>
      </div>
      {expanded && (
        <div className="cli-hint-details">
          <div className="cli-hint-command">
            <code>{command}</code>
            <button
              type="button"
              className="cli-hint-copy"
              title="Copy command"
              onClick={() => {
                void navigator.clipboard.writeText(command).then(() => {
                  setCopied(true);
                  setTimeout(() => {
                    setCopied(false);
                  }, 1500);
                });
              }}
            >
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </button>
          </div>
          <p>
            {projectId ? '' : 'Pick the project when prompted. '}Each commit then pushes its
            markdown here, folder structure and all. You'll need an API key first:{' '}
            <button type="button" className="cli-hint-link" onClick={onOpenOrgSettings}>
              create one in settings
            </button>
            , where you'll also find how to install the CLI and the MCP integration.
          </p>
        </div>
      )}
    </aside>
  );
}

/** Replaces `CliLinkHint` once a project has any repo-mirrored document —
 *  quiet, persistent confirmation that the link is live, rather than the
 *  hint just vanishing with nothing in its place (Phase 34.E). */
function CliLinkedIndicator(): JSX.Element {
  return (
    <aside
      className="cli-hint cli-hint--linked"
      data-testid="cli-linked-indicator"
      title="vorlyn push (or an auto-installed git hook) mirrors this project's local folder here"
    >
      <IconLink size={13} />
      <span>Linked to local folder</span>
    </aside>
  );
}

/** Which lane the main column shows. */
export type Lane =
  | { kind: 'all' }
  | { kind: 'unfiled' }
  | { kind: 'archived' }
  | { kind: 'project'; projectId: string };

function laneParams(lane: Lane): { view?: 'unfiled' | 'archived'; projectId?: string } {
  if (lane.kind === 'project') return { projectId: lane.projectId };
  if (lane.kind === 'all') return {};
  return { view: lane.kind };
}

export function Shell({
  me,
  mode,
  setMode,
  onLogout,
  onOpenDocument,
  onOpenOrgSettings,
}: {
  me: Me;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  onLogout: () => void;
  onOpenDocument: (id: string) => void;
  /** Opens the unified `/settings` shell (Phase 39.A), landing on its org
   *  section — the Shell's one settings entry point now (its Billing rail
   *  group was removed with the billing vertical, S4 spike). */
  onOpenOrgSettings: () => void;
}): JSX.Element {
  const [lane, setLane] = useState<Lane>({ kind: 'all' });
  // Mobile lane-nav drawer (Phase 39.F) — below 720px the sidebar has no
  // permanent column to live in, so lane selection closes it, same as a
  // real app drawer; harmless no-op on desktop where it's never open.
  const [laneDrawerOpen, setLaneDrawerOpen] = useState(false);
  const selectLane = useCallback((l: Lane) => {
    setLane(l);
    setLaneDrawerOpen(false);
  }, []);
  const [documents, setDocuments] = useState<OverviewDocumentDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [counts, setCounts] = useState({ all: 0, unfiled: 0, archived: 0 });
  const [openByProject, setOpenByProject] = useState<Map<string, number>>(new Map());
  /** Only populated while `lane.kind === 'project'` — the flat overview list
   *  above still drives sidebar signals (counts/openByProject) regardless of
   *  which view (tree or list) the main column is showing. */
  const [projectTree, setProjectTree] = useState<ProjectTreeDto | null>(null);
  const [addingProject, setAddingProject] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const [pendingProjectDelete, setPendingProjectDelete] = useState<ProjectDto | null>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  /** Project-level sharing (ADR 0014) — org-admin only, so this is a separate
   *  affordance from the creator-or-admin Rename/Delete menu items. */
  const [sharingProjectId, setSharingProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<
    { kind: 'single'; id: string } | { kind: 'bulk'; ids: string[] } | null
  >(null);

  // One project menu open at a time; outside click or Escape closes it.
  useEffect(() => {
    if (!openProjectMenuId) return;
    function onOutsideClick(e: MouseEvent): void {
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setOpenProjectMenuId(null);
      }
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpenProjectMenuId(null);
    }
    window.document.addEventListener('mousedown', onOutsideClick);
    window.document.addEventListener('keydown', onKeyDown);
    return () => {
      window.document.removeEventListener('mousedown', onOutsideClick);
      window.document.removeEventListener('keydown', onKeyDown);
    };
  }, [openProjectMenuId]);

  // Same pattern as the project menu above, for the project share popover.
  useEffect(() => {
    if (!sharingProjectId) return;
    function onOutsideClick(e: MouseEvent): void {
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setSharingProjectId(null);
      }
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setSharingProjectId(null);
    }
    window.document.addEventListener('mousedown', onOutsideClick);
    window.document.addEventListener('keydown', onKeyDown);
    return () => {
      window.document.removeEventListener('mousedown', onOutsideClick);
      window.document.removeEventListener('keydown', onKeyDown);
    };
  }, [sharingProjectId]);

  // Escape closes the mobile lane drawer, same as the project menu above.
  useEffect(() => {
    if (!laneDrawerOpen) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setLaneDrawerOpen(false);
    }
    window.document.addEventListener('keydown', onKeyDown);
    return () => {
      window.document.removeEventListener('keydown', onKeyDown);
    };
  }, [laneDrawerOpen]);

  /** One round trip paints the whole home screen (lane docs + sidebar
   *  signals); a project lane also pulls its workspace tree (Phase 29) in
   *  parallel so switching into/out of a project doesn't need a second
   *  render pass before the tree appears. */
  const refresh = useCallback(async (currentLane: Lane) => {
    const [overview, tree] = await Promise.all([
      api.overview(laneParams(currentLane)),
      currentLane.kind === 'project' ? api.getProjectTree(currentLane.projectId) : null,
    ]);
    setDocuments(overview.documents);
    setNextCursor(overview.nextCursor);
    setProjects(overview.projects);
    setCounts(overview.counts);
    setOpenByProject(new Map(overview.openByProject.map((e) => [e.projectId, e.open])));
    setProjectTree(tree);
  }, []);

  useEffect(() => {
    refresh(lane).catch(() => {
      setError('Could not load documents. Refresh to retry.');
    });
  }, [lane, refresh]);

  const act = useCallback(
    (fn: () => Promise<unknown>) => {
      setError(null);
      fn()
        .then(() => refresh(lane))
        .catch((e: unknown) => {
          setError(errorCopy(e));
        });
    },
    [lane, refresh],
  );

  function loadMore(): void {
    if (!nextCursor) return;
    api
      .overview({ ...laneParams(lane), cursor: nextCursor })
      .then((page) => {
        setDocuments((docs) => [...docs, ...page.documents]);
        setNextCursor(page.nextCursor);
      })
      .catch(() => {
        setError('Could not load more documents.');
      });
  }

  function uploadFiles(files: UploadFile[]): void {
    setError(null);
    const projectId = lane.kind === 'project' ? lane.projectId : null;
    void (async () => {
      const failures: string[] = [];
      for (const file of files) {
        // Refused by the client-side pre-check (ADR 0011) — never sent. The
        // server would refuse it too; this only saves the round trip.
        if (file.rejection !== undefined) {
          failures.push(`${file.title} ${uploadErrorCopy(file.rejection)}`);
          continue;
        }
        try {
          await api.uploadDocument({ title: file.title, content: file.content, projectId });
        } catch (e) {
          const detail = e instanceof ApiError ? uploadErrorCopy(e.code) : 'failed';
          failures.push(`${file.title} ${detail}`);
        }
      }
      if (failures.length > 0) setError(`Not uploaded: ${failures.join('; ')}`);
      await refresh(lane);
    })();
  }

  /** Bulk lifecycle ops run per document — n stays small (selection-bound). */
  function bulk(ids: string[], run: (id: string) => Promise<unknown>): void {
    setError(null);
    void (async () => {
      const failures: string[] = [];
      for (const id of ids) {
        try {
          await run(id);
        } catch {
          failures.push(id);
        }
      }
      if (failures.length > 0) setError(`${String(failures.length)} document(s) failed.`);
      await refresh(lane);
    })();
  }

  const laneTitle =
    lane.kind === 'project'
      ? (projects.find((p) => p.id === lane.projectId)?.name ?? 'Project')
      : lane.kind === 'all'
        ? 'All documents'
        : lane.kind === 'unfiled'
          ? 'Unfiled'
          : 'Archived';

  const canUpload = lane.kind !== 'archived';

  /** A path on any document means the CLI already owns this project's shape. */
  const treeHasPaths = projectTree?.documents.some((d) => d.path !== null) ?? false;
  const showTree =
    lane.kind === 'project' &&
    projectTree?.projectId === lane.projectId &&
    !projectTree.tooLarge &&
    treeHasPaths;
  /* Where the empty-org nudge earns its place: the moment a new org most
     needs the pointer, before any project even exists to scope a command to
     (`DocumentList`'s "No documents yet" state, at the bottom, unchanged).
     A project lane gets its own persistent top-of-page affordance instead
     (`CliLinkHint`/`CliLinkedIndicator` below, Phase 34.E) — it never falls
     back to this bottom placement. Never in Archived. */
  const showCliHint =
    !treeHasPaths && lane.kind !== 'archived' && lane.kind !== 'project' && documents.length === 0;
  const { active: dropActive, dropTargetProps } = useDropTarget({
    onFiles: uploadFiles,
    disabled: !canUpload,
  });

  return (
    <div className="shell">
      {pendingDelete && (
        <ConfirmDialog
          title={
            pendingDelete.kind === 'single'
              ? 'Delete this document?'
              : `Delete ${String(pendingDelete.ids.length)} document(s)?`
          }
          body={
            /* Repo-backed documents (Phase 34.D) get the same reassurance
               archive/move show — deleting here never touches the local
               file, and the repo stays the source of truth. */
            documents.some(
              (d) =>
                d.path !== null &&
                (pendingDelete.kind === 'single'
                  ? d.id === pendingDelete.id
                  : pendingDelete.ids.includes(d.id)),
            )
              ? "It can be recovered until retention expires. This won't touch any linked local file — the repo stays the source of truth."
              : 'It can be recovered until retention expires.'
          }
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            if (pendingDelete.kind === 'single') {
              act(() => api.deleteDocument(pendingDelete.id));
            } else {
              bulk(pendingDelete.ids, (id) => api.deleteDocument(id));
            }
            setPendingDelete(null);
          }}
          onCancel={() => {
            setPendingDelete(null);
          }}
        />
      )}
      {pendingProjectDelete && (
        <ConfirmDialog
          title={`Delete "${pendingProjectDelete.name}"?`}
          body="Documents in this project are kept and moved to Unfiled."
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            const deletedId = pendingProjectDelete.id;
            const nextLane: Lane =
              lane.kind === 'project' && lane.projectId === deletedId ? { kind: 'all' } : lane;
            setPendingProjectDelete(null);
            setError(null);
            api
              .deleteProject(deletedId)
              .then(() => {
                setLane(nextLane);
                return refresh(nextLane);
              })
              .catch((e: unknown) => {
                setError(errorCopy(e));
              });
          }}
          onCancel={() => {
            setPendingProjectDelete(null);
          }}
        />
      )}
      <AppHeader
        me={me}
        mode={mode}
        setMode={setMode}
        onLogout={onLogout}
        onNavigateHome={() => {
          selectLane({ kind: 'all' });
        }}
        onOpenDocument={onOpenDocument}
        onOpenSettings={onOpenOrgSettings}
        projects={projects}
        onOpenLaneMenu={() => {
          setLaneDrawerOpen(true);
        }}
      >
        <h2 className="page-title">
          {lane.kind === 'project' && (
            <span
              className="lane-chip"
              style={{ background: projects.find((p) => p.id === lane.projectId)?.color }}
            />
          )}
          <span className="page-title-text">{laneTitle}</span>
        </h2>
        {canUpload && <UploadButton onFiles={uploadFiles} />}
      </AppHeader>

      <div className="shell-body">
        {laneDrawerOpen && (
          <div
            className="lane-drawer-backdrop"
            data-testid="lane-drawer-backdrop"
            onClick={() => {
              setLaneDrawerOpen(false);
            }}
          />
        )}
        <nav className={`sidebar${laneDrawerOpen ? ' sidebar--open' : ''}`} aria-label="Lanes">
          <LaneLink
            current={lane.kind === 'all'}
            title="All documents"
            onClick={() => {
              selectLane({ kind: 'all' });
            }}
          >
            All documents
            <span className="lane-count">{counts.all}</span>
          </LaneLink>
          <LaneLink
            current={lane.kind === 'unfiled'}
            title="Documents not in a project"
            onClick={() => {
              selectLane({ kind: 'unfiled' });
            }}
          >
            Unfiled
            <span className="lane-count">{counts.unfiled}</span>
          </LaneLink>
          <div className="sidebar-heading">Projects</div>
          {projects.map((p) =>
            editingProjectId === p.id ? (
              <ProjectForm
                key={p.id}
                initial={{ name: p.name, color: p.color }}
                onCancel={() => {
                  setEditingProjectId(null);
                }}
                onCreate={(input) => {
                  setEditingProjectId(null);
                  act(() => api.patchProject(p.id, input));
                }}
              />
            ) : (
              <div className="lane-row" key={p.id}>
                <LaneLink
                  current={lane.kind === 'project' && lane.projectId === p.id}
                  title={p.name}
                  onClick={() => {
                    selectLane({ kind: 'project', projectId: p.id });
                  }}
                >
                  <span className="lane-chip" style={{ background: p.color }} />
                  {p.name}
                  {(openByProject.get(p.id) ?? 0) > 0 && (
                    <span className="lane-signal">{openByProject.get(p.id)}</span>
                  )}
                </LaneLink>
                {/* Mirror of the server gate (Phase 24 canManageProject):
                    creator or admin; a null-owner legacy project is admin-only. */}
                {(me.role === 'admin' || (p.createdBy !== null && p.createdBy === me.userId)) && (
                  <div
                    className="lane-actions"
                    ref={
                      openProjectMenuId === p.id || sharingProjectId === p.id
                        ? projectMenuRef
                        : undefined
                    }
                  >
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      aria-haspopup="menu"
                      aria-expanded={openProjectMenuId === p.id}
                      aria-label={`More actions for ${p.name}`}
                      title="More actions"
                      onClick={() => {
                        setOpenProjectMenuId(openProjectMenuId === p.id ? null : p.id);
                      }}
                    >
                      <IconMoreHorizontal />
                    </button>
                    {openProjectMenuId === p.id && (
                      <div className="doc-menu" role="menu">
                        {/* Org-admin only (unlike Rename/Delete below, which
                            are creator-or-admin) — mirrors the server's own
                            `requireAdminProject` gate (ADR 0014). */}
                        {me.role === 'admin' && (
                          <button
                            type="button"
                            role="menuitem"
                            className="doc-menu-item"
                            onClick={() => {
                              setOpenProjectMenuId(null);
                              setSharingProjectId(p.id);
                            }}
                          >
                            <IconShare size={14} />
                            Share
                          </button>
                        )}
                        <button
                          type="button"
                          role="menuitem"
                          className="doc-menu-item"
                          onClick={() => {
                            setOpenProjectMenuId(null);
                            setEditingProjectId(p.id);
                          }}
                        >
                          <IconPencil size={14} />
                          Rename
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="doc-menu-item doc-menu-item--danger"
                          onClick={() => {
                            setOpenProjectMenuId(null);
                            setPendingProjectDelete(p);
                          }}
                        >
                          <IconTrash size={14} />
                          Delete
                        </button>
                      </div>
                    )}
                    {sharingProjectId === p.id && (
                      <ProjectSharePanel
                        projectId={p.id}
                        projectName={p.name}
                        onClose={() => {
                          setSharingProjectId(null);
                        }}
                      />
                    )}
                  </div>
                )}
              </div>
            ),
          )}
          {addingProject ? (
            <ProjectForm
              onCancel={() => {
                setAddingProject(false);
              }}
              onCreate={(input) => {
                setAddingProject(false);
                act(() => api.createProject(input));
              }}
            />
          ) : (
            <button
              type="button"
              className="btn btn-ghost"
              title="Add a new project"
              onClick={() => {
                setAddingProject(true);
              }}
            >
              <IconPlus size={14} />
              New project
            </button>
          )}
          <div className="sidebar-heading">More</div>
          <LaneLink
            current={lane.kind === 'archived'}
            title="Archived documents"
            onClick={() => {
              selectLane({ kind: 'archived' });
            }}
          >
            Archived
            <span className="lane-count">{counts.archived}</span>
          </LaneLink>
        </nav>

        <div className="main">
          <main className="content" {...dropTargetProps}>
            {dropActive && canUpload && <DropOverlay />}
            <div className="content-inner">
              {error && (
                <div className="banner-error" role="alert">
                  {error}
                </div>
              )}
              {lane.kind === 'project' &&
                (treeHasPaths ? (
                  <CliLinkedIndicator />
                ) : (
                  <CliLinkHint projectId={lane.projectId} onOpenOrgSettings={onOpenOrgSettings} />
                ))}
              {showTree ? (
                // Path-having project: the tree is the source of truth for
                // what's on screen (unpaged already — no "load more" here).
                // Org that never uploads via the CLI never sees this branch —
                // it gets `CliLinkHint` in the flat branch instead.
                <ProjectTree
                  projectId={lane.projectId}
                  tree={buildPathTree(projectTree.documents)}
                  onOpen={onOpenDocument}
                />
              ) : (
                <>
                  <DocumentList
                    documents={documents}
                    projects={projects}
                    archivedView={lane.kind === 'archived'}
                    groupByProject={lane.kind === 'all'}
                    onOpen={onOpenDocument}
                    onOpenProject={(projectId) => {
                      setLane({ kind: 'project', projectId });
                    }}
                    onMove={(id, projectId) => {
                      act(() => api.patchDocument(id, { projectId }));
                    }}
                    onArchive={(id, archived) => {
                      act(() => api.patchDocument(id, { archived }));
                    }}
                    onDelete={(id) => {
                      setPendingDelete({ kind: 'single', id });
                    }}
                    onBulkArchive={(ids, archived) => {
                      bulk(ids, (id) => api.patchDocument(id, { archived }));
                    }}
                    onBulkMove={(ids, projectId) => {
                      bulk(ids, (id) => api.patchDocument(id, { projectId }));
                    }}
                    onBulkDelete={(ids) => {
                      setPendingDelete({ kind: 'bulk', ids });
                    }}
                  />
                  {nextCursor && (
                    <button
                      type="button"
                      className="btn load-more"
                      title="Load more documents"
                      onClick={loadMore}
                    >
                      <IconVorlynDown size={14} />
                      Load more
                    </button>
                  )}
                  {showCliHint && (
                    <CliLinkHint projectId={null} onOpenOrgSettings={onOpenOrgSettings} />
                  )}
                </>
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

function LaneLink({
  current,
  onClick,
  title,
  children,
}: {
  current: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      className="lane-link"
      aria-current={current}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
