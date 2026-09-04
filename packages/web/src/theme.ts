import { useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'mdloop-theme';

function loadMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/** `system` omits the attribute so the `prefers-color-scheme` media query wins. */
function applyMode(mode: ThemeMode): void {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
}

/**
 * App-wide theme state: OS preference by default, overridable and persisted.
 * Also resolves the *effective* light/dark for consumers (like mermaid) that
 * can't read CSS custom properties.
 */
export function useTheme(): { mode: ThemeMode; setMode: (mode: ThemeMode) => void; dark: boolean } {
  const [mode, setMode] = useState<ThemeMode>(loadMode);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    applyMode(mode);
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent): void => {
      setSystemDark(e.matches);
    };
    mql.addEventListener('change', onChange);
    return () => {
      mql.removeEventListener('change', onChange);
    };
  }, []);

  const dark = mode === 'dark' || (mode === 'system' && systemDark);
  return { mode, setMode, dark };
}

/** Cycles light -> dark -> system -> light. */
export function nextMode(mode: ThemeMode): ThemeMode {
  if (mode === 'light') return 'dark';
  if (mode === 'dark') return 'system';
  return 'light';
}

export function modeLabel(mode: ThemeMode): string {
  if (mode === 'light') return 'Light';
  if (mode === 'dark') return 'Dark';
  return 'Auto';
}
