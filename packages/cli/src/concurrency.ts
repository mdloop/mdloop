/**
 * Runs `worker` over `items` with at most `limit` in flight at once — the
 * global concurrency cap for a bulk push: a
 * multi-file burst (e.g. `git checkout` touching 50 files) needs bounding
 * even without a debounce/watch layer, which is out of scope for the
 * one-shot `push` command (20.B).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: workerCount }, () =>
    (async () => {
      for (;;) {
        const current = next;
        next += 1;
        if (current >= items.length) return;
        results[current] = await worker(items[current] as T, current);
      }
    })(),
  );
  await Promise.all(runners);
  return results;
}
