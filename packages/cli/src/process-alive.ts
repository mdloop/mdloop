/**
 * Pid-liveness check shared by every local-lock-style file this CLI writes
 * (`.mdloop/.lock` in `lock.ts`, `instance.json` in `instance-record.ts`,
 * `projects.json` in `folder-projects.ts`). Extracted from `lock.ts`, which
 * had this exact logic private to itself before any of the other two files
 * existed.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process — the previous run crashed, whatever it held is
    // stale. Any other error (e.g. EPERM, owned by another user) means the
    // process does exist; treat conservatively as alive so we never steal a
    // live lock/record.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
