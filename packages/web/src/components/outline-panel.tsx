import type { JSX } from 'react';
import type { OutlineEntry } from '../outline.js';
import { IconX } from './icons.js';

export interface OutlinePanelProps {
  open: boolean;
  outline: OutlineEntry[];
  /** Open-comment count per section, index-aligned with `outline`. */
  openCounts: number[];
  onToggle: () => void;
  onPick: (entry: OutlineEntry) => void;
  onClose: () => void;
}

/**
 * Slide-in drawer, not a permanent column — a slim vertical tab (rotated
 * label) sits at the content's left edge whether the drawer is open or not;
 * clicking it (or a heading, or the X) toggles/closes the panel.
 */
export function OutlinePanel({
  open,
  outline,
  openCounts,
  onToggle,
  onPick,
  onClose,
}: OutlinePanelProps): JSX.Element {
  return (
    <div className={`outline-drawer${open ? ' outline-drawer--open' : ''}`}>
      <button
        type="button"
        className="outline-tab"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? 'Close outline' : 'Open outline'}
        title={open ? 'Close outline' : 'Open outline'}
      >
        <span className="outline-tab-label">Outline</span>
      </button>
      <nav
        className="outline-panel"
        data-testid="outline-panel"
        aria-label="Document outline"
        aria-hidden={!open}
      >
        <div className="outline-head">
          <span className="sidebar-heading">Outline</span>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label="Close outline"
            title="Close outline"
          >
            <IconX />
          </button>
        </div>
        {outline.length === 0 && <p className="doc-meta">No headings in this document.</p>}
        {outline.map((entry, i) => (
          <button
            key={`${String(entry.start)}-${String(i)}`}
            type="button"
            className="outline-item"
            style={{ paddingLeft: `${String(8 + (entry.level - 1) * 12)}px` }}
            title={`Jump to "${entry.text}"`}
            onClick={() => {
              onPick(entry);
            }}
          >
            <span className="outline-text">{entry.text}</span>
            {(openCounts[i] ?? 0) > 0 && <span className="lane-signal">{openCounts[i]}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}
