// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JSX } from 'react';
import { ErrorBoundary, FeatureBoundary, FeatureFallback } from './error-boundary.js';

afterEach(cleanup);

function Boom(): never {
  throw new Error('render exploded: secret-doc-title');
}

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('all good')).toBeTruthy();
  });

  it('catches a render throw and shows the reload fallback, reporting opaquely', () => {
    // React logs the caught error to console.error; suppress the expected noise.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();

    // The opaque report went out (event: client_error), and it never carried
    // the thrown message / doc title.
    const reported = spy.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
      .find((s) => s.includes('client_error'));
    expect(reported).toBeDefined();
    expect(reported).not.toContain('secret-doc-title');
    spy.mockRestore();
  });
});

/** Throws only while `explode` is set, so one tree can fail then recover. */
function MaybeBoom({ explode }: { explode: boolean }): JSX.Element {
  if (explode) throw new Error('render exploded: secret-doc-title');
  return <p>rendered fine</p>;
}

describe('FeatureBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <FeatureBoundary fallback={<p>fallback</p>}>
        <p>all good</p>
      </FeatureBoundary>,
    );
    expect(screen.getByText('all good')).toBeTruthy();
    expect(screen.queryByText('fallback')).toBeNull();
  });

  it('catches a render throw locally and shows only the small fallback', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <div>
        <p>rest of the page</p>
        <FeatureBoundary
          source="diagram"
          fallback={<FeatureFallback title="This diagram couldn't be displayed." />}
        >
          <Boom />
        </FeatureBoundary>
      </div>,
    );
    expect(screen.getByText("This diagram couldn't be displayed.")).toBeTruthy();
    // The point of the inner layer: the surrounding page survived, and the
    // whole-page reload prompt never appeared.
    expect(screen.getByText('rest of the page')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    spy.mockRestore();
  });

  it('reports opaquely under its own source tag, never the thrown message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <FeatureBoundary source="viewer-document" fallback={<p>fallback</p>}>
        <Boom />
      </FeatureBoundary>,
    );
    const reported = spy.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
      .find((s) => s.includes('client_error'));
    expect(reported).toContain('viewer-document');
    expect(reported).not.toContain('secret-doc-title');
    spy.mockRestore();
  });

  it('retries children when resetKey changes, so a fixed slot un-sticks', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender } = render(
      <FeatureBoundary resetKey="leg-3" fallback={<p>fallback</p>}>
        <MaybeBoom explode />
      </FeatureBoundary>,
    );
    expect(screen.getByText('fallback')).toBeTruthy();

    // Same content, still broken — a re-render alone must not clear it.
    rerender(
      <FeatureBoundary resetKey="leg-3" fallback={<p>fallback</p>}>
        <MaybeBoom explode={false} />
      </FeatureBoundary>,
    );
    expect(screen.getByText('fallback')).toBeTruthy();

    // New content (a corrected leg) — retried, and it renders.
    rerender(
      <FeatureBoundary resetKey="leg-4" fallback={<p>fallback</p>}>
        <MaybeBoom explode={false} />
      </FeatureBoundary>,
    );
    expect(screen.getByText('rendered fine')).toBeTruthy();
    expect(screen.queryByText('fallback')).toBeNull();
    spy.mockRestore();
  });

  it('fails again on new content that is also broken', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender } = render(
      <FeatureBoundary resetKey="leg-3" fallback={<p>fallback</p>}>
        <MaybeBoom explode />
      </FeatureBoundary>,
    );
    rerender(
      <FeatureBoundary resetKey="leg-4" fallback={<p>fallback</p>}>
        <MaybeBoom explode />
      </FeatureBoundary>,
    );
    expect(screen.getByText('fallback')).toBeTruthy();
    spy.mockRestore();
  });
});
