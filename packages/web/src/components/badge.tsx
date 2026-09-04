import type { HTMLAttributes, JSX, ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'signal' | 'resolved' | 'danger';

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'className' | 'style'> {
  tone?: BadgeTone;
  children: ReactNode;
}

/**
 * Tone-based status pill — generalizes the ad hoc
 * `.invite-status--pending/accepted/revoked/expired` variants and
 * `.admin-tier-badge`. Tone maps straight onto the design system's fixed
 * palette (`docs/design-system.md`): `signal` amber for "needs attention",
 * `resolved` green with no wash (matching the Signals convention — "green,
 * no wash"), `danger` red for states that reflect an actual failure (not for
 * destructive actions themselves, which stay on buttons), `neutral` for
 * everything else.
 *
 * Spreads any other span attributes through (`...rest`) so a `<Badge>` can
 * itself be a `Tooltip` trigger — `Tooltip` clones hover/focus handlers onto
 * its direct child, which only works if that child forwards them to a real
 * DOM node. `className`/`style` are excluded from the passthrough so a
 * caller can never fight the tone class.
 */
export function Badge({ tone = 'neutral', children, ...rest }: BadgeProps): JSX.Element {
  return (
    <span className={`badge badge--${tone}`} {...rest}>
      {children}
    </span>
  );
}
