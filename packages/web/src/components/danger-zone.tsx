import { useId } from 'react';
import type { JSX, ReactNode } from 'react';

export interface DangerZoneProps {
  title: string;
  description: ReactNode;
  /** The destructive action's own button(s) — this wrapper supplies weight
   *  and warning, not the control itself. */
  children: ReactNode;
}

/**
 * Destructive-section wrapper with a real `--danger-wash` background, not
 * the border-color-only tint `.admin-danger-zone` used before Phase 39.A —
 * "Purge organization" should carry more visual weight than "Session
 * length", not just a different border.
 */
export function DangerZone({ title, description, children }: DangerZoneProps): JSX.Element {
  const headingId = useId();
  return (
    <section className="danger-zone settings-section" aria-labelledby={headingId}>
      <div className="settings-section-head">
        <h3 id={headingId}>{title}</h3>
        <p className="help-text">{description}</p>
      </div>
      {children}
    </section>
  );
}
