import { useEffect, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { api } from '../api/client.js';
import type { Me, ProjectDto, SearchHitDto } from '../api/client.js';
import { BrandMark } from './brand-mark.js';
import { ThemeToggle } from './theme-toggle.js';
import type { ThemeMode } from '../theme.js';
import { IconLogOut, IconMenu, IconSettings, IconUser } from './icons.js';

export interface AppHeaderProps {
  me: Me;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  onLogout: () => void;
  onNavigateHome: () => void;
  onOpenDocument: (id: string) => void;
  /** Opens the unified `/settings` shell (Phase 39.A — org settings and
   *  billing collapsed into one rail-based surface, so the account menu
   *  needs only one entry point instead of two). Admin-only "Settings" menu
   *  item is shown when this is passed AND `me.role === 'admin'`. The
   *  settings shell's own pages omit this prop, so the item doesn't appear
   *  while already inside it. */
  onOpenSettings?: (() => void) | undefined;
  /** Resolves each search hit's `projectId` to a name/color badge — pass
   *  whatever project list the caller already has loaded. Omit where none
   *  is available (e.g. org settings); hits just show "Unfiled". */
  projects?: ProjectDto[];
  /** Opens the mobile lane-nav drawer (Phase 39.F) — only `Shell` has a
   *  `.sidebar` for this to reveal, so only it passes this. The trigger
   *  button itself is CSS-hidden at >=720px regardless (`.app-header-lane-trigger`),
   *  so passing it on a page with no drawer would render a dead button —
   *  every other `AppHeader` caller omits it. */
  onOpenLaneMenu?: (() => void) | undefined;
  /** Page-specific controls, rendered between the brand and search — empty
   *  for pages that need nothing extra. */
  children?: ReactNode;
}

/** `Me` (see api/client.ts) carries only `userId`/`orgId`/`role` — the `/me`
 *  route has no displayName/email to derive initials from, so the identity
 *  menu trigger is a generic person mark rather than a `.thread-avatar`-style
 *  initials disc. Revisit if `/me` ever grows those fields. */
function roleLabel(me: Me): string {
  return me.role;
}

/** One header, rendered once in App(), shared by every authenticated app
 *  page (home, viewer, org settings) instead of each page building its own —
 *  logo/wordmark, global search, identity menu, and theme toggle never move
 *  or disappear between pages; only `children` (page-specific controls) does.
 *  Pre-auth/redemption screens (login, guest/share/invite links) aren't
 *  "pages" in this sense — there's no session or search to offer yet — and
 *  keep the lighter floating <BrandMark> instead. */
export function AppHeader({
  me,
  mode,
  setMode,
  onLogout,
  onNavigateHome,
  onOpenDocument,
  onOpenSettings,
  projects = [],
  onOpenLaneMenu,
  children,
}: AppHeaderProps): JSX.Element {
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHitDto[] | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuOpen, setMenuOpen] = useState(false);
  const searchSeq = useRef(0);
  const searchBoxRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const identityRef = useRef<HTMLDivElement>(null);

  /* Debounced, permission-scoped search — same query the old per-page
     search boxes used, just available everywhere now. */
  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) {
      setHits(null);
      return;
    }
    const seq = (searchSeq.current += 1);
    const timer = window.setTimeout(() => {
      api
        .searchDocuments(q)
        .then((res) => {
          if (searchSeq.current === seq) setHits(res.hits);
        })
        .catch(() => {
          if (searchSeq.current === seq) setHits([]);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query]);

  // Fresh hits invalidate whatever was highlighted before.
  useEffect(() => {
    setActiveIndex(-1);
  }, [hits]);

  useEffect(() => {
    if (!open) return;
    function onOutsideClick(e: MouseEvent): void {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.document.addEventListener('mousedown', onOutsideClick);
    return () => {
      window.document.removeEventListener('mousedown', onOutsideClick);
    };
  }, [open]);

  useEffect(() => {
    if (!menuOpen) return;
    function onOutsideClick(e: MouseEvent): void {
      if (identityRef.current && !identityRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    window.document.addEventListener('mousedown', onOutsideClick);
    window.document.addEventListener('keydown', onKeyDown);
    return () => {
      window.document.removeEventListener('mousedown', onOutsideClick);
      window.document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  // Cmd+K / Ctrl+K focuses search from anywhere on the page, including from
  // inside another input — this is the one shortcut that must win globally.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  function pick(documentId: string): void {
    setQuery('');
    setHits(null);
    setOpen(false);
    onOpenDocument(documentId);
  }

  function hitId(documentId: string): string {
    return `app-header-search-hit-${documentId}`;
  }

  const showSettingsItem = me.role === 'admin' && Boolean(onOpenSettings);

  return (
    <header className="app-header">
      <div className="app-header-left">
        {onOpenLaneMenu && (
          <button
            type="button"
            className="app-header-lane-trigger"
            aria-label="Open lanes"
            title="Open lanes"
            onClick={onOpenLaneMenu}
          >
            <IconMenu size={18} />
          </button>
        )}
        <BrandMark inline onClick={onNavigateHome} />

        <div className="app-header-page-slot">{children}</div>
      </div>

      <div className="app-header-search" ref={searchBoxRef}>
        <input
          ref={searchInputRef}
          type="search"
          className="topbar-search"
          placeholder="Search documents…"
          aria-label="Search documents"
          aria-activedescendant={
            open && hits && activeIndex >= 0 && hits[activeIndex]
              ? hitId(hits[activeIndex].documentId)
              : undefined
          }
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (hits) setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              e.currentTarget.blur();
            } else if (e.key === 'ArrowDown') {
              if (!hits || hits.length === 0) return;
              e.preventDefault();
              setOpen(true);
              setActiveIndex((i) => (i + 1) % hits.length);
            } else if (e.key === 'ArrowUp') {
              if (!hits || hits.length === 0) return;
              e.preventDefault();
              setOpen(true);
              setActiveIndex((i) => (i <= 0 ? hits.length - 1 : i - 1));
            } else if (e.key === 'Enter') {
              const hit = (activeIndex >= 0 ? hits?.[activeIndex] : undefined) ?? hits?.[0];
              if (hit) pick(hit.documentId);
            }
          }}
        />
        {query.length === 0 && <kbd className="app-header-search-kbd">⌘K</kbd>}
        {open && hits && (
          <div className="app-header-search-results" role="listbox">
            {hits.length === 0 ? (
              <div className="app-header-search-empty">
                No matches — search covers titles and content of documents you can open.
              </div>
            ) : (
              hits.map((hit, i) => (
                <button
                  type="button"
                  key={hit.documentId}
                  id={hitId(hit.documentId)}
                  className={`app-header-search-hit${
                    i === activeIndex ? ' app-header-search-hit--active' : ''
                  }`}
                  role="option"
                  aria-selected={i === activeIndex}
                  onClick={() => {
                    pick(hit.documentId);
                  }}
                  onMouseEnter={() => {
                    setActiveIndex(i);
                  }}
                >
                  <span className="app-header-search-hit-main">
                    <span className="app-header-search-hit-title">{hit.title}</span>
                    {hit.path && <span className="app-header-search-hit-path">{hit.path}</span>}
                  </span>
                  <span className="app-header-search-hit-project">
                    {hit.projectId && projectById.has(hit.projectId) ? (
                      <>
                        <span
                          className="app-header-search-hit-dot"
                          style={{ background: projectById.get(hit.projectId)?.color }}
                        />
                        {projectById.get(hit.projectId)?.name}
                      </>
                    ) : (
                      'Unfiled'
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div className="app-header-sticky">
        <div className="app-header-identity" ref={identityRef}>
          <button
            type="button"
            className="app-header-avatar"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Account menu"
            title="Account menu"
            onClick={() => {
              setMenuOpen((o) => !o);
            }}
          >
            <IconUser size={14} />
          </button>
          {menuOpen && (
            <div className="app-header-menu" role="menu">
              <div className="app-header-menu-meta doc-meta" role="none">
                {roleLabel(me)}
              </div>
              {showSettingsItem && (
                <button
                  type="button"
                  role="menuitem"
                  className="app-header-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenSettings?.();
                  }}
                >
                  <IconSettings size={14} />
                  Settings
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className="app-header-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onLogout();
                }}
              >
                <IconLogOut size={14} />
                Sign out
              </button>
            </div>
          )}
        </div>
        <ThemeToggle mode={mode} setMode={setMode} />
      </div>
    </header>
  );
}
