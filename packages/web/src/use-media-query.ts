import { useEffect, useState } from 'react';

/**
 * Live `window.matchMedia` subscription — same recipe as `useTheme`'s
 * `prefers-color-scheme` listener in `theme.ts`, generalized to any query.
 * Used for genuinely structural responsive behavior (the settings rail's
 * drill-down, `DataTable`'s stacked-row collapse) that CSS alone can't
 * express, because the two layouts are different DOM shapes, not just
 * different styling of the same markup.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mql = window.matchMedia(query);
    // Re-sync in case the query itself changed, or matched state drifted
    // between render and effect (StrictMode double-invoke, etc).
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent): void => {
      setMatches(e.matches);
    };
    mql.addEventListener('change', onChange);
    return () => {
      mql.removeEventListener('change', onChange);
    };
  }, [query]);

  return matches;
}
