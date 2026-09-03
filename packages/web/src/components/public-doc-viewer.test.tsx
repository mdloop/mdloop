// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as clientModule from '../api/client.js';
import { api, ApiError } from '../api/client.js';
import { PublicDocViewer } from './public-doc-viewer.js';

vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual<typeof clientModule>('../api/client.js');
  return {
    ...actual,
    api: {
      getPublicDoc: vi.fn(),
      getPublicDocContent: vi.fn(),
    },
  };
});

// Spy on MarkdownView so we can assert exactly what props PublicDocViewer
// passes it — in particular that `dark` is always forced to `false` — without
// exercising the real mermaid/markdown pipeline.
// The `BOOM` sentinel stands in for any render throw inside the real markdown
// pipeline (a diagram, a callout, a plugin) — see the FeatureBoundary test.
vi.mock('./markdown-view.js', () => ({
  MarkdownView: (props: { source: string; dark: boolean }) => {
    if (props.source.startsWith('BOOM')) throw new Error('render exploded: BOOM secret');
    return (
      <div data-testid="markdown-view" data-dark={String(props.dark)}>
        {props.source}
      </div>
    );
  },
}));

afterEach(cleanup);

describe('PublicDocViewer', () => {
  it('renders the published document with dark forced to false', async () => {
    vi.mocked(api.getPublicDoc).mockResolvedValue({
      slug: 'runbook',
      title: 'Runbook',
      publishedAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-10T00:00:00Z',
    });
    vi.mocked(api.getPublicDocContent).mockResolvedValue('# Hello world');

    render(<PublicDocViewer slug="runbook" onBack={vi.fn()} />);

    expect(await screen.findByText('Runbook')).toBeDefined();
    const md = screen.getByTestId('markdown-view');
    expect(md.getAttribute('data-dark')).toBe('false');
    expect(md.textContent).toBe('# Hello world');
  });

  it('renders a friendly not-found message when getPublicDoc resolves null', async () => {
    vi.mocked(api.getPublicDoc).mockResolvedValue(null);
    vi.mocked(api.getPublicDocContent).mockRejectedValue(new ApiError(404, 'not_found'));

    render(<PublicDocViewer slug="missing" onBack={vi.fn()} />);

    expect(await screen.findByText("This document isn't published")).toBeDefined();
    expect(screen.queryByTestId('markdown-view')).toBeNull();
  });

  it('renders no comment/thread chrome alongside the document', async () => {
    vi.mocked(api.getPublicDoc).mockResolvedValue({
      slug: 'runbook',
      title: 'Runbook',
      publishedAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-10T00:00:00Z',
    });
    vi.mocked(api.getPublicDocContent).mockResolvedValue('body text');

    const { container } = render(<PublicDocViewer slug="runbook" onBack={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('markdown-view')).toBeDefined();
    });

    // Viewer.tsx's review chrome (comment rail, composer, minimap) is never
    // imported here — these selectors should never match in the public hub.
    expect(container.querySelector('.comment-rail')).toBeNull();
    expect(container.querySelector('.composer')).toBeNull();
    expect(container.querySelector('[data-testid="viewer-content"]')).toBeNull();
  });

  it('falls back to the raw source when the markdown pipeline throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.getPublicDoc).mockResolvedValue({
      slug: 'runbook',
      title: 'Runbook',
      publishedAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-10T00:00:00Z',
    });
    vi.mocked(api.getPublicDocContent).mockResolvedValue('BOOM\n\nthe rest of the runbook');

    render(<PublicDocViewer slug="runbook" onBack={vi.fn()} />);

    expect(
      await screen.findByText("This document couldn't be displayed — here is its source."),
    ).toBeDefined();
    // The words survived, and so did the page around them.
    expect(screen.getByRole('alert').textContent).toContain('the rest of the runbook');
    expect(screen.getByText('Runbook')).toBeDefined();
    expect(screen.getByRole('button', { name: /Back to hub/ })).toBeDefined();
    spy.mockRestore();
  });
});
