import type { JSX } from 'react';
import { modeLabel, nextMode } from '../theme.js';
import type { ThemeMode } from '../theme.js';
import { IconMonitor, IconMoon, IconSun } from './icons.js';

export interface ThemeToggleProps {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  /** Chrome-less screens (login, redeemers) have no topbar to sit inline in. */
  floating?: boolean;
}

function modeIcon(mode: ThemeMode): JSX.Element {
  if (mode === 'light') return <IconSun size={14} />;
  if (mode === 'dark') return <IconMoon size={14} />;
  return <IconMonitor size={14} />;
}

export function ThemeToggle({ mode, setMode, floating = false }: ThemeToggleProps): JSX.Element {
  return (
    <button
      type="button"
      className={`btn btn-ghost theme-toggle${floating ? ' theme-toggle--floating' : ''}`}
      title={`Theme: ${modeLabel(mode)} (click to change)`}
      // The label text is CSS-hidden below 720px (`.theme-toggle-label`,
      // Phase 39.F — real header-overflow fix, not decoration) to free up
      // room for the identity menu; the visible text is this button's only
      // naming source otherwise, so give it an explicit one that survives
      // that.
      aria-label={`Theme: ${modeLabel(mode)}`}
      onClick={() => {
        setMode(nextMode(mode));
      }}
    >
      {modeIcon(mode)}
      <span className="theme-toggle-label">{modeLabel(mode)}</span>
    </button>
  );
}
