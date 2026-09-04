import type { JSX } from 'react';

/**
 * The mdloop logomark: a loop drawn as two round-capped half-circle strokes
 * — ink on the left half, the mdloop accent on the right — meeting at the
 * top (where the round caps simply overlap) and at the bottom, where an ink
 * bead sits over the join. The shape reads literally as the product name
 * (a loop) and keeps this mark's running idea from its predecessor: two
 * parties (ink, accent — human and agent) tracing the same cycle, meeting
 * at one shared point the bead calls out, standing in for a comment
 * anchored to a specific spot. Both halves are cubic-bezier approximations
 * of a true semicircle (the standard 0.5523×r control-point offset), not
 * SVG arc commands — arcs need a sweep-flag whose visual direction is easy
 * to get backwards; these control points are exact and reviewable. The
 * bead's radius (4.5) has to exceed the strokes' own round-cap radius (half
 * of strokeWidth, 3.5) and it has to be the last element drawn — otherwise
 * it's just redundant ink painted over ink already there, invisible against
 * both the stroke and the page. Two colors only, same as the strokes
 * themselves. Replaced an earlier bold-letterform-initial mark (2026-09-04):
 * a single letter reads as whichever name was current when it was drawn,
 * rather than surviving a rename — a loop has no such expiration date.
 */
export function MdloopMark({ size = 20 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M20,7 C12.82,7 7,12.82 7,20 C7,27.18 12.82,33 20,33"
        stroke="var(--ink)"
        strokeWidth="7"
        strokeLinecap="round"
      />
      <path
        d="M20,7 C27.18,7 33,12.82 33,20 C33,27.18 27.18,33 20,33"
        stroke="var(--mdloop)"
        strokeWidth="7"
        strokeLinecap="round"
      />
      <circle cx="20" cy="33" r="4.5" fill="var(--ink)" />
    </svg>
  );
}
