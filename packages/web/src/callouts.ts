/**
 * GitHub-style callout parsing. Kept DOM-free (plain strings) so the marker
 * detection/stripping is unit-testable without rendering — the blockquote
 * component in markdown-view.tsx does the React-node plumbing.
 */

export type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

const LABELS: Record<CalloutKind, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
};

/** Marker must lead the blockquote and sit alone on its first line. */
const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i;

export interface Callout {
  kind: CalloutKind;
  label: string;
  /** First-paragraph text with the marker line removed. */
  body: string;
}

/** Detect a `[!NOTE]`-style marker at the start of blockquote text. */
export function parseCallout(text: string): Callout | null {
  const m = MARKER.exec(text);
  if (!m?.[1]) return null;
  const kind = m[1].toLowerCase() as CalloutKind;
  return { kind, label: LABELS[kind], body: text.slice(m[0].length) };
}

/** Strip a leading callout marker line; passthrough when there is none. */
export function stripCalloutMarker(text: string): string {
  return text.replace(MARKER, '');
}
