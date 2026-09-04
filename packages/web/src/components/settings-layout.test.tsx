// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsLayout } from './settings-layout.js';
import type { SettingsRailGroup } from './settings-layout.js';

function stubMatchMedia(matchesFor: (query: string) => boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: matchesFor(query),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function rail(onSelectBilling: () => void): SettingsRailGroup[] {
  return [
    {
      heading: 'ORGANIZATION',
      items: [{ id: 'org', label: 'Org settings', active: true, onSelect: () => undefined }],
    },
    {
      heading: 'BILLING',
      items: [{ id: 'billing', label: 'Billing', active: false, onSelect: onSelectBilling }],
    },
  ];
}

afterEach(cleanup);

describe('SettingsLayout at desktop width', () => {
  beforeEach(() => {
    stubMatchMedia(() => false);
  });

  it('shows the rail and content together, with no back button', () => {
    render(
      <SettingsLayout header={<div>Header</div>} rail={rail(vi.fn())}>
        <p>Body content</p>
      </SettingsLayout>,
    );
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeDefined();
    expect(screen.getByText('Body content')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Sections/ })).toBeNull();
  });

  it('marks the active rail item with aria-current', () => {
    render(
      <SettingsLayout header={<div>Header</div>} rail={rail(vi.fn())}>
        <p>Body</p>
      </SettingsLayout>,
    );
    expect(screen.getByRole('button', { name: 'Org settings' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('button', { name: 'Billing' }).getAttribute('aria-current')).toBeNull();
  });

  it('fires the item onSelect when a rail item is clicked', async () => {
    const onSelectBilling = vi.fn();
    render(
      <SettingsLayout header={<div>Header</div>} rail={rail(onSelectBilling)}>
        <p>Body</p>
      </SettingsLayout>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Billing' }));
    expect(onSelectBilling).toHaveBeenCalled();
  });
});

describe('SettingsLayout below 720px', () => {
  beforeEach(() => {
    stubMatchMedia((q) => q === '(max-width: 720px)');
  });

  it('shows content by default (deep-linking a section shows that section)', () => {
    render(
      <SettingsLayout header={<div>Header</div>} rail={rail(vi.fn())}>
        <p>Body content</p>
      </SettingsLayout>,
    );
    expect(screen.getByText('Body content')).toBeDefined();
    expect(screen.queryByRole('navigation', { name: 'Settings sections' })).toBeNull();
    expect(screen.getByRole('button', { name: /Sections/ })).toBeDefined();
  });

  it('drills into the section index on "Sections", then back into a section on tap', async () => {
    const onSelectBilling = vi.fn();
    render(
      <SettingsLayout header={<div>Header</div>} rail={rail(onSelectBilling)}>
        <p>Body content</p>
      </SettingsLayout>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Sections/ }));
    expect(screen.queryByText('Body content')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Org settings' })).toBeDefined();

    await userEvent.click(screen.getByRole('button', { name: 'Billing' }));
    expect(onSelectBilling).toHaveBeenCalled();
  });
});
