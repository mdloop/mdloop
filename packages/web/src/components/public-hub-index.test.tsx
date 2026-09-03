// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as clientModule from '../api/client.js';
import { api } from '../api/client.js';
import { PublicHubIndex } from './public-hub-index.js';

vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual<typeof clientModule>('../api/client.js');
  return {
    ...actual,
    api: {
      getPublicDocs: vi.fn(),
      searchPublicDocs: vi.fn(),
    },
  };
});

afterEach(cleanup);

describe('PublicHubIndex', () => {
  it('renders the published doc list from getPublicDocs', async () => {
    vi.mocked(api.getPublicDocs).mockResolvedValue({
      docs: [
        { slug: 'runbook', title: 'Runbook', publishedAt: '2026-07-01T00:00:00Z' },
        { slug: 'faq', title: 'FAQ', publishedAt: '2026-07-05T00:00:00Z' },
      ],
    });

    render(<PublicHubIndex onOpenDoc={vi.fn()} />);

    expect(await screen.findByText('Runbook')).toBeDefined();
    expect(screen.getByText('FAQ')).toBeDefined();
  });

  it('navigates via onOpenDoc when a list item is clicked', async () => {
    vi.mocked(api.getPublicDocs).mockResolvedValue({
      docs: [{ slug: 'runbook', title: 'Runbook', publishedAt: '2026-07-01T00:00:00Z' }],
    });
    const onOpenDoc = vi.fn();

    render(<PublicHubIndex onOpenDoc={onOpenDoc} />);
    await screen.findByText('Runbook');
    await userEvent.click(screen.getByText('Runbook'));

    expect(onOpenDoc).toHaveBeenCalledWith('runbook');
  });

  it('shows a friendly empty state when there are no published docs', async () => {
    vi.mocked(api.getPublicDocs).mockResolvedValue({ docs: [] });

    render(<PublicHubIndex onOpenDoc={vi.fn()} />);

    expect(await screen.findByText('No public documents yet.')).toBeDefined();
  });

  it('debounces search input and calls searchPublicDocs, rendering hits', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.getPublicDocs).mockResolvedValue({ docs: [] });
    vi.mocked(api.searchPublicDocs).mockResolvedValue({
      hits: [{ slug: 'runbook', title: 'Runbook', snippet: 'the «on-call» rotation' }],
    });

    const user = userEvent.setup({ delay: null });
    render(<PublicHubIndex onOpenDoc={vi.fn()} />);
    await screen.findByText('No public documents yet.');

    await user.type(screen.getByPlaceholderText('Search public docs…'), 'on-call');

    // Not called immediately — debounced.
    expect(api.searchPublicDocs).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    await waitFor(() => {
      expect(api.searchPublicDocs).toHaveBeenCalledWith('on-call');
    });
    expect(await screen.findByText('Runbook')).toBeDefined();
    // The «»-delimited match renders inside a <mark>, as plain text (no HTML
    // injection) rather than via dangerouslySetInnerHTML.
    expect(screen.getByText('on-call').tagName).toBe('MARK');

    vi.useRealTimers();
  });
});
