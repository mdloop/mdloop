// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataTable } from './data-table.js';
import type { DataTableColumn } from './data-table.js';

interface Row {
  id: string;
  name: string;
  role: string;
}

const columns: DataTableColumn<Row>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name },
  { key: 'role', header: 'Role', render: (r) => r.role },
];

const rows: Row[] = [
  { id: 'u1', name: 'Jas', role: 'Admin' },
  { id: 'u2', name: 'Priya', role: 'Member' },
];

/** Matches the app-wide stub convention (shell.test.tsx/viewer.test.tsx):
 *  parameterized so a single test can simulate a narrow viewport. */
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

afterEach(cleanup);

beforeEach(() => {
  stubMatchMedia(() => false);
});

describe('DataTable', () => {
  it('renders a real table with header cells at desktop width', () => {
    render(
      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.id}
        caption="Members"
        emptyState={<p>None</p>}
      />,
    );
    expect(screen.getByTestId('data-table')).toBeDefined();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeDefined();
    expect(screen.getByText('Jas')).toBeDefined();
    expect(screen.getByText('Priya')).toBeDefined();
  });

  it('shows the empty-state slot instead of a table when there are no rows', () => {
    render(
      <DataTable
        columns={columns}
        rows={[]}
        getRowKey={(r) => r.id}
        caption="Members"
        emptyState={<p>No members yet</p>}
      />,
    );
    expect(screen.getByTestId('data-table-empty')).toBeDefined();
    expect(screen.getByText('No members yet')).toBeDefined();
    expect(screen.queryByTestId('data-table')).toBeNull();
  });

  it('collapses to stacked label/value blocks below 720px', () => {
    stubMatchMedia((q) => q === '(max-width: 720px)');
    render(
      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.id}
        caption="Members"
        emptyState={<p>None</p>}
      />,
    );
    expect(screen.queryByTestId('data-table')).toBeNull();
    const stack = screen.getByTestId('data-table-stack');
    expect(stack).toBeDefined();
    // Each stacked cell carries its own label — the header row disappears,
    // but the label survives per value instead.
    expect(screen.getAllByText('Name').length).toBe(2);
    expect(screen.getByText('Jas')).toBeDefined();
  });

  it('marks shed columns so they can be hidden at the tablet band via CSS', () => {
    render(
      <DataTable
        columns={[...columns, { key: 'extra', header: 'Extra', render: () => 'x', shed: true }]}
        rows={rows}
        getRowKey={(r) => r.id}
        caption="Members"
        emptyState={<p>None</p>}
      />,
    );
    const extraHeader = screen.getByRole('columnheader', { name: 'Extra' });
    expect(extraHeader.className).toContain('data-table-col--shed');
  });
});
