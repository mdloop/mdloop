/** Shared formatting helpers — originally operator-console-only (Phase
 *  26.E), promoted here in 39.C once org-settings needed the same storage
 *  and ledger-date formatting for the usage overview. */

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex] ?? 'TB'}`;
}

const dateFmt = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' });

/** Long form with year — a ledger's "Created" row may be looking years back. */
export function fmtDateWithYear(iso: string | null): string {
  if (!iso) return '—';
  return dateFmt.format(new Date(iso));
}
