/** Markdown heading outline — parsed from source, fenced code skipped. */

export interface OutlineEntry {
  /** 1–6. */
  level: number;
  text: string;
  /** Character offset of the heading line in the source. */
  start: number;
  /** End of the section: next heading's start, or source end. */
  end: number;
  /** Position among all rendered headings, for scroll targeting. */
  index: number;
}

export function parseOutline(source: string): OutlineEntry[] {
  const entries: Omit<OutlineEntry, 'end'>[] = [];
  let offset = 0;
  let inFence = false;
  let index = 0;
  for (const line of source.split('\n')) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence) {
      const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (m?.[1] && m[2]) {
        entries.push({ level: m[1].length, text: m[2], start: offset, index });
        index += 1;
      }
    }
    offset += line.length + 1;
  }
  return entries.map((e, i) => ({ ...e, end: entries[i + 1]?.start ?? source.length }));
}

/** Open-comment count per outline section, from resolved anchor offsets. */
export function countBySection(outline: OutlineEntry[], starts: (number | null)[]): number[] {
  return outline.map(
    (section) => starts.filter((s) => s !== null && s >= section.start && s < section.end).length,
  );
}
