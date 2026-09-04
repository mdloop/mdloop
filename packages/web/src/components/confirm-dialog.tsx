import { useEffect, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { IconCheck, IconTrash, IconX } from './icons.js';

export interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  /** Extra content between the body and the actions — e.g. an optional note
   *  field on the version-upload confirmation (ADR 0003 §B). */
  extra?: ReactNode;
  /**
   * When set, the confirm button stays disabled until the operator types
   * this exact string into a field rendered just above the actions (org
   * purge, Phase 26.E — the first destructive action in this codebase
   * requiring typed confirmation).
   */
  confirmMatchText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Focus-trapped confirm modal — Escape or backdrop click cancels, Enter confirms. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  extra,
  confirmMatchText,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [typedMatch, setTypedMatch] = useState('');
  const matchGated = confirmMatchText !== undefined;
  const matchSatisfied = !matchGated || typedMatch === confirmMatchText;

  // Focus the confirm button once on mount — not on every parent re-render,
  // which would steal focus back from the optional note field (ADR 0003 §B)
  // mid-typing. When match-gated the button starts disabled, so focus the
  // typed-confirmation field instead.
  const matchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (matchGated) matchInputRef.current?.focus();
    else confirmRef.current?.focus();
  }, [matchGated]);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

  return (
    <div
      className="confirm-backdrop"
      onClick={onCancel}
      role="presentation"
      data-testid="confirm-dialog-backdrop"
    >
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        data-testid="confirm-dialog"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <h3 id="confirm-dialog-title">{title}</h3>
        <p>{body}</p>
        {extra}
        {matchGated && (
          <label className="confirm-match-field">
            <span className="confirm-match-label">
              Type <strong>{confirmMatchText}</strong> to confirm
            </span>
            <input
              ref={matchInputRef}
              type="text"
              value={typedMatch}
              aria-label={`Type ${confirmMatchText} to confirm`}
              onChange={(e) => {
                setTypedMatch(e.target.value);
              }}
            />
          </label>
        )}
        <div className="confirm-dialog-actions">
          <button type="button" className="btn btn-ghost" title="Cancel" onClick={onCancel}>
            <IconX size={14} />
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            title={confirmLabel}
            disabled={!matchSatisfied}
            onClick={onConfirm}
          >
            {danger ? <IconTrash size={14} /> : <IconCheck size={14} />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
