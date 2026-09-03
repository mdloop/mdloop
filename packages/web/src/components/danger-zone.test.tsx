// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DangerZone } from './danger-zone.js';

afterEach(cleanup);

describe('DangerZone', () => {
  it('renders title, description, and the passed action', () => {
    render(
      <DangerZone title="Danger zone" description="This cannot be undone.">
        <button type="button">Purge organization</button>
      </DangerZone>,
    );
    expect(screen.getByRole('heading', { name: 'Danger zone' })).toBeDefined();
    expect(screen.getByText('This cannot be undone.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Purge organization' })).toBeDefined();
  });

  it('labels the section by its own heading for a11y', () => {
    render(
      <DangerZone title="Danger zone" description="Careful.">
        <button type="button" onClick={vi.fn()}>
          Act
        </button>
      </DangerZone>,
    );
    const section = screen.getByRole('heading', { name: 'Danger zone' }).closest('section');
    expect(section?.getAttribute('aria-labelledby')).toBe(
      screen.getByRole('heading', { name: 'Danger zone' }).id,
    );
  });
});
