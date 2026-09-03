// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Record } from './record.js';

afterEach(cleanup);

describe('Record', () => {
  it('renders each label immediately followed by its value (dt/dd adjacency)', () => {
    render(
      <Record
        items={[
          { label: 'Seats', value: '3' },
          { label: 'Interval', value: 'Monthly' },
        ]}
      />,
    );
    expect(screen.getByText('Seats').nextElementSibling?.textContent).toBe('3');
    expect(screen.getByText('Interval').nextElementSibling?.textContent).toBe('Monthly');
  });

  it('accepts non-text ReactNode values', () => {
    render(<Record items={[{ label: 'Status', value: <span data-testid="v">Active</span> }]} />);
    expect(screen.getByTestId('v').textContent).toBe('Active');
  });

  it('renders nothing but an empty dl for an empty item list', () => {
    render(<Record items={[]} />);
    expect(document.querySelector('dl.record')?.children.length).toBe(0);
  });
});
