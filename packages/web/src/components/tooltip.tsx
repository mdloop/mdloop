import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { JSX, ReactElement } from 'react';

interface TooltipTriggerProps {
  'aria-describedby'?: string | undefined;
  onMouseEnter?: (e: React.MouseEvent) => void;
  onMouseLeave?: (e: React.MouseEvent) => void;
  onFocus?: (e: React.FocusEvent) => void;
  onBlur?: (e: React.FocusEvent) => void;
  onClick?: (e: React.MouseEvent) => void;
}

export interface TooltipProps {
  content: string;
  /** A single focusable element (button, link…) — native `title=` is what
   *  this replaces, so the trigger keeps its own accessible name; `content`
   *  is supplementary description, exposed via `aria-describedby`. */
  children: ReactElement<TooltipTriggerProps>;
}

interface TooltipPos {
  top: number;
  left: number;
}

const EDGE_MARGIN = 8;
const GAP = 6;

/**
 * Accessible tooltip: opens on hover *and* keyboard focus (native `title=`
 * only does the former — unreachable by keyboard, per
 * `docs/design-system.md`/Phase 39.A). On touch, where there is no hover,
 * the trigger's own focus (a tap on a real `<button>`/`<a>` focuses it) opens
 * the bubble; tapping elsewhere or Escape dismisses it, same as a mouse
 * leaving the trigger or Escape while hovering.
 *
 * Positioned via JS (`position: fixed`, coordinates from `getBoundingClientRect`)
 * rather than CSS `position: absolute`, and computed relative to the
 * viewport rather than centered blindly on the trigger — same reasoning
 * `version-strip.tsx`'s "Earlier (N)" dropdown already documents: a trigger
 * that sits inside a horizontally-scrollable row (that file's `.version-strip`)
 * has its `overflow-y` forced to `auto` too by CSS's paired-axis rule, which
 * clips away any `position: absolute` descendant that pokes outside the
 * row's own box — exactly what an above-the-trigger tooltip does. `fixed`
 * escapes that ancestor entirely. Horizontal position is then clamped to the
 * viewport so a trigger flush against the left/right edge doesn't push the
 * bubble half off-screen.
 */
export function Tooltip({ content, children }: TooltipProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  // null until measured — the bubble renders once (invisible) to get a real
  // size via `getBoundingClientRect`, then this is set and it repaints in
  // place. Both happen inside `useLayoutEffect`, before the browser paints,
  // so there's no visible flash.
  const [pos, setPos] = useState<TooltipPos | null>(null);

  function reposition(): void {
    const wrap = wrapRef.current;
    const bubble = bubbleRef.current;
    if (!wrap || !bubble) return;
    const wrapRect = wrap.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    let left = wrapRect.left + wrapRect.width / 2 - bubbleRect.width / 2;
    left = Math.max(
      EDGE_MARGIN,
      Math.min(left, window.innerWidth - bubbleRect.width - EDGE_MARGIN),
    );
    const top = wrapRect.top - bubbleRect.height - GAP;
    setPos({ top, left });
  }

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    reposition();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    function onOutside(e: Event): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    // Window resize can reflow the trigger's position (e.g. a rotation or a
    // devtools panel toggling) — recompute rather than leave the bubble
    // pointing at a stale spot, same as version-strip.tsx's older-dropdown.
    function onResize(): void {
      reposition();
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    window.document.addEventListener('mousedown', onOutside);
    window.document.addEventListener('touchstart', onOutside);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.document.removeEventListener('mousedown', onOutside);
      window.document.removeEventListener('touchstart', onOutside);
    };
  }, [open]);

  const trigger = cloneElement(children, {
    'aria-describedby': open ? id : undefined,
    onMouseEnter: (e) => {
      children.props.onMouseEnter?.(e);
      setOpen(true);
    },
    onMouseLeave: (e) => {
      children.props.onMouseLeave?.(e);
      setOpen(false);
    },
    onFocus: (e) => {
      children.props.onFocus?.(e);
      setOpen(true);
    },
    onBlur: (e) => {
      children.props.onBlur?.(e);
      setOpen(false);
    },
    // Idempotent open rather than a toggle: on touch, a tap already focuses
    // the trigger first (opening it), and click fires right after — a
    // toggle there would flip it straight back closed on the very first tap.
    onClick: (e) => {
      children.props.onClick?.(e);
      setOpen(true);
    },
  });

  return (
    <span className="tooltip-wrap" ref={wrapRef}>
      {trigger}
      {open && (
        <span
          role="tooltip"
          id={id}
          ref={bubbleRef}
          className="tooltip-bubble"
          style={{
            top: pos?.top ?? 0,
            left: pos?.left ?? 0,
            visibility: pos ? 'visible' : 'hidden',
          }}
        >
          {content}
        </span>
      )}
    </span>
  );
}
