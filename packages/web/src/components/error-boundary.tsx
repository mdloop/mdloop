import { Component } from 'react';
import type { ErrorInfo, JSX, ReactNode } from 'react';
import { reportClientError } from '../error-reporting.js';

interface FeatureBoundaryProps {
  children: ReactNode;
  /**
   * Rendered in place of `children` after a caught throw.
   *
   * A plain node, deliberately not a `(error) => ReactNode` render prop: the
   * thrown message can quote document or comment text (a stack frame can too),
   * and a render prop is a standing invitation to put that on screen — and from
   * there into a screenshot or a pasted bug report. Nothing outside this file
   * ever holds the Error object; the only thing that leaves is the opaque
   * report `reportClientError` makes.
   */
  fallback: ReactNode;
  /** Opaque tag for that report — a static feature name, never content. */
  source?: string | undefined;
  /**
   * Changing this clears a previous failure and retries `children`. Without it
   * a boundary is a one-way latch: a diagram that threw on v3 would keep
   * showing its fallback after v4 fixed it — the same stuck-fallback bug
   * MermaidBlock had. Pass whatever identifies the content being rendered
   * (source text, thread object), so new content always gets a fresh attempt.
   */
  resetKey?: unknown;
}

interface State {
  failed: boolean;
  /** Last `resetKey` this instance rendered against — the change detector. */
  resetKey: unknown;
}

/**
 * A localized error boundary (one feature, one slot). Where `ErrorBoundary`
 * below is the whole-page floor, this is the per-feature layer: a throw inside
 * the markdown/mermaid/comment pipeline takes out its own block and leaves the
 * rest of the page usable, instead of blanking the SPA down to a reload prompt.
 *
 * Not automatic — React boundaries only catch *render* throws in their subtree.
 * Expected async failures (a 404, a revoked share) still get inline handling at
 * their own call site; this catches the unexpected ones.
 */
export class FeatureBoundary extends Component<FeatureBoundaryProps, State> {
  override state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: FeatureBoundaryProps,
    state: State,
  ): Partial<State> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null;
    return { failed: false, resetKey: props.resetKey };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    reportClientError(this.props.source ?? 'feature', error);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * The house shape for a `FeatureBoundary` fallback: a quiet inline notice in
 * the failed slot, optionally over the raw content it could not render. Small
 * on purpose — the surrounding page still works, so this must not read like a
 * page-level failure (that's `ErrorBoundary`'s job, and it looks different).
 */
export function FeatureFallback({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="feature-fallback" role="alert">
      <p className="feature-fallback-title">{title}</p>
      {children}
    </div>
  );
}

/**
 * Top-level last-resort boundary (Phase 24.E). A render throw anywhere in the
 * tree otherwise blanks the whole SPA; here it is caught, reported opaquely
 * (no content — see reportClientError), and replaced with a minimal reload
 * prompt. This is the floor, not per-feature error UI: individual flows still
 * handle their own expected failures (missing doc, revoked share) inline, and
 * the render-throw risks in the markdown/comment pipeline are caught closer to
 * home by `FeatureBoundary` above — nothing should reach this except a throw
 * in the app chrome itself.
 *
 * No `resetKey`: at this level there is nothing left to retry into, which is
 * exactly why the fallback offers a reload instead.
 */
export function ErrorBoundary({ children }: { children: ReactNode }): JSX.Element {
  return (
    <FeatureBoundary
      source="render"
      fallback={
        <div className="viewer-missing empty" role="alert">
          <h3>Something went wrong</h3>
          <p>An unexpected error interrupted the page. Reloading usually fixes it.</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              window.location.reload();
            }}
          >
            Reload
          </button>
        </div>
      }
    >
      {children}
    </FeatureBoundary>
  );
}
