import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { JSX, WheelEvent } from 'react';
import { ApiError, api } from '../api/client.js';
import { errorCopy } from '../api/error-copy.js';
import type {
  AnchorDto,
  DiagramAnchorDto,
  DocumentDto,
  Me,
  MentionDto,
  OrgUserDto,
  ProjectDto,
  ProjectTreeDto,
  ReplyDto,
  ThreadDto,
  VersionDto,
} from '../api/client.js';
import { anchorOccurrence, captureTextAnchor } from '../anchors/capture.js';
import { applyHighlight, clearHighlights } from '../anchors/highlight.js';
import { diagramAnchorLabel } from '../anchors/diagram.js';
import { countBySection, parseOutline } from '../outline.js';
import { gutterSegments } from '../gutter.js';
import {
  activeMentionQuery,
  filterMentionCandidates,
  mentionInsertText,
  mentionSlug,
  segmentMentionsSafe,
} from '../mentions.js';
import type { MentionOption } from '../mentions.js';
import { MarkdownView } from './markdown-view.js';
import { FeatureBoundary, FeatureFallback } from './error-boundary.js';
import { Breadcrumb } from './breadcrumb.js';
import { DiffView } from './diff-view.js';
import { SharePanel } from './share-panel.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { DropOverlay, useDropTarget } from './upload-dropzone.js';
import { precheckUpload, uploadErrorCopy } from '../upload-precheck.js';
import { OutlinePanel } from './outline-panel.js';
import { VersionStrip } from './version-strip.js';
import { TriagePanel } from './triage-panel.js';
import { ReviewControl } from './review-control.js';
import { ThemeToggle } from './theme-toggle.js';
import { AppHeader } from './app-header.js';
import { BrandMark } from './brand-mark.js';
import { ProjectTree } from './project-tree.js';
import { buildPathTree } from '../path-tree.js';
import type { ThemeMode } from '../theme.js';
import {
  IconArrowLeft,
  IconCheck,
  IconVorlynDown,
  IconCopy,
  IconGitCompare,
  IconHelp,
  IconMarginBubbles,
  IconListView,
  IconMessage,
  IconPencil,
  IconReply,
  IconShare,
  IconThumbsUp,
  IconTrash,
  IconUpload,
  IconX,
} from './icons.js';

export interface ViewerProps {
  documentId: string;
  /** Comment id from the #c= deep link, if any. */
  deepLinkCommentId: string | null;
  me: Me;
  dark: boolean;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  onBack: () => void;
  /** Absent for guest sessions — guests get no AppHeader (no home, no org
   *  surface, no search across documents they can't see). */
  onOpenDocument?: (id: string) => void;
  onLogout?: () => void;
  /** Threaded straight to AppHeader — admin-only "Settings" identity-menu
   *  item (Phase 39.A: the unified `/settings` shell). Absent for guests,
   *  same as onOpenDocument/onLogout above. */
  onOpenOrgSettings?: () => void;
}

type ThreadLane = 'open' | 'replied' | 'resolved' | 'orphan' | 'accepted-pending';
type ThreadFilter = 'open' | 'mine' | 'orphan' | 'suggestion' | 'resolved';
type RailMode = 'list' | 'bubbles';

/** Mirrors MAX_COMMENT_BODY_LENGTH in @vorlyn/domain — web has no dependency
 * on the domain package, so the cap is duplicated here rather than imported. */
const MAX_COMMENT_LENGTH = 2_000;
/** Mirrors MAX_PROPOSED_TEXT_LENGTH in @vorlyn/domain, same reason as above. */
const MAX_PROPOSED_TEXT_LENGTH = 20_000;
/** Mirrors document_versions_change_note_len_ck (migration 0017). */
const MAX_CHANGE_NOTE = 20_000;
type BubbleSide = 'left' | 'right';
interface BubblePosition {
  side: BubbleSide;
  top: number;
}

const BUBBLE_GAP = 12;
/** Fallback card height for the first layout pass, before real heights are measured. */
const BUBBLE_FALLBACK_HEIGHT = 88;
/** Draft composer bubble uses this id in the position map — never a real comment id. */
const DRAFT_BUBBLE_ID = '__draft__';

/** Lanes come from the server-side re-anchoring, never from guessing. */
function laneOf(thread: ThreadDto): ThreadLane {
  // Checked first: an accepted-but-unmaterialized suggestion (ADR 0007
  // decision 6) needs its own distinct treatment regardless of whether
  // accepting also resolved the parent comment's thread status — it must
  // not blend into the generic "resolved" lane.
  if (
    thread.comment.kind === 'suggestion' &&
    thread.comment.suggestionOutcome === 'accepted' &&
    thread.comment.appliedVersionId === null
  ) {
    return 'accepted-pending';
  }
  if (thread.comment.status === 'resolved') return 'resolved';
  if (thread.resolution.method === 'orphan') return 'orphan';
  return thread.replies.length > 0 ? 'replied' : 'open';
}

function quoteOf(anchor: AnchorDto): string {
  if (anchor.type === 'text') return anchor.exact;
  if (anchor.type === 'diagram') return diagramAnchorLabel(anchor);
  return 'Whole document';
}

/** Vertical position of a thread in the minimap, as a source-length fraction. */
function minimapFraction(thread: ThreadDto, source: string): number {
  const { resolution, comment } = thread;
  if (resolution.start !== null && source.length > 0) {
    return Math.min(0.98, resolution.start / source.length);
  }
  return comment.anchor.type === 'diagram' ? 0.5 : 0.02;
}

const draftKey = (documentId: string): string => `vorlyn:draft:${documentId}`;

export function Viewer({
  documentId,
  deepLinkCommentId,
  me,
  dark,
  mode,
  setMode,
  onBack,
  onOpenDocument,
  onLogout,
  onOpenOrgSettings,
}: ViewerProps): JSX.Element {
  const [document, setDocument] = useState<DocumentDto | null>(null);
  const [source, setSource] = useState('');
  const [threads, setThreads] = useState<ThreadDto[]>([]);
  const [resolvedThreads, setResolvedThreads] = useState<ThreadDto[] | null>(null);
  const [counts, setCounts] = useState({ open: 0, resolved: 0 });
  /** Comment id currently playing the finish-sweep animation — set the instant
   *  a resolve fires, cleared once both the API call and the ~500ms sweep
   *  window finish. Keeps the sweep visible before the thread leaves the
   *  open list (see resolveWithSweep). */
  const [sweepId, setSweepId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [draftAnchor, setDraftAnchor] = useState<AnchorDto | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(deepLinkCommentId);
  /** Comment ids whose accepted-pending-suggestion overlay is expanded —
   *  shared between the body mark (click-to-reveal, ADR 0007 decision 6)
   *  and the card's own toggle button, so either drives the same state. */
  const [expandedSuggestions, setExpandedSuggestions] = useState<Set<string>>(new Set());
  const toggleSuggestionExpanded = useCallback((commentId: string) => {
    setExpandedSuggestions((prev) => {
      const next = new Set(prev);
      if (next.has(commentId)) {
        next.delete(commentId);
      } else {
        next.add(commentId);
      }
      return next;
    });
  }, []);

  /* Hash-only navigation (e.g. `#c=<id>` deep links) is same-document — the
     component never remounts, so the useState initializer above never
     re-runs. Re-sync explicitly whenever the deep-link id changes. */
  useEffect(() => {
    setSelectedId(deepLinkCommentId);
  }, [deepLinkCommentId]);
  const [orgUsers, setOrgUsers] = useState<OrgUserDto[]>([]);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [projectTree, setProjectTree] = useState<ProjectTreeDto | null>(null);
  const [versions, setVersions] = useState<VersionDto[]>([]);
  const [diffFrom, setDiffFrom] = useState<VersionDto | null>(null);
  const [viewVersion, setViewVersion] = useState<VersionDto | null>(null);
  const [oldSource, setOldSource] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  /** `null` = no filter selected, shows every thread. */
  const [filter, setFilter] = useState<ThreadFilter | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  /** In-rail comment search (ADR 0003 §C): filters the loaded threads client-
   *  side; the server comment search backs it up with a count of matches that
   *  live outside the loaded set (e.g. in resolved threads). */
  const [railQuery, setRailQuery] = useState('');
  const [railElsewhere, setRailElsewhere] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const shortcutsRef = useRef<HTMLDivElement>(null);
  /** One-way latch for the quiet-marks default (ADR 0003 §F.5): once the
   *  rail has been opened or a mark selected, the calm hairline treatment
   *  never comes back for the rest of this session, even if the rail
   *  closes again. */
  const [railEverEngaged, setRailEverEngaged] = useState(railOpen || selectedId !== null);
  const [docSwitcherOpen, setDocSwitcherOpen] = useState(false);
  const docSwitcherRef = useRef<HTMLDivElement>(null);
  const sharePanelRef = useRef<HTMLDivElement>(null);
  const [triageSeq, setTriageSeq] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [railMode, setRailMode] = useState<RailMode>('list');
  const [bubbleRawTops, setBubbleRawTops] = useState<Map<string, number>>(new Map());
  const [contentReflowTick, setContentReflowTick] = useState(0);
  const [bubblePositions, setBubblePositions] = useState<Map<string, BubblePosition>>(new Map());
  const [draftAnchorRect, setDraftAnchorRect] = useState<DOMRect | null>(null);
  /** A fresh text-anchored draft shows pinned at the selection (both list and
   *  bubbles mode) for as long as it's still a draft — it only reaches its
   *  margin lane / rail slot once the comment has actually been posted, as
   *  an ordinary thread. No rect (whole-document or diagram anchors) has
   *  nowhere to pin to, so it goes straight to 'lane'. */
  const draftPhase: 'anchor' | 'lane' = draftAnchor && draftAnchorRect ? 'anchor' : 'lane';
  const contentRef = useRef<HTMLDivElement>(null);
  const contentWrapRef = useRef<HTMLDivElement>(null);
  const leftCanvasRef = useRef<HTMLDivElement>(null);
  const rightCanvasRef = useRef<HTMLDivElement>(null);
  const bubbleCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const railRef = useRef<HTMLElement>(null);
  const versionFileRef = useRef<HTMLInputElement>(null);

  const myPermission = document?.myPermission ?? 'read';
  /** At least `comment` on the lattice (`read < comment < share < edit`,
   *  ADR 0014) — every rung above `read` includes commenting rights, so this
   *  is a lattice check, not an enumeration of the three rungs that qualify. */
  const canComment = myPermission !== 'read';
  /** Upload a new version — owner, org admin, or an ADR 0008 `edit` grantee. */
  const canEdit = myPermission === 'edit';
  /**
   * Manage the document — delete/archive/move, resolve, re-share, request
   * review, accept or reject a suggestion. Owner or org admin only; every one
   * of these is server-gated on `canManageDocument`, so this mirrors that
   * predicate rather than the permission lattice.
   *
   * Before ADR 0008 the two were the same boolean, because `edit` implied
   * owner-or-admin. Now an `edit` grantee reports `myPermission: 'edit'`
   * honestly while holding none of the management rights, so the UI has to
   * distinguish them or it would offer buttons the server refuses. Computed
   * client-side from data the viewer already has — no API change.
   */
  const canManage = document !== null && (document.ownerId === me.userId || me.role === 'admin');
  /**
   * Sharing (creating/revoking grants on this document) — owner/org-admin, or
   * a `share`/`edit` grantee (ADR 0014: `edit` inherits `share` by lattice, so
   * an `edit` holder may also re-share). `SharePanel` itself caps what a
   * non-`canManage` caller may delegate at their own held level.
   */
  const canShare = canManage || myPermission === 'share' || myPermission === 'edit';

  useEffect(() => {
    if (railOpen || selectedId !== null) setRailEverEngaged(true);
  }, [railOpen, selectedId]);

  /** Calm sheet for a non-editing reader who hasn't engaged the rail yet
   *  (ADR 0003 §F.5) — editors always get full amber, this is a reading
   *  posture, not a permission gate. */
  const quietMarks = !canEdit && !railEverEngaged;

  /** Whether the signed-in user is a requested reviewer awaiting their own
   *  verdict — reported up from ReviewControl, which owns the review data.
   *  Drives which header button gets the single primary slot for
   *  read/comment users (ADR 0003 §F.6). */
  const [reviewerPendingVerdict, setReviewerPendingVerdict] = useState(false);
  /** Editors already have New version as their primary action — this only
   *  matters, and only ever applies, for read/comment users. */
  const addCommentPrimary = !canEdit && !reviewerPendingVerdict;

  /** Threads + counts only — the cheap path every comment mutation takes. */
  const refreshThreads = useCallback(async () => {
    const open = await api.listThreads(documentId, 'open');
    setThreads(open.threads);
    setCounts(open.counts);
    // Drop the resolved cache; the filter effect refetches it if on screen.
    setResolvedThreads(null);
  }, [documentId]);

  /** Document + content + versions + threads — load and version-upload path. */
  const refreshAll = useCallback(async () => {
    const [doc, text, threadRes, versionRes] = await Promise.all([
      api.getDocument(documentId),
      api.getDocumentContent(documentId),
      api.listThreads(documentId, 'open'),
      api.listVersions(documentId),
    ]);
    setDocument(doc);
    setSource(text);
    setThreads(threadRes.threads);
    setCounts(threadRes.counts);
    setResolvedThreads(null);
    setVersions(versionRes.versions);
  }, [documentId]);

  useEffect(() => {
    refreshAll().catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setError('Could not load the document. Refresh to retry.');
    });
  }, [refreshAll]);

  /** Names for the "who's this from" avatar — guests can't list org users
   *  (outside their allowlisted surface), so they just see initials/ids. */
  useEffect(() => {
    if (me.role === 'guest') return;
    api
      .listOrgUsers()
      .then((res) => {
        setOrgUsers(res.users);
      })
      .catch(() => {
        /* Non-essential — avatars fall back to a generic mark. */
      });
  }, [me.role]);

  /** For the header search dropdown's project badge, and (once loaded) the
   *  document switcher below — guests never see either surface. */
  useEffect(() => {
    if (me.role === 'guest') return;
    api
      .listProjects()
      .then((res) => {
        setProjects(res.projects);
      })
      .catch(() => {
        /* Non-essential. */
      });
  }, [me.role]);

  /** Sibling documents in the same project, for the document switcher —
   *  refetched whenever the open document's project changes. Unfiled
   *  documents (`projectId === null`) have no siblings to switch between.
   *  Sourced from the same bounded, path-aware `getProjectTree` the sidebar
   *  uses (Phase 33.E) rather than the old unpaged `listDocuments` — a
   *  project with hundreds of docs used to mean fetching every one of them
   *  into a flat, ever-growing dropdown. */
  useEffect(() => {
    if (me.role === 'guest' || !document?.projectId) {
      setProjectTree(null);
      return;
    }
    api
      .getProjectTree(document.projectId)
      .then((res) => {
        setProjectTree(res);
      })
      .catch(() => {
        setProjectTree(null);
      });
  }, [me.role, document?.projectId]);

  useEffect(() => {
    if (!docSwitcherOpen) return;
    function onOutsideClick(e: MouseEvent): void {
      if (docSwitcherRef.current && !docSwitcherRef.current.contains(e.target as Node)) {
        setDocSwitcherOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setDocSwitcherOpen(false);
    }
    window.document.addEventListener('mousedown', onOutsideClick);
    window.document.addEventListener('keydown', onKeyDown);
    return () => {
      window.document.removeEventListener('mousedown', onOutsideClick);
      window.document.removeEventListener('keydown', onKeyDown);
    };
  }, [docSwitcherOpen]);

  /* One popover, anchored to the Share trigger, in both List and Bubbles
     mode — same outside-click + Escape pattern as the doc switcher above. */
  useEffect(() => {
    if (!sharing) return;
    function onOutsideClick(e: MouseEvent): void {
      if (sharePanelRef.current && !sharePanelRef.current.contains(e.target as Node)) {
        setSharing(false);
      }
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setSharing(false);
    }
    window.document.addEventListener('mousedown', onOutsideClick);
    window.document.addEventListener('keydown', onKeyDown);
    return () => {
      window.document.removeEventListener('mousedown', onOutsideClick);
      window.document.removeEventListener('keydown', onKeyDown);
    };
  }, [sharing]);

  /* Shortcuts popover — same outside-click + Escape pattern as Share above. */
  useEffect(() => {
    if (!shortcutsOpen) return;
    function onOutsideClick(e: MouseEvent): void {
      if (shortcutsRef.current && !shortcutsRef.current.contains(e.target as Node)) {
        setShortcutsOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setShortcutsOpen(false);
    }
    window.document.addEventListener('mousedown', onOutsideClick);
    window.document.addEventListener('keydown', onKeyDown);
    return () => {
      window.document.removeEventListener('mousedown', onOutsideClick);
      window.document.removeEventListener('keydown', onKeyDown);
    };
  }, [shortcutsOpen]);

  const authorsById = useMemo(() => new Map(orgUsers.map((u) => [u.id, u])), [orgUsers]);

  /**
   * Doc-scoped @mention candidates for the composer picker (ADR 0003 §D): the
   * document owner, everyone who has commented or replied here, and anyone
   * already mentioned on a thread — built from data already loaded, never the
   * org directory. The server re-resolves against the authoritative doc-scoped
   * set on store, so this list only has to be a good autocomplete, not the law.
   */
  const mentionCandidates = useMemo<MentionOption[]>(() => {
    const byId = new Map<string, string>();
    const add = (id: string | undefined, name: string | undefined): void => {
      if (id && name && id !== me.userId && !byId.has(id)) byId.set(id, name);
    };
    if (document) add(document.ownerId, authorsById.get(document.ownerId)?.displayName);
    for (const t of [...threads, ...(resolvedThreads ?? [])]) {
      add(t.comment.authorId, authorsById.get(t.comment.authorId)?.displayName);
      for (const r of t.replies) add(r.authorId, authorsById.get(r.authorId)?.displayName);
      for (const m of t.mentions) add(m.userId, m.displayName);
    }
    return [...byId].map(([userId, displayName]) => ({ userId, displayName }));
  }, [document, authorsById, threads, resolvedThreads, me.userId]);

  /** Fetch resolved threads on first use of Resolved, or once nothing is filtered. */
  useEffect(() => {
    if ((filter !== 'resolved' && filter !== null) || resolvedThreads !== null) return;
    api
      .listThreads(documentId, 'resolved')
      .then((res) => {
        setResolvedThreads(res.threads);
      })
      .catch(() => {
        setError('Could not load resolved comments.');
      });
  }, [filter, resolvedThreads, documentId]);

  /** A filter whose chip just disappeared (e.g. your last comment got
   *  deleted while "Mine" was active) shouldn't leave the view stuck empty
   *  on a dead filter — fall back to showing everything. */
  useEffect(() => {
    if (filter === null) return;
    const known = [...threads, ...(resolvedThreads ?? [])];
    if (filter === 'mine' && !known.some((t) => t.comment.authorId === me.userId)) {
      setFilter(null);
    } else if (filter === 'orphan' && !known.some((t) => t.resolution.method === 'orphan')) {
      setFilter(null);
    } else if (filter === 'suggestion' && !known.some((t) => t.comment.kind === 'suggestion')) {
      setFilter(null);
    } else if (filter === 'resolved' && counts.resolved === 0) {
      setFilter(null);
    }
  }, [filter, threads, resolvedThreads, counts.resolved, me.userId]);

  /** Old-version viewing: swap in that version's content, read-only. */
  useEffect(() => {
    if (!viewVersion) {
      setOldSource(null);
      return;
    }
    api
      .getVersionContent(documentId, viewVersion.id)
      .then(setOldSource)
      .catch(() => {
        setError(`Could not load v${String(viewVersion.seq)}.`);
        setViewVersion(null);
      });
  }, [viewVersion, documentId]);

  const viewingOld = viewVersion !== null && oldSource !== null;
  const shownSource = viewingOld ? oldSource : source;

  /* Re-apply highlights whenever threads or content change (current version
     only). Every thread gets a mark regardless of status — selecting a
     resolved comment must highlight its anchor exactly like an open one.
     railMode is a dependency even though marks don't depend on it: List and
     Bubbles mount contentColumn under different parent shapes, so React
     remounts it (a fresh MarkdownView, no marks) on every toggle — without
     railMode here, marks would never come back until some other dep changed. */
  useEffect(() => {
    const container = contentRef.current;
    if (!container || source.length === 0 || viewingOld) return;
    clearHighlights(container);
    for (const thread of [...threads, ...(resolvedThreads ?? [])]) {
      // Highlight where the anchor RESOLVES on this version — orphans get none.
      const { start, end } = thread.resolution;
      if (start === null || end === null || end <= start) continue;
      const exactNow = source.slice(start, end);
      const status = laneOf(thread);
      const mark = applyHighlight(
        container,
        {
          commentId: thread.comment.id,
          exact: exactNow,
          occurrence: anchorOccurrence(source, exactNow, start),
          start,
          end,
          status,
        },
        source,
      );
      // ADR 0007 decision 6: an accepted-but-unmaterialized suggestion, once
      // expanded (body mark click or card toggle — see the click handler
      // below and Thread's card), gets a client-side-only strike+insert
      // preview spliced right into the reading pane. Never touches `source`
      // or any data-src-* offset — a plain sibling element, stripped by
      // clearHighlights on the next pass so it can never accumulate.
      if (mark && status === 'accepted-pending' && expandedSuggestions.has(thread.comment.id)) {
        const runMarks = container.querySelectorAll(`mark[data-comment-id="${thread.comment.id}"]`);
        const lastMark = runMarks[runMarks.length - 1] ?? mark;
        const overlay = container.ownerDocument.createElement('span');
        overlay.className = 'anchor-suggestion-overlay';
        overlay.dataset.commentId = thread.comment.id;
        const del = container.ownerDocument.createElement('del');
        del.textContent = exactNow;
        overlay.appendChild(del);
        const proposed = thread.comment.proposedText ?? '';
        if (proposed.length > 0) {
          const ins = container.ownerDocument.createElement('ins');
          ins.textContent = proposed;
          overlay.appendChild(ins);
        } else {
          const em = container.ownerDocument.createElement('em');
          em.className = 'suggestion-delete-note';
          em.textContent = '(remove this text)';
          overlay.appendChild(em);
        }
        lastMark.parentNode?.insertBefore(overlay, lastMark.nextSibling);
      }
    }
    if (selectedId) {
      // An anchor can render as several <mark> fragments — one per leaf
      // crossed (bold/italic/link/paragraph boundaries, see anchors/
      // highlight.ts's structural path) — so this must promote all of
      // them, not just the first querySelector match, or only the first
      // fragment gets the --selected treatment and the rest silently stay
      // at their base status color.
      const marks = container.querySelectorAll(`mark[data-comment-id="${selectedId}"]`);
      for (const mark of marks) mark.classList.add('anchor-mark--selected');
      marks[0]?.scrollIntoView({ block: 'center' });
    }
  }, [threads, resolvedThreads, source, selectedId, viewingOld, railMode, expandedSuggestions]);

  /* Two-way sync: selecting a highlight scrolls the rail to its thread card.
     Inline mode scrolls the content instead (the highlight effect above
     already does that); its margin cards follow via the scroll-mirror effect. */
  useEffect(() => {
    if (!selectedId || railMode !== 'list') return;
    railRef.current
      ?.querySelector(`[data-thread-id="${selectedId}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, railMode]);

  const act = useCallback((fn: () => Promise<unknown>, refresh: () => Promise<void>) => {
    setError(null);
    fn()
      .then(refresh)
      .catch((e: unknown) => {
        setError(errorCopy(e));
      });
  }, []);

  /** Patches one thread's upvote state in place instead of refetching every
   *  open (and cached resolved) thread — a full refreshThreads() replaces
   *  the whole array with fresh objects, which reruns every threads-keyed
   *  layout effect (bubble placement recompute, gutter, minimap) for a
   *  single-field toggle. */
  const patchUpvote = useCallback((commentId: string, upvotes: ThreadDto['upvotes']) => {
    const apply = (list: ThreadDto[]): ThreadDto[] =>
      list.map((t) => (t.comment.id === commentId ? { ...t, upvotes } : t));
    setThreads((prev) => apply(prev));
    setResolvedThreads((prev) => (prev ? apply(prev) : prev));
  }, []);

  /** Resolve, but hold the thread in the open list until the finish sweep has
   *  had its ~500ms on screen — refreshThreads (which drops it from `threads`)
   *  waits on both the API call and a timer together, so the sweep never gets
   *  cut short by a fast response. */
  const resolveWithSweep = useCallback(
    (id: string, resolve: () => Promise<unknown>) => {
      setError(null);
      setSweepId(id);
      const sweepWindow = new Promise<void>((res) => {
        window.setTimeout(res, 500);
      });
      Promise.all([resolve(), sweepWindow])
        .then(refreshThreads)
        .catch((e: unknown) => {
          setError(errorCopy(e));
        })
        .finally(() => {
          setSweepId(null);
        });
    },
    [refreshThreads],
  );

  const captureSelection = useCallback((): void => {
    if (!canComment || viewingOld) return;
    const selection = window.getSelection();
    const container = contentRef.current;
    if (!selection || !container) return;
    if (selection.isCollapsed) return;
    // Selection must live inside the document content, not the rail or chrome.
    if (!container.contains(selection.anchorNode)) return;
    const anchor = captureTextAnchor(container, selection, source);
    setDraftAnchor(anchor ?? { type: 'document' });
    setDraftAnchorRect(
      anchor && selection.rangeCount > 0 ? selection.getRangeAt(0).getBoundingClientRect() : null,
    );
  }, [canComment, viewingOld, source]);

  /* MarkdownView reads this via ref rather than depending on it directly,
     so an inline arrow function here would no longer cause diagram
     remounts — kept as useCallback anyway so the `threads` closure below
     stays current without regenerating on every unrelated render. */
  const handleDiagramSelect = useCallback(
    (anchor: DiagramAnchorDto) => {
      if (viewingOld) return;
      // Same part already carries an open thread (the tinted case) — select
      // it instead of stacking a second draft on top.
      const existing = threads.find((t) => {
        const a = t.comment.anchor;
        return (
          a.type === 'diagram' &&
          a.blockIndex === anchor.blockIndex &&
          a.kind === anchor.kind &&
          JSON.stringify(a.stableId) === JSON.stringify(anchor.stableId)
        );
      });
      if (existing) {
        setSelectedId(existing.comment.id);
        setRailOpen(true);
        return;
      }
      setDraftAnchor(anchor);
      setDraftAnchorRect(null);
    },
    [viewingOld, threads],
  );

  const draftPopoverRef = useRef<HTMLDivElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);

  /** Clamps the anchored draft popover to the viewport — selecting text near
   *  the bottom or right edge otherwise renders it (partly) off-screen,
   *  since it's plain fixed positioning off the selection rect. Flips above
   *  the selection when there's no room below, same idea horizontally. */
  useLayoutEffect(() => {
    if (draftPhase !== 'anchor' || !draftAnchorRect) {
      setPopoverPos(null);
      return;
    }
    const margin = 8;
    const el = draftPopoverRef.current;
    const width = el?.offsetWidth ?? 280;
    const height = el?.offsetHeight ?? 160;
    let top = draftAnchorRect.bottom + margin;
    if (top + height > window.innerHeight - margin) {
      top = Math.max(margin, draftAnchorRect.top - height - margin);
    }
    const left = Math.min(
      Math.max(margin, draftAnchorRect.left),
      window.innerWidth - width - margin,
    );
    setPopoverPos({ top, left });
  }, [draftPhase, draftAnchorRect]);

  const cancelDraft = useCallback(() => {
    setDraftAnchor(null);
    setDraftAnchorRect(null);
  }, []);

  const submitDraft = useCallback(
    (body: string, proposedText: string | null = null) => {
      if (!draftAnchor) return;
      const anchor = draftAnchor;
      setDraftAnchor(null);
      setDraftAnchorRect(null);
      act(() => api.createComment(documentId, { body, anchor, proposedText }), refreshThreads);
    },
    [draftAnchor, documentId, act, refreshThreads],
  );

  /** Accept a suggestion (ADR 0007): metadata-only, no version is minted, so
   *  a plain refreshThreads is enough — same as reject below. The
   *  suggestion-only gate still gets its own honest copy (Core Principle 2: no
   *  silent retry, no guessing) — `suggestion_not_open` is now mapped in
   *  api/error-copy.ts with the same words, alongside every other code. */
  const acceptSuggestionAction = useCallback(
    (commentId: string) => {
      setError(null);
      api
        .acceptSuggestion(commentId)
        .then(() => refreshThreads())
        .catch((e: unknown) => {
          setError(errorCopy(e));
        });
    },
    [refreshThreads],
  );

  const rejectSuggestionAction = useCallback(
    (commentId: string) => {
      setError(null);
      api
        .rejectSuggestion(commentId)
        .then(() => refreshThreads())
        .catch((e: unknown) => {
          setError(errorCopy(e));
        });
    },
    [refreshThreads],
  );

  /* Touch devices: long-press selection never fires mouseup on iOS Safari,
     so watch selectionchange (debounced to let the drag handles settle). */
  useEffect(() => {
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    let timer = 0;
    function onSelectionChange(): void {
      window.clearTimeout(timer);
      timer = window.setTimeout(captureSelection, 600);
    }
    window.document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      window.clearTimeout(timer);
      window.document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [captureSelection]);

  const allThreads = useMemo(() => {
    if (filter === 'resolved') return resolvedThreads ?? [];
    if (filter === null) return [...threads, ...(resolvedThreads ?? [])];
    return threads;
  }, [filter, threads, resolvedThreads]);

  const visible = useMemo(() => {
    const base =
      filter === 'mine'
        ? allThreads.filter((t) => t.comment.authorId === me.userId)
        : filter === 'orphan'
          ? allThreads.filter((t) => t.resolution.method === 'orphan')
          : filter === 'suggestion'
            ? allThreads.filter((t) => t.comment.kind === 'suggestion')
            : allThreads;
    return [...base].sort((a, b) => {
      const fa = minimapFraction(a, source);
      const fb = minimapFraction(b, source);
      return fa - fb || a.comment.createdAt.localeCompare(b.comment.createdAt);
    });
  }, [allThreads, filter, me.userId, source]);

  /** The list mode's search input appears once the rail gets busy (ADR 0003 §C
   *  — "> ~8" threads); below that, scanning beats searching. */
  const railSearchable = threads.length > 8;

  /** Threads the in-rail search keeps: a case-insensitive match over the comment
   *  body or any reply body. Empty query keeps everything. */
  const railThreads = useMemo(() => {
    const q = railQuery.trim().toLowerCase();
    if (!q) return visible;
    return visible.filter(
      (t) =>
        t.comment.body.toLowerCase().includes(q) ||
        t.replies.some((r) => r.body.toLowerCase().includes(q)),
    );
  }, [visible, railQuery]);

  /** Server comment-search backs up the client filter: it counts matches in this
   *  document that are NOT in the loaded threads (typically resolved ones), so
   *  the reader learns a match exists beyond what the rail is showing. */
  useEffect(() => {
    const q = railQuery.trim();
    if (!railSearchable || q.length === 0) {
      setRailElsewhere(0);
      return;
    }
    let cancelled = false;
    const loadedIds = new Set(allThreads.map((t) => t.comment.id));
    const timer = setTimeout(() => {
      api
        .searchDocuments(q)
        .then((res) => {
          if (cancelled) return;
          const elsewhere = res.commentHits.filter(
            (h) => h.documentId === documentId && !loadedIds.has(h.commentId),
          ).length;
          setRailElsewhere(elsewhere);
        })
        .catch(() => {
          if (!cancelled) setRailElsewhere(0);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [railQuery, railSearchable, allThreads, documentId]);

  /** Scroll-invariant vertical position for one thread: the real DOM anchor
   *  mark when one exists (text anchors), the minimap's fraction-of-source
   *  estimate for diagrams or an unresolved mark, or the very top for
   *  whole-document comments — they have no position of their own, so they
   *  float as the first (topmost) bubble instead of a separate section. */
  function rawContentOffset(
    thread: ThreadDto,
    wrapRect: DOMRect,
    wrap: HTMLElement,
    container: HTMLElement,
  ): number {
    if (thread.comment.anchor.type === 'document') return 0;
    const mark = container.querySelector(`mark[data-comment-id="${thread.comment.id}"]`);
    return mark
      ? mark.getBoundingClientRect().top - wrapRect.top + wrap.scrollTop
      : minimapFraction(thread, source) * wrap.scrollHeight;
  }

  /* Bubble mode: anchor marks move whenever the content reflows for a
     reason the effect below can't see in its own dependencies — a window
     resize, a mermaid diagram finishing its async render, an image
     loading. A ResizeObserver on the content element catches all of these
     uniformly (its height changes for exactly the same reasons a mark's
     position would), and bumping a tick re-triggers the raw-offset pass. */
  useEffect(() => {
    if (railMode !== 'bubbles') return;
    const container = contentRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      setContentReflowTick((t) => t + 1);
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [railMode]);

  /* Bubble mode, pass 1: raw scroll-invariant vertical position per bubble.
     Runs after the highlight effect above has (re)applied marks for this
     render. Includes a virtual entry for the draft composer, if open. */
  useEffect(() => {
    if (railMode !== 'bubbles') return;
    const wrap = contentWrapRef.current;
    const container = contentRef.current;
    if (!wrap || !container) return;
    const wrapRect = wrap.getBoundingClientRect();
    const raw = new Map<string, number>();
    for (const thread of visible) {
      raw.set(thread.comment.id, rawContentOffset(thread, wrapRect, wrap, container));
    }
    if (draftAnchor) {
      // Whole-document drafts, and diagram drafts (no captured selection
      // rect to measure), float to the top like a pinned comment would.
      const top = draftAnchorRect ? draftAnchorRect.top - wrapRect.top + wrap.scrollTop : 0;
      raw.set(DRAFT_BUBBLE_ID, top);
    }
    setBubbleRawTops(raw);
  }, [
    railMode,
    visible,
    source,
    viewingOld,
    threads,
    draftAnchor,
    draftAnchorRect,
    outlineOpen,
    contentReflowTick,
  ]);

  /* Bubble mode, pass 2: assign each bubble a side and nudge it down enough
     to clear whatever's already been placed on that side, using heights
     actually rendered at the raw positions from pass 1. Always fills
     whichever side currently has more headroom — the "depending on where
     there's space" placement. Bubbles above the canvas (negative top) stay
     negative and scroll out of view like their anchor does.

     Two passes: the first run happens before any bubble has ever rendered
     at a real position, so every height reads as the fallback — a tall
     card and a one-line reply both measure the same, and they collide. One
     rAF later, the bubbles placed by that first pass are actually on
     screen and measurable, so a second pass corrects it. Heights don't
     change between the two, so this always settles. */
  useLayoutEffect(() => {
    if (railMode !== 'bubbles') return;
    function place(): Map<string, BubblePosition> {
      const ordered = [...bubbleRawTops.entries()].sort((a, b) => a[1] - b[1]);
      const placed = new Map<string, BubblePosition>();
      let leftCursor = -Infinity;
      let rightCursor = -Infinity;
      for (const [id, top] of ordered) {
        const height =
          bubbleCardRefs.current.get(id)?.getBoundingClientRect().height ?? BUBBLE_FALLBACK_HEIGHT;
        // Ties (both cursors equal — most commonly both still -Infinity, the
        // very first bubble placed) favor the right: a lone new comment on
        // light content should land where users expect a margin note to be,
        // not default left just because left came first in this comparison.
        // With the outline open, the left canvas is collapsed to 0 width
        // (freeing that space for the outline column instead of shrinking
        // content) — so every bubble goes right until it closes again.
        const side: BubbleSide = outlineOpen || rightCursor <= leftCursor ? 'right' : 'left';
        const cursor = side === 'left' ? leftCursor : rightCursor;
        const placedTop = Math.max(top, cursor);
        placed.set(id, { side, top: placedTop });
        const nextCursor = placedTop + height + BUBBLE_GAP;
        if (side === 'left') leftCursor = nextCursor;
        else rightCursor = nextCursor;
      }
      return placed;
    }
    setBubblePositions(place());
    const raf = requestAnimationFrame(() => {
      setBubblePositions(place());
    });
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [railMode, bubbleRawTops, outlineOpen]);

  /* Mirrors the content's scroll position onto both margin canvases so
     bubbles stay glued beside their anchor as the document scrolls — the
     columns scroll independently otherwise (each has its own overflow-y). */
  useEffect(() => {
    if (railMode !== 'bubbles') return;
    const wrap = contentWrapRef.current;
    const left = leftCanvasRef.current;
    const right = rightCanvasRef.current;
    if (!wrap || !left || !right) return;
    const onScroll = (): void => {
      const t = `translateY(${String(-wrap.scrollTop)}px)`;
      left.style.transform = t;
      right.style.transform = t;
    };
    onScroll();
    wrap.addEventListener('scroll', onScroll);
    return () => {
      wrap.removeEventListener('scroll', onScroll);
    };
  }, [railMode]);

  /* Margins are overflow-hidden viewports (their canvas is transformed, not
     scrolled — see the mirror effect above), so a wheel event over them
     never reaches anything scrollable. Forward it to the content column
     so scrolling works with the mouse anywhere over the document, margins
     included, not just the narrow content column itself. */
  const forwardMarginScroll = useCallback((e: WheelEvent) => {
    const wrap = contentWrapRef.current;
    if (!wrap) return;
    // deltaY is only pixels when deltaMode is 0 (most trackpads, Chrome
    // wheel) — Firefox's mouse wheel reports line units (mode 1, deltaY
    // ~3), which would crawl at raw value. Normalize like the browser's
    // own scroll math does.
    const delta =
      e.deltaMode === 1
        ? e.deltaY * 16
        : e.deltaMode === 2
          ? e.deltaY * wrap.clientHeight
          : e.deltaY;
    wrap.scrollTop += delta;
    e.preventDefault();
  }, []);

  const outline = useMemo(() => parseOutline(source), [source]);
  const sectionCounts = useMemo(
    () =>
      countBySection(
        outline,
        threads.map((t) => t.resolution.start),
      ),
    [outline, threads],
  );

  const gutter = useMemo(
    () => gutterSegments(outline, sectionCounts, source.length),
    [outline, sectionCounts, source.length],
  );

  /** Anchors for currently-open diagram threads — tints their SVG parts amber. */
  const openDiagramAnchors = useMemo(
    () =>
      threads
        .map((t) => t.comment.anchor)
        .filter((a): a is DiagramAnchorDto => a.type === 'diagram'),
    [threads],
  );

  const versionSeqById = useMemo(() => new Map(versions.map((v) => [v.id, v.seq])), [versions]);
  const currentSeq = versions.at(-1)?.seq ?? 1;

  /** Shared between list and inline rendering — same thread, same behavior.
   *  Each card is boundaried individually (see `threadCard` below), so one
   *  malformed thread costs its own card and not the entire conversation. */
  function renderThread(thread: ThreadDto): JSX.Element {
    return (
      <FeatureBoundary
        key={thread.comment.id}
        source="viewer-thread"
        /* Thread objects are replaced wholesale by refreshThreads, so any
           refetch (reply, resolve, upload) retries a failed card. */
        resetKey={thread}
        fallback={
          <FeatureFallback title="This comment couldn't be displayed. Refreshing usually fixes it." />
        }
      >
        {threadCard(thread)}
      </FeatureBoundary>
    );
  }

  function threadCard(thread: ThreadDto): JSX.Element {
    const fromSeq = versionSeqById.get(thread.comment.versionId);
    const behind = fromSeq !== undefined && fromSeq !== currentSeq;
    // Owner-or-org-admin — the exact signal accept/reject are gated to
    // server-side (the same one already driving canResolve/resolve and
    // ReviewControl's canManage). An open suggestion is actionable only
    // under that signal; anything else (resolved outcome, plain comment,
    // insufficient permission) renders no accept/reject controls at all.
    const isOpenSuggestion =
      thread.comment.kind === 'suggestion' && thread.comment.suggestionOutcome === 'open';
    const appliedSeq = thread.comment.appliedVersionId
      ? (versionSeqById.get(thread.comment.appliedVersionId) ?? null)
      : null;
    return (
      <Thread
        key={thread.comment.id}
        thread={thread}
        lane={laneOf(thread)}
        canComment={canComment}
        canResolve={canManage}
        canEditComment={thread.comment.authorId === me.userId}
        selected={thread.comment.id === selectedId}
        sweeping={thread.comment.id === sweepId}
        fromSeq={behind ? fromSeq : null}
        me={me}
        authorsById={authorsById}
        appliedSeq={appliedSeq}
        expanded={expandedSuggestions.has(thread.comment.id)}
        onToggleExpanded={() => {
          toggleSuggestionExpanded(thread.comment.id);
        }}
        onViewApplied={
          appliedSeq !== null
            ? () => {
                const v = versions.find((x) => x.id === thread.comment.appliedVersionId);
                if (v) {
                  setDiffFrom(null);
                  setViewVersion(v);
                }
              }
            : null
        }
        onAccept={
          isOpenSuggestion && canManage
            ? () => {
                acceptSuggestionAction(thread.comment.id);
              }
            : null
        }
        onReject={
          isOpenSuggestion && canManage
            ? () => {
                rejectSuggestionAction(thread.comment.id);
              }
            : null
        }
        onShowDiff={
          behind
            ? () => {
                const v = versions.find((x) => x.id === thread.comment.versionId);
                if (v) setDiffFrom(v);
              }
            : null
        }
        onSelect={() => {
          setSelectedId(thread.comment.id);
        }}
        onReply={(body, parentReplyId) => {
          act(() => api.addReply(thread.comment.id, body, parentReplyId), refreshThreads);
        }}
        onUpvote={() => {
          const commentId = thread.comment.id;
          const previous = thread.upvotes;
          patchUpvote(commentId, {
            mine: !previous.mine,
            count: previous.count + (previous.mine ? -1 : 1),
          });
          setError(null);
          api
            .toggleUpvote(commentId)
            .then((result) => {
              patchUpvote(commentId, { mine: result.upvoted, count: result.count });
            })
            .catch((e: unknown) => {
              patchUpvote(commentId, previous);
              setError(errorCopy(e));
            });
        }}
        onEdit={(body) => {
          act(() => api.editComment(thread.comment.id, body), refreshThreads);
        }}
        onDelete={() => {
          act(() => api.deleteComment(thread.comment.id), refreshThreads);
        }}
        onResolve={() => {
          resolveWithSweep(thread.comment.id, () => api.resolveComment(thread.comment.id));
        }}
      />
    );
  }

  function uploadVersionFile(
    file: File | null | undefined,
    changeNote: string | null = null,
  ): void {
    if (!file) return;
    void file.text().then((content) => {
      // Same client-side pre-check the homepage dropzone runs (ADR 0011) —
      // the server re-validates regardless; this just skips a doomed round
      // trip and says why in plain language.
      const rejection = precheckUpload(file, content);
      if (rejection !== undefined) {
        setError(`Not uploaded: ${file.name} ${uploadErrorCopy(rejection)}`);
        return;
      }
      setDiffFrom(null);
      setViewVersion(null);
      act(
        () => api.uploadVersion(documentId, content, changeNote),
        async () => {
          await refreshAll();
          setTriageSeq(currentSeq + 1);
        },
      );
    });
  }

  function copyFeedback(): void {
    setError(null);
    api
      .getFeedbackBundle(documentId)
      .then((bundle) => navigator.clipboard.writeText(bundle.prompt))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => {
          setCopied(false);
        }, 2000);
      })
      .catch(() => {
        setError('Could not copy the feedback bundle.');
      });
  }

  /* Keyboard review: j/k walk threads, e resolve, r reply, o toggle resolved. */
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        if (visible.length === 0) return;
        const at = visible.findIndex((t) => t.comment.id === selectedId);
        const next =
          e.key === 'j'
            ? visible[Math.min(at + 1, visible.length - 1)]
            : visible[Math.max(at <= 0 ? 0 : at - 1, 0)];
        if (next) setSelectedId(next.comment.id);
        setRailOpen(true);
      } else if (e.key === 'o') {
        setFilter((f) => (f === 'resolved' ? 'open' : 'resolved'));
      } else if (e.key === 'e' && selectedId && canManage) {
        const selected = visible.find((t) => t.comment.id === selectedId);
        if (selected?.comment.status === 'open') {
          resolveWithSweep(selectedId, () => api.resolveComment(selectedId));
        }
      } else if (e.key === 'r' && selectedId) {
        e.preventDefault();
        railRef.current
          ?.querySelector<HTMLInputElement>(`[data-thread-id="${selectedId}"] input[type="text"]`)
          ?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [visible, selectedId, canManage, resolveWithSweep]);

  // A file staged for upload — from a paste, the New version picker, or a
  // full-body drag-drop. The confirm step carries the optional "what
  // changed?" note (ADR 0003 §B); every entry point routes through it now.
  const [uploadCandidate, setUploadCandidate] = useState<File | null>(null);
  const [uploadNote, setUploadNote] = useState('');

  function clearUpload(): void {
    setUploadCandidate(null);
    setUploadNote('');
  }

  // The whole viewer body is the drop target (mirrors the homepage's
  // .content drop zone) — dropping a file stages it as the upload candidate
  // above rather than uploading instantly, so it gets the same confirm+note
  // dialog as the picker and paste paths.
  const { active: dropActive, dropTargetProps } = useDropTarget({
    onRawFiles: (files) => {
      setUploadCandidate(files[0] ?? null);
    },
    disabled: !canEdit,
  });

  /* Paste a copied markdown file anywhere in the viewer to upload it as a new version. */
  useEffect(() => {
    if (!canEdit) return;
    function onPaste(e: ClipboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      const file = e.clipboardData?.files[0];
      if (!file) return;
      e.preventDefault();
      setUploadCandidate(file);
    }
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('paste', onPaste);
    };
  }, [canEdit]);

  if (notFound) {
    return (
      <div className="viewer-missing empty">
        <h3>Document not found</h3>
        <p>It may have been deleted, or the link belongs to another organization.</p>
        <button type="button" className="btn" title="Back to documents" onClick={onBack}>
          <IconArrowLeft size={14} />
          Back to documents
        </button>
      </div>
    );
  }

  // Only offer filters that could actually narrow something — an empty
  // "Mine" or "Orphans" chip is a dead end, not a useful option.
  const knownThreads = [...threads, ...(resolvedThreads ?? [])];
  const hasMine = knownThreads.some((t) => t.comment.authorId === me.userId);
  const hasOrphan = knownThreads.some((t) => t.resolution.method === 'orphan');
  const hasSuggestion = knownThreads.some((t) => t.comment.kind === 'suggestion');
  const hasResolved = counts.resolved > 0;

  const filterChips: { key: ThreadFilter; label: string; count?: number }[] = [
    { key: 'open', label: 'Open', count: counts.open },
    ...(hasMine ? [{ key: 'mine' as const, label: 'Mine' }] : []),
    ...(hasOrphan ? [{ key: 'orphan' as const, label: 'Orphans' }] : []),
    ...(hasSuggestion ? [{ key: 'suggestion' as const, label: 'Suggestions' }] : []),
    ...(hasResolved
      ? [{ key: 'resolved' as const, label: 'Resolved', count: counts.resolved }]
      : []),
  ];

  /** Toggleable filters, several (or none) of which can be on at once — a
   *  button group, not tabs. Shared between List (sticky atop the rail) and
   *  Bubbles (its own toolbar row) mode, since it's the same control either
   *  way. */
  const filterChipsRow = (
    <div className="rail-chips" role="group" aria-label="Comment filters">
      {filterChips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          aria-pressed={filter === chip.key}
          className={`rail-chip${filter === chip.key ? ' rail-chip--on' : ''}`}
          title={
            filter === chip.key
              ? 'Click to clear this filter'
              : `Show ${chip.label.toLowerCase()} comments`
          }
          onClick={() => {
            setFilter((f) => (f === chip.key ? null : chip.key));
          }}
        >
          {chip.label}
          {chip.count !== undefined && <span className="rail-chip-count">{chip.count}</span>}
        </button>
      ))}
    </div>
  );

  const outlinePanel = (
    <OutlinePanel
      open={outlineOpen}
      outline={outline}
      openCounts={sectionCounts}
      onToggle={() => {
        setOutlineOpen((o) => !o);
      }}
      onClose={() => {
        setOutlineOpen(false);
      }}
      onPick={(entry) => {
        const heading = contentRef.current?.querySelectorAll('h1,h2,h3,h4,h5,h6')[entry.index];
        heading?.scrollIntoView({ block: 'start' });
        setOutlineOpen(false);
      }}
    />
  );

  /** Shared between List and Bubbles mode — same content, same handlers. */
  const contentColumn = (
    <div className="viewer-content-wrap" ref={contentWrapRef}>
      {triageSeq !== null && (
        <TriagePanel
          threads={threads}
          newSeq={triageSeq}
          canResolve={canManage}
          onSelect={(id) => {
            setSelectedId(id);
            setRailOpen(true);
          }}
          onResolve={(id) => {
            resolveWithSweep(id, () => api.resolveComment(id));
          }}
          onClose={() => {
            setTriageSeq(null);
          }}
        />
      )}
      {viewingOld && (
        <div className="banner-info" role="status">
          Viewing v{viewVersion.seq} — read-only. Comments always pin to the current version.
          {viewVersion.changeNote ? ` — ${viewVersion.changeNote}` : ''}
        </div>
      )}
      <div
        ref={contentRef}
        className={`viewer-content${quietMarks ? ' viewer-content--quiet-marks' : ''}`}
        data-testid="viewer-content"
        onMouseUp={captureSelection}
        onClick={(e) => {
          const mark = (e.target as Element).closest('mark.anchor-mark');
          const id = mark?.getAttribute('data-comment-id');
          if (id) {
            setSelectedId(id);
            setRailOpen(true);
            // Quiet mark, click to reveal (ADR 0007 decision 6) — fires
            // alongside the ordinary select-and-open-rail behavior above,
            // never instead of it.
            if (mark?.classList.contains('anchor-mark--accepted-pending')) {
              toggleSuggestionExpanded(id);
            }
          }
        }}
      >
        {/* The document body is the one thing on this screen that must never
            take the page with it: a render throw here used to blank the SPA,
            losing the rail, the header, and any half-written comment. Reset on
            the shown source, so switching legs — or a new upload fixing the
            markdown that broke — always gets a fresh attempt. Anchoring,
            highlighting and diagram selection are all dead in the fallback (no
            rendered DOM to anchor into), which is why it says so plainly
            instead of pretending the document is merely unstyled. */}
        <FeatureBoundary
          source="viewer-document"
          resetKey={shownSource}
          fallback={
            <FeatureFallback title="This document couldn't be displayed — here is its source. Commenting is unavailable until it renders.">
              <pre className="feature-fallback-source">
                <code>{shownSource}</code>
              </pre>
            </FeatureFallback>
          }
        >
          <MarkdownView
            source={shownSource}
            dark={dark}
            onDiagramSelect={handleDiagramSelect}
            {...(!viewingOld && { openDiagramAnchors })}
          />
        </FeatureBoundary>
      </div>
    </div>
  );

  /** Bubbles on one side, in top-to-bottom order — the draft composer is a
   *  bubble too, once it has been assigned a side by the layout effect. */
  function bubbleEntries(side: BubbleSide): { id: string; top: number; node: JSX.Element }[] {
    const entries: { id: string; top: number; node: JSX.Element }[] = [];
    for (const thread of visible) {
      const pos = bubblePositions.get(thread.comment.id);
      if (pos?.side !== side) continue;
      entries.push({ id: thread.comment.id, top: pos.top, node: renderThread(thread) });
    }
    // Still in its anchor phase (see draftPhase decl.) — rendered as a
    // floating overlay at the selection instead, not in either lane yet.
    const draftPos =
      draftAnchor && draftPhase === 'lane' ? bubblePositions.get(DRAFT_BUBBLE_ID) : undefined;
    if (draftAnchor && draftPos?.side === side) {
      entries.push({
        id: DRAFT_BUBBLE_ID,
        top: draftPos.top,
        node: (
          <Composer
            documentId={documentId}
            anchor={draftAnchor}
            candidates={mentionCandidates}
            onCancel={cancelDraft}
            onSubmit={submitDraft}
          />
        ),
      });
    }
    return entries.sort((a, b) => a.top - b.top);
  }

  return (
    <div className="viewer">
      {uploadCandidate && (
        <ConfirmDialog
          title={`Upload "${uploadCandidate.name}" as v${String(currentSeq + 1)}?`}
          body={
            document?.path != null
              ? "This document is linked to a local folder. Uploading here replaces what's currently on screen — and the next vorlyn push from that folder will silently overwrite it again, since the repo stays the source of truth."
              : "This replaces what's currently on screen for anyone viewing this document."
          }
          confirmLabel="Upload"
          extra={
            <label className="upload-note-field">
              <span className="upload-note-label">What changed? (optional)</span>
              <input
                type="text"
                value={uploadNote}
                maxLength={MAX_CHANGE_NOTE}
                placeholder="e.g. Reworked the intro"
                onChange={(e) => {
                  setUploadNote(e.target.value);
                }}
              />
            </label>
          }
          onConfirm={() => {
            uploadVersionFile(uploadCandidate, uploadNote.trim() || null);
            clearUpload();
          }}
          onCancel={clearUpload}
        />
      )}
      {diffFrom && (
        <DiffView
          documentId={documentId}
          fromVersionId={diffFrom.id}
          fromSeq={diffFrom.seq}
          toSeq={currentSeq}
          currentSource={source}
          dark={dark}
          onClose={() => {
            setDiffFrom(null);
          }}
          // Compare here always diffs against the current version (toSeq =
          // currentSeq), so the open threads' current-version offsets describe
          // the same version `source` is — safe to overlay as block chips.
          threads={threads}
          onOpenThread={(commentId, openRail) => {
            setSelectedId(commentId);
            if (openRail) setRailOpen(true);
          }}
        />
      )}
      {onOpenDocument && onLogout ? (
        <AppHeader
          me={me}
          mode={mode}
          setMode={setMode}
          onLogout={onLogout}
          onNavigateHome={onBack}
          onOpenDocument={onOpenDocument}
          onOpenSettings={onOpenOrgSettings}
          projects={projects}
        >
          <div className="mode-toggle-inline" role="group" aria-label="Comment view">
            <button
              type="button"
              className={`btn btn-ghost btn-icon${railMode === 'list' ? ' mode-toggle-inline--on' : ''}`}
              aria-pressed={railMode === 'list'}
              aria-label="Show comments as a list"
              title="Show comments as a list"
              onClick={() => {
                setRailMode('list');
              }}
            >
              <IconListView size={14} />
            </button>
            <button
              type="button"
              className={`btn btn-ghost btn-icon${railMode === 'bubbles' ? ' mode-toggle-inline--on' : ''}`}
              aria-pressed={railMode === 'bubbles'}
              aria-label="Show comments as bubbles beside the content"
              title="Show comments as bubbles beside the content"
              onClick={() => {
                setRailMode('bubbles');
              }}
            >
              <IconMarginBubbles size={14} />
            </button>
          </div>
        </AppHeader>
      ) : (
        // Guest sessions: no home, no org surface, no cross-document search
        // or logout to offer — same mode/theme controls, but built from
        // AppHeader's own classes (not the retired .topbar/.topbar-user)
        // so there's exactly one header layout in the CSS, not two.
        <header className="app-header">
          <BrandMark inline />
          <div className="app-header-sticky">
            <div className="mode-toggle-inline" role="group" aria-label="Comment view">
              <button
                type="button"
                className={`btn btn-ghost btn-icon${railMode === 'list' ? ' mode-toggle-inline--on' : ''}`}
                aria-pressed={railMode === 'list'}
                aria-label="Show comments as a list"
                title="Show comments as a list"
                onClick={() => {
                  setRailMode('list');
                }}
              >
                <IconListView size={14} />
              </button>
              <button
                type="button"
                className={`btn btn-ghost btn-icon${railMode === 'bubbles' ? ' mode-toggle-inline--on' : ''}`}
                aria-pressed={railMode === 'bubbles'}
                aria-label="Show comments as bubbles beside the content"
                title="Show comments as bubbles beside the content"
                onClick={() => {
                  setRailMode('bubbles');
                }}
              >
                <IconMarginBubbles size={14} />
              </button>
            </div>
            <ThemeToggle mode={mode} setMode={setMode} />
          </div>
        </header>
      )}

      {/* Document-specific chrome — every document function lives here, not
          in AppHeader above, which stays the same regardless of what
          document (or screen) is open. Back nav + title live here too (not
          in AppHeader) since both are specific to the document currently
          open, not app-wide chrome. */}
      <div className="document-header">
        <div className="document-header-left">
          <div className="document-title-block">
            {document?.path != null && <Breadcrumb path={document.path} />}
            <h2>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={onBack}
                aria-label="Back to documents"
                title="Back to documents"
              >
                <IconArrowLeft />
              </button>
              {onOpenDocument && projectTree && projectTree.documentCount > 1 ? (
                <div className="doc-switcher" ref={docSwitcherRef}>
                  <button
                    type="button"
                    className="doc-title doc-title--switcher"
                    aria-haspopup="listbox"
                    aria-expanded={docSwitcherOpen}
                    title="Switch to another document in this project"
                    onClick={() => {
                      setDocSwitcherOpen((o) => !o);
                    }}
                  >
                    {document?.title ?? '…'}
                    <IconVorlynDown size={14} />
                  </button>
                  {docSwitcherOpen &&
                    (projectTree.tooLarge ? (
                      <div className="doc-switcher-menu doc-switcher-menu--too-large">
                        <p className="help-text">
                          {projectTree.documentCount} documents — too many to browse here. Open the
                          project from the sidebar to see the full tree.
                        </p>
                      </div>
                    ) : (
                      <div className="doc-switcher-menu">
                        <ProjectTree
                          projectId={projectTree.projectId}
                          tree={buildPathTree(projectTree.documents)}
                          onOpen={(id) => {
                            setDocSwitcherOpen(false);
                            if (id !== documentId) onOpenDocument(id);
                          }}
                          currentDocumentId={documentId}
                          asListbox
                          persistCollapseState={false}
                          onEscape={() => {
                            setDocSwitcherOpen(false);
                          }}
                        />
                      </div>
                    ))}
                </div>
              ) : (
                <span className="doc-title">{document?.title ?? '…'}</span>
              )}
            </h2>
          </div>
          <span
            className="doc-meta"
            title={`v${String(currentSeq)} — the latest version of this document`}
          >
            v{currentSeq}
          </span>
          <span className="doc-meta">{counts.open} open</span>
          {!canComment && <span className="doc-signal doc-signal--clear">read-only</span>}
        </div>
        <div className="document-header-right">
          <ReviewControl
            documentId={documentId}
            me={me}
            canManage={canManage}
            onChanged={() => {
              void refreshAll();
            }}
            onPendingVerdictChange={setReviewerPendingVerdict}
          />
          {canComment && !viewingOld && (
            <button
              type="button"
              className={`btn${addCommentPrimary ? ' btn-primary' : ''}`}
              title={draftAnchor ? 'Finish or cancel the open draft first' : 'Add comment'}
              disabled={!!draftAnchor}
              onClick={() => {
                setDraftAnchor({ type: 'document' });
                setDraftAnchorRect(null);
              }}
            >
              <IconMessage size={14} />
              Add comment
            </button>
          )}
          {me.role !== 'guest' && (
            <button
              type="button"
              className="btn"
              title={
                copied ? 'Copied' : counts.open === 0 ? 'No open comments to copy' : 'Copy feedback'
              }
              disabled={counts.open === 0}
              onClick={copyFeedback}
            >
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
              Copy feedback
            </button>
          )}
          {/* Sharing (ADR 0014): owner/org-admin, or a `share`/`edit`
              grantee — `edit` inherits `share` by lattice, so an `edit`
              holder can also re-share, not just push new versions.
              `SharePanel` caps what a non-manager caller may delegate. */}
          {/* `&& document` is a no-op at runtime (`canShare` already implies
              it — see canShare's own comment) but gives TS a narrowing
              anchor for `document.title` below; `canManage`'s own definition
              narrows directly, `canShare`'s `||` across unrelated subjects
              doesn't. */}
          {canShare && document && (
            <div className="share-anchor" ref={sharePanelRef}>
              <button
                type="button"
                className={`btn${sharing ? ' mode-toggle-inline--on' : ''}`}
                aria-haspopup="dialog"
                aria-expanded={sharing}
                title="Share this document"
                onClick={() => {
                  setSharing((s) => !s);
                }}
              >
                <IconShare size={14} />
              </button>
              {sharing && (
                <SharePanel
                  documentId={documentId}
                  documentTitle={document.title}
                  myPermission={myPermission}
                  canManage={canManage}
                  me={me}
                  onClose={() => {
                    setSharing(false);
                  }}
                />
              )}
            </div>
          )}
          {canEdit && (
            <>
              <button
                type="button"
                className="btn btn-primary"
                data-testid="version-upload-button"
                title="Upload a new version"
                onClick={() => versionFileRef.current?.click()}
              >
                <IconUpload size={14} />
                New version
              </button>
              <input
                ref={versionFileRef}
                type="file"
                accept=".md,.markdown,text/markdown,text/plain"
                hidden
                data-testid="version-file-input"
                onChange={(e) => {
                  setUploadCandidate(e.target.files?.[0] ?? null);
                  e.target.value = '';
                }}
              />
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="viewer-error-slot">
          <div className="banner-error" role="alert">
            {error}
          </div>
        </div>
      )}

      <VersionStrip
        versions={versions}
        currentVersionId={document?.currentVersionId ?? null}
        viewingId={viewVersion?.id ?? null}
        onView={(v) => {
          setDiffFrom(null);
          setViewVersion(v);
        }}
        onDiff={(from) => {
          setViewVersion(null);
          setDiffFrom(from);
        }}
      />

      <div
        className={`viewer-body${railMode === 'bubbles' ? ' viewer-body--bubbles' : ''}${
          railMode === 'list' && outlineOpen ? ' viewer-body--outline' : ''
        }`}
        data-testid="viewer-body"
        {...dropTargetProps}
      >
        {dropActive && canEdit && (
          <DropOverlay
            label="Drop to ship a new version"
            hint="Markdown, up to 500 KB — replaces the current version"
          />
        )}
        {/* Shared between list and bubbles mode: a rect-anchored draft is
            pinned right at the selection while composing, in both modes —
            it only reaches the rail/margin once actually posted. */}
        {draftAnchor && draftAnchorRect && draftPhase === 'anchor' && (
          <div
            ref={draftPopoverRef}
            className="draft-anchor-popover"
            style={popoverPos ?? { top: draftAnchorRect.bottom + 8, left: draftAnchorRect.left }}
          >
            <Composer
              documentId={documentId}
              anchor={draftAnchor}
              candidates={mentionCandidates}
              onCancel={cancelDraft}
              onSubmit={submitDraft}
            />
          </div>
        )}

        {railMode === 'list' ? (
          <>
            {outlinePanel}

            {contentColumn}

            <aside
              ref={railRef}
              className={`comment-rail${railOpen ? ' comment-rail--open' : ''}`}
              aria-label="Comments"
            >
              <div className="rail-close-row">
                {filterChipsRow}
                {/* Keyboard shortcuts used to be a permanent footer bar —
                    fixed cost on every view even with zero comments. A
                    trigger + popover (Linear/Superhuman pattern) gives the
                    same discoverability for free screen space instead. */}
                <div className="rail-shortcuts-anchor" ref={shortcutsRef}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    aria-haspopup="dialog"
                    aria-expanded={shortcutsOpen}
                    aria-label="Keyboard shortcuts"
                    title="Keyboard shortcuts"
                    onClick={() => {
                      setShortcutsOpen((s) => !s);
                    }}
                  >
                    <IconHelp size={14} />
                  </button>
                  {shortcutsOpen && (
                    <div
                      className="rail-shortcuts-popover"
                      role="dialog"
                      aria-label="Keyboard shortcuts"
                    >
                      <dl>
                        <dt>j / k</dt>
                        <dd>walk comments</dd>
                        <dt>e</dt>
                        <dd>resolve</dd>
                        <dt>r</dt>
                        <dd>reply</dd>
                        <dt>o</dt>
                        <dd>toggle resolved</dd>
                      </dl>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon rail-close"
                  aria-label="Close comments"
                  title="Close comments"
                  onClick={() => {
                    setRailOpen(false);
                  }}
                >
                  <IconX size={14} />
                </button>
              </div>
              <div className="rail-scroll">
                {/* In-rail comment search — only once the rail is busy enough that
                    scanning stops working (ADR 0003 §C). Rail chrome, never the
                    app header (that's document search). */}
                {railSearchable && (
                  <div className="rail-search">
                    <input
                      type="search"
                      aria-label="Search comments"
                      placeholder="Search comments…"
                      value={railQuery}
                      onChange={(e) => {
                        setRailQuery(e.target.value);
                      }}
                    />
                  </div>
                )}
                {/* Rect-anchored drafts stay pinned at the selection (the
                    draft-anchor-popover rendered above, shared with bubbles
                    mode) until posted — they only land here once they're a
                    real thread. Rect-less drafts (whole-document/diagram) have
                    nowhere to pin to, so they open directly in the rail. */}
                {draftAnchor && draftPhase === 'lane' && (
                  <Composer
                    documentId={documentId}
                    anchor={draftAnchor}
                    candidates={mentionCandidates}
                    onCancel={cancelDraft}
                    onSubmit={submitDraft}
                  />
                )}
                {visible.length === 0 && !draftAnchor && (
                  <div className="empty">
                    <h3>No comments yet</h3>
                    <p>
                      {canComment
                        ? 'Select any text in the document to start a thread.'
                        : 'You have read access — comments will appear here.'}
                    </p>
                  </div>
                )}
                {railQuery.trim() !== '' && railThreads.length === 0 && (
                  <p className="rail-search-empty" role="status">
                    No loaded threads match “{railQuery.trim()}”.
                  </p>
                )}
                {railThreads.map((thread) => renderThread(thread))}
                {railElsewhere > 0 && (
                  <p className="rail-search-elsewhere" role="status">
                    {railElsewhere} more matching {railElsewhere === 1 ? 'comment' : 'comments'} in
                    resolved or filtered threads.
                  </p>
                )}
              </div>
            </aside>

            <Minimap
              threads={visible}
              source={source}
              gutter={gutter}
              selectedId={selectedId}
              onPick={(id) => {
                setSelectedId(id);
                setRailOpen(true);
              }}
            />

            <button
              type="button"
              className="rail-fab btn btn-primary"
              aria-label="Show comments"
              title="Show comments"
              onClick={() => {
                setRailOpen(true);
              }}
            >
              <IconMessage size={14} /> {counts.open}
            </button>
          </>
        ) : (
          <div className="bubbles-layout">
            {/* No rail exists in this mode — the filter chips get their own
                slim toolbar row instead of the rail's sticky header. */}
            <div className="bubbles-chips-toolbar">{filterChipsRow}</div>
            <div className={`bubbles-row${outlineOpen ? ' bubbles-row--outline' : ''}`}>
              {outlinePanel}
              <div className="bubble-canvas bubble-canvas--left" onWheel={forwardMarginScroll}>
                <div className="bubble-canvas-inner" ref={leftCanvasRef}>
                  {bubbleEntries('left').map(({ id, top, node }) => (
                    <div
                      key={id}
                      ref={(el) => {
                        if (el) bubbleCardRefs.current.set(id, el);
                        else bubbleCardRefs.current.delete(id);
                      }}
                      className="bubble-card"
                      style={{ top }}
                    >
                      {node}
                    </div>
                  ))}
                </div>
              </div>

              {contentColumn}

              <div className="bubble-canvas bubble-canvas--right" onWheel={forwardMarginScroll}>
                {visible.length === 0 && !draftAnchor && (
                  <div className="empty bubbles-empty">
                    <h3>
                      {filter === 'open' || filter === null ? 'No comments yet' : 'Nothing here'}
                    </h3>
                    <p>
                      {filter !== 'open' && filter !== null
                        ? 'No comments match this filter.'
                        : canComment
                          ? 'Select any text in the document to start a thread.'
                          : 'You have read access — comments will appear here.'}
                    </p>
                  </div>
                )}
                <div className="bubble-canvas-inner" ref={rightCanvasRef}>
                  {bubbleEntries('right').map(({ id, top, node }) => (
                    <div
                      key={id}
                      ref={(el) => {
                        if (el) bubbleCardRefs.current.set(id, el);
                        else bubbleCardRefs.current.delete(id);
                      }}
                      className="bubble-card"
                      style={{ top }}
                    >
                      {node}
                    </div>
                  ))}
                </div>
              </div>

              <Minimap
                threads={visible}
                source={source}
                gutter={gutter}
                selectedId={selectedId}
                onPick={(id) => {
                  setSelectedId(id);
                  setRailOpen(true);
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Thin heat strip on the content's left edge: pure signal, not interactive. */
function Minimap({
  threads,
  source,
  gutter,
  selectedId,
  onPick,
}: {
  threads: ThreadDto[];
  source: string;
  /** Comment-density segments, same fraction-of-source convention as the
   *  ticks below — rendered as a subdued background layer so the ticks stay
   *  the dominant signal. */
  gutter: ReturnType<typeof gutterSegments>;
  selectedId: string | null;
  onPick: (id: string) => void;
}): JSX.Element {
  return (
    <div className="minimap" data-testid="minimap" aria-label="Comment minimap">
      <div className="minimap-density" data-testid="minimap-density" aria-hidden="true">
        {gutter.map((seg, i) => (
          <div
            key={i}
            className="minimap-density-segment"
            style={{
              top: `${String(seg.topFraction * 100)}%`,
              height: `${String(seg.heightFraction * 100)}%`,
              opacity: seg.opacity,
            }}
          />
        ))}
      </div>
      {threads.map((t) => {
        const lane = laneOf(t);
        return (
          <button
            key={t.comment.id}
            type="button"
            className={`minimap-tick minimap-tick--${lane}${
              t.comment.id === selectedId ? ' minimap-tick--selected' : ''
            }`}
            style={{ top: `${String(minimapFraction(t, source) * 100)}%` }}
            title={quoteOf(t.comment.anchor)}
            aria-label={`${lane} comment: ${t.comment.body.slice(0, 40)}`}
            onClick={() => {
              onPick(t.comment.id);
            }}
          />
        );
      })}
    </div>
  );
}

export function Composer({
  documentId,
  anchor,
  candidates,
  onSubmit,
  onCancel,
}: {
  documentId: string;
  anchor: AnchorDto;
  /** Doc-scoped @mention candidates for the picker (ADR 0003 §D). */
  candidates: MentionOption[];
  onSubmit: (body: string, proposedText?: string | null) => void;
  onCancel: () => void;
}): JSX.Element {
  // Drafts survive reloads and accidental navigation — session-scoped, per doc.
  const [body, setBody] = useState(() => sessionStorage.getItem(draftKey(documentId)) ?? '');
  const taRef = useRef<HTMLTextAreaElement>(null);
  // The @mention picker: open only while the caret sits inside an @token that
  // matches at least one doc-scoped candidate. `index` is the keyboard cursor.
  const [menu, setMenu] = useState<{
    start: number;
    options: MentionOption[];
    index: number;
  } | null>(null);
  function refreshMenu(value: string, caret: number): void {
    const active = activeMentionQuery(value, caret);
    if (!active) {
      setMenu(null);
      return;
    }
    const options = filterMentionCandidates(candidates, active.query);
    setMenu(options.length > 0 ? { start: active.start, options, index: 0 } : null);
  }
  function pickMention(option: MentionOption): void {
    const ta = taRef.current;
    if (!ta || !menu) return;
    const caret = ta.selectionStart;
    const before = body.slice(0, menu.start);
    const insert = mentionInsertText(option.displayName);
    const next = `${before}${insert} ${body.slice(caret)}`;
    persist(next);
    setMenu(null);
    const pos = before.length + insert.length + 1;
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  }
  // Suggestions require a text anchor server-side (there's nothing to splice
  // on a whole-document or diagram anchor) — the toggle only ever appears
  // when there's a range to propose a replacement for.
  const canSuggest = anchor.type === 'text';
  const [suggesting, setSuggesting] = useState(false);
  // Prefilled with the anchored/selected text — the common case is trimming
  // or rewording it, not starting from a blank slate. Empty is still a valid
  // "delete this" proposal (ADR 0002 C.1).
  const [proposedText, setProposedText] = useState(() =>
    anchor.type === 'text' ? anchor.exact : '',
  );
  function persist(next: string): void {
    setBody(next);
    if (next.length > 0) sessionStorage.setItem(draftKey(documentId), next);
    else sessionStorage.removeItem(draftKey(documentId));
  }
  function submit(): void {
    if (body.trim().length === 0) return;
    sessionStorage.removeItem(draftKey(documentId));
    onSubmit(body.trim(), suggesting ? proposedText : null);
  }
  return (
    <div className="composer" data-testid="composer">
      <blockquote className="composer-quote">{quoteOf(anchor)}</blockquote>
      <div className="composer-field">
        <textarea
          ref={taRef}
          aria-label="Comment"
          placeholder="What needs to change? (@ to mention, Enter to post, Shift+Enter for a new line)"
          value={body}
          maxLength={MAX_COMMENT_LENGTH}
          autoFocus
          onChange={(e) => {
            persist(e.target.value);
            refreshMenu(e.target.value, e.target.selectionStart);
          }}
          onClick={(e) => {
            refreshMenu(body, e.currentTarget.selectionStart);
          }}
          onKeyDown={(e) => {
            if (menu) {
              const n = menu.options.length;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMenu({ ...menu, index: (menu.index + 1) % n });
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMenu({ ...menu, index: (menu.index - 1 + n) % n });
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                const picked = menu.options[menu.index];
                if (picked) pickMention(picked);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setMenu(null);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {menu && (
          <ul className="mention-menu" role="listbox" aria-label="Mention someone">
            {menu.options.map((option, i) => (
              <li key={option.userId} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={i === menu.index}
                  className={`mention-option${i === menu.index ? ' mention-option--active' : ''}`}
                  // Keep the textarea's caret — mousedown fires before blur.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickMention(option);
                  }}
                >
                  @{option.displayName}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <CharCount length={body.length} />
      {canSuggest && (
        <button
          type="button"
          className={`btn btn-ghost composer-suggest-toggle${suggesting ? ' composer-suggest-toggle--on' : ''}`}
          aria-pressed={suggesting}
          title={
            suggesting
              ? 'Plain comment instead — no proposed replacement text'
              : 'Suggest an edit — propose replacement text for the anchored range'
          }
          onClick={() => {
            setSuggesting((s) => !s);
          }}
        >
          <IconGitCompare size={13} />
          Suggest an edit
        </button>
      )}
      {suggesting && (
        <div className="composer-suggestion" data-testid="composer-suggestion">
          <label className="sidebar-heading" htmlFor="proposed-text">
            Proposed replacement
          </label>
          <textarea
            id="proposed-text"
            aria-label="Proposed replacement text"
            placeholder="Leave blank to propose removing the anchored text entirely."
            value={proposedText}
            maxLength={MAX_PROPOSED_TEXT_LENGTH}
            onChange={(e) => {
              setProposedText(e.target.value);
            }}
          />
        </div>
      )}
      <div className="composer-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={body.trim().length === 0}
          title={suggesting ? 'Post suggestion' : 'Post comment'}
          onClick={submit}
        >
          <IconCheck size={14} />
          Post
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-icon--cancel"
          title="Cancel"
          aria-label="Cancel"
          onClick={onCancel}
        >
          <IconX size={14} />
        </button>
      </div>
    </div>
  );
}

/**
 * A comment body with its stored @mentions highlighted quietly (ADR 0003 §D) —
 * only tokens that resolved to a real mention are marked, so the highlight never
 * implies someone was notified who wasn't. No new hue: `.mention` reuses the
 * conversation blue as a weight, not a fill.
 */
function CommentBody({ body, mentions }: { body: string; mentions: MentionDto[] }): JSX.Element {
  const slugs = useMemo(() => new Set(mentions.map((m) => mentionSlug(m.displayName))), [mentions]);
  if (slugs.size === 0) return <>{body}</>;
  return (
    <>
      {/* Safe variant: highlighting is decoration, the words are the point —
          see segmentMentionsSafe (mentions.ts) for why it degrades to the
          unsegmented body rather than throwing out of the rail. */}
      {segmentMentionsSafe(body, slugs).map((seg, i) =>
        seg.mention ? (
          <span key={i} className="mention" data-testid="mention">
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/** "via <key name>" — shown when a comment/reply/version came through an
 *  API key rather than a signed-in browser session. Says nothing about who
 *  held the key (agent, script, or a human on the CLI). */
function ViaKeyChip({ viaApiKeyName }: { viaApiKeyName: string | null }): JSX.Element | null {
  if (viaApiKeyName === null) return null;
  return (
    <span className="via-key-chip" title={`Created via API key "${viaApiKeyName}"`}>
      via {viaApiKeyName}
    </span>
  );
}

/** Confidence badge for re-anchored comments: how the anchor was found.
 *  Plain language, not a percentage (ADR 0003 §F.2) — >=0.9 stays silent
 *  (extends the old exact-match silence), the 0.6-0.9 band gets a words-only
 *  badge with the raw number moved to the tooltip, and <0.6 is the orphan
 *  path (Core Principle 2), untouched here — its own note carries the
 *  message. */
function ResolutionBadge({ thread }: { thread: ThreadDto }): JSX.Element | null {
  const { method, confidence } = thread.resolution;
  if (method === 'orphan') return null; // the orphan note carries the message
  if (confidence >= 0.9) return null;
  return (
    <span
      className="thread-badge"
      title={`Re-anchored on the current version · ${String(Math.round(confidence * 100))}%`}
    >
      Moved — check this still fits
    </span>
  );
}

function initialsOf(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase();
  return ((parts[0]?.[0] ?? '') + (parts.at(-1)?.[0] ?? '')).toUpperCase();
}

/** Who a comment or reply is from — initials avatar, full name/email on hover.
 *  Guests and anyone outside the org directory fall back to a bare mark. */
function Avatar({
  authorId,
  authorsById,
  me,
}: {
  authorId: string;
  authorsById: Map<string, OrgUserDto>;
  me: Me;
}): JSX.Element {
  const user = authorsById.get(authorId);
  const isMe = authorId === me.userId;
  const name = user?.displayName ?? user?.email ?? undefined;
  const tooltip = isMe
    ? `You${user?.email ? ` (${user.email})` : ''}`
    : (name ?? 'Unknown user (not in your org directory)');
  return (
    <span className="thread-avatar" title={tooltip} aria-label={tooltip}>
      {initialsOf(isMe ? 'You' : (name ?? '?'))}
    </span>
  );
}

/** Only shows up once you're within reach of the limit — no clutter otherwise. */
function CharCount({ length }: { length: number }): JSX.Element | null {
  const remaining = MAX_COMMENT_LENGTH - length;
  if (remaining > 200) return null;
  return (
    <span className={`char-count${remaining <= 0 ? ' char-count--limit' : ''}`}>
      {remaining} left
    </span>
  );
}

/** Replies as a tree: children grouped under their parent, depth capped at 5. */
interface ReplyNode {
  reply: ReplyDto;
  children: ReplyNode[];
}

function buildReplyTree(replies: ReplyDto[]): ReplyNode[] {
  const nodes = new Map<string, ReplyNode>(replies.map((r) => [r.id, { reply: r, children: [] }]));
  const roots: ReplyNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.reply.parentReplyId ? nodes.get(node.reply.parentReplyId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

const MAX_REPLY_DEPTH = 5;

function ReplyTree({
  nodes,
  depth,
  canComment,
  me,
  authorsById,
  onReply,
}: {
  nodes: ReplyNode[];
  depth: number;
  canComment: boolean;
  me: Me;
  authorsById: Map<string, OrgUserDto>;
  onReply: (body: string, parentReplyId: string) => void;
}): JSX.Element {
  return (
    <>
      {nodes.map((node) => (
        <ReplyItem
          key={node.reply.id}
          node={node}
          depth={depth}
          canComment={canComment}
          me={me}
          authorsById={authorsById}
          onReply={onReply}
        />
      ))}
    </>
  );
}

function ReplyItem({
  node,
  depth,
  canComment,
  me,
  authorsById,
  onReply,
}: {
  node: ReplyNode;
  depth: number;
  canComment: boolean;
  me: Me;
  authorsById: Map<string, OrgUserDto>;
  onReply: (body: string, parentReplyId: string) => void;
}): JSX.Element {
  const [replying, setReplying] = useState(false);
  const [body, setBody] = useState('');
  return (
    <div className="thread-reply-node" style={{ marginLeft: depth > 1 ? 14 : 0 }}>
      <p className="thread-reply">
        <Avatar authorId={node.reply.authorId} authorsById={authorsById} me={me} />
        <ViaKeyChip viaApiKeyName={node.reply.viaApiKeyName} />
        {node.reply.body}
        {canComment && depth < MAX_REPLY_DEPTH && !replying && (
          <button
            type="button"
            className="btn btn-ghost btn-icon thread-reply-btn"
            title="Reply to this comment"
            aria-label="Reply to this comment"
            onClick={(e) => {
              e.stopPropagation();
              setReplying(true);
            }}
          >
            <IconReply size={12} />
          </button>
        )}
      </p>
      {replying && (
        <div className="thread-reply-input-row">
          <input
            type="text"
            aria-label={`Reply to: ${node.reply.body.slice(0, 30)}`}
            placeholder="Reply…"
            value={body}
            autoFocus
            onClick={(e) => {
              e.stopPropagation();
            }}
            onChange={(e) => {
              setBody(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && body.trim().length > 0) {
                onReply(body.trim(), node.reply.id);
                setBody('');
                setReplying(false);
              }
              if (e.key === 'Escape') setReplying(false);
            }}
          />
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-icon--confirm"
            disabled={body.trim().length === 0}
            title="Post reply"
            aria-label="Post reply"
            onClick={(e) => {
              e.stopPropagation();
              onReply(body.trim(), node.reply.id);
              setBody('');
              setReplying(false);
            }}
          >
            <IconCheck size={14} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-icon--cancel"
            title="Cancel"
            aria-label="Cancel"
            onClick={(e) => {
              e.stopPropagation();
              setReplying(false);
            }}
          >
            <IconX size={14} />
          </button>
        </div>
      )}
      {node.children.length > 0 && (
        <ReplyTree
          nodes={node.children}
          depth={depth + 1}
          canComment={canComment}
          me={me}
          authorsById={authorsById}
          onReply={onReply}
        />
      )}
    </div>
  );
}

function Thread({
  thread,
  lane,
  selected,
  sweeping,
  canComment,
  canResolve,
  canEditComment,
  fromSeq,
  appliedSeq,
  expanded,
  onToggleExpanded,
  me,
  authorsById,
  onShowDiff,
  onViewApplied,
  onAccept,
  onReject,
  onSelect,
  onReply,
  onUpvote,
  onEdit,
  onDelete,
  onResolve,
}: {
  thread: ThreadDto;
  lane: ThreadLane;
  selected: boolean;
  /** Playing the finish-sweep animation — set for the ~500ms window right
   *  after this thread is resolved, before it leaves the open list. */
  sweeping: boolean;
  canComment: boolean;
  canResolve: boolean;
  /** Whether the signed-in user authored this comment — only they may edit it. */
  canEditComment: boolean;
  /** Version the comment was written on, when older than current. */
  fromSeq: number | null;
  /** Version the suggestion minted when accepted; null unless kind is 'suggestion'
   *  and outcome is 'accepted'. */
  appliedSeq: number | null;
  /** Whether this comment's suggestion-diff (or, for an accepted-pending
   *  suggestion, the body's inline strike+insert overlay too — same shared
   *  state, ADR 0007 decision 6) is currently expanded. Lifted to Viewer so
   *  a click on the body mark and a click here drive the same state. */
  expanded: boolean;
  onToggleExpanded: () => void;
  me: Me;
  authorsById: Map<string, OrgUserDto>;
  onShowDiff: (() => void) | null;
  /** Non-null exactly when appliedSeq is — views the minted version. */
  onViewApplied: (() => void) | null;
  /** Non-null only for an open suggestion and an owner/org-admin viewer
   *  (the same signal that gates resolve/upload) — null renders no button. */
  onAccept: (() => void) | null;
  onReject: (() => void) | null;
  onSelect: () => void;
  onReply: (body: string, parentReplyId: string | null) => void;
  onUpvote: () => void;
  onEdit: (body: string) => void;
  onDelete: () => void;
  onResolve: () => void;
}): JSX.Element {
  const [reply, setReply] = useState('');
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { comment } = thread;
  const replyTree = useMemo(() => buildReplyTree(thread.replies), [thread.replies]);
  return (
    <article
      className={`thread thread--${lane}${selected ? ' thread--selected' : ''}${sweeping ? ' thread--sweep' : ''}${comment.kind === 'suggestion' ? ' thread--suggestion' : ''}`}
      data-testid="thread"
      data-thread-id={comment.id}
      onClick={onSelect}
    >
      {(canEditComment || (canResolve && comment.status === 'open')) && (
        <div className="thread-top-actions">
          {canResolve && comment.status === 'open' && (
            <button
              type="button"
              className="thread-resolve-check"
              title="Resolve this thread"
              aria-label="Resolve this thread"
              onClick={(e) => {
                e.stopPropagation();
                onResolve();
              }}
            >
              <IconCheck size={13} />
            </button>
          )}
          {canEditComment && !editing && (
            <button
              type="button"
              className="thread-resolve-check"
              title="Edit this comment"
              aria-label="Edit this comment"
              onClick={(e) => {
                e.stopPropagation();
                setEditBody(comment.body);
                setEditing(true);
              }}
            >
              <IconPencil size={13} />
            </button>
          )}
          {canEditComment && (
            <button
              type="button"
              className="thread-resolve-check thread-delete-check"
              title="Delete this comment"
              aria-label="Delete this comment"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmingDelete(true);
              }}
            >
              <IconTrash size={13} />
            </button>
          )}
        </div>
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title="Delete this comment?"
          body="This removes the comment and its place in the thread. Replies stay on record but the thread disappears from every view."
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            setConfirmingDelete(false);
            onDelete();
          }}
          onCancel={() => {
            setConfirmingDelete(false);
          }}
        />
      )}
      <div className="thread-meta">
        <Avatar authorId={comment.authorId} authorsById={authorsById} me={me} />
        <ViaKeyChip viaApiKeyName={comment.viaApiKeyName} />
        {fromSeq !== null && onShowDiff && (
          <button
            type="button"
            className="thread-diff-chip"
            title={`See what changed since v${String(fromSeq)}`}
            onClick={(e) => {
              e.stopPropagation();
              onShowDiff();
            }}
          >
            <IconGitCompare size={11} />
            changed since v{fromSeq}
          </button>
        )}
      </div>
      <blockquote className="thread-quote">{quoteOf(comment.anchor)}</blockquote>
      <ResolutionBadge thread={thread} />
      {lane === 'orphan' && (
        <span className="thread-orphan-note">original text no longer present</span>
      )}
      {comment.kind === 'suggestion' &&
        (comment.suggestionOutcome === 'open' || comment.suggestionOutcome === null ? (
          <div className="suggestion-block" data-testid="suggestion-block">
            <span className="suggestion-chip suggestion-chip--open">Suggestion · open</span>
            <p className="suggestion-diff">
              <span className="suggestion-arrow" aria-hidden="true">
                →
              </span>
              {comment.proposedText && comment.proposedText.length > 0 ? (
                <ins>{comment.proposedText}</ins>
              ) : (
                <em className="suggestion-delete-note">(remove this text)</em>
              )}
            </p>
            {(onAccept !== null || onReject !== null) && (
              <div className="suggestion-actions">
                {onAccept && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    title="Accept this suggestion — marks it accepted; someone still needs to apply the text and upload a new version"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAccept();
                    }}
                  >
                    <IconCheck size={13} />
                    Accept
                  </button>
                )}
                {onReject && (
                  <button
                    type="button"
                    className="btn"
                    title="Reject this suggestion"
                    onClick={(e) => {
                      e.stopPropagation();
                      onReject();
                    }}
                  >
                    <IconX size={13} />
                    Reject
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="suggestion-block" data-testid="suggestion-block">
            <button
              type="button"
              className={`suggestion-status suggestion-status--${comment.suggestionOutcome}`}
              aria-expanded={expanded}
              title={expanded ? 'Hide the proposed diff' : 'Show the proposed diff'}
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpanded();
              }}
            >
              {comment.suggestionOutcome === 'accepted' ? (
                <IconCheck size={12} />
              ) : (
                <IconX size={12} />
              )}
              <span className="suggestion-status-text">
                Suggestion {comment.suggestionOutcome}
                {comment.suggestionOutcome === 'accepted' && appliedSeq !== null
                  ? ` → v${String(appliedSeq)}`
                  : ''}
              </span>
              <span className="suggestion-status-hint">{expanded ? 'hide diff' : 'show diff'}</span>
            </button>
            {expanded && (
              <div
                className="suggestion-summary-body"
                onClick={(e) => {
                  e.stopPropagation();
                }}
              >
                <p className="suggestion-diff">
                  <span className="suggestion-arrow" aria-hidden="true">
                    →
                  </span>
                  {comment.proposedText && comment.proposedText.length > 0 ? (
                    <ins>{comment.proposedText}</ins>
                  ) : (
                    <em className="suggestion-delete-note">(remove this text)</em>
                  )}
                </p>
                {comment.suggestionOutcome === 'accepted' &&
                  appliedSeq !== null &&
                  onViewApplied && (
                    <button
                      type="button"
                      className="btn btn-ghost thread-diff-link"
                      title={`View v${String(appliedSeq)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onViewApplied();
                      }}
                    >
                      <IconGitCompare size={12} />
                      Applied as v{appliedSeq}
                    </button>
                  )}
              </div>
            )}
          </div>
        ))}
      {editing ? (
        <div
          className="thread-edit"
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <div className="thread-edit-field">
            <textarea
              aria-label={`Edit comment: ${comment.body.slice(0, 30)}`}
              value={editBody}
              maxLength={MAX_COMMENT_LENGTH}
              autoFocus
              onChange={(e) => {
                setEditBody(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && editBody.trim().length > 0) {
                  e.preventDefault();
                  onEdit(editBody.trim());
                  setEditing(false);
                }
                if (e.key === 'Escape') setEditing(false);
              }}
            />
            <CharCount length={editBody.length} />
          </div>
          <div className="thread-edit-actions">
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-icon--confirm"
              disabled={editBody.trim().length === 0}
              title="Save changes"
              aria-label="Save changes"
              onClick={() => {
                onEdit(editBody.trim());
                setEditing(false);
              }}
            >
              <IconCheck size={14} />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-icon--cancel"
              title="Cancel"
              aria-label="Cancel"
              onClick={() => {
                setEditing(false);
              }}
            >
              <IconX size={14} />
            </button>
          </div>
        </div>
      ) : (
        <p
          className={`thread-body${canEditComment ? ' thread-body--editable' : ''}`}
          title={canEditComment ? 'Double-click to edit' : undefined}
          onDoubleClick={(e) => {
            if (!canEditComment) return;
            e.stopPropagation();
            setEditBody(comment.body);
            setEditing(true);
          }}
        >
          <CommentBody body={comment.body} mentions={thread.mentions} />
        </p>
      )}
      <ReplyTree
        nodes={replyTree}
        depth={1}
        canComment={canComment && comment.status === 'open'}
        me={me}
        authorsById={authorsById}
        onReply={(body, parentReplyId) => {
          onReply(body, parentReplyId);
        }}
      />
      <div className="thread-actions">
        {canComment && (
          <button
            type="button"
            className={`thread-upvote${thread.upvotes.mine ? ' thread-upvote--on' : ''}`}
            aria-pressed={thread.upvotes.mine}
            aria-label={thread.upvotes.mine ? 'Remove upvote' : 'Upvote'}
            title={thread.upvotes.mine ? 'Remove upvote' : 'Upvote'}
            onClick={(e) => {
              e.stopPropagation();
              onUpvote();
            }}
          >
            <IconThumbsUp size={13} />
            {thread.upvotes.count > 0 && (
              <span className="thread-upvote-count">{thread.upvotes.count}</span>
            )}
          </button>
        )}
        {comment.status === 'open' && canComment && (
          <>
            <input
              type="text"
              aria-label={`Reply to: ${comment.body.slice(0, 30)}`}
              placeholder="Reply…"
              value={reply}
              onChange={(e) => {
                setReply(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && reply.trim().length > 0) {
                  onReply(reply.trim(), null);
                  setReply('');
                }
              }}
            />
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-icon--confirm"
              disabled={reply.trim().length === 0}
              title="Post reply"
              aria-label="Post reply"
              onClick={(e) => {
                e.stopPropagation();
                onReply(reply.trim(), null);
                setReply('');
              }}
            >
              <IconCheck size={14} />
            </button>
          </>
        )}
      </div>
    </article>
  );
}
