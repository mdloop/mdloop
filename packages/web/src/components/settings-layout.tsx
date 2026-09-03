import { useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { useMediaQuery } from '../use-media-query.js';
import { IconArrowLeft } from './icons.js';

export interface SettingsRailItem {
  id: string;
  label: string;
  active: boolean;
  onSelect: () => void;
}

export interface SettingsRailGroup {
  /** Mono uppercase eyebrow (`docs/design-system.md`: mono for anything
   *  that names or counts, including section eyebrows). */
  heading: string;
  items: SettingsRailItem[];
}

export interface SettingsLayoutProps {
  /** Full-width chrome above the rail/content split — the customer
   *  `AppHeader` or the operator console's accent-stripe + topbar. Left
   *  un-opinionated on purpose so the two surfaces keep their distinct
   *  chrome signal while sharing this shell's rail/content mechanics. */
  header: ReactNode;
  rail: SettingsRailGroup[];
  children: ReactNode;
}

/**
 * The settings rail + content shell (`docs/design-system.md` "Layout: the
 * settings rail") — shared by customer org settings/billing and the
 * operator console. Left rail at the app's existing 232px sidebar width
 * (`--sidebar-w`), mono uppercase group eyebrows, active item marked with
 * `aria-current`.
 *
 * Responsive (design-system.md bands): >=1080px and 720-899px both show
 * rail + content together (content itself is already a single vertical
 * stack, so the 900-1079px "shed columns" rule is a `DataTable` concern,
 * not this component's). Below 720px the rail becomes a drill-down: a
 * section index full width, tap a section to see its content, "Sections"
 * to go back — matching phone settings conventions instead of a tab strip
 * that would flatten the group headings.
 */
export function SettingsLayout({ header, rail, children }: SettingsLayoutProps): JSX.Element {
  const narrow = useMediaQuery('(max-width: 720px)');
  const [showIndex, setShowIndex] = useState(false);

  const showRail = !narrow || showIndex;
  const showContent = !narrow || !showIndex;

  return (
    <div className="settings-shell">
      {header}
      <div className="settings-body">
        {showRail && (
          <nav className="settings-rail" aria-label="Settings sections">
            {rail.map((group) => (
              <div className="settings-rail-group" key={group.heading}>
                <div className="settings-rail-heading">{group.heading}</div>
                <ul className="settings-rail-items">
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="settings-rail-item"
                        aria-current={item.active ? 'page' : undefined}
                        onClick={() => {
                          setShowIndex(false);
                          item.onSelect();
                        }}
                      >
                        {item.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        )}
        {showContent && (
          <main className="content">
            {narrow && (
              <button
                type="button"
                className="settings-back-button"
                onClick={() => {
                  setShowIndex(true);
                }}
              >
                <IconArrowLeft size={14} />
                Sections
              </button>
            )}
            <div className="content-inner">{children}</div>
          </main>
        )}
      </div>
    </div>
  );
}
