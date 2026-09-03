import type { JSX } from 'react';
import type { ThreadDto } from '../api/client.js';
import { IconCheck, IconX } from './icons.js';

export interface TriagePanelProps {
  /** Open threads on the freshly uploaded version. */
  threads: ThreadDto[];
  newSeq: number;
  canResolve: boolean;
  onSelect: (commentId: string) => void;
  onResolve: (commentId: string) => void;
  onClose: () => void;
}

/**
 * Post-upload triage: how each open comment's anchor survived the new
 * version, with one-click resolve for feedback the new version addressed.
 */
export function TriagePanel({
  threads,
  newSeq,
  canResolve,
  onSelect,
  onResolve,
  onClose,
}: TriagePanelProps): JSX.Element | null {
  const orphaned = threads.filter((t) => t.resolution.method === 'orphan');
  // >=0.9 stays silent (ADR 0003 §F.2, same floor as ResolutionBadge in
  // viewer.tsx) — only the 0.6-0.9 "worth a second look" band shows here.
  const moved = threads.filter(
    (t) => t.resolution.method !== 'orphan' && t.resolution.confidence < 0.9,
  );
  if (orphaned.length === 0 && moved.length === 0) return null;

  const row = (t: ThreadDto, note: string, noteTitle?: string): JSX.Element => (
    <li key={t.comment.id} className="triage-row">
      <button
        type="button"
        className="triage-quote"
        title="Jump to this comment"
        onClick={() => {
          onSelect(t.comment.id);
        }}
      >
        {t.comment.body.slice(0, 80)}
      </button>
      <span className="doc-meta" title={noteTitle}>
        {note}
      </span>
      {canResolve && (
        <button
          type="button"
          className="btn btn-ghost"
          title="Resolve this comment"
          onClick={() => {
            onResolve(t.comment.id);
          }}
        >
          <IconCheck size={14} />
          Resolve
        </button>
      )}
    </li>
  );

  return (
    <section className="triage-panel" data-testid="triage-panel" aria-label="Anchor triage">
      <div className="triage-head">
        <strong>
          v{newSeq} uploaded — {orphaned.length + moved.length} open comment
          {orphaned.length + moved.length === 1 ? '' : 's'} to review
        </strong>
        <button
          type="button"
          className="btn btn-ghost"
          title="Dismiss this review"
          onClick={onClose}
        >
          <IconX size={14} />
          Dismiss
        </button>
      </div>
      <ul>
        {orphaned.map((t) => row(t, 'original text gone — addressed?'))}
        {moved.map((t) =>
          row(
            t,
            'Moved — check this still fits',
            `Re-anchored · ${String(Math.round(t.resolution.confidence * 100))}%`,
          ),
        )}
      </ul>
    </section>
  );
}
