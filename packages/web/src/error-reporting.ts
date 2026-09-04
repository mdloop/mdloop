/**
 * Opaque client-error reporting (Phase 24.E). A render throw or an unhandled
 * rejection otherwise white-screens the SPA with zero signal. We report only a
 * static error name + the source that caught it + a timestamp — never the
 * message, stack, or any document/comment content (CONSTITUTION §3 in spirit;
 * client logs are no exception).
 *
 * Stopgap sink: `console.error`. When Phase 10 lands a client-error ingestion
 * endpoint, swap the body of `reportClientError` for a `fetch` to it — the
 * call sites (ErrorBoundary + the global handlers) do not change.
 */
export function reportClientError(source: string, error: unknown): void {
  const name = error instanceof Error ? error.name : 'unknown_error';
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({ event: 'client_error', source, name, ts: new Date().toISOString() }),
  );
}

/**
 * Registers the two window-level catch-alls once at bootstrap: a rejected
 * promise nothing awaited, and a synchronous error that escaped React (e.g. in
 * an event handler, where an ErrorBoundary can't see it).
 */
export function installGlobalErrorReporting(): void {
  window.addEventListener('unhandledrejection', (e) => {
    reportClientError('unhandledrejection', e.reason);
  });
  window.addEventListener('error', (e) => {
    reportClientError('window.onerror', e.error);
  });
}
