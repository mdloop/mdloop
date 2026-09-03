import type { JSX } from 'react';
import { VorlynMark } from './vorlyn-mark.js';

/** Logo + wordmark, always routes back to home. Fixed corner overlay by
 * default (pre-login, redemption screens with no real header of their own);
 * `inline` drops the fixed positioning to sit as a normal flow item inside
 * AppHeader instead — same look, same click target, different placement. */
export function BrandMark({
  onClick,
  inline,
}: {
  onClick?: () => void;
  inline?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`brand-mark${inline ? ' brand-mark--inline' : ''}`}
      onClick={onClick}
      aria-label="Vorlyn — back to home"
      title="Vorlyn — back to home"
    >
      <VorlynMark size={26} />
      <span className="brand-mark-word">vorlyn</span>
    </button>
  );
}
