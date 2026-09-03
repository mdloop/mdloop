import type { JSX } from 'react';

/**
 * The vorlyn logomark: a bold "V" in two strokes, round-capped — ink on the
 * left arm, the vorlyn accent on the right — with an ink bead at the vertex
 * where they meet. Reads at once as the brand initial, the `v3`-style
 * version-chip glyph used throughout the app (design-system.md), and the
 * same document moving between its two states across a review; the bead
 * marks the one point the two states share, standing in for a comment
 * anchored to a specific spot. The bead's radius (4.5) has to exceed the
 * arms' own round-cap radius (half of strokeWidth, 3.5) and it has to be
 * the last element drawn — otherwise it's just redundant ink painted over
 * ink already there, invisible against both the arm and the page. Two
 * colors only, same as the arms themselves. Replaced the original
 * two-bars-passing mark (2026-08-31), which read too literally as the
 * relay baton object from this repo's first identifier (brand-check:allow)
 * rather than anything specific to vorlyn.
 */
export function VorlynMark({ size = 20 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M9,7 L20,31" stroke="var(--ink)" strokeWidth="7" strokeLinecap="round" />
      <path d="M20,31 L31,7" stroke="var(--vorlyn)" strokeWidth="7" strokeLinecap="round" />
      <circle cx="20" cy="31" r="4.5" fill="var(--ink)" />
    </svg>
  );
}
