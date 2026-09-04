import type { JSX } from 'react';

export interface BreadcrumbProps {
  /** Repo-relative POSIX path from the sync CLI mirror (e.g. `docs/specs/auth.md`).
   *  CLI-owned and read-only here — never editable, never a navigation target. */
  path: string;
}

/**
 * Quiet, display-only folder trail above the document title — the filename
 * itself is dropped (the title next to this already shows it) and there is
 * nothing to click: `path` is CLI-owned, so this component never renders a
 * link or attaches a handler. A root-level file (no `/` in `path`) has no
 * folders to show, so it renders nothing.
 */
export function Breadcrumb({ path }: BreadcrumbProps): JSX.Element | null {
  const segments = path.split('/').slice(0, -1);
  if (segments.length === 0) return null;
  return (
    <div className="breadcrumb" data-testid="breadcrumb">
      {segments.map((segment, i) => (
        <span className="breadcrumb-item" key={`${String(i)}-${segment}`}>
          {segment}
          <span className="breadcrumb-sep" aria-hidden="true">
            /
          </span>
        </span>
      ))}
    </div>
  );
}
