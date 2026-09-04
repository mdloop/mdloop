// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VersionDto } from '../api/client.js';
import { VersionStrip, versionSourceLabel } from './version-strip.js';

function version(overrides: Partial<VersionDto> = {}): VersionDto {
  return {
    id: 'v1',
    seq: 1,
    source: 'web',
    createdBy: 'u1',
    createdAt: '2026-07-01T00:00:00Z',
    purgedAt: null,
    viaApiKeyName: null,
    changeNote: null,
    ...overrides,
  };
}

type Handler = 'onView' | 'onDiff';

function renderStrip(
  overrides: Partial<Parameters<typeof VersionStrip>[0]> = {},
): Record<Handler, ReturnType<typeof vi.fn>> {
  const handlers = { onView: vi.fn(), onDiff: vi.fn() };
  render(
    <VersionStrip
      versions={[version(), version({ id: 'v2', seq: 2 })]}
      currentVersionId="v2"
      viewingId={null}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

afterEach(cleanup);

describe('VersionStrip', () => {
  it('renders nothing for a single-version document', () => {
    const { container } = render(
      <VersionStrip
        versions={[version()]}
        currentVersionId="v1"
        viewingId={null}
        onView={vi.fn()}
        onDiff={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a "vN" chip per version', () => {
    renderStrip();
    expect(screen.getByText('v1')).toBeDefined();
    expect(screen.getByText('v2')).toBeDefined();
  });

  it('keeps a purged version visible but inert', async () => {
    const user = userEvent.setup();
    const { onView } = renderStrip({
      versions: [version({ purgedAt: '2026-07-10T00:00:00Z' }), version({ id: 'v2', seq: 2 })],
    });
    const purged = screen.getByText('v1');
    expect(purged.tagName).toBe('SPAN');
    expect(purged.className).toContain('badge');
    await user.hover(purged);
    expect(screen.getByRole('tooltip').textContent).toBe('Content purged by retention policy');
    await user.click(purged);
    expect(onView).not.toHaveBeenCalled();
  });

  it('clicking a non-current chip views that version', async () => {
    const { onView } = renderStrip();
    await userEvent.click(screen.getByText('v1'));
    expect(onView).toHaveBeenCalledWith(expect.objectContaining({ id: 'v1', seq: 1 }));
  });

  it('shows only the actions while viewing — the content banner owns the read-only signal', () => {
    renderStrip({ viewingId: 'v1' });
    expect(screen.queryByText(/read-only/)).toBeNull();
    expect(screen.getByRole('button', { name: /Diff against current/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /Back to current/ })).toBeDefined();
  });

  it('titles each chip with its version number and upload time', async () => {
    const user = userEvent.setup();
    renderStrip();
    await user.hover(screen.getByRole('button', { name: 'v1' }));
    expect(screen.getByRole('tooltip').textContent).toMatch(/^v1 — uploaded /);
  });

  it('names where each version came from, including a repo push (Phase 20.A `cli`)', async () => {
    const user = userEvent.setup();
    renderStrip({
      versions: [
        version({ source: 'web' }),
        version({ id: 'v2', seq: 2, source: 'mcp' }),
        version({ id: 'v3', seq: 3, source: 'cli' }),
      ],
      currentVersionId: 'v3',
    });
    await user.hover(screen.getByRole('button', { name: 'v1' }));
    expect(screen.getByRole('tooltip').textContent).toContain('uploaded in mdloop on');
    await user.unhover(screen.getByRole('button', { name: 'v1' }));

    await user.hover(screen.getByRole('button', { name: 'v2' }));
    expect(screen.getByRole('tooltip').textContent).toContain('uploaded by an agent on');
    await user.unhover(screen.getByRole('button', { name: 'v2' }));

    await user.hover(screen.getByRole('button', { name: 'v3' }));
    expect(screen.getByRole('tooltip').textContent).toContain('uploaded from the repo on');
  });

  it('labels every upload source — a widened union can never go unlabelled', () => {
    const sources: VersionDto['source'][] = ['web', 'mcp', 'cli'];
    const labels = sources.map(versionSourceLabel);
    expect(labels.every((l) => l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(sources.length);
  });

  it('marks a version uploaded via API key with a neutral marker naming the key', async () => {
    const user = userEvent.setup();
    renderStrip({
      versions: [version(), version({ id: 'v2', seq: 2, viaApiKeyName: 'ci bot' })],
    });
    const keyChip = screen.getByRole('button', { name: /v2/ });
    expect(keyChip.textContent).toContain('key');
    await user.hover(keyChip);
    expect(screen.getByRole('tooltip').textContent).toContain('via API key "ci bot"');
    await user.unhover(keyChip);
    // The browser-session chip carries no key marker.
    const sessionChip = screen.getByRole('button', { name: 'v1' });
    expect(sessionChip.textContent).not.toContain('key');
  });

  it('puts the change note in the chip tooltip, never inline (ADR 0003 §B)', async () => {
    const user = userEvent.setup();
    renderStrip({
      versions: [version({ changeNote: 'Reworked the intro' }), version({ id: 'v2', seq: 2 })],
    });
    const chip = screen.getByRole('button', { name: 'v1' });
    await user.hover(chip);
    expect(screen.getByRole('tooltip').textContent).toContain('Reworked the intro');
    // The note is tooltip-only — it must not render as chip text.
    expect(chip.textContent).not.toContain('Reworked the intro');
  });

  it('diffs the viewed version against current', async () => {
    const { onDiff } = renderStrip({ viewingId: 'v1' });
    await userEvent.click(screen.getByRole('button', { name: /Diff against current/ }));
    expect(onDiff).toHaveBeenCalledWith(expect.objectContaining({ id: 'v1', seq: 1 }));
  });

  it('returns to current from the viewing state', async () => {
    const { onView } = renderStrip({ viewingId: 'v1' });
    await userEvent.click(screen.getByRole('button', { name: /Back to current/ }));
    expect(onView).toHaveBeenCalledWith(null);
  });

  describe('with more than 8 versions', () => {
    function manyVersions(count: number): VersionDto[] {
      return Array.from({ length: count }, (_, i) => version({ id: `v${i + 1}`, seq: i + 1 }));
    }

    it('shows only the last 8 as chips, folding the rest behind "Earlier"', () => {
      renderStrip({ versions: manyVersions(10), currentVersionId: 'v10' });
      // The 8 most recent (v3 through v10) are direct chips.
      for (let seq = 3; seq <= 10; seq++) {
        expect(screen.getByRole('button', { name: new RegExp(`^v${String(seq)}$`) })).toBeDefined();
      }
      // The 2 oldest are folded behind the dropdown trigger, not rendered as chips.
      expect(screen.queryByRole('button', { name: 'v1' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'v2' })).toBeNull();
      expect(screen.getByRole('button', { name: /Earlier \(2\)/ })).toBeDefined();
    });

    it('opens the dropdown and views an older version from it', async () => {
      const { onView } = renderStrip({ versions: manyVersions(10), currentVersionId: 'v10' });
      await userEvent.click(screen.getByRole('button', { name: /Earlier \(2\)/ }));
      const item = screen.getByRole('option', { name: 'v1' });
      await userEvent.click(item);
      expect(onView).toHaveBeenCalledWith(expect.objectContaining({ id: 'v1', seq: 1 }));
      // Selecting closes the dropdown.
      expect(screen.queryByRole('option', { name: 'v1' })).toBeNull();
    });

    it('keeps a purged older version inert inside the dropdown', async () => {
      const versions = manyVersions(10).map((v, i) =>
        i === 0 ? { ...v, purgedAt: '2026-07-10T00:00:00Z' } : v,
      );
      const { onView } = renderStrip({ versions, currentVersionId: 'v10' });
      await userEvent.click(screen.getByRole('button', { name: /Earlier \(2\)/ }));
      const purged = screen.getByText('v1');
      expect(purged.tagName).toBe('SPAN');
      await userEvent.click(purged);
      expect(onView).not.toHaveBeenCalled();
    });

    it('labels the trigger with the selected version when viewing a folded-away version', () => {
      renderStrip({ versions: manyVersions(10), currentVersionId: 'v10', viewingId: 'v1' });
      expect(screen.getByRole('button', { name: /^v1$/ })).toBeDefined();
      expect(screen.queryByRole('button', { name: /Earlier/ })).toBeNull();
    });

    it('does not fold anything at exactly 8 versions', () => {
      renderStrip({ versions: manyVersions(8), currentVersionId: 'v8' });
      expect(screen.queryByRole('button', { name: /Earlier/ })).toBeNull();
      expect(screen.getByRole('button', { name: 'v1' })).toBeDefined();
    });

    it('folds exactly 1 version at 9 and singularizes the label', async () => {
      const user = userEvent.setup();
      renderStrip({ versions: manyVersions(9), currentVersionId: 'v9' });
      const trigger = screen.getByRole('button', { name: 'Earlier (1)' });
      await user.hover(trigger);
      expect(screen.getByRole('tooltip').textContent).toBe('1 earlier version');
    });

    it('toggles aria-expanded and shows the listbox while open', async () => {
      renderStrip({ versions: manyVersions(10), currentVersionId: 'v10' });
      const trigger = screen.getByRole('button', { name: /Earlier \(2\)/ });
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByRole('listbox')).toBeNull();
      await userEvent.click(trigger);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(screen.getByRole('listbox')).toBeDefined();
    });

    it('closes without selecting when the trigger is clicked again', async () => {
      const { onView } = renderStrip({ versions: manyVersions(10), currentVersionId: 'v10' });
      const trigger = screen.getByRole('button', { name: /Earlier \(2\)/ });
      await userEvent.click(trigger);
      expect(screen.getByRole('listbox')).toBeDefined();
      await userEvent.click(trigger);
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(onView).not.toHaveBeenCalled();
    });

    it('closes on Escape without selecting', async () => {
      const { onView } = renderStrip({ versions: manyVersions(10), currentVersionId: 'v10' });
      await userEvent.click(screen.getByRole('button', { name: /Earlier \(2\)/ }));
      expect(screen.getByRole('listbox')).toBeDefined();
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(onView).not.toHaveBeenCalled();
    });

    it('closes on an outside click without selecting', async () => {
      const { onView } = renderStrip({ versions: manyVersions(10), currentVersionId: 'v10' });
      await userEvent.click(screen.getByRole('button', { name: /Earlier \(2\)/ }));
      expect(screen.getByRole('listbox')).toBeDefined();
      await userEvent.click(document.body);
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(onView).not.toHaveBeenCalled();
    });

    it('marks the currently-viewed older version as the selected option', async () => {
      renderStrip({ versions: manyVersions(10), currentVersionId: 'v10', viewingId: 'v1' });
      await userEvent.click(screen.getByRole('button', { name: /^v1$/ }));
      const option = screen.getByRole('option', { name: 'v1' });
      expect(option.getAttribute('aria-selected')).toBe('true');
    });

    it('recomputes the panel position on window resize', async () => {
      renderStrip({ versions: manyVersions(10), currentVersionId: 'v10' });
      const trigger = screen.getByRole('button', { name: /Earlier \(2\)/ });
      const rectSpy = vi
        .spyOn(trigger, 'getBoundingClientRect')
        .mockReturnValue({ bottom: 100, left: 50 } as DOMRect);
      await userEvent.click(trigger);
      const menu = screen.getByRole('listbox');
      expect(menu.style.top).toBe('106px');
      expect(menu.style.left).toBe('50px');

      rectSpy.mockReturnValue({ bottom: 300, left: 20 } as DOMRect);
      fireEvent(window, new Event('resize'));
      expect(menu.style.top).toBe('306px');
      expect(menu.style.left).toBe('20px');
    });
  });
});
