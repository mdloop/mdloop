import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import type { VersionDto } from '../api/client.js';
import { Badge } from './badge.js';
import { Tooltip } from './tooltip.js';
import { IconMdloopDown, IconGitCompare, IconRotateCcw } from './icons.js';

export interface VersionStripProps {
  versions: VersionDto[];
  currentVersionId: string | null;
  /** Version being viewed when not the current one. */
  viewingId: string | null;
  onView: (version: VersionDto | null) => void;
  onDiff: (from: VersionDto) => void;
}

/** Versions past this many are folded behind the "earlier" dropdown, so the
 * strip stays scannable however long a document's history gets. */
const VISIBLE_RECENT_COUNT = 8;

/**
 * Where a version came from, in reader's language. Kept exhaustive over
 * `VersionDto['source']` so widening the union (Phase 20.A added `cli`) is a
 * type error here rather than a silently unlabelled chip.
 */
const SOURCE_LABEL: Record<VersionDto['source'], string> = {
  web: 'in mdloop',
  mcp: 'by an agent',
  cli: 'from the repo',
};

export function versionSourceLabel(source: VersionDto['source']): string {
  return SOURCE_LABEL[source];
}

function versionTitle(v: VersionDto): string {
  return (
    `v${String(v.seq)} — uploaded ${versionSourceLabel(v.source)} on ${new Date(v.createdAt).toLocaleString()}` +
    (v.viaApiKeyName ? ` via API key "${v.viaApiKeyName}"` : '') +
    // What-changed note lives in the tooltip only, never inline in the
    // chip (ADR 0003 §B surfacing ruling).
    (v.changeNote ? `\n${v.changeNote}` : '')
  );
}

/**
 * Version timeline: one chip per version, click to view read-only, diff any
 * older version against current. Purged versions stay visible but inert —
 * the tombstone is part of the history (ADR 0001).
 */
export function VersionStrip({
  versions,
  currentVersionId,
  viewingId,
  onView,
  onDiff,
}: VersionStripProps): JSX.Element | null {
  const [olderOpen, setOlderOpen] = useState(false);
  const olderRef = useRef<HTMLDivElement>(null);
  const olderBtnRef = useRef<HTMLButtonElement>(null);
  // Positioned via JS rather than CSS `position: absolute` — .version-strip
  // is horizontally scrollable, which makes its overflow-y compute to
  // `auto` too (CSS's paired-axis rule), so an absolute panel would get
  // clipped. `fixed` escapes that; coordinates are read from the trigger.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!olderOpen) return;
    const rect = olderBtnRef.current?.getBoundingClientRect();
    if (rect) setMenuPos({ top: rect.bottom + 6, left: rect.left });
  }, [olderOpen]);

  useEffect(() => {
    if (!olderOpen) return;
    function onOutsideClick(e: MouseEvent): void {
      if (olderRef.current && !olderRef.current.contains(e.target as Node)) {
        setOlderOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOlderOpen(false);
    }
    // Window resize can reflow the trigger's position (e.g. a rotation or a
    // devtools panel toggling) — recompute rather than leave the panel
    // pointing at a stale spot.
    function onResize(): void {
      const rect = olderBtnRef.current?.getBoundingClientRect();
      if (rect) setMenuPos({ top: rect.bottom + 6, left: rect.left });
    }
    window.document.addEventListener('mousedown', onOutsideClick);
    window.document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    return () => {
      window.document.removeEventListener('mousedown', onOutsideClick);
      window.document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
    };
  }, [olderOpen]);

  if (versions.length < 2) return null;

  const viewing = versions.find((v) => v.id === viewingId) ?? null;
  const hasOverflow = versions.length > VISIBLE_RECENT_COUNT;
  const older = hasOverflow ? versions.slice(0, versions.length - VISIBLE_RECENT_COUNT) : [];
  const recent = hasOverflow ? versions.slice(versions.length - VISIBLE_RECENT_COUNT) : versions;
  const viewingIsOlder = viewing !== null && older.some((v) => v.id === viewing.id);

  return (
    <div
      className="version-strip"
      data-testid="version-strip"
      aria-label="Version history"
      onScroll={() => {
        setOlderOpen(false);
      }}
    >
      {hasOverflow && (
        <div className="version-strip-older" ref={olderRef}>
          <Tooltip
            content={`${String(older.length)} earlier version${older.length === 1 ? '' : 's'}`}
          >
            <button
              ref={olderBtnRef}
              type="button"
              className={`version-chip version-chip-older${
                viewingIsOlder ? ' version-chip--selected' : ''
              }`}
              aria-haspopup="listbox"
              aria-expanded={olderOpen}
              onClick={() => {
                setOlderOpen((o) => !o);
              }}
            >
              {viewingIsOlder ? `v${String(viewing.seq)}` : `Earlier (${String(older.length)})`}
              <IconMdloopDown size={12} />
            </button>
          </Tooltip>
          {olderOpen && menuPos && (
            <div
              className="version-strip-older-menu"
              role="listbox"
              style={{ top: menuPos.top, left: menuPos.left }}
            >
              {older.map((v) => {
                const selected = viewing ? v.id === viewing.id : false;
                if (v.purgedAt !== null) {
                  return (
                    <Tooltip key={v.id} content="Content purged by retention policy">
                      <span className="version-strip-older-item version-strip-older-item--purged">
                        <Badge tone="neutral" tabIndex={0}>
                          v{v.seq}
                        </Badge>
                      </span>
                    </Tooltip>
                  );
                }
                return (
                  <Tooltip key={v.id} content={versionTitle(v)}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`version-strip-older-item${
                        selected ? ' version-strip-older-item--selected' : ''
                      }`}
                      onClick={() => {
                        setOlderOpen(false);
                        onView(v.id === currentVersionId ? null : v);
                      }}
                    >
                      v{v.seq}
                      {v.viaApiKeyName !== null && (
                        <span className="version-chip-via-key">
                          {' '}
                          <Badge tone="neutral">key</Badge>
                        </span>
                      )}
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          )}
        </div>
      )}
      {recent.map((v) => {
        const isCurrent = v.id === currentVersionId;
        const selected = viewing ? v.id === viewing.id : isCurrent;
        if (v.purgedAt !== null) {
          return (
            <Tooltip key={v.id} content="Content purged by retention policy">
              <span className="version-chip version-chip--purged">
                <Badge tone="neutral" tabIndex={0}>
                  v{v.seq}
                </Badge>
              </span>
            </Tooltip>
          );
        }
        return (
          <Tooltip key={v.id} content={versionTitle(v)}>
            <button
              type="button"
              className={`version-chip${selected ? ' version-chip--selected' : ''}${
                isCurrent ? ' version-chip--current' : ''
              }`}
              onClick={() => {
                onView(isCurrent ? null : v);
              }}
            >
              v{v.seq}
              {v.viaApiKeyName !== null && (
                <span className="version-chip-via-key">
                  {' '}
                  <Badge tone="neutral">key</Badge>
                </span>
              )}
            </button>
          </Tooltip>
        );
      })}
      {/* No "viewing vN" signal here — the in-content banner is the one
          source of that message; this span only offers the actions. */}
      {viewing && (
        <span className="version-strip-actions">
          <Tooltip content="Diff this version against current">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                onDiff(viewing);
              }}
            >
              <IconGitCompare size={14} />
              Diff against current
            </button>
          </Tooltip>
          <Tooltip content="Back to current version">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                onView(null);
              }}
            >
              <IconRotateCcw size={14} />
              Back to current
            </button>
          </Tooltip>
        </span>
      )}
    </div>
  );
}
