import type { JSX } from 'react';
import { MdloopMark } from './mdloop-mark.js';

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
      aria-label="mdloop — back to home"
      title="mdloop — back to home"
    >
      <MdloopMark size={26} />
      <span className="brand-mark-word">mdloop</span>
    </button>
  );
}
